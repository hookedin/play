import type { Integer, Checkpoint, Operation, Prize, Round } from '../protocol/types.ts';
import type { AssetId } from '../protocol/protocol.ts';
import type { CasinoWallet, GameIntent } from './wallet.ts';
import { Wallet, getAddress, hexlify, randomBytes, ZeroHash, ZeroAddress, id } from 'ethers';
import type { Details, PotStatus, PlayerPots } from '../protocol/types.ts';
import {
  canonicalJSON,
  plain,
  same,
  memo,
  KIND,
  STATE_TYPES,
  OP_TYPES,
  ACCESS_TYPES,
  assertSignature,
  deriveState,
  hashState,
  hashOperation,
  rejectionCheckpoint,
  operation,
  outcome,
  roundId,
  seedHash,
  verifyShareStatement,
  sharesFor,
  valueOf,
  hashRedeem,
  FUND_ID,
  DEVELOPER_ID,
  FAUCET_ID,
  FAUCET_AMOUNT,
  FAUCET_BELOW,
  ASSETS,
  testOpening,
  initialState,
  FUND_TYPES,
  REDEEM_TYPES,
  RESOLUTION_TYPES,
  BANK_TYPES,
  WITHDRAW_TYPES,
  BANK_ID,
  hashJSON,
  hashWithdraw,
  potPayouts,
  settleStep,
  checkpointEvidence,
} from '../protocol/protocol.ts';
import { describeBet } from '../protocol/risk.ts';
import { gameAmount, gameName } from './game-account.ts';
import { gameError } from './bridge.ts';
import { WalletTransactions } from './wallet-transactions.ts';
const random = () => hexlify(randomBytes(32));
/** Operations that collect what is owed. They commit none of the signed balance. */
const CREDITS = ['divest', 'earnings', 'faucet', 'payout', 'withdrawn'];
const bytes32 = (value: unknown) =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !same(value, ZeroHash);
function validRound({ id, seedHash }: Round): Round {
  if (!bytes32(id) || !bytes32(seedHash)) throw new Error('Invalid round');
  return { id, seedHash };
}
/** The stake is paid to enter; every prize whose range holds the round's outcome pays. */
export interface BetInput {
  stake: Integer;
  prizes: Prize[];
}
/** An entry into a pot: its stake, and for a house or developer pot the prizes it holds, with the
 * referee's quote for a developer's. */
export interface EntryInput {
  pot: string;
  stake: Integer;
  prizes?: Prize[];
  quote?: { expiresAt: string; signature: string };
}

/** The off-chain channel protocol: exact signed requests, verified results, rejections, rounds, pots,
 * banks and recovery of lost replies. */
