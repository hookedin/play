import type { Integer, Checkpoint, Operation, Prize, MatchTerms } from '../protocol/types.ts';
import type { CasinoWallet, GameIntent } from './wallet.ts';
import { Wallet, getAddress, hexlify, randomBytes, ZeroHash, ZeroAddress, id, keccak256 } from 'ethers';
import {
  canonicalJSON,
  plain,
  same,
  STATE_TYPES,
  OP_TYPES,
  assertSignature,
  deriveState,
  hashState,
  hashOperation,
  rejectionCheckpoint,
  operation,
  outcome,
  matchId,
  matchPayouts,
  matchPot,
  validateMatch,
  verifyShareStatement,
  sharesFor,
  valueOf,
  hashRedeem,
  FUND_ID,
  FUND_TYPES,
  REDEEM_TYPES,
  RESOLUTION_TYPES,
  verifyStep,
  checkpointEvidence,
} from '../protocol/protocol.ts';
import { describeBet } from '../protocol/risk.ts';
import { generateHashChain } from '../protocol/hash-chain.ts';
import { gameAmount } from './game-account.ts';
import { WalletTransactions } from './wallet-transactions.ts';
const random = () => hexlify(randomBytes(32));
/** Receipt suffix for a bet withdrawn because its remembered round head had passed. */
const STALE = ':stale-head';
const isOwnRound = (c: { round?: { roundHead: string } }, op: Operation) =>
  Boolean(c.round) && same(c.round!.roundHead, op.roundHead);
const noteEpoch = (c: { epochs?: Record<string, number> }, { owner, epoch }: { owner: string; epoch: number }) => {
  if ((c.epochs?.[owner] ?? 0) < epoch) c.epochs = { ...c.epochs, [owner]: epoch };
};
function hostedRound(round: HostedRound): HostedRound {
  const { owner, epoch, index, roundHead, seed } = round;
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(owner) ||
    ![roundHead, seed].every(value => /^0x[0-9a-fA-F]{64}$/.test(value)) ||
    [roundHead, seed].some(value => same(value, ZeroHash)) ||
    ![epoch, index].every(value => Number.isSafeInteger(value) && value >= 0)
  )
    throw new Error('Invalid round');
  return { owner: owner.toLowerCase(), epoch, index, roundHead, seed };
}
/** Where a casino says a pot bet settled, or would have. Unsigned and optional: a malformed one is
 * ignored, never an obstacle to accepting the signed result it came with. */
function reportedRound(round: any) {
  try {
    const { owner, epoch, index } = hostedRound({
      ...round,
      roundHead: '0x' + '1'.repeat(64),
      seed: '0x' + '1'.repeat(64),
    });
    return { owner, epoch, index };
  } catch {
    return null;
  }
}

/** A round on someone else's chain: its owner, the address of the table's host, announces the head
 * and seed, collects every player's signed bet and submits them together, so all share one outcome. */
export interface HostedRound {
  owner: string;
  epoch: number;
  index: number;
  roundHead: string;
  seed: string;
}
/** The stake is paid to enter; every prize whose range holds the round's outcome pays. */
export interface BetInput {
  stake: Integer;
  prizes: Prize[];
  round?: HostedRound;
}

/** The off-chain channel protocol: exact signed requests, verified results, rejections,
 * rounds, transfers and recovery of lost replies. */
