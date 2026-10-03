import type { Integer, Checkpoint, Operation, Quote } from '../protocol/types.ts';
import type { CasinoWallet, GameIntent } from './wallet.ts';
import { getAddress, hexlify, randomBytes, ZeroAddress, ZeroHash, id } from 'ethers';
import type { Details, PlayerDeveloperBets, PublicDeveloperBet } from '../protocol/types.ts';
import {
  canonicalJSON,
  plain,
  same,
  memo,
  KIND,
  STATE_TYPES,
  OP_TYPES,
  assertSignature,
  hashState,
  hashOperation,
  betTerms,
  checkDetails,
  rejectionCheckpoint,
  operation,
  outcome,
  betPayout,
  seedHash,
  covers,
  verifyQuote,
  verifyEvidence,
  QUOTE_PERIOD,
  verifyShareStatement,
  sharesFor,
  valueOf,
  hashRedeem,
  FUND_ID,
  DEVELOPER_ID,
  FUND_TYPES,
  SHARE_TYPES,
  REDEEM_TYPES,
  SETTLEMENT_TYPES,
  BANK_TYPES,
  BANK_WITHDRAW_TYPES,
  BANK_ID,
  hashBankWithdraw,
  settleStep,
  checkpointEvidence,
  MAX_PAYOUTS,
  validMeta,
} from '../protocol/protocol.ts';
import { describeBet } from '../protocol/risk.ts';
import { gameAmount, gameError, gameRef, META } from './bridge.ts';
import { WalletTransactions, inbound } from './wallet-transactions.ts';
const random = () => hexlify(randomBytes(32));
/** Every operation this wallet signs: the kind it is signed as, what it is called, and whether it is the open game's. A
 * developer bet, a payment, an investment and a bank deposit are debits, a withdrawal names the address it pays, a
 * transfer the account it goes into (a lock-in is one to this account itself), a payout collected is a credit, money
 * deposited into the channel is taken in with a deposit, and the network fee of a deposit is a loan the casino makes. */
export const OPERATIONS: Record<string, { kind: number; name: string; game?: boolean }> = {
  'casino-bet': { kind: KIND.casinoBet, name: 'casino bet', game: true },
  payment: { kind: KIND.debit, name: 'game payment', game: true },
  'developer-bet': { kind: KIND.debit, name: 'developer bet', game: true },
  invest: { kind: KIND.debit, name: 'bankroll investment' },
  bank: { kind: KIND.debit, name: 'bank deposit' },
  withdrawal: { kind: KIND.withdrawal, name: 'withdrawal' },
  transfer: { kind: KIND.transfer, name: 'transfer' },
  'lock-in': { kind: KIND.transfer, name: 'lock-in' },
  divest: { kind: KIND.credit, name: 'bankroll payout' },
  earnings: { kind: KIND.credit, name: 'earnings payout' },
  'developer-bet-payout': { kind: KIND.credit, name: 'developer bet payout' },
  withdrawn: { kind: KIND.credit, name: 'bank withdrawal' },
  'taken-in': { kind: KIND.deposit, name: 'deposit' },
  loan: { kind: KIND.loan, name: 'network fee loan' },
};
/** A payout collected, a deposit taken in or a loan adds to the balance, and commits none of it. */
const credit = (kind: string) => [KIND.credit, KIND.deposit, KIND.loan].includes(OPERATIONS[kind]!.kind as 3);
/** A casino bet: the stake is paid to enter, and the bet pays its prize when the round's outcome is below its chance,
 * counted in outcomes out of 2^64. */
export interface CasinoBetInput {
  stake: Integer;
  chance: Integer;
  prize: Integer;
  group?: string;
}
/** A developer bet: its stake goes to the bank of the game's developer, who settles it on its word. Its meta is the
 * game's own JSON, saying what the bet is. */
export interface DeveloperBetInput {
  stake: Integer;
  meta: Record<string, unknown>;
  group?: string;
}

/** The off-chain channel protocol: exact signed requests, verified results, rejections, rounds, casino bets,
 * developer bets, banks and recovery of lost replies. */