export class ChannelClient extends WalletTransactions {
  /** What the channel in play holds: the network's ETH, or the casino's test coins. */
  get asset(): { id: AssetId; symbol: string; decimals: number } {
    const self = this as unknown as CasinoWallet;
    return self.playing === 'test'
      ? ASSETS.test
      : { ...ASSETS.eth, symbol: self.networkName === 'Sepolia' ? 'Sepolia ETH' : 'ETH' };
  }
  /** Switch what this tab plays with. The open game's limit was in the other asset, so it is released. */
  play(this: CasinoWallet, asset: AssetId) {
    this.preferTest = asset === 'test';
    // `render` releases the open game's limit whenever what this tab plays with has changed.
    this.render();
  }
  async setPlaying(this: CasinoWallet, asset: AssetId) {
    await this.exclusive(async () => {
      if (this.pending) throw gameError('pending-operation', 'Recover the pending operation first');
      if (asset === 'eth' && (!this.current?.key || Number(this.current.onchain?.status) !== 1))
        throw gameError('no-channel', 'Deposit ETH to play with it');
      this.play(asset);
      if (asset === 'test') await this.ensureTestChannel();
      if (this.channel?.key) await this.reconcile().catch(() => {});
    });
    await this.fillTestChannel();
    this.render();
  }
  /** Every account has a test channel: a key of its own, opened at the casino with no chain involved
   * and empty until the faucet fills it. The caller holds the wallet's lock. */
  async ensureTestChannel(this: CasinoWallet) {
    if (this.recoveryOnly) return;
    if (!this.channels[this.testId!]) {
      const key = Wallet.createRandom().privateKey,
        opening = testOpening(this.address, new Wallet(key).address);
      this.channels[opening.channelId] = {
        key,
        opening,
        asset: 'test',
        state: initialState(opening),
        playerSignature: '0x',
        casinoSignature: '0x',
        onchain: { status: '1' },
      };
      this.testId = opening.channelId;
      await this.save();
    }
    const test = this.channels[this.testId!];
    // The funding key says the channel is this player's; nothing on-chain can say it for them.
    const message = { channelId: this.testId!, expiresAt: String(Math.floor(Date.now() / 1000) + 60) };
    const owner = { message, signature: await this.signer.signTypedData(this.domain, ACCESS_TYPES, message) };
    const reply = await this.api(
      `/api/channels/${this.testId}/activate`,
      { opening: test.opening, asset: 'test', owner },
      test,
    );
    this.noteNames(reply);
    if (this.playing === 'test') this.updateBankroll(reply.bankroll);
  }
  /** A new test channel is filled at once, so a guest can play straight away. */
  async fillTestChannel(this: CasinoWallet) {
    const test = this.channels[this.testId!];
    if (this.playing === 'test' && test && BigInt(test.state.balance) === 0n && !test.pending && !this.recoveryOnly)
      await this.claimTestCoins().catch(() => {});
  }
  /** Ask the faucet for test coins: it pays a test channel that has run low. */
  async claimTestCoins(this: CasinoWallet) {
    if (this.playing !== 'test') throw new Error('Switch to test coins first');
    if (BigInt(this.channel?.state.balance ?? 0) >= FAUCET_BELOW)
      throw gameError('not-due', 'The faucet pays once you hold fewer than 10 test coins');
    return this.perform(
      'faucet',
      { amount: FAUCET_AMOUNT, source: FAUCET_ID },
      `faucet:${this.channel!.state.sequence}`,
    );
  }
  async balance(this: CasinoWallet) {
    return BigInt(this.channel?.state.balance || 0);
  }
  /** The signed balance less what a pending operation has already committed: what the player may
   * still allocate to the open game. A credit collects what is owed and commits nothing. */
  playableBalance(this: CasinoWallet) {
    const pending = this.pending,
      committed = pending?.request && !CREDITS.includes(pending.kind) ? BigInt(pending.request.amount) : 0n,
      free = BigInt(this.channel?.state.balance || 0) - committed;
    return free < 0n ? 0n : free;
  }
  /** The signed balance minus what this tab's open game may still risk; never below zero. */
  availableBalance(this: CasinoWallet) {
    const limit = this.game ? BigInt(this.game.balance) : 0n,
      available = BigInt(this.channel?.state.balance || 0) - limit;
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
  async executeBet(this: CasinoWallet, input: BetInput, operationId: string = crypto.randomUUID(), game?: GameIntent) {
    return this.perform('bet', input, operationId, game);
  }
  async payBankroll(
    this: CasinoWallet,
    amount: Integer,
    operationId: string = crypto.randomUUID(),
    game: GameIntent | undefined = undefined,
  ) {
    return this.perform('payment', { amount }, operationId, game);
  }
  async perform(this: CasinoWallet, kind: string, input: any, operationId: string, game?: GameIntent) {
    this.requireDurableState();
    const intent = {
      // A payment and an investment are debits, and a payout collected is a credit.
      kind:
        (
          {
            bet: KIND.bet,
            payment: KIND.debit,
            entry: KIND.debit,
            invest: KIND.debit,
            bank: KIND.debit,
            divest: KIND.credit,
            earnings: KIND.credit,
            faucet: KIND.credit,
            payout: KIND.credit,
            withdrawn: KIND.credit,
          } as Record<string, number>
        )[kind] || 0,
      amount: BigInt(kind === 'bet' ? input.stake : input.amount),
      prizes:
        kind === 'bet'
          ? (input.prizes as Prize[]).map(prize => ({
              rangeStart: BigInt(prize.rangeStart),
              rangeEnd: BigInt(prize.rangeEnd),
              payout: BigInt(prize.payout),
            }))
          : [],
    };
    if (!intent.kind) throw new Error('Unknown wallet operation');
    // What the operation means, signed as its memo. A bet, a payment and a pot entry are always the open
    // game's, so which game that is has one source of truth: the session this wallet has open. An entry,
    // an investment, a deposit and a payout name what they pay into or collect from.
    const details: Details = plain({
      id: id(operationId),
      ...(['bet', 'payment', 'entry'].includes(kind) ? { game: gameName(this.requireGame().identity) } : {}),
      ...(input.source ? { counterparty: input.source.toLowerCase() } : {}),
      ...(kind === 'entry' && (input.prizes || input.quote)
        ? {
            entry: {
              ...(input.prizes ? { prizes: plain(input.prizes) } : {}),
              ...(input.quote
                ? { quote: { expiresAt: String(input.quote.expiresAt), signature: input.quote.signature } }
                : {}),
            },
          }
        : {}),
    });
    const matches = (operation: Operation, signed: Details) => {
      if (
        (['kind', 'amount'] as const).some(key => BigInt(operation[key]) !== BigInt(intent[key])) ||
        canonicalJSON(plain(operation.prizes)) !== canonicalJSON(plain(intent.prizes)) ||
        canonicalJSON(signed) !== canonicalJSON(details)
      )
        throw gameError('id-conflict', 'Operation ID is bound to a different intent (terms or game)');
    };
    const cached = await this.getReceipt(operationId);
    this.requireDurableState();
    if (cached) {
      matches(cached.request || cached.proof.step.operation, cached.details);
      if (game && (cached.game?.key !== game.key || cached.game?.id !== game.id))
        throw gameError('id-conflict', 'Operation ID is bound to a different game');
      return cached;
    }
    /** What every operation this wallet signs must satisfy: it fits the money the player allowed, and
     * a bet's terms are a prize table the casino's own rule can read. */
    const allowed = (debit: bigint) => {
      if (game) {
        if (this.game?.key !== game.key) throw gameError('game-closed', 'The game is no longer open');
        if (debit > BigInt(this.game.balance)) throw gameError('insufficient-funds', 'Bet exceeds the game balance');
      } else if (debit > this.availableBalance()) throw new Error('Debit exceeds unallocated wallet balance');
      if (kind !== 'bet') return;
      try {
        describeBet({ stake: intent.amount, prizes: intent.prizes });
      } catch {
        throw new Error('Invalid wager terms');
      }
    };
    const sign = async () => {
      // A credit collects what is owed: it spends nothing.
      allowed(CREDITS.includes(kind) ? 0n : intent.amount);
      // The round is fixed before this wallet draws its seed, so only one secret can settle the bet:
      // the wallet draws the seed and sends it with the bet.
      const seed = kind === 'bet' ? random() : null,
        round: Round | null =
          kind === 'bet' ? validRound({ id: await this.ownRound(), seedHash: seedHash(seed!) }) : null;
      const request = operation(this.domain, this.channel!.state, {
        kind: intent.kind,
        amount: intent.amount,
        prizes: intent.prizes,
        round: round?.id ?? ZeroHash,
        seedHash: round?.seedHash ?? ZeroHash,
        memo: memo(details),
      });
      // Signed, then saved once: nothing leaves this wallet until the signed request is durable.
      this.pending = {
        ...(game ? { game } : {}),
        ...(seed ? { seed } : {}),
        kind,
        operationId,
        request,
        details,
        signature: await this.channelSigner().signTypedData(this.domain, OP_TYPES, request),
      };
      await this.save();
    };
    return this.exclusive(async () => {
      this.ready();
      if (!this.pending) await sign();
      else {
        if (this.pending.operationId !== operationId)
          throw gameError('pending-operation', 'Recover the previous operation');
        matches(this.pending.request, this.pending.details);
        if (game && canonicalJSON(this.pending.game) !== canonicalJSON(game))
          throw gameError('id-conflict', 'Pending game request differs');
      }
      return this.resume();
    });
  }
  async getReceipt(this: CasinoWallet, operationId: string) {
    return this.storage.get(this.storageKey + ':receipt:' + operationId);
  }
  async resume(this: CasinoWallet) {
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
      ...(pending.seed ? { seed: pending.seed } : {}),
    };
    this.onProgress('Confirming the signed result…');
    const response = await this.api(`/api/channels/${c.state.channelId}/operations`, entry);
    return this.accept(response, pending.operationId, pending.kind);
  }
  /** Verify a signed result, record it and advance the channel. */
  async accept(this: CasinoWallet, response: any, operationId: string, kind: string) {
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
      // The casino declined the saved operation with a signed unchanged-balance checkpoint above
      // it. The wallet countersigns only now, so the casino never holds a player-signed
      // checkpoint that could supersede a completed result.
      if (!c.pending?.request || !['bet', 'entry', 'invest'].includes(kind)) throw new Error('Unexpected rejection');
      next = rejectionCheckpoint(this.domain, c.state, c.pending.request);
      assertSignature(this.domain, STATE_TYPES, next, response.casinoSignature, this.operator);
    } else {
      // The operation is the one this wallet signed, and its authorization goes into this wallet's
      // evidence: it must be the very signature this wallet made, which needs no recovering.
      if (!c.pending?.signature || !same(step.authorization, c.pending.signature))
        throw new Error('Casino returned a different authorization');
      next = settleStep(this.domain, c.state, step, this.operator);
    }
    if (!same(hashState(this.domain, next), hashState(this.domain, response.state)))
      throw new Error('Result state differs from evidence');
    const game = c.pending?.game as GameIntent | undefined;
    // The open game's limit follows its verified result. A result recovered after a reload, or
    // for a game since closed, changes only the channel balance: the limit was already released.
    if (game && this.game?.key === game.key) {
      const limit = BigInt(this.game.balance) + BigInt(next.balance) - BigInt(c.state.balance);
      this.game.balance = String(limit < 0n ? 0n : limit);
    }
    // A reply to a bet on this channel's own round names its next one. It needs no signature: this
    // wallet draws its seed only after it has the round.
    if (Number(op.kind) === KIND.bet && same(op.round, c.round))
      c.round = bytes32(response.nextRound) ? response.nextRound : undefined;
    // A declined bet on this channel's own round comes with the round's secret, and the seed was this
    // wallet's, so what the bet would have paid is known now: the wallet countersigns nothing less.
    // A round the casino says it lost is the one exception, and its receipt says so.
    const own = Number(op.kind) === KIND.bet,
      lost = rejected && own && response.lost === true;
    if (rejected && own && !lost && (!bytes32(response.secret) || !same(roundId(response.secret), op.round)))
      throw new Error('The casino declined this bet without revealing its round');
    const wouldHavePaid = rejected && own && !lost ? outcome(op.prizes, c.pending.seed, response.secret).payout : null;
    c.state = next;
    c.casinoSignature = rejected ? response.casinoSignature : step.casinoSignature;
    c.playerSignature = await this.channelSigner().signTypedData(this.domain, STATE_TYPES, next);
    c.lastResponse = rejected
      ? { ...response, evidence: checkpointEvidence(next, c.playerSignature, c.casinoSignature) }
      : { ...response, evidence: { ...response.evidence, step } };
    const isBet = !rejected && Number(op.kind) === KIND.bet,
      settled = isBet ? outcome(step.operation.prizes, step.seed, step.secret) : null,
      // What the player signed, exactly: the most the bet could pay and its return out of 2^64 stakes.
      table =
        Number(op.kind) === KIND.bet
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
    // An investment comes back with the casino's signed statement of the holding it bought.
    const invested = kind === 'invest' && !rejected ? this.adoptStatement(response.statement, op) : null,
      banked =
        kind === 'bank' && !rejected
          ? { ...this.bank, [this.playing]: this.bankStatement(response.statement, hashOperation(this.domain, op)) }
          : null,
      pot = kind === 'entry' && !rejected ? details.counterparty! : null;
    const receipt = plain({
      kind,
      // What this receipt is in: the channel that signed it holds one asset.
      ...(this.playing === 'test' ? { asset: 'test' } : {}),
      operationId,
      ...(game ? { game: { key: game.key, id: game.id, name: game.name } } : {}),
      status: rejected ? 'rejected' : 'signed',
      ...(rejected ? { request: op, reason: response.reason } : {}),
      // The seed of a declined bet stays with its receipt, beside what it would have paid.
      ...(rejected && c.pending?.seed ? { seed: c.pending.seed } : {}),
      ...(wouldHavePaid === null ? {} : { wouldHavePaid }),
      ...(lost ? { lost: true } : {}),
      verified: true,
      proof: c.lastResponse!.evidence,
      // The round's 64-bit outcome, and what the prizes holding it paid in total.
      outcome: settled?.value,
      payout: settled?.payout,
      randomHash: settled?.randomHash,
      stake: op.amount,
      ...(table ? { maxPayout: table.maxPayout, expectedPayout: table.expectedPayout } : {}),
      amount: rejected ? '0' : op.amount,
      details,
      // A pot entry's number among the pot's entries: what the pot's end pays is read by it.
      ...(kind === 'entry' && !rejected ? { entry: Number(response.entry) } : {}),
      ...(invested ? { shares: invested.minted, holding: invested.fund.shares } : {}),
      ...(details.game ? { developer: details.game.developer } : {}),
      commission,
      balance: next.balance,
      createdAt: new Date().toISOString(),
    });
    c.pending = null;
    await this.save(receipt, {
      channels: { ...this.channels, [c.state.channelId]: c },
      ...(invested ? { fund: invested.fund } : {}),
      ...(banked ? { bank: banked } : {}),
      // An entry waits in the pot, and this wallet remembers it until the pot's end is collected.
      ...(pot
        ? {
            pots: {
              ...this.pots,
              [pot]: {
                ...this.pots[pot],
                game: details.game!,
                asset: this.playing,
                entries: [...(this.pots[pot]?.entries ?? []), operationId],
              },
            },
          }
        : {}),
    });
    this.updateBankroll(response.bankroll);
    void this.api(`/api/channels/${c.state.channelId}/ack`, {
      stateHash: hashState(this.domain, next),
      signature: c.playerSignature,
    }).catch(() => {});
    return receipt;
  }
  // --- Pots -------------------------------------------------------------------------------------

  /** Enter a pot of the open game: a debit that completes at once, and is final. Asking again with the
   * same ID finds the entry, and once the pot has ended, what it paid, collected into this channel. */
  async enterPot(this: CasinoWallet, input: EntryInput, operationId: string, game: GameIntent) {
    const pot: PotStatus = await this.api(`/api/pots/${input.pot}`);
    if (!(await this.getReceipt(operationId)) && this.pending?.operationId !== operationId) {
      // Checked before anything is signed: the pot is this game's, in what this tab plays with, and open.
      if (!same(pot.game, this.requireGame().key)) throw gameError('invalid-request', "This pot is another game's");
      if (pot.asset !== this.playing) throw gameError('wrong-asset', 'This pot is played with another asset');
      if (pot.status !== 'unresolved') throw gameError('pot-closed', 'The pot takes no more entries');
    }
    const receipt = await this.perform(
      'entry',
      { ...input, amount: input.stake, source: input.pot },
      operationId,
      game,
    );
    if (receipt.status === 'signed' && pot.status !== 'unresolved') await this.collectPot(input.pot);
    return (await this.getReceipt(operationId)) ?? receipt;
  }
  /** What each entry of a pot that has ended is owed, worked out here from what ended it: a house pot's
   * seed and secret, checked against its round, or its referee's signed result. Throws if either does not
   * check out, so the wallet signs nothing for a pot whose end it cannot verify. */
  potPaid(this: CasinoWallet, pot: PotStatus) {
    if (pot.status !== 'resolved') throw new Error('The pot has not resolved');
    if (pot.resolution === 'refund') return { payouts: potPayouts(pot, { refund: true }) };
    if (pot.resolution !== 'outcome') throw new Error('Unknown pot resolution');
    if (pot.bank === 'house') {
      if (
        !bytes32(pot.secret) ||
        !same(roundId(pot.secret!), pot.id) ||
        !bytes32(pot.seed) ||
        !same(seedHash(pot.seed!), pot.seedHash!)
      )
        throw new Error("The pot's seed and secret are not the round it was opened with");
      const value = outcome([], pot.seed!, pot.secret!).value;
      return { payouts: potPayouts(pot, { value }), outcome: String(value) };
    }
    assertSignature(
      this.domain,
      RESOLUTION_TYPES,
      { pot: pot.id, result: hashJSON(pot.result) },
      pot.signature!,
      pot.referee,
    );
    return {
      payouts: potPayouts(pot, pot.result!),
      ...('outcome' in pot.result! ? { outcome: String(pot.result.outcome) } : {}),
    };
  }
  /** Collect what a pot this wallet entered came to. The casino owes each of this account's entries what
   * the pot's end gives it; the wallet works that out itself and signs a credit for exactly its total, which
   * raises the open game's limit if it is the game that entered. Each entry's receipt then says what it got. */
  async collectPot(this: CasinoWallet, id: string) {
    const tracked = this.pots[id],
      channelId = this.channelId;
    if (!tracked || tracked.asset !== this.playing) return null;
    const ids = tracked.entries;
    if (!ids.length) throw new Error('Entry proofs are missing. Restore the wallet backup that holds these entries.');
    const pot: PotStatus = await this.api(`/api/pots/${id}`);
    if (pot.status === 'unresolved') return null;
    if (pot.asset !== tracked.asset || !same(pot.id, id)) throw new Error('The pot identity or asset differs');
    const { payouts, outcome: landed } = this.potPaid(pot),
      entries = await Promise.all(ids.map(entry => this.getReceipt(entry)));
    if (entries.some(receipt => !receipt))
      throw new Error('Entry proofs are missing. Restore the wallet backup that holds these entries.');
    let total = 0n;
    for (const receipt of entries) {
      const held = pot.entries[receipt.entry];
      if (
        !held ||
        BigInt(held.stake) !== BigInt(receipt.stake) ||
        canonicalJSON(held.prizes ?? null) !== canonicalJSON(receipt.details.entry?.prizes ?? null)
      )
        throw new Error("The pot does not hold this wallet's entry as it was signed");
      total += payouts[receipt.entry];
    }
    const game = entries[0]?.game;
    await this.exclusive(
      async () => {
        if (this.channelId !== channelId) throw new Error('Wallet account or asset changed');
        if (!this.pots[id]) return;
        await this.save(undefined, {
          pots: {
            ...this.pots,
            [id]: {
              ...this.pots[id],
              error: undefined,
              state: {
                id,
                game: tracked.game,
                asset: pot.asset,
                status: pot.status,
                closesAt: pot.closesAt,
                deadline: pot.deadline,
                stake: String(entries.reduce((sum, entry) => sum + BigInt(entry.stake), 0n)),
                payout: String(total),
                collected: false,
                resolution: pot.resolution,
                refundReason: pot.refundReason,
                resolvedAt: pot.resolvedAt,
              },
            },
          },
        });
      },
      { wait: true },
    );
    if (this.channelId !== channelId) throw new Error('Wallet account or asset changed');
    if (total) {
      const credited = await this.perform(
        'payout',
        { amount: total, source: id },
        `pot:${id}`,
        game && this.game?.key === game.key ? game : undefined,
      );
      if (credited.status !== 'signed') throw new Error('The pot payout was not credited');
    }
    await this.exclusive(
      async () => {
        if (this.channelId !== channelId) throw new Error('Wallet account or asset changed');
        for (const receipt of entries)
          await this.save({
            ...receipt,
            payout: String(payouts[receipt.entry]),
            ...(landed === undefined ? {} : { outcome: landed }),
            resolution: pot.resolution,
            resolvedAt: pot.resolvedAt,
            ...(pot.resolution === 'refund' ? { reason: `Stake refunded: pot ${pot.refundReason}` } : {}),
          });
        const { [id]: _collected, ...rest } = this.pots;
        await this.save(undefined, { pots: rest });
      },
      { wait: true },
    );
    return total;
  }

  /** Refresh the account's current obligations and consume its durable resolution feed. Save each page
   * with its cursor before attempting collection, so a failed credit cannot hide a resolved pot. */
  async refreshPots(this: CasinoWallet) {
    const channelId = this.channelId,
      asset = this.playing;
    if (!channelId) return;
    try {
      for (const status of ['unresolved', 'resolved'] as const) {
        let after = status === 'resolved' ? (this.potCursors[asset] ?? '0') : '';
        for (;;) {
          const page: PlayerPots = await this.api(
            `/api/channels/${channelId}/pots?status=${status}&after=${encodeURIComponent(after)}`,
          );
          if (
            !Array.isArray(page.pots) ||
            page.pots.length > 100 ||
            typeof page.cursor !== 'string' ||
            (page.more && page.cursor === after)
          )
            throw new Error('Invalid pot list');
          if (this.channelId !== channelId) return;
          await this.exclusive(
            async () => {
              if (this.channelId !== channelId) return;
              if (status === 'resolved' && Number(page.cursor) <= Number(this.potCursors[asset] ?? '0')) return;
              const pots = { ...this.pots };
              for (const state of page.pots) {
                if (state.asset !== asset || state.status !== status) throw new Error('Invalid pot list');
                if (
                  state.status === 'unresolved' &&
                  (pots[state.id]?.state?.status === 'resolved' ||
                    this.history.some(
                      receipt =>
                        receipt.kind === 'entry' &&
                        receipt.details?.counterparty === state.id &&
                        receipt.payout !== undefined,
                    ))
                )
                  continue;
                if (!pots[state.id] && state.status === 'resolved' && (state.collected || state.payout === '0'))
                  continue;
                pots[state.id] = {
                  ...pots[state.id],
                  entries: pots[state.id]?.entries ?? [],
                  game: state.game,
                  asset,
                  state,
                };
              }
              if (
                canonicalJSON(pots) === canonicalJSON(this.pots) &&
                (status === 'unresolved' || page.cursor === (this.potCursors[asset] ?? '0'))
              )
                return;
              await this.save(undefined, {
                pots,
                ...(status === 'resolved' ? { potCursors: { ...this.potCursors, [asset]: page.cursor } } : {}),
              });
            },
            { wait: true },
          );
          after = page.cursor;
          if (!page.more) break;
        }
      }
      this.potError = null;
    } catch (error: any) {
      if (this.channelId === channelId) this.potError = error.message;
      throw error;
    } finally {
      this.render();
    }
  }

  // --- A developer's bank ------------------------------------------------------------------------

  /** Put money into this account's bank, in what this tab plays with: a debit answered with the casino's
   * signed statement of the balance. The bank pays what this developer's pots owe beyond their entries. */
  async depositBank(this: CasinoWallet, amount: Integer, operationId: string = crypto.randomUUID()) {
    return this.perform('bank', { amount, source: BANK_ID }, operationId);
  }
  /** A statement of this account's bank, for a deposit or withdrawal this wallet signed: the casino's
   * signature on it, for this account and asset, and caused by `cause`. The balance is the casino's to
   * state: every pot of this developer's that ends moves it. */
  bankStatement(this: CasinoWallet, statement: any, cause: string) {
    const asset = this.playing,
      held = this.bank[asset] ?? {};
    assertSignature(this.domain, BANK_TYPES, statement?.message, statement?.signature, this.operator);
    const { message } = statement;
    if (
      !same(message.developer, this.address) ||
      message.asset !== asset ||
      !same(message.cause, cause) ||
      Number(message.sequence) <= Number(held.statement?.message.sequence ?? 0)
    )
      throw new Error('The bank statement is not for what this wallet signed');
    return { ...held, statement: plain(statement) };
  }
  /** This account's bank as the casino has it now, in what this tab plays with. */
  async bankBalance(this: CasinoWallet) {
    const { balance, sequence } = await this.api(`/api/channels/${this.channelId}/bank`);
    return { balance: String(BigInt(balance)), sequence: Number(sequence) };
  }
  /** Take money out of this account's bank: any balance, at any time. The signed `Withdraw` is saved
   * before it is sent, and what it takes out is owed to this account, collected into the open channel. */
  async withdrawBank(this: CasinoWallet, amount: Integer) {
    return this.exclusive(async () => {
      this.ready();
      const asset = this.playing,
        held = { ...this.bank[asset] };
      if (!held.withdrawing) {
        const bank = await this.bankBalance();
        if (BigInt(amount) <= 0n || BigInt(amount) > BigInt(bank.balance))
          throw new Error('Not that much is in the bank');
        const message = {
          developer: this.address,
          asset,
          amount: String(BigInt(amount)),
          sequence: String(bank.sequence + 1),
        };
        held.withdrawing = {
          message,
          signature: await this.channelSigner().signTypedData(this.domain, WITHDRAW_TYPES, message),
        };
        await this.save(undefined, { bank: { ...this.bank, [asset]: held } });
      }
      const request = held.withdrawing;
      let statement;
      try {
        ({ statement } = await this.api(`/api/channels/${this.channelId}/bank/withdraw`, request));
      } catch (error: any) {
        // Refused, so never taken: the next withdrawal is signed afresh.
        if (error.status === 409 || error.status === 400)
          await this.save(undefined, { bank: { ...this.bank, [asset]: { ...held, withdrawing: null } } });
        throw error;
      }
      await this.save(undefined, {
        bank: {
          ...this.bank,
          [asset]: {
            ...this.bankStatement(statement, hashWithdraw(this.domain, request.message)),
            withdrawing: null,
            owed: [...(held.owed ?? []), String(request.message.amount)],
          },
        },
      });
      return statement;
    });
  }

  // --- The bankroll fund -------------------------------------------------------------------

  /** Invest in the casino's bankroll: a transfer from this channel that buys shares at the going
   * price. The money becomes the casino's to bet with. A share is the casino's promise of a part of
   * the bankroll, not protected principal: the wallet can prove what it holds, never what it is worth. */
  async invest(this: CasinoWallet, amount: Integer, operationId: string = crypto.randomUUID()) {
    return this.perform('invest', { amount, source: FUND_ID }, operationId);
  }
  /** The statement for an investment this wallet just made. It is believed as far as it can be
   * checked: the casino's signature, this exact transfer, and the shares its stated price implies.
   * The checkpoint it came with is already signed and stands either way, so a statement that fails
   * is kept out and shown as an alert instead. */
  adoptStatement(this: CasinoWallet, statement: any, op: Operation) {
    const holder = this.channel!.opening.player,
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
      return { minted: '0', fund: { ...this.fund, alert: `Investment ${op.memo}: ${error.message}` } };
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
   * collected into the open channel. */
  async redeem(this: CasinoWallet, shares: Integer) {
    return this.exclusive(async () => {
      this.ready();
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
            signature: await this.channelSigner().signTypedData(this.domain, REDEEM_TYPES, message),
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

  /** Collect what the fund and the games this player develops owe them. A redemption is checked
   * against this wallet's own share statement before it signs the credit; commission is simply collected. */
  async collectPayouts(this: CasinoWallet) {
    if (
      this.busy ||
      this.pending ||
      !this.channel?.key ||
      this.channel.closing ||
      Number(this.channel.onchain?.status) !== 1
    )
      return [];
    const channelId = this.channelId,
      collected: any[] = [];
    const due = await this.api(`/api/channels/${channelId}/payouts`);
    if (!Array.isArray(due) || due.length > 256) throw new Error('Invalid payout list');
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
              `earnings:${this.playing}:${payout.collected}`,
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
        // Money this developer took out of their bank: signed for only as one of their own statements priced it.
        const held = this.bank[this.playing],
          at = (held?.owed ?? []).indexOf(String(payout.amount));
        if (!held || at < 0) continue;
        collected.push(
          await this.perform(
            'withdrawn',
            { amount: payout.amount, source: BANK_ID },
            `bank:${this.playing}:${payout.index}`,
          ),
        );
        await this.exclusive(
          () =>
            this.save(undefined, {
              bank: { ...this.bank, [this.playing]: { ...held, owed: held.owed!.toSpliced(at, 1) } },
            }),
          { wait: true },
        );
      }
    }
    await this.refreshPots();
    for (const [id, pot] of Object.entries(this.pots)) {
      if (this.channelId !== channelId || this.busy || this.pending) break;
      if (pot.asset !== this.playing || pot.state?.status !== 'resolved') continue;
      try {
        const total = await this.collectPot(id);
        if (total) collected.push(total);
      } catch (error: any) {
        await this.exclusive(
          async () => {
            if (this.channelId === channelId && this.pots[id])
              await this.save(undefined, { pots: { ...this.pots, [id]: { ...this.pots[id], error: error.message } } });
          },
          { wait: true },
        );
      }
    }
    return collected;
  }
  /** This channel's next round. The casino names the round first and needs no signature for it: the
   * wallet draws its seed only afterwards, and only the round's one secret can settle a bet that
   * names it. Each reply to a bet names the next round, so an ordinary bet stays a single request. */
  async ownRound(this: CasinoWallet) {
    const c = this.channel!;
    if (!c.round) {
      const { id } = await this.api(`/api/channels/${c.state.channelId}/round`, {});
      c.round = validRound({ id, seedHash: id }).id;
    }
    return c.round;
  }
  async reconcile(this: CasinoWallet) {
    const c = this.channel;
    if (!c?.key) return;
    const reply = await this.api(`/api/channels/${c.state.channelId}`);
    this.noteNames(reply);
    if (same(hashState(this.domain, c.state), hashState(this.domain, reply.state))) {
      this.updateBankroll(reply.bankroll);
      return;
    }
    if (!reply.lastResponse) throw new Error('Casino checkpoint differs; import recovery evidence');
    if (!this.pending) throw new Error('Unknown pending operation; use saved recovery evidence');
    await this.accept(reply.lastResponse, this.pending.operationId, this.pending.kind);
  }
}