export class ChannelClient extends WalletTransactions {
  async balance(this: CasinoWallet) {
    return BigInt(this.current?.state.balance || 0);
  }
  /** The signed balance minus what this tab's open game may still risk; never below zero. */
  availableBalance(this: CasinoWallet) {
    const available = BigInt(this.current?.state.balance || 0) - BigInt(this.game?.balance || 0);
    return available < 0n ? 0n : available;
  }
  async freeBankroll(this: CasinoWallet) {
    return BigInt(this.reportedBankroll);
  }
  updateBankroll(this: CasinoWallet, value: unknown) {
    // An informational hint must never prevent accepting valid settlement evidence.
    try {
      this.reportedBankroll = String(gameAmount(value, false));
    } catch {}
  }
  async executeBet(
    this: CasinoWallet,
    input: BetInput,
    developer: string,
    operationId: string = crypto.randomUUID(),
    game?: GameIntent,
  ) {
    return this.perform('bet', input, getAddress(developer), operationId, game);
  }
  async payBankroll(
    this: CasinoWallet,
    amount: Integer,
    operationId: string = crypto.randomUUID(),
    game: GameIntent | undefined = undefined,
    developer: string | null = null,
  ) {
    return this.perform('payment', { amount }, developer, operationId, game);
  }
  async transfer(
    this: CasinoWallet,
    amount: Integer,
    recipient: string,
    operationId: string = crypto.randomUUID(),
    game?: GameIntent,
    developer: string | null = null,
  ) {
    return this.perform(
      'transfer',
      { amount: gameAmount(String(BigInt(amount))), recipient: getAddress(recipient) },
      developer,
      operationId,
      game,
    );
  }
  /** Accept one incoming transfer only when this channel has no signed operation.
   * The caller may repeat this while serving payouts; the browser polls it too. */
  async receiveTransfers(this: CasinoWallet, { gamePayoutsOnly = false } = {}) {
    if (this.busy || !this.current?.key || this.current.closing || Number(this.current.onchain?.status) !== 1)
      return null;
    const storageKey = this.storageKey,
      channelId = this.currentId;
    const current = () => this.storageKey === storageKey && this.currentId === channelId;
    if (this.pending) {
      if (!['transfer', 'receive'].includes(this.pending.kind)) return null;
      return this.exclusive(() => {
        if (!current() || !this.pending || !['transfer', 'receive'].includes(this.pending.kind)) return null;
        this.ready();
        return this.resume();
      });
    }
    const allowed = (offer: any) =>
      !gamePayoutsOnly || (this.game !== null && same(this.game.identity.developer, offer.opening?.player));
    // Inbox reads are optional: do not hold the action lock or block foreground
    // play when there is no payment to accept. Recheck identity and authority
    // after the read and again after loading the durable wallet under its lock.
    const offers = await this.api(`/api/channels/${channelId}/transfers`);
    if (!current() || this.busy || this.pending) return null;
    if (!Array.isArray(offers) || offers.length > 256) throw new Error('Invalid transfer inbox');
    const offer = offers.find(allowed);
    if (!offer) return null;
    return this.exclusive(async () => {
      if (!current() || this.pending || !allowed(offer)) return null;
      this.ready();
      const { request: source, signature, opening } = offer;
      await this.verifyRegisteredOpening(opening);
      assertSignature(this.domain, OP_TYPES, source, signature, opening.signer);
      if (
        Number(source.kind) !== 4 ||
        !same(source.channelId, opening.channelId) ||
        !same(source.counterparty, this.currentId) ||
        same(source.channelId, this.currentId)
      )
        throw new Error('Invalid incoming transfer');
      const digest = hashOperation(this.domain, source);
      const request = operation(this.domain, this.current.state, {
        kind: 5,
        amount: source.amount,
        counterparty: source.channelId,
        operationId: digest,
      });
      // Validate all arithmetic before persisting a new authorization.
      deriveState(this.domain, this.current.state, request);
      this.pending = { kind: 'receive', operationId: 'receive:' + digest, request, signature: null, developer: null };
      await this.save();
      return this.resume();
    });
  }
  async perform(
    this: CasinoWallet,
    kind: string,
    input: any,
    developer: string | null,
    operationId: string,
    game?: GameIntent,
  ) {
    this.requireDurableState();
    const intent = {
      // A stake is a transfer into a match and a payout the credit out of it.
      // An investment is a transfer into the bankroll fund, and redeemed money the credit out of it.
      kind:
        ({ bet: 1, payment: 2, transfer: 4, stake: 4, invest: 4, payout: 5, divest: 5 } as Record<string, number>)[
          kind
        ] || 0,
      amount: BigInt(kind === 'bet' || kind === 'stake' ? input.stake : input.amount),
      prizes:
        kind === 'bet'
          ? (input.prizes as Prize[]).map(prize => ({
              rangeStart: BigInt(prize.rangeStart),
              rangeEnd: BigInt(prize.rangeEnd),
              payout: BigInt(prize.payout),
            }))
          : [],
      // Only a bet signs its developer; the local attribution of payments stays in the receipt.
      developer: kind === 'bet' ? developer || ZeroAddress : ZeroAddress,
    };
    if (!intent.kind) throw new Error('Unknown wallet operation');
    const matches = (operation: Operation) => {
      if (
        (['kind', 'amount'] as const).some(key => BigInt(operation[key]) !== BigInt(intent[key])) ||
        canonicalJSON(plain(operation.prizes)) !== canonicalJSON(plain(intent.prizes)) ||
        !same(operation.developer, intent.developer) ||
        (input.matchId && !same(operation.counterparty, input.matchId)) ||
        (input.round && (!same(operation.roundHead, input.round.roundHead) || !same(operation.seed, input.round.seed)))
      )
        throw new Error('Operation ID is bound to a different intent (terms or developer)');
    };
    const cached = await this.getReceipt(operationId);
    this.requireDurableState();
    if (cached) {
      matches(cached.request || cached.proof.step.operation);
      if (kind === 'transfer' && !same(cached.recipient, input.recipient))
        throw new Error('Operation ID is bound to a different recipient');
      if (game && (cached.game?.key !== game.key || cached.game?.id !== game.id))
        throw new Error('Operation ID is bound to a different game');
      return cached;
    }
    const sign = async () => {
      // A payout is a credit: it spends nothing.
      const debit = kind === 'payout' || kind === 'divest' ? 0n : intent.amount;
      if (game) {
        if (this.game?.key !== game.key) throw new Error('The game is no longer open');
        if (debit > BigInt(this.game.balance)) throw new Error('Bet exceeds the game balance');
      } else if (debit > this.availableBalance()) throw new Error('Debit exceeds unallocated wallet balance');
      // A match stake or payout names its match, as a transfer names the other channel.
      let counterparty = input.matchId ?? ZeroHash;
      if (kind === 'transfer') {
        const opening = await this.api(`/api/channels/${this.currentId}/recipient`, { player: input.recipient });
        await this.verifyRegisteredOpening(opening);
        if (!same(opening.player, input.recipient)) throw new Error('Transfer recipient differs');
        counterparty = opening.channelId;
        if (same(counterparty, this.currentId)) throw new Error('Recipient needs a different open channel');
      }
      if (kind === 'bet')
        try {
          describeBet({ stake: intent.amount, prizes: intent.prizes });
        } catch {
          throw new Error('Invalid wager terms');
        }
      // The round head is fixed before this wallet draws its seed, so only one preimage can settle
      // the bet. A hosted round's owner supplies both; its seed is the owner's, not this wallet's.
      const round: HostedRound | null =
        kind !== 'bet' ? null : input.round ? hostedRound(input.round) : await this.ownRound();
      if (round) noteEpoch(this.current!, round);
      const request = operation(this.domain, this.current!.state, {
        kind: intent.kind,
        counterparty,
        amount: intent.amount,
        prizes: intent.prizes,
        // Every seat of a match whose pot is a bet draws its own seed, after the terms fixed the round head.
        seed: round?.seed ?? (kind === 'stake' && input.terms.prizes.length ? random() : ZeroHash),
        roundHead: round?.roundHead ?? ZeroHash,
        // A bet signed again after its remembered round head proved stale needs a new signed ID.
        operationId: id((await this.getReceipt(operationId + STALE)) ? operationId + ':fresh-head' : operationId),
        developer: intent.developer,
      });
      this.pending = {
        ...(game ? { game } : {}),
        ...(round ? { round: { owner: round.owner, epoch: round.epoch, index: round.index } } : {}),
        // A hosted bet and a match stake are handed to someone else to submit, not sent by this wallet.
        ...(input.round || kind === 'stake' ? { hosted: true } : {}),
        ...(input.matchId ? { match: { id: input.matchId, terms: input.terms, seat: input.seat } } : {}),
        kind,
        operationId,
        request,
        developer,
        ...(kind === 'transfer' ? { recipient: input.recipient } : {}),
        signature: null,
      };
      await this.save();
    };
    return this.exclusive(async () => {
      this.ready();
      for (let retried = false; ; retried = true) {
        if (!this.pending) await sign();
        else {
          if (this.pending.operationId !== operationId) throw new Error('Recover the previous operation');
          matches(this.pending.request);
          if (kind === 'transfer' && !same(this.pending.recipient, input.recipient))
            throw new Error('Pending transfer has a different recipient');
          if (game && canonicalJSON(this.pending.game) !== canonicalJSON(game))
            throw new Error('Pending game request differs');
        }
        try {
          return await this.resume();
        } catch (error: any) {
          // The head this wallet remembered for its own next round has passed (a restored backup, a
          // channel that also hosts, a casino that lost the chain). The signed bet is withdrawn with a
          // verified rejection, kept under its own receipt, and the same bet is signed once more.
          if (retried || kind !== 'bet' || this.pending?.hosted || error.message !== 'Round head is not current')
            throw error;
          const withdrawn = await this.withdrawPending(operationId + STALE);
          if (withdrawn.status !== 'rejected') return withdrawn;
        }
      }
    });
  }
  async getReceipt(this: CasinoWallet, operationId: string) {
    return this.storage.get(this.storageKey + ':receipt:' + operationId);
  }
  async resume(this: CasinoWallet) {
    const pending = this.pending,
      c = this.current!;
    if (!pending?.request) throw new Error('No signed operation to recover');
    if (!pending.signature) {
      pending.signature = await this.channelSigner().signTypedData(this.domain, OP_TYPES, pending.request);
      await this.save();
    }
    const acknowledgment =
      c.playerSignature && c.playerSignature !== '0x'
        ? {
            stateHash: hashState(this.domain, c.state),
            signature: c.playerSignature,
          }
        : undefined;
    const entry = { request: pending.request, signature: pending.signature, acknowledgment };
    // Only its owner can settle a hosted round. Hand the signed bet over, then look for the result.
    if (pending.hosted) {
      const found = await this.api(
        `/api/channels/${c.state.channelId}/operations/${pending.request.operationId}`,
      ).catch(error => {
        if (error.message !== 'Operation has no recorded result') throw error;
      });
      if (!found) return { status: 'pending', verified: false, operationId: pending.operationId, entry: plain(entry) };
      return this.accept(found, pending.operationId, pending.kind, pending.developer);
    }
    this.onProgress('Confirming the signed result…');
    const response = await this.api(`/api/channels/${c.state.channelId}/operations`, entry);
    if (response.status === 'pending' && pending.kind === 'transfer')
      return { status: 'pending', verified: false, operationId: pending.operationId };
    return this.accept(response, pending.operationId, pending.kind, pending.developer);
  }
  async accept(this: CasinoWallet, response: any, operationId: string, kind: string, developer: string | null) {
    const c = structuredClone(this.current!),
      rejected = response.status === 'rejected',
      step = response.evidence.step,
      op = rejected ? response.request : step.operation;
    if (
      this.pending?.request &&
      !same(hashOperation(this.domain, op), hashOperation(this.domain, this.pending.request))
    )
      throw new Error('Casino returned a different operation');
    if (!rejected && !same(hashState(this.domain, response.evidence.base), hashState(this.domain, c.state)))
      throw new Error('Response does not follow the saved checkpoint');
    if (
      Number(op.kind) === 1 &&
      (!developer || !same(op.developer, developer) || (!rejected && !same(response.developer, developer)))
    )
      throw new Error('Developer attribution differs from the selected game');
    let next: Checkpoint;
    if (rejected) {
      // The casino declined the saved operation with a signed unchanged-balance checkpoint above
      // it. The wallet countersigns only now, so the casino never holds a player-signed
      // checkpoint that could supersede a completed result.
      if (!c.pending?.request || !['bet', 'transfer', 'stake', 'invest'].includes(kind))
        throw new Error('Unexpected rejection');
      next = rejectionCheckpoint(this.domain, c.state, c.pending.request);
      assertSignature(this.domain, STATE_TYPES, next, response.casinoSignature, this.operator);
    } else next = verifyStep(this.domain, c.state, step, new Wallet(c.key!).address, this.operator);
    if (!same(hashState(this.domain, next), hashState(this.domain, response.state)))
      throw new Error('Result state differs from evidence');
    const game = c.pending?.game as GameIntent | undefined;
    // The open game's limit follows its verified result. A result recovered after a reload, or
    // for a game since closed, changes only the channel balance: the limit was already released.
    if (game && this.game?.key === game.key) {
      const limit = BigInt(this.game.balance) + BigInt(next.balance) - BigInt(c.state.balance);
      this.game.balance = String(limit < 0n ? 0n : limit);
    }
    // This channel's own settled bet revealed the head of its next round; anything else about its
    // chain (a rejection, a hosted bet, the last position of an epoch) is asked of the casino again.
    if (Number(op.kind) === 1) {
      const own = isOwnRound(c, op) && !rejected && c.round!.index + 1 < c.round!.length;
      c.round = own ? { ...c.round!, index: c.round!.index + 1, roundHead: step.preimage } : undefined;
    }
    c.state = next;
    c.casinoSignature = rejected ? response.casinoSignature : step.casinoSignature;
    c.playerSignature = await this.channelSigner().signTypedData(this.domain, STATE_TYPES, next);
    c.lastResponse = rejected
      ? { ...response, evidence: checkpointEvidence(next, c.playerSignature, c.casinoSignature) }
      : { ...response, evidence: { ...response.evidence, step } };
    const isBet = !rejected && Number(op.kind) === 1,
      settled = isBet ? outcome(step.operation, step.preimage) : null,
      // What the player signed, exactly: the most the bet could pay and its return out of 2^64 stakes.
      table =
        Number(op.kind) === 1
          ? describeBet({
              stake: BigInt(op.amount),
              prizes: (op.prizes as Prize[]).map(prize => ({
                rangeStart: BigInt(prize.rangeStart),
                rangeEnd: BigInt(prize.rangeEnd),
                payout: BigInt(prize.payout),
              })),
            })
          : null;
    let commission: string | undefined;
    try {
      commission = String(gameAmount(String(rejected ? 0 : response.commission), false));
    } catch {
      /* Invalid optional accounting cannot discard signed settlement or break receipt display. */
    }
    // A pot bet the casino declined names the round it would have settled on and every seat's seed.
    // With this wallet's own seed among them, the refusal can be audited once that chain is retired.
    const declined = rejected && c.pending?.match && response.match,
      where = declined && reportedRound(declined.round),
      refused =
        where &&
        Array.isArray(declined.seeds) &&
        same(declined.seeds[c.pending!.match.seat], op.seed) &&
        !same(op.seed, ZeroHash)
          ? { terms: c.pending!.match.terms, seeds: declined.seeds, round: where }
          : null;
    if (refused) noteEpoch(c, refused.round);
    // An investment comes back with the casino's signed statement of the holding it bought.
    const invested = kind === 'invest' && !rejected ? this.adoptStatement(response.statement, op) : null;
    const receipt = plain({
      kind,
      operationId,
      ...(game ? { game: { key: game.key, id: game.id } } : {}),
      status: rejected ? 'rejected' : 'signed',
      ...(rejected ? { request: op, reason: response.reason } : {}),
      verified: true,
      proof: c.lastResponse!.evidence,
      // The round's 64-bit outcome, and what the prizes holding it paid in total.
      outcome: settled?.value,
      payout: settled?.payout,
      randomHash: settled?.randomHash,
      stake: op.amount,
      ...(table ? { maxPayout: table.maxPayout, expectedPayout: table.expectedPayout } : {}),
      amount: rejected ? '0' : op.amount,
      counterparty: op.counterparty,
      ...(c.pending?.recipient ? { recipient: c.pending.recipient } : {}),
      ...(c.pending?.round ? { round: c.pending.round } : {}),
      // The seed of a hosted round was the host's, not this wallet's.
      ...(c.pending?.hosted && kind === 'bet' ? { hosted: true } : {}),
      ...(c.pending?.match ? { matchId: c.pending.match.id } : {}),
      ...(refused ? { refused } : {}),
      ...(invested ? { shares: invested.minted, holding: invested.fund.shares } : {}),
      developer,
      commission,
      balance: next.balance,
      createdAt: new Date().toISOString(),
    });
    // An entered match is a financial record: the casino holds this stake until the oracle these
    // terms name decides. It travels in backups, and a collected payout is checked against it.
    const match = c.pending?.match;
    if (match && !rejected && (kind === 'stake' || c.matches?.[match.id]))
      c.matches = {
        ...c.matches,
        [match.id]:
          kind === 'stake'
            ? { terms: match.terms, seat: match.seat, seed: op.seed, ...(game ? { game } : {}) }
            : { ...c.matches![match.id], collected: String(op.amount) },
      };
    c.pending = null;
    await this.save(receipt, {
      channels: { ...this.channels, [c.state.channelId]: c },
      ...(invested ? { fund: invested.fund } : {}),
    });
    this.updateBankroll(response.bankroll);
    void this.api(`/api/channels/${c.state.channelId}/ack`, {
      stateHash: hashState(this.domain, next),
      signature: c.playerSignature,
    }).catch(() => {});
    return receipt;
  }
  /** Withdraw an offer the recipient has not accepted, or a hosted bet its owner has not settled.
   * The casino signs the rejection checkpoint above it and the wallet countersigns it, so the
   * channel moves on. A bet the owner settled first returns its recorded result instead. */
  async cancelPending(this: CasinoWallet) {
    return this.exclusive(async () => {
      this.ready();
      if (this.pending?.kind !== 'transfer' && !this.pending?.hosted)
        throw new Error('No cancellable operation is pending');
      return this.withdrawPending();
    });
  }
  /** Ask the casino to decline the pending bet, stake or transfer offer. */
  async withdrawPending(this: CasinoWallet, receiptId?: string) {
    const pending = this.pending,
      c = this.current!;
    // The operation travels with its signature: the casino may never have seen it.
    if (!pending.signature) {
      pending.signature = await this.channelSigner().signTypedData(this.domain, OP_TYPES, pending.request);
      await this.save();
    }
    const response = await this.api(`/api/channels/${this.currentId}/cancel`, {
      request: pending.request,
      signature: pending.signature,
      acknowledgment:
        c.playerSignature && c.playerSignature !== '0x'
          ? { stateHash: hashState(this.domain, c.state), signature: c.playerSignature }
          : undefined,
    });
    // A bet settled before the withdrawal arrived is simply that bet's result.
    const id = receiptId && response.status === 'rejected' ? receiptId : pending.operationId;
    return this.accept(response, id, pending.kind, pending.developer);
  }
  /** Enter a match: stake against the other seats, with the casino holding every stake until the
   * oracle named in the terms decides. The signed stake is returned for the game's host to submit
   * with the others; asking again looks for the result, and the stake can be withdrawn until then. */
  async stakeMatch(this: CasinoWallet, terms: MatchTerms, operationId: string, game?: GameIntent) {
    validateMatch(terms);
    const seat = terms.seats.findIndex(s => same(s.channelId, this.currentId));
    if (seat < 0) throw new Error('This wallet holds no seat in the match');
    if (BigInt(terms.expiresAt) * 1000n <= BigInt(Date.now())) throw new Error('Match has already expired');
    const id = matchId(this.domain, terms);
    const receipt = await this.perform(
      'stake',
      { stake: terms.seats[seat].stake, matchId: id, terms: plain(terms), seat },
      null,
      operationId,
      game,
    );
    if (receipt.status !== 'signed') return receipt;
    // The pot is settled the moment the match opens. A pot the wallet cannot verify is recorded as
    // an alert on the match; the signed stake stands either way.
    const status = await this.api(`/api/matches/${id}`).catch(() => null);
    if (status) await this.noteMatch(id, this.checkedPot(this.current!.matches![id], status));
    const { stakes, pot, potOutcome } = this.matchStatus(id);
    if (receipt.pot !== undefined || pot === null) return receipt;
    // The receipt says what the match plays for, once the wallet has verified it.
    const played = { ...receipt, stakes, pot, ...(potOutcome ? { potOutcome } : {}) };
    await this.exclusive(() => this.save(played), { wait: true });
    return played;
  }
  /** The pot of an entered match, believed only as far as it can be recomputed: the stakes, or the
   * signed prizes applied to the preimage of the signed round head and every seat's seed, this
   * wallet's own among them. */
  verifyMatchPot(
    this: CasinoWallet,
    terms: MatchTerms,
    seat: number,
    seed: string | undefined,
    status: { pot: Integer; seeds: string[]; preimage: string },
  ) {
    const settled = matchPot(terms, status.seeds, status.preimage);
    if (seed && !same(status.seeds[seat], seed))
      throw new Error('The pot was settled without the seed this wallet signed');
    if (BigInt(settled.pot) !== BigInt(status.pot))
      throw new Error(`The casino reports a pot of ${status.pot} wei where the match won ${settled.pot}`);
    return settled;
  }
  checkedPot(this: CasinoWallet, match: any, status: any): Record<string, unknown> {
    try {
      const { pot, potOutcome } = this.verifyMatchPot(match.terms, match.seat, match.seed, status);
      const round = potOutcome && reportedRound(status.round);
      return { pot, ...(potOutcome ? { potOutcome } : {}), ...(round ? { round } : {}) };
    } catch (error: any) {
      return { alert: error.message };
    }
  }
  /** What the wallet knows of a match it entered. */
  matchStatus(this: CasinoWallet, id: string): Record<string, any> {
    const match = this.current?.matches?.[id.toLowerCase()];
    if (!match) return { matchId: id, status: 'unknown' };
    const payout =
      match.outcome === undefined || match.pot === undefined
        ? null
        : String(matchPayouts(match.terms, match.pot, match.outcome)[match.seat]);
    return {
      matchId: id,
      status: match.outcome === undefined ? 'open' : match.status,
      stakes: String(validateMatch(match.terms).stakes),
      pot: match.pot ?? null,
      potOutcome: match.potOutcome ?? null,
      outcome: match.outcome ?? null,
      payout,
      collected: payout !== null && (payout === '0' || match.collected === payout),
      ...(match.alert ? { alert: match.alert } : {}),
    };
  }
  /** A settled match is only believed with the signature of the oracle its terms named, or, for a
   * void nobody signed, once its deadline has passed. */
  verifyMatchOutcome(this: CasinoWallet, terms: MatchTerms, pot: Integer, outcome: Integer, signature?: string | null) {
    const id = matchId(this.domain, terms),
      payouts = matchPayouts(terms, pot, outcome);
    if (signature)
      assertSignature(
        this.domain,
        RESOLUTION_TYPES,
        { matchId: id, outcome: String(outcome) },
        signature,
        terms.oracle,
      );
    else if (
      BigInt(outcome) !== BigInt(validateMatch(terms).outcomes) ||
      BigInt(terms.expiresAt) * 1000n > BigInt(Date.now())
    )
      throw new Error('Match outcome is not signed by its oracle');
    return payouts;
  }
  // --- The bankroll fund -------------------------------------------------------------------