export class ChannelClient extends WalletTransactions {
  async balance(this: CasinoWallet) {
    return BigInt(this.channel?.state.balance || 0);
  }
  /** The most the player may allow the open game: the signed balance less what a pending operation has already
   * committed. A credit collects what is owed and commits nothing. */
  playableBalance(this: CasinoWallet) {
    const pending = this.pending,
      committed = pending?.request && !credit(pending.kind) ? BigInt(pending.request.amount) : 0n,
      free = BigInt(this.channel?.state.balance || 0) - committed;
    return free < 0n ? 0n : free;
  }
  /** The signed balance minus what this tab's open game may still risk of it, and what its groups hold; never below
   * zero. */
  availableBalance(this: CasinoWallet) {
    const allowance = this.game ? BigInt(this.game.allowance) + this.inPlay() : 0n,
      available = BigInt(this.channel?.state.balance || 0) - allowance;
    return available < 0n ? 0n : available;
  }
  /** Whether the pending casino bet was signed on a quote that covered it, and so went with its seed: the casino must
   * settle it, and the wallet countersigns no decline of it, whenever one comes. */
  bound(this: CasinoWallet, channel = this.channel) {
    return Boolean(channel?.pending?.quote);
  }
  /** Whether the pending casino bet's quote still covers it: one the casino does not settle is disputed on-chain, by
   * closing with it, until the quote expires. */
  disputable(this: CasinoWallet, channel = this.channel) {
    const pending = channel?.pending;
    return this.bound(channel) && covers(pending.quote, pending.request, Math.floor(Date.now() / 1000));
  }
  /** Whether the casino proves a declined operation one this account carried out on another channel: the operation
   * the account signed there, under the same game and operation ID. */
  carriedElsewhere(this: CasinoWallet, response: any, pending: any) {
    const carried = response.carried;
    try {
      assertSignature(this.domain, OP_TYPES, carried.operation, carried.authorization, this.address);
      return (
        response.used === true &&
        same(memo(carried.details), carried.operation.memo) &&
        carried.details.id === pending.details.id &&
        same(carried.details.game ?? '', pending.details.game ?? '') &&
        !same(carried.operation.channelId, pending.request.channelId)
      );
    } catch {
      return false;
    }
  }
  /** Take up the casino's quote for the casino bet that follows `c`'s state, or none if it is not one for that state. */
  adoptQuote(this: CasinoWallet, c: { state: Checkpoint; quote?: Quote }, quote: unknown) {
    try {
      c.quote = verifyQuote(this.domain, quote as Quote, c.state, this.operator);
    } catch {
      c.quote = undefined;
    }
  }
  async executeCasinoBet(
    this: CasinoWallet,
    input: CasinoBetInput,
    operationId: string = crypto.randomUUID(),
    game?: GameIntent,
  ) {
    return this.perform('casino-bet', input, operationId, game);
  }
  async payBankroll(
    this: CasinoWallet,
    amount: Integer,
    operationId: string = crypto.randomUUID(),
    game: GameIntent | undefined = undefined,
    group?: string,
  ) {
    return this.perform('payment', { amount, ...(group === undefined ? {} : { group }) }, operationId, game);
  }
  async perform(this: CasinoWallet, kind: string, input: any, operationId: string, game?: GameIntent) {
    this.requireDurableState();
    // A deposit on its way into the balance goes first: nothing else is signed before the casino has signed it.
    if (!inbound(kind) && inbound(this.pending?.kind)) await this.takeDeposits();
    const known = OPERATIONS[kind];
    if (!known) throw new Error('Unknown wallet operation');
    const intent = {
      kind: known.kind,
      amount: BigInt(kind === 'casino-bet' ? input.stake : input.amount),
      recipient: input.recipient ? getAddress(input.recipient) : ZeroAddress,
      fee: BigInt(input.fee ?? 0),
      chance: kind === 'casino-bet' ? BigInt(input.chance) : 0n,
      prize: kind === 'casino-bet' ? BigInt(input.prize) : 0n,
    };
    // What the operation means, signed as its memo. A casino bet, a developer bet and a payment are always the open
    // game's, so which game that is has one source of truth: the session this wallet has open; the game may give
    // them a group. An investment, a bank deposit and a payout name what they pay into or collect from.
    const details: Details = plain({
      // A loan is known by the hash of the deposit transaction whose network fee it lends: one loan for each.
      id: kind === 'loan' ? input.transaction : id(operationId),
      ...(known.game ? { game: gameRef(this.requireGame().identity) } : {}),
      ...(input.group ? { group: input.group } : {}),
      ...(input.source ? { counterparty: input.source.toLowerCase() } : {}),
      ...(kind === 'developer-bet' ? { meta: input.meta } : {}),
    });
    const matches = (operation: Operation, signed: Details) => {
      if (
        (['kind', 'amount', 'fee', 'chance', 'prize'] as const).some(
          key => BigInt(operation[key]) !== BigInt(intent[key]),
        ) ||
        !same(operation.recipient, intent.recipient) ||
        canonicalJSON(signed) !== canonicalJSON(details)
      )
        throw gameError('id-conflict', 'Operation ID is bound to a different intent (terms or game)');
    };
    /** What every operation this wallet signs must satisfy: it fits the money the player allowed, and
     * a bet's terms are ones the casino's own rule can read. */
    const allowed = (debit: bigint) => {
      if (game) {
        if (this.game?.key !== game.key) throw gameError('game-closed', 'The game is no longer open');
        if (debit + BigInt(game.kept ?? 0) > BigInt(this.gameAllowance(game.group).allowance))
          throw gameError('insufficient-allowance', "Bet exceeds the game's allowance");
        if (kind === 'developer-bet' && !this.game.developerBets)
          throw gameError(
            'developer-bets-not-allowed',
            'The player has not let this game place developer bets: ask with requestAllowance({ developerBets: true }).',
          );
      } else if (
        // Only a bet stakes what the casino lent the balance: money moved into the fund or a bank leaves it.
        debit + (['invest', 'bank'].includes(kind) ? BigInt(this.channel!.state.loan) : 0n) >
        this.availableBalance()
      )
        throw new Error("Debit exceeds your balance less the game's allowance and what the casino lent it");
      if (kind === 'casino-bet')
        try {
          describeBet(betTerms(intent.amount, intent.chance, intent.prize));
        } catch {
          throw new Error('Invalid bet terms');
        }
      try {
        checkDetails(intent.kind, details);
      } catch {
        throw gameError('invalid-request', 'Invalid bet terms');
      }
    };
    const sign = async () => {
      // A credit collects what is owed: it spends nothing.
      allowed(credit(kind) ? 0n : intent.amount);
      // The round is fixed before this wallet picks its seed, so only one secret can settle the casino bet. The seed
      // goes with the bet only when the casino's quote covers it, which the casino must then settle: a bet it does not
      // cover, the casino declines without the seed, never knowing what it would have paid.
      const seed = kind === 'casino-bet' ? random() : null,
        quote = seed ? await this.ownQuote() : null;
      const request = operation(this.domain, this.channel!.state, {
        kind: intent.kind,
        amount: intent.amount,
        recipient: intent.recipient,
        fee: intent.fee,
        chance: intent.chance,
        prize: intent.prize,
        round: quote ? quote.message.round : ZeroHash,
        seedHash: seed ? seedHash(seed) : ZeroHash,
        memo: memo(details),
      });
      // A quote covers the bet only with at least half its day left, so a bet the casino leaves unanswered has hours to
      // be disputed: one about to expire would let the casino outwait it.
      const covered = quote && covers(quote, request, Math.floor(Date.now() / 1000) + QUOTE_PERIOD / 2);
      // Signed, then saved once: nothing leaves this wallet until the signed request is durable.
      this.pending = {
        ...(game ? { game } : {}),
        ...(covered ? { seed, quote } : {}),
        kind,
        operationId,
        request,
        details,
        signature: await this.signer.signTypedData(this.domain, OP_TYPES, request),
      };
      await this.save();
    };
    // The wallet's own background work finishes first: an operation waits for it rather than failing as busy.
    return this.exclusive(
      async () => {
        // Read under the lock: a request with this ID that finished while this one waited, here or in another tab,
        // is its answer. Signing again would bind a second operation to the ID, which the casino refuses for good.
        const cached = await this.getReceipt(operationId);
        if (cached) {
          matches(cached.request || cached.proof.step.operation, cached.details);
          if (game && (cached.game?.key !== game.key || cached.game?.id !== game.id))
            throw gameError('id-conflict', 'Operation ID is bound to a different game');
          return cached;
        }
        await this.ready();
        if (!this.pending) await sign();
        else {
          if (this.pending.operationId !== operationId)
            throw gameError('pending-operation', 'Recover the previous operation');
          matches(this.pending.request, this.pending.details);
          if (game && canonicalJSON(this.pending.game) !== canonicalJSON(game))
            throw gameError('id-conflict', 'Pending game request differs');
        }
        return this.resume();
      },
      { wait: true },
    );
  }
  async getReceipt(this: CasinoWallet, operationId: string) {
    return this.storage.get(this.storageKey + ':receipt:' + operationId);
  }
  async resume(this: CasinoWallet): Promise<any> {
    const pending = this.pending,
      c = this.channel!;
    if (!pending?.request) throw new Error('No signed operation to recover');
    const acknowledgment =
      c.playerSignature && c.playerSignature !== '0x'
        ? {
            stateHash: hashState(this.domain, c.state),
            signature: c.playerSignature,
          }
        : undefined;
    const entry = {
      request: pending.request,
      details: pending.details,
      signature: pending.signature,
      acknowledgment,
      ...(pending.rejectionSignature ? { rejectionSignature: pending.rejectionSignature } : {}),
      // Once its quote has expired, a bet goes without its seed: a casino that has not seen it could no longer be held
      // to what it would pay.
      ...(this.disputable() ? { seed: pending.seed, quote: pending.quote } : {}),
    };
    try {
      const response = await this.api(`/api/channels/${c.state.channelId}/operations`, entry);
      return await this.accept(response, pending.operationId, pending.kind);
    } catch (error: any) {
      this.pendingError = { operationId: pending.operationId, message: error.message, code: error.code };
      throw error;
    }
  }
  /** Verify a signed result, record it and advance the channel. */
  async accept(this: CasinoWallet, response: any, operationId: string, kind: string): Promise<any> {
    const c = structuredClone(this.channel!),
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
    // What the operation meant is what this wallet signed as its memo, and the operation is the one it signed.
    const details: Details = c.pending!.details;
    let next: Checkpoint;
    if (rejected) {
      next = rejectionCheckpoint(this.domain, c.state, c.pending.request);
      if (!same(hashState(this.domain, next), hashState(this.domain, response.state)))
        throw new Error('Result state differs from evidence');
      // A rejection starts unsigned. The wallet agrees only after checking it cannot void a covered casino bet,
      // unless the casino proves that game operation was carried out on another channel. Save the signature before
      // sending it, so a lost reply recovers this cancellation without deciding again.
      if (response.casinoSignature === '0x') {
        if (c.pending.rejectionSignature) throw new Error('The casino has not completed the agreed rejection');
        if (this.bound(c) && !this.carriedElsewhere(response, c.pending))
          throw new Error(
            'The casino declined a casino bet its quote covers: dispute it by closing without the casino.',
          );
        c.pending.rejectionSignature = await this.signer.signTypedData(this.domain, STATE_TYPES, next);
        c.pending.rejection = {
          reason: response.reason,
          ...(response.used === true ? { used: true } : {}),
          ...(response.carried ? { carried: response.carried } : {}),
        };
        await this.save(undefined, { channels: { ...this.channels, [c.state.channelId]: c } });
        return this.resume();
      }
      assertSignature(this.domain, STATE_TYPES, next, response.casinoSignature, this.operator);
      const proven = verifyEvidence({
        chainId: this.expectedChainId,
        casino: this.config.contractAddress,
        operator: this.operator,
        opening: c.opening,
        evidence: response.evidence,
      }).state;
      if (!same(hashState(this.domain, next), hashState(this.domain, proven)))
        throw new Error('Rejection is not jointly signed');
      response = { ...response, ...c.pending.rejection };
    } else {
      // Once this wallet has signed the operation's rejection, the casino holds a checkpoint two above the base with the
      // account's signature, which it could complete whenever it liked: taking a result now would leave the state after
      // it at that sequence, where the rejection would supersede it. Only the rejection completes the operation.
      if (c.pending.rejectionSignature)
        throw new Error('The casino answered with a result after its rejection was agreed: close without the casino.');
      // The operation is the one this wallet signed, and its authorization goes into this wallet's
      // evidence: it must be the very signature this wallet made, which needs no recovering.
      if (!c.pending?.signature || !same(step.authorization, c.pending.signature))
        throw new Error('Casino returned a different authorization');
      next = settleStep(this.domain, c.state, step, this.operator);
    }
    if (!same(hashState(this.domain, next), hashState(this.domain, response.state)))
      throw new Error('Result state differs from evidence');
    const game = c.pending?.game as GameIntent | undefined;
    // The open game's allowance follows its verified result. A result recovered after a reload, or for a game since
    // closed, changes only the channel balance: the allowance was already released.
    if (game && this.game?.key === game.key) {
      const change = BigInt(next.balance) - BigInt(c.state.balance),
        staked = rejected || credit(kind) ? 0n : BigInt(op.amount),
        won = change + staked;
      this.gameSettled(
        won < 0n ? -change : staked,
        won < 0n ? 0n : won,
        game.group,
        rejected ? 0n : BigInt(game.kept ?? 0),
      );
    }
    const casinoBet = Number(op.kind) === KIND.casinoBet;
    c.state = next;
    // Every reply brings the quote for the next casino bet.
    this.adoptQuote(c, response.quote);
    c.casinoSignature = rejected ? response.casinoSignature : step.casinoSignature;
    c.playerSignature = rejected
      ? response.evidence.playerSignature
      : await this.signer.signTypedData(this.domain, STATE_TYPES, next);
    c.lastResponse = rejected
      ? { ...response, evidence: checkpointEvidence(next, c.playerSignature, c.casinoSignature) }
      : response;
    const drawn = !rejected && casinoBet ? outcome(step.seed, step.secret) : null,
      settled = drawn ? { ...drawn, payout: betPayout(op, drawn.value) } : null,
      // What the player signed, exactly: the most the bet could pay and its return out of 2^64 stakes.
      table = casinoBet ? describeBet(betTerms(op.amount, op.chance, op.prize)) : null;
    let commission: string | undefined;
    try {
      commission = String(gameAmount(String(rejected ? 0 : response.commission), false));
    } catch {
      /* Invalid optional accounting cannot discard signed settlement or break receipt display. */
    }
    // An investment comes back with the casino's signed statement of the holding it bought.
    const invested = kind === 'invest' && !rejected ? this.adoptStatement(response.statement, op) : null,
      banked =
        kind === 'bank' && !rejected ? this.bankStatement(response.statement, hashOperation(this.domain, op)) : null,
      // A developer bet is known by the hash of the operation that placed it, and a withdrawal or a transfer is a claim
      // under it.
      developerBet = kind === 'developer-bet' && !rejected ? hashOperation(this.domain, op).toLowerCase() : null,
      withdrawal =
        ['withdrawal', 'transfer', 'lock-in'].includes(kind) && !rejected
          ? hashOperation(this.domain, op).toLowerCase()
          : null;
    const receipt = plain({
      kind,
      operationId,
      ...(game ? { game: { key: game.key, id: game.id, name: game.name, developer: game.developer } } : {}),
      status: rejected ? 'rejected' : 'signed',
      ...(rejected ? { request: op, reason: response.reason } : {}),
      // Declined as one this player carried out on another channel: the game must not take it for a fresh decline.
      ...(rejected && response.used === true ? { used: true } : {}),
      verified: true,
      proof: c.lastResponse!.evidence,
      // The round's 64-bit outcome, and what the bet paid on it: its prize, or nothing.
      outcome: settled?.value,
      payout: settled?.payout,
      randomHash: settled?.randomHash,
      stake: op.amount,
      ...(table ? { maxPayout: table.maxPayout, expectedPayout: table.expectedPayout } : {}),
      amount: rejected ? '0' : op.amount,
      details,
      ...(developerBet ? { bet: developerBet } : {}),
      // Where it goes: the contract records it as a claim under the withdrawal's ID once anyone sends the proof.
      ...(withdrawal ? { withdrawal, to: this.destination(op), fee: op.fee, paid: false } : {}),
      ...(invested ? { shares: invested.minted, holding: invested.fund.shares } : {}),
      commission,
      balance: next.balance,
      createdAt: new Date().toISOString(),
    });
    c.pending = null;
    await this.save(receipt, {
      channels: { ...this.channels, [c.state.channelId]: c },
      ...(invested ? { fund: invested.fund } : {}),
      ...(banked ? { bank: banked } : {}),
      // A developer bet is remembered until what its developer paid is collected.
      ...(developerBet
        ? {
            developerBets: {
              ...this.developerBets,
              [developerBet]: { operationId, game: details.game! },
            },
          }
        : {}),
    });
    return receipt;
  }
  // --- Developer bets --------------------------------------------------------------------------------

  /** Place a developer bet of the open game: a debit that completes at once and pays its stake into the bank of the
   * game's developer, who settles it. Asking again with the same ID returns the receipt as it stands; the wallet
   * checks and collects what the developer paid once it has settled the bet. */
  async placeDeveloperBet(this: CasinoWallet, input: DeveloperBetInput, operationId: string, game: GameIntent) {
    // A game opened by its URL alone is published by nobody, so nobody takes its developer bets.
    if (this.requireGame().identity.slug === undefined)
      throw gameError('invalid-request', 'A game published nowhere takes no developer bets');
    // Its meta is what makes the debit a developer bet: without it, the stake would pay the bankroll.
    if (!validMeta(input.meta)) throw gameError('invalid-request', META);
    return this.perform(
      'developer-bet',
      { amount: input.stake, meta: input.meta, ...(input.group ? { group: input.group } : {}) },
      operationId,
      game,
    );
  }
  /** What a settled developer bet was paid: what its developer's signed settlement says, which is its developer's
   * word. Throws if the casino describes another bet or the settlement is not the developer's, so the wallet signs
   * nothing it cannot verify. */
  developerBetPaid(this: CasinoWallet, receipt: any, bet: PublicDeveloperBet) {
    const developer: string = receipt.game?.developer,
      hash = hashOperation(this.domain, receipt.proof.step.operation);
    if (!same(bet.bet, hash) || BigInt(bet.stake) !== BigInt(receipt.stake) || !same(bet.developer, developer))
      throw new Error('The casino describes another bet');
    const settlement = bet.settlement!;
    assertSignature(
      this.domain,
      SETTLEMENT_TYPES,
      { bet: hash, player: settlement?.player, casino: settlement?.casino },
      settlement?.signature,
      developer,
    );
    return { payout: BigInt(settlement.player), settlement: plain(settlement) };
  }
  /** Collect what a developer bet this wallet placed was paid, once its developer settled it. The wallet checks the
   * settlement, then signs a credit for what it pays, which goes to the open game if it is the game that placed the
   * bet: into the bet's group, if it has one, until the game ends it. The bet's receipt then says what it was paid, and goes to the game that placed it. */
  async collectDeveloperBet(this: CasinoWallet, hash: string) {
    const tracked = this.developerBets[hash],
      channelId = this.channelId;
    if (!tracked) return null;
    const receipt = tracked.operationId ? await this.getReceipt(tracked.operationId) : null;
    if (!receipt) throw new Error('The proof of this bet is in the browser that placed it: collect it there.');
    const bet: PublicDeveloperBet = await this.api(`/api/developer-bets/${hash}`);
    if (bet.status === 'open') return null;
    const paid = this.developerBetPaid(receipt, bet);
    await this.exclusive(
      async () => {
        if (this.channelId !== channelId) throw new Error('Wallet account changed');
        if (!this.developerBets[hash]) return;
        await this.save(undefined, {
          developerBets: {
            ...this.developerBets,
            [hash]: {
              ...this.developerBets[hash],
              error: undefined,
              state: {
                bet: hash,
                game: tracked.game,
                ...(bet.group ? { group: bet.group } : {}),
                status: bet.status,
                stake: bet.stake,
                payout: String(paid.payout),
                settledAt: bet.settledAt,
                collected: false,
              },
            },
          },
        });
      },
      { wait: true },
    );
    if (this.channelId !== channelId) throw new Error('Wallet account changed');
    const game = receipt.game;
    if (paid.payout) {
      const credited = await this.perform(
        'developer-bet-payout',
        { amount: paid.payout, source: hash },
        `developer-bet-payout:${hash}`,
        // What it paid returns to the bet's group, which the game ends once it has shown the result.
        game && this.game?.key === game.key
          ? { ...game, ...(receipt.details?.group ? { group: receipt.details.group } : {}) }
          : undefined,
      );
      if (credited.status !== 'signed') throw new Error('What the bet was paid was not credited');
    }
    const settled = plain({
      ...receipt,
      payout: paid.payout,
      settlement: paid.settlement,
      settledAt: bet.settledAt,
    });
    await this.exclusive(
      async () => {
        if (this.channelId !== channelId) throw new Error('Wallet account changed');
        if (!this.developerBets[hash]) return;
        const { [hash]: _collected, ...rest } = this.developerBets;
        await this.save(settled, { developerBets: rest });
        if (game) this.onGameReceipt(game, settled);
      },
      { wait: true },
    );
    return paid.payout;
  }