  /** Invest in the casino's bankroll: a transfer from this channel that buys shares at the going
   * price. The money becomes the casino's to bet with. A share is the casino's promise of a part of
   * the bankroll, not protected principal: the wallet can prove what it holds, never what it is worth. */
  async invest(this: CasinoWallet, amount: Integer, operationId: string = crypto.randomUUID()) {
    return this.perform('invest', { amount, matchId: FUND_ID }, null, operationId);
  }
  /** The statement for an investment this wallet just made. It is believed as far as it can be
   * checked: the casino's signature, this exact transfer, and the shares its stated price implies.
   * The checkpoint it came with is already signed and stands either way, so a statement that fails
   * is kept out and shown as an alert instead. */
  adoptStatement(this: CasinoWallet, statement: any, op: Operation) {
    const holder = this.current!.opening.player,
      cause = hashOperation(this.domain, op);
    try {
      const follows = Number(statement?.message?.sequence) === this.fund.sequence + 1,
        minted = verifyShareStatement(this.domain, statement, this.operator, {
          holder,
          cause,
          amount: op.amount,
          // A wallet restored from an older backup has missed statements: the casino's newer signed
          // one is taken as it stands, unless it leaves fewer shares than this wallet can prove.
          previous: follows
            ? this.fund
            : {
                sequence: Number(statement.message.sequence) - 1,
                shares:
                  BigInt(statement.message.shares) -
                  sharesFor(statement.message.amount, statement.message.equity, statement.message.totalShares),
              },
        });
      if (!follows && BigInt(statement.message.shares) - minted < BigInt(this.fund.shares))
        throw new Error('The casino states fewer shares than its earlier signed statement');
      const { alert, ...fund } = this.fund;
      return {
        minted: String(minted),
        fund: {
          ...fund,
          sequence: Number(statement.message.sequence),
          shares: String(statement.message.shares),
          statement,
        },
      };
    } catch (error: any) {
      return { minted: '0', fund: { ...this.fund, alert: `Investment ${op.operationId}: ${error.message}` } };
    }
  }
  /** The fund as the casino states it, signed, with what this account's shares come to at that price. */
  async fundStatus(this: CasinoWallet) {
    const { message, signature } = await this.api('/api/fund');
    assertSignature(this.domain, FUND_TYPES, message, signature, this.operator);
    return {
      ...message,
      shares: this.fund.shares,
      value: String(
        BigInt(this.fund.shares) > BigInt(message.totalShares)
          ? 0n
          : valueOf(this.fund.shares, message.equity, message.totalShares),
      ),
      owed: this.fund.owed || [],
      alert: this.fund.alert ?? null,
    };
  }
  /** Turn shares back into money. The signed request is saved before it is sent, so a lost reply is
   * asked for again; the casino's statement says what the shares fetched, and that money is then
   * collected into the open channel like a match payout. */
  async redeem(this: CasinoWallet, shares: Integer) {
    return this.exclusive(async () => {
      this.ready();
      if (!this.fund.redeeming) {
        if (BigInt(shares) <= 0n || BigInt(shares) > BigInt(this.fund.shares))
          throw new Error('Not that many shares to redeem');
        const message = {
          holder: this.current!.opening.player,
          shares: String(BigInt(shares)),
          sequence: String(this.fund.sequence + 1),
        };
        this.fund = {
          ...this.fund,
          redeeming: {
            message,
            signature: await this.channelSigner().signTypedData(this.domain, REDEEM_TYPES, message),
          },
        };
        await this.save();
      }
      const request = this.fund.redeeming!;
      let statement;
      try {
        ({ statement } = await this.api(`/api/channels/${this.currentId}/fund/redeem`, request));
      } catch (error: any) {
        // A considered refusal leaves nothing pending; a lost reply is asked for again with the same request.
        if (error.status === 409) {
          this.fund = { ...this.fund, redeeming: null };
          await this.save();
        }
        throw error;
      }
      verifyShareStatement(this.domain, statement, this.operator, {
        holder: request.message.holder,
        previous: this.fund,
        cause: hashRedeem(this.domain, request.message),
        burned: request.message.shares,
      });
      const { alert, ...fund } = this.fund,
        receipt = plain({
          kind: 'redeem',
          operationId: `redeem:${statement.message.sequence}`,
          status: 'signed',
          verified: true,
          shares: request.message.shares,
          holding: statement.message.shares,
          amount: statement.message.amount,
          statement,
          balance: this.current!.state.balance,
          createdAt: new Date().toISOString(),
        });
      await this.save(receipt, {
        fund: {
          ...fund,
          sequence: Number(statement.message.sequence),
          shares: String(statement.message.shares),
          statement,
          redeeming: null,
          owed: [...(fund.owed || []), String(statement.message.amount)],
        },
      });
      return receipt;
    });
  }

  /** Learn how entered matches ended, and collect what they owe: each payout is a credit this
   * wallet signs only after checking it against the terms it staked on and the oracle's signature. */
  async collectMatchPayouts(this: CasinoWallet) {
    if (
      this.busy ||
      this.pending ||
      !this.current?.key ||
      this.current.closing ||
      Number(this.current.onchain?.status) !== 1
    )
      return [];
    const channelId = this.currentId,
      collected: any[] = [];
    // Matches this wallet lost owe it nothing, so it asks how they ended: at most every half minute
    // per match, since a match may stay open for days. A payout owed is found below without this.
    const asked = (this.matchesAsked ??= new Map<string, number>());
    for (const [id, match] of Object.entries<any>(this.current.matches || {})
      .filter(([id, m]) => m.outcome === undefined && Date.now() - (asked.get(id) ?? 0) >= 30000)
      .slice(0, 5)) {
      asked.set(id, Date.now());
      const status = await this.api(`/api/matches/${id}`).catch(() => null);
      if (!status || status.status === 'open' || this.currentId !== channelId) continue;
      try {
        const { pot } = this.verifyMatchPot(match.terms, match.seat, match.seed, status);
        this.verifyMatchOutcome(match.terms, pot, status.outcome, status.signature);
        await this.noteMatch(id, {
          pot,
          outcome: String(status.outcome),
          status: status.status,
          signature: status.signature,
        });
      } catch (error: any) {
        await this.noteMatch(id, { alert: error.message });
      }
    }
    const due = await this.api(`/api/channels/${channelId}/payouts`);
    if (!Array.isArray(due) || due.length > 256) throw new Error('Invalid payout list');
    for (const payout of due) {
      if (this.currentId !== channelId || this.busy || this.pending) break;
      if (same(payout.matchId, FUND_ID)) {
        // Redeemed shares: the wallet signs only for an amount one of its own statements priced.
        const owed = this.fund.owed || [],
          at = owed.indexOf(String(payout.amount));
        if (at < 0) continue;
        collected.push(
          await this.perform('divest', { amount: payout.amount, matchId: FUND_ID }, null, `divest:${payout.seat}`),
        );
        await this.exclusive(() => this.save(undefined, { fund: { ...this.fund, owed: owed.toSpliced(at, 1) } }), {
          wait: true,
        });
        continue;
      }
      const id = matchId(this.domain, payout.terms);
      try {
        const seat = payout.terms.seats[payout.seat];
        if (!same(id, payout.matchId) || !seat || !this.channels[String(seat.channelId).toLowerCase()])
          throw new Error('Payout is for a match this wallet did not enter');
        // The seed this wallet signed is remembered by the channel that staked, which may since have closed.
        const staked = this.channels[String(seat.channelId).toLowerCase()].matches?.[id],
          { pot } = this.verifyMatchPot(payout.terms, payout.seat, staked?.seed, payout);
        const owed = this.verifyMatchOutcome(payout.terms, pot, payout.outcome, payout.signature)[payout.seat];
        if (owed !== BigInt(payout.amount))
          throw new Error(`The casino offers ${payout.amount} wei where the match owes ${owed}`);
      } catch (error: any) {
        // Underpayment or a forged outcome is recorded for the player; the wallet signs nothing for it.
        await this.noteMatch(id, { alert: error.message });
        continue;
      }
      const saved = this.current.matches?.[id];
      collected.push(
        await this.perform(
          'payout',
          { amount: payout.amount, matchId: id },
          null,
          `payout:${id}:${payout.seat}`,
          saved?.game && this.game?.key === saved.game.key ? saved.game : undefined,
        ),
      );
      await this.noteMatch(id, {
        pot: String(payout.pot),
        outcome: String(payout.outcome),
        status: payout.signature ? 'resolved' : 'void',
        signature: payout.signature,
      });
    }
    return collected;
  }
  async noteMatch(this: CasinoWallet, id: string, values: Record<string, unknown>) {
    await this.exclusive(
      async () => {
        const c = this.current;
        if (!c?.matches?.[id]) return;
        // A later epoch of a host's chain, seen here, is what lets a refusal on an earlier one be audited.
        if (values.round) noteEpoch(c, values.round as { owner: string; epoch: number });
        if (
          values.outcome !== undefined &&
          BigInt(values.outcome as string) === BigInt(validateMatch(c.matches[id].terms).outcomes)
        )
          values.status = 'void';
        c.matches = { ...c.matches, [id]: { ...c.matches[id], ...values } };
        await this.save();
      },
      { wait: true },
    );
  }
  /** The head of this channel's next round. It needs no signature: the wallet draws its seed only
   * after knowing it, and only the head's one preimage can settle a bet that names it. Each settled
   * bet reveals the next head, so an ordinary bet stays a single request. A channel that hosts
   * rounds asks afresh: the bets it settles for others move its chain without passing through here. */
  async ownRound(this: CasinoWallet, fresh = false) {
    const c = this.current!;
    if (fresh || !c.round) {
      // The chain belongs to this channel's key, the same key that signs its bets.
      const self = this.channelSigner().address.toLowerCase(),
        { owner, epoch, index, length, roundHead } = await this.api(`/api/chains/${self}/round`, {});
      if (!same(owner, self) || !Number.isSafeInteger(length) || index >= length)
        throw new Error('Casino returned an invalid round');
      hostedRound({ owner, epoch, index, roundHead, seed: roundHead });
      c.round = { owner, epoch, index, length, roundHead };
      noteEpoch(c, c.round);
    }
    return hostedRound({ ...c.round, seed: random() });
  }
  /** Rejected wagers become verifiable once their chain epoch is retired: the casino
   * publishes the seed, and the wallet records what each declined bet would have paid. */
  async auditRejections(this: CasinoWallet) {
    const c = this.current;
    if (!c?.key || this.recoveryOnly) return [];
    const chains = new Map<string, readonly string[] | null>();
    const audited: any[] = [];
    for (const receipt of this.history) {
      // A declined bet, or a declined match whose pot was a bet.
      const refused = receipt.kind === 'stake' ? receipt.refused : null;
      if (receipt.status !== 'rejected' || receipt.wouldHavePaid !== undefined) continue;
      if (receipt.kind !== 'bet' && !refused) continue;
      const round = refused?.round ?? receipt.round;
      if (!round || !same(receipt.request?.channelId, c.state.channelId)) continue;
      // Nothing is asked of the casino until this wallet has seen the owner on a later epoch.
      if ((c.epochs?.[round.owner] ?? 0) <= round.epoch) continue;
      const key = `${round.owner}/${round.epoch}`;
      if (!chains.has(key)) {
        const chain = await this.api(`/api/chains/${key}`).catch(() => null);
        if (chain && (!Number.isSafeInteger(chain.length) || chain.length > 1000000))
          throw new Error('Invalid retired chain');
        chains.set(key, chain ? generateHashChain(chain.seed, chain.length).preimages : null);
      }
      const preimages = chains.get(key);
      if (!preimages) continue;
      const preimage = preimages[Number(round.index)];
      if (!preimage || !same(keccak256(preimage), refused?.terms.roundHead ?? receipt.request.roundHead))
        throw new Error('Retired chain does not match the rejected wager');
      // For a match, what it would have paid is the pot it would have been played for.
      audited.push({
        ...receipt,
        wouldHavePaid: refused
          ? matchPot(refused.terms, refused.seeds, preimage).pot
          : String(outcome(receipt.request, preimage).payout),
      });
    }
    if (audited.length)
      await this.exclusive(
        async () => {
          for (const receipt of audited) await this.save(receipt);
        },
        { wait: true },
      );
    return audited;
  }
  async reconcile(this: CasinoWallet) {
    const c = this.current;
    if (!c?.key) return;
    const reply = await this.api(`/api/channels/${c.state.channelId}`);
    if (same(hashState(this.domain, c.state), hashState(this.domain, reply.state))) {
      this.updateBankroll(reply.bankroll);
      return;
    }
    if (!reply.lastResponse) throw new Error('Casino checkpoint differs; import recovery evidence');
    if (!this.pending) throw new Error('Unknown pending operation; use saved recovery evidence');
    await this.accept(reply.lastResponse, this.pending.operationId, this.pending.kind, this.pending.developer);
  }
}