  /** Refresh the account's open developer bets and consume its durable feed of settled ones. Save each page with its
   * cursor before attempting collection, so a failed credit cannot hide a settled bet. */
  async refreshDeveloperBets(this: CasinoWallet) {
    const channelId = this.channelId;
    if (!channelId) return;
    try {
      for (const status of ['open', 'settled'] as const) {
        let after = status === 'settled' ? this.developerBetCursor : '';
        for (;;) {
          const page: PlayerDeveloperBets = await this.api(
            `/api/channels/${channelId}/developer-bets?status=${status}&after=${encodeURIComponent(after)}`,
          );
          if (
            !Array.isArray(page.bets) ||
            page.bets.length > 100 ||
            typeof page.cursor !== 'string' ||
            (page.more && page.cursor === after)
          )
            throw new Error('Invalid bet list');
          if (this.channelId !== channelId) return;
          await this.exclusive(
            async () => {
              if (this.channelId !== channelId) return;
              if (status === 'settled' && Number(page.cursor) <= Number(this.developerBetCursor)) return;
              const developerBets = { ...this.developerBets };
              for (const state of page.bets) {
                if (state.status !== status) throw new Error('Invalid bet list');
                // A bet this wallet knows has settled, or has collected, is not open again.
                if (status === 'open' && developerBets[state.bet]?.state?.status === 'settled') continue;
                if (!developerBets[state.bet] && status === 'settled' && (state.collected || state.payout === '0'))
                  continue;
                if (
                  status === 'open' &&
                  this.history.some(receipt => receipt.bet === state.bet && receipt.payout !== undefined)
                )
                  continue;
                developerBets[state.bet] = { ...developerBets[state.bet], game: state.game, state };
              }
              if (
                canonicalJSON(developerBets) === canonicalJSON(this.developerBets) &&
                (status === 'open' || page.cursor === this.developerBetCursor)
              )
                return;
              await this.save(undefined, {
                developerBets,
                ...(status === 'settled' ? { developerBetCursor: page.cursor } : {}),
              });
            },
            { wait: true },
          );
          after = page.cursor;
          if (!page.more) break;
        }
      }
      this.developerBetError = null;
    } catch (error: any) {
      if (this.channelId === channelId) this.developerBetError = error.message;
      throw error;
    } finally {
      this.render();
    }
  }

  // --- A developer's bank ------------------------------------------------------------------------

  /** Put money into this account's bank: a debit answered with the casino's signed statement of the balance. The bank
   * takes the stakes of the developer bets on this developer's games, and pays their settlements and this developer's
   * casino bets. */
  async depositBank(this: CasinoWallet, amount: Integer, operationId: string = crypto.randomUUID()) {
    return this.perform('bank', { amount, source: BANK_ID }, operationId);
  }
  /** A statement of this account's bank, for a deposit or withdrawal this wallet signed: the casino's
   * signature on it, for this account, and caused by `cause`. The balance is the casino's to state: every
   * developer bet, settlement and casino bet of this developer moves it. */
  bankStatement(this: CasinoWallet, statement: any, cause: string) {
    const held = this.bank;
    assertSignature(this.domain, BANK_TYPES, statement?.message, statement?.signature, this.operator);
    const { message } = statement;
    if (
      !same(message.developer, this.address) ||
      !same(message.cause, cause) ||
      Number(message.sequence) <= Number(held.statement?.message.sequence ?? 0)
    )
      throw new Error('The bank statement is not for what this wallet signed');
    return { ...held, statement: plain(statement) };
  }
  /** This account's bank as the casino has it now. */
  async bankBalance(this: CasinoWallet) {
    const { balance, sequence } = await this.api(`/api/channels/${this.channelId}/bank`);
    return { balance: String(BigInt(balance)), sequence: Number(sequence) };
  }
  /** Take money out of this account's bank: any balance, at any time. The signed `BankWithdraw` is saved
   * before it is sent, and what it takes out is owed to this account, collected into the open channel. */
  async withdrawBank(this: CasinoWallet, amount: Integer) {
    return this.exclusive(async () => {
      await this.ready();
      const held = { ...this.bank };
      if (!held.withdrawing) {
        const bank = await this.bankBalance();
        if (BigInt(amount) <= 0n || BigInt(amount) > BigInt(bank.balance))
          throw new Error('Not that much is in the bank');
        const message = {
          developer: this.address,
          amount: String(BigInt(amount)),
          sequence: String(bank.sequence + 1),
        };
        held.withdrawing = {
          message,
          signature: await this.signer.signTypedData(this.domain, BANK_WITHDRAW_TYPES, message),
        };
        await this.save(undefined, { bank: held });
      }
      const request = held.withdrawing;
      let statement;
      try {
        ({ statement } = await this.api(`/api/channels/${this.channelId}/bank/withdraw`, request));
      } catch (error: any) {
        // Refused, so never taken: the next withdrawal is signed afresh.
        if (error.status === 409 || error.status === 400)
          await this.save(undefined, { bank: { ...held, withdrawing: null } });
        throw error;
      }
      await this.save(undefined, {
        bank: {
          ...this.bankStatement(statement, hashBankWithdraw(this.domain, request.message)),
          withdrawing: null,
          owed: [...(held.owed ?? []), String(request.message.amount)],
        },
      });
      return statement;
    });
  }

  // --- The bankroll fund -------------------------------------------------------------------

  /** Invest in the casino's bankroll: a debit from this channel that buys shares at the going
   * price. The money becomes the casino's to bet with. A share is the casino's promise of a part of
   * the bankroll, not money the contract protects: the wallet can prove what it holds, never what it is worth. */
  async invest(this: CasinoWallet, amount: Integer, operationId: string = crypto.randomUUID()) {
    return this.perform('invest', { amount, source: FUND_ID }, operationId);
  }
  /** The statement for an investment this wallet just made. It is believed as far as it can be
   * checked: the casino's signature, this exact debit, and the shares its stated price implies.
   * The checkpoint it came with is already signed and stands either way, so a statement that fails
   * is kept out and shown as an alert instead. One that does not follow the wallet's last statement,
   * as when the account plays on another device too, is checked on its own and left for `syncFund`. */
  adoptStatement(this: CasinoWallet, statement: any, op: Operation) {
    const holder = this.channel!.opening.player,
      cause = hashOperation(this.domain, op);
    try {
      if (Number(statement?.message?.sequence) !== this.fund.sequence + 1) {
        const minted = verifyShareStatement(this.domain, statement, this.operator, {
          holder,
          cause,
          amount: op.amount,
          previous: {
            sequence: Number(statement.message.sequence) - 1,
            shares:
              BigInt(statement.message.shares) -
              sharesFor(statement.message.amount, statement.message.equity, statement.message.totalShares),
          },
        });
        return { minted: String(minted), fund: this.fund };
      }
      const minted = verifyShareStatement(this.domain, statement, this.operator, {
          holder,
          cause,
          amount: op.amount,
          previous: this.fund,
        }),
        { alert, ...fund } = this.fund;
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
      return { minted: '0', fund: { ...this.fund, alert: `Investment ${op.memo}: ${error.message}` } };
    }
  }
  /** Take up the casino's latest statement of this account's holding when it is later than the wallet's: a wallet whose
   * account plays on another device too, or that lost its browser's data, has missed statements. The casino sends every
   * `Redeem` this account signed with the statement it produced, and the later statement is taken only if every share
   * it takes away is one of those redemptions this wallet has not seen, each checked: this account's signature, the
   * casino's, and the price. What each of them sold for is owed to this account. Nothing is taken while an operation
   * or a redemption is pending, whose own reply brings its statement; a statement that fails is kept out and shown as
   * an alert. */
  async syncFund(this: CasinoWallet) {
    if (!this.channel?.registered || this.pending || this.fund.redeeming) return;
    const { statement, redeems } = await this.api(`/api/channels/${this.channelId}/fund`);
    if (!statement || Number(statement.message?.sequence) <= this.fund.sequence) return;
    await this.exclusive(
      () => {
        const known = this.fund,
          holder = this.channel!.opening.player;
        if (this.pending || known.redeeming || Number(statement.message.sequence) <= known.sequence) return;
        let fund: any;
        try {
          assertSignature(this.domain, SHARE_TYPES, statement.message, statement.signature, this.operator);
          if (!same(statement.message.holder, holder)) throw new Error('The share statement is for another holder');
          let burned = 0n;
          const owed: string[] = [],
            seen = new Set<number>();
          for (const redeem of Array.isArray(redeems) ? redeems : []) {
            const sequence = Number(redeem.statement.message.sequence);
            if (sequence <= known.sequence) continue;
            if (sequence > Number(statement.message.sequence) || seen.has(sequence))
              throw new Error('A redemption does not belong to this holding');
            seen.add(sequence);
            assertSignature(this.domain, REDEEM_TYPES, redeem.request.message, redeem.request.signature, holder);
            if (!same(redeem.request.message.holder, holder) || Number(redeem.request.message.sequence) !== sequence)
              throw new Error('A redemption does not belong to this holding');
            verifyShareStatement(this.domain, redeem.statement, this.operator, {
              holder,
              previous: {
                sequence: sequence - 1,
                shares: BigInt(redeem.statement.message.shares) + BigInt(redeem.request.message.shares),
              },
              cause: hashRedeem(this.domain, redeem.request.message),
              burned: redeem.request.message.shares,
            });
            burned += BigInt(redeem.request.message.shares);
            owed.push(String(redeem.statement.message.amount));
          }
          if (BigInt(statement.message.shares) < BigInt(known.shares) - burned)
            throw new Error('The casino states fewer shares than this account redeemed');
          const { alert, ...rest } = known;
          fund = {
            ...rest,
            sequence: Number(statement.message.sequence),
            shares: String(statement.message.shares),
            statement,
            owed: [...(known.owed || []), ...owed],
          };
        } catch (error: any) {
          fund = { ...known, alert: `Share statement ${statement.message?.sequence}: ${error.message}` };
        }
        return this.save(undefined, { fund });
      },
      { wait: true },
    );
  }
  /** The fund as the casino states it, signed, with what this account's shares come to at that price. */
  async fundStatus(this: CasinoWallet) {
    await this.syncFund();
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
   * collected into the open channel. */
  async redeem(this: CasinoWallet, shares: Integer) {
    // A redemption follows the latest statement: a wallet that missed some takes them up before it signs.
    await this.syncFund();
    return this.exclusive(async () => {
      await this.ready();
      if (!this.fund.redeeming) {
        if (BigInt(shares) <= 0n || BigInt(shares) > BigInt(this.fund.shares))
          throw new Error('Not that many shares to redeem');
        const message = {
          holder: this.channel!.opening.player,
          shares: String(BigInt(shares)),
          sequence: String(this.fund.sequence + 1),
        };
        this.fund = {
          ...this.fund,
          redeeming: {
            message,
            signature: await this.signer.signTypedData(this.domain, REDEEM_TYPES, message),
          },
        };
        await this.save();
      }
      const request = this.fund.redeeming!;
      let statement;
      try {
        ({ statement } = await this.api(`/api/channels/${this.channelId}/fund/redeem`, request));
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
          balance: this.channel!.state.balance,
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

  /** Collect what the fund, the games this player develops and the developer bets they placed owe them. A redemption
   * is checked against this wallet's own share statement before it signs the credit, and a developer bet against its
   * developer's settlement; commission is simply collected. */
  async collectPayouts(this: CasinoWallet) {
    // Money deposited into the channel goes into the balance first: a waiting casino is asked again next time.
    if (!this.busy) await this.takeDeposits().catch(() => {});
    if (this.busy || this.pending || !this.playable) return [];
    const channelId = this.channelId,
      collected: any[] = [];
    const due = await this.api(`/api/channels/${channelId}/payouts`);
    if (!Array.isArray(due) || due.length > MAX_PAYOUTS) throw new Error('Invalid payout list');
    for (const payout of due) {
      if (this.channelId !== channelId || this.busy || this.pending) break;
      if (same(payout.source, DEVELOPER_ID)) {
        // Commission the games this player develops have earned. The casino keeps the tally and this
        // channel shows it; a credit needs no checking, so the wallet takes what is offered.
        this.developerEarnings = { earned: String(payout.earned), collected: String(payout.collected) };
        if (BigInt(payout.amount) > 0n)
          collected.push(
            await this.perform(
              'earnings',
              { amount: payout.amount, source: DEVELOPER_ID },
              `earnings:${payout.collected}`,
            ),
          );
        continue;
      }
      if (same(payout.source, FUND_ID)) {
        // Redeemed shares: the wallet signs only for an amount one of its own statements priced.
        const owed = this.fund.owed || [],
          at = owed.indexOf(String(payout.amount));
        if (at < 0) continue;
        collected.push(
          await this.perform('divest', { amount: payout.amount, source: FUND_ID }, `divest:${payout.index}`),
        );
        await this.exclusive(() => this.save(undefined, { fund: { ...this.fund, owed: owed.toSpliced(at, 1) } }), {
          wait: true,
        });
        continue;
      }
      if (same(payout.source, BANK_ID)) {
        // Money this account took out of its bank: signed for only as one of its own statements priced it.
        const held = this.bank,
          at = (held.owed ?? []).indexOf(String(payout.amount));
        if (at < 0) continue;
        collected.push(
          await this.perform('withdrawn', { amount: payout.amount, source: BANK_ID }, `bank:${payout.index}`),
        );
        await this.exclusive(
          () => this.save(undefined, { bank: { ...this.bank, owed: this.bank.owed!.toSpliced(at, 1) } }),
          { wait: true },
        );
      }
    }
    await this.refreshDeveloperBets();
    for (const [hash, bet] of Object.entries(this.developerBets)) {
      if (this.channelId !== channelId || this.busy || this.pending) break;
      if (bet.state?.status !== 'settled') continue;
      try {
        const paid = await this.collectDeveloperBet(hash);
        if (paid) collected.push(paid);
      } catch (error: any) {
        console.error(`Collecting developer bet ${hash} failed`, error);
        await this.exclusive(
          async () => {
            if (this.channelId === channelId && this.developerBets[hash])
              await this.save(undefined, {
                developerBets: { ...this.developerBets, [hash]: { ...this.developerBets[hash], error: error.message } },
              });
          },
          { wait: true },
        );
      }
    }
    return collected;
  }
  /** The casino's quote for this channel's next casino bet: its round, fixed before the wallet picks its seed, and the
   * virtual bankroll the bet is admitted against. Each reply brings the next one, so a casino bet stays a single
   * request; one with less than half its day left is asked for afresh, so a bet the casino leaves unanswered has hours
   * to be disputed. */
  async ownQuote(this: CasinoWallet) {
    const c = this.channel!,
      left = BigInt(c.quote?.message.expiresAt ?? 0) - BigInt(Math.floor(Date.now() / 1000));
    if (
      !c.quote ||
      !same(c.quote.message.previousStateHash, hashState(this.domain, c.state)) ||
      left < QUOTE_PERIOD / 2
    ) {
      const { quote } = await this.api(`/api/channels/${c.state.channelId}/quote`, {});
      this.adoptQuote(c, quote);
      if (!c.quote) throw new Error('The casino sent no valid quote');
    }
    return c.quote;
  }
}
