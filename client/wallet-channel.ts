import type { Integer, Checkpoint, Operation, Prize, Round, TableTerms, Settlement } from '../protocol/types.ts';
import type { AssetId } from '../protocol/protocol.ts';
import type { CasinoWallet, GameIntent } from './wallet.ts';
import { Wallet, getAddress, hexlify, randomBytes, ZeroHash, ZeroAddress, id } from 'ethers';
import {
  canonicalJSON,
  plain,
  same,
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
  tableId,
  validateTable,
  validateSettlement,
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
  SETTLEMENT_TYPES,
  IDENTITY_TYPES,
  verifyStep,
  checkpointEvidence,
} from '../protocol/protocol.ts';
import { describeBet } from '../protocol/risk.ts';
import { gameAmount } from './game-account.ts';
import { gameError } from './bridge.ts';
import { WalletTransactions } from './wallet-transactions.ts';
const random = () => hexlify(randomBytes(32));
/** Receipt suffix for a bet withdrawn because the round this wallet remembered is no longer its next one. */
const STALE = ':stale-round';
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
  /** A round a game's host opened, with the hash of the host's seed. Without one, the bet is on this channel's own round. */
  round?: Round;
}

/** The off-chain channel protocol: exact signed requests, verified results, rejections,
 * rounds, transfers and recovery of lost replies. */
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
      null,
      `faucet:${this.channel!.state.sequence}`,
    );
  }
  async balance(this: CasinoWallet) {
    return BigInt(this.channel?.state.balance || 0);
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
    if (this.busy || !this.channel?.key || this.channel.closing || Number(this.channel.onchain?.status) !== 1)
      return null;
    const storageKey = this.storageKey,
      channelId = this.channelId;
    const current = () => this.storageKey === storageKey && this.channelId === channelId;
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
      await this.verifyRegisteredOpening(opening, this.playing);
      assertSignature(this.domain, OP_TYPES, source, signature, opening.signer);
      if (
        Number(source.kind) !== KIND.transfer ||
        !same(source.channelId, opening.channelId) ||
        !same(source.counterparty, this.channelId) ||
        same(source.channelId, this.channelId)
      )
        throw new Error('Invalid incoming transfer');
      const digest = hashOperation(this.domain, source);
      const request = operation(this.domain, this.channel.state, {
        kind: KIND.receive,
        amount: source.amount,
        counterparty: source.channelId,
        operationId: digest,
      });
      // Validate all arithmetic before persisting a new authorization.
      deriveState(this.domain, this.channel.state, request);
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
      // A buy-in is a transfer into a table and a payout the credit out of it.
      // An investment is a transfer into the bankroll fund, and redeemed money the credit out of it.
      kind:
        (
          {
            bet: KIND.bet,
            payment: KIND.payment,
            transfer: KIND.transfer,
            buyin: KIND.transfer,
            invest: KIND.transfer,
            payout: KIND.receive,
            divest: KIND.receive,
            earnings: KIND.receive,
            faucet: KIND.receive,
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
      // Only a bet signs its developer; the local attribution of payments stays in the receipt.
      developer: kind === 'bet' ? developer || ZeroAddress : ZeroAddress,
    };
    if (!intent.kind) throw new Error('Unknown wallet operation');
    const matches = (operation: Operation) => {
      if (
        (['kind', 'amount'] as const).some(key => BigInt(operation[key]) !== BigInt(intent[key])) ||
        canonicalJSON(plain(operation.prizes)) !== canonicalJSON(plain(intent.prizes)) ||
        !same(operation.developer, intent.developer) ||
        (input.source && !same(operation.counterparty, input.source)) ||
        (input.round && (!same(operation.round, input.round.id) || !same(operation.seedHash, input.round.seedHash)))
      )
        throw gameError('id-conflict', 'Operation ID is bound to a different intent (terms or developer)');
    };
    const cached = await this.getReceipt(operationId);
    this.requireDurableState();
    if (cached) {
      matches(cached.request || cached.proof.step.operation);
      if (kind === 'transfer' && !same(cached.recipient, input.recipient))
        throw gameError('id-conflict', 'Operation ID is bound to a different recipient');
      if (game && (cached.game?.key !== game.key || cached.game?.id !== game.id))
        throw gameError('id-conflict', 'Operation ID is bound to a different game');
      return cached;
    }
    const sign = async () => {
      // A payout is a credit: it spends nothing.
      const debit = ['payout', 'divest', 'earnings', 'faucet'].includes(kind) ? 0n : intent.amount;
      if (game) {
        if (this.game?.key !== game.key) throw gameError('game-closed', 'The game is no longer open');
        if (debit > BigInt(this.game.balance)) throw gameError('insufficient-funds', 'Bet exceeds the game balance');
      } else if (debit > this.availableBalance()) throw new Error('Debit exceeds unallocated wallet balance');
      // A buy-in or payout names its table, as a transfer names the other channel.
      let counterparty = input.source ?? ZeroHash;
      if (kind === 'transfer') {
        const opening = await this.api(`/api/channels/${this.channelId}/recipient`, { player: input.recipient });
        await this.verifyRegisteredOpening(opening, this.playing);
        if (!same(opening.player, input.recipient)) throw new Error('Transfer recipient differs');
        counterparty = opening.channelId;
        if (same(counterparty, this.channelId)) throw new Error('Recipient needs a different open channel');
      }
      if (kind === 'bet')
        try {
          describeBet({ stake: intent.amount, prizes: intent.prizes });
        } catch {
          throw new Error('Invalid wager terms');
        }
      // The round is fixed before this wallet draws its seed, so only one secret can settle the
      // bet. A hosted round comes with the hash of its host's seed, which the host keeps until it
      // closes the round; on its own round this wallet draws the seed and sends it with the bet.
      const seed = kind === 'bet' && !input.round ? random() : null,
        round: Round | null =
          kind !== 'bet'
            ? null
            : input.round
              ? validRound(input.round)
              : validRound({ id: await this.ownRound(), seedHash: seedHash(seed!) });
      const request = operation(this.domain, this.channel!.state, {
        kind: intent.kind,
        counterparty,
        amount: intent.amount,
        prizes: intent.prizes,
        seedHash: round?.seedHash ?? ZeroHash,
        round: round?.id ?? ZeroHash,
        // A bet signed again after its remembered round proved stale needs a new signed ID.
        operationId: id((await this.getReceipt(operationId + STALE)) ? operationId + ':fresh-round' : operationId),
        developer: intent.developer,
      });
      this.pending = {
        ...(game ? { game } : {}),
        // A hosted bet waits at the casino until its round's host closes the round.
        ...(input.round ? { hosted: true } : {}),
        ...(seed ? { seed } : {}),
        // A buy-in travels with the terms of its table, which the casino may never have seen.
        ...(input.terms ? { table: { id: input.source, terms: input.terms } } : {}),
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
          if (this.pending.operationId !== operationId)
            throw gameError('pending-operation', 'Recover the previous operation');
          matches(this.pending.request);
          if (kind === 'transfer' && !same(this.pending.recipient, input.recipient))
            throw new Error('Pending transfer has a different recipient');
          if (game && canonicalJSON(this.pending.game) !== canonicalJSON(game))
            throw gameError('id-conflict', 'Pending game request differs');
        }
        try {
          return await this.resume();
        } catch (error: any) {
          // The round this wallet remembered as its next is not (a restored backup, a casino that
          // lost it). The signed bet is withdrawn with a verified rejection, kept under its own
          // receipt, and the same bet is signed once more on the round the casino names now.
          if (retried || kind !== 'bet' || this.pending?.hosted || error.code !== 'round-not-open') throw error;
          this.channel!.round = undefined;
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
      c = this.channel!;
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
    const entry = {
      request: pending.request,
      signature: pending.signature,
      acknowledgment,
      ...(pending.seed ? { seed: pending.seed } : {}),
      ...(pending.table ? { table: pending.table.terms } : {}),
    };
    this.onProgress('Confirming the signed result…');
    const response = await this.api(`/api/channels/${c.state.channelId}/operations`, entry);
    // A transfer waits for its recipient, and a bet on a hosted round for the host to close it:
    // sending the same request again finds the result.
    if (
      (response.status === 'pending' && pending.kind === 'transfer') ||
      (response.status === 'seated' && pending.hosted)
    )
      return { status: 'pending', verified: false, operationId: pending.operationId };
    return this.accept(response, pending.operationId, pending.kind, pending.developer);
  }
  async accept(this: CasinoWallet, response: any, operationId: string, kind: string, developer: string | null) {
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
    if (
      Number(op.kind) === KIND.bet &&
      (!developer || !same(op.developer, developer) || (!rejected && !same(response.developer, developer)))
    )
      throw new Error('Developer attribution differs from the selected game');
    let next: Checkpoint;
    if (rejected) {
      // The casino declined the saved operation with a signed unchanged-balance checkpoint above
      // it. The wallet countersigns only now, so the casino never holds a player-signed
      // checkpoint that could supersede a completed result.
      if (!c.pending?.request || !['bet', 'transfer', 'buyin', 'invest'].includes(kind))
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
    // A reply to a bet on this channel's own round names its next one. It needs no signature: this
    // wallet draws its seed only after it has the round.
    if (Number(op.kind) === KIND.bet && same(op.round, c.round))
      c.round = bytes32(response.nextRound) ? response.nextRound : undefined;
    // A declined round of this channel's own is revealed at once, and the seed was this wallet's, so
    // what the bet would have paid is known now.
    const declined =
      rejected &&
      Number(op.kind) === KIND.bet &&
      bytes32(c.pending?.seed) &&
      bytes32(response.secret) &&
      same(roundId(response.secret), op.round);
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
    const bought = kind === 'buyin' ? c.pending?.table : null;
    // An investment comes back with the casino's signed statement of the holding it bought.
    const invested = kind === 'invest' && !rejected ? this.adoptStatement(response.statement, op) : null;
    const receipt = plain({
      kind,
      // What this receipt is in: the channel that signed it holds one asset.
      ...(this.playing === 'test' ? { asset: 'test' } : {}),
      operationId,
      ...(game ? { game: { key: game.key, id: game.id } } : {}),
      status: rejected ? 'rejected' : 'signed',
      ...(rejected ? { request: op, reason: response.reason } : {}),
      // The seed of a declined bet stays with its receipt until its round is revealed.
      ...(rejected && c.pending?.seed ? { seed: c.pending.seed } : {}),
      ...(declined ? { wouldHavePaid: outcome(op.prizes, c.pending!.seed!, response.secret).payout } : {}),
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
      // The seed of a hosted round was the host's, not this wallet's.
      ...(c.pending?.hosted && kind === 'bet' ? { hosted: true } : {}),
      ...(bought ? { tableId: bought.id } : {}),
      ...(invested ? { shares: invested.minted, holding: invested.fund.shares } : {}),
      developer,
      commission,
      balance: next.balance,
      createdAt: new Date().toISOString(),
    });
    // A table bought into is a financial record: the casino holds the money until the host these
    // terms name pays it out. It travels in backups.
    if (bought && !rejected) {
      const table = c.tables?.[bought.id] ?? { terms: bought.terms, bought: '0', collected: '0' };
      c.tables = {
        ...c.tables,
        [bought.id]: { ...table, ...(game ? { game } : {}), bought: String(BigInt(table.bought) + BigInt(op.amount)) },
      };
    }
    const paid = kind === 'payout' && !rejected && c.tables?.[String(op.counterparty).toLowerCase()];
    if (paid)
      c.tables = {
        ...c.tables,
        [String(op.counterparty).toLowerCase()]: {
          ...paid,
          collected: String(BigInt(paid.collected) + BigInt(op.amount)),
        },
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
  /** Ask the casino to decline the pending bet or transfer offer. */
  async withdrawPending(this: CasinoWallet, receiptId?: string) {
    const pending = this.pending,
      c = this.channel!;
    // The operation travels with its signature: the casino may never have seen it.
    if (!pending.signature) {
      pending.signature = await this.channelSigner().signTypedData(this.domain, OP_TYPES, pending.request);
      await this.save();
    }
    const response = await this.api(`/api/channels/${this.channelId}/cancel`, {
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
  /** Buy into a table: the amount leaves this channel for a pot the casino holds, and the host named
   * in the terms says who is paid out of it. The channel is free again at once. */
  async buyIn(this: CasinoWallet, terms: TableTerms, amount: Integer, operationId: string, game?: GameIntent) {
    validateTable(terms);
    if (BigInt(terms.expiresAt) * 1000n <= BigInt(Date.now())) throw new Error('This table has closed');
    return this.perform(
      'buyin',
      { amount, source: tableId(this.domain, terms).toLowerCase(), terms: plain(terms) },
      null,
      operationId,
      game,
    );
  }
  /** What the wallet knows of a table it bought into: what it put in and what it has collected. */
  tableStatus(this: CasinoWallet, id: string): Record<string, any> {
    const table = this.channel?.tables?.[id.toLowerCase()];
    return table
      ? {
          tableId: id,
          bought: table.bought,
          collected: table.collected,
          ...(table.alert ? { alert: table.alert } : {}),
        }
      : { tableId: id, bought: '0', collected: '0' };
  }
  /** A payout from a table is believed with the signature of the host its terms name over a
   * settlement paying this player exactly that amount, or, unsigned, once the table's deadline has
   * passed and the casino returns what was left of the pot. */
  verifyPayout(
    this: CasinoWallet,
    payout: {
      source: string;
      amount: Integer;
      terms: TableTerms;
      settlement?: { message: Settlement; signature: string } | null;
    },
  ) {
    validateTable(payout.terms);
    if (!same(tableId(this.domain, payout.terms), payout.source)) throw new Error('Payout names another table');
    if (!payout.settlement) {
      if (BigInt(payout.terms.expiresAt) * 1000n > BigInt(Date.now()))
        throw new Error('Payout is not signed by the host of its table');
      return;
    }
    const { message, signature } = payout.settlement;
    validateSettlement(message);
    assertSignature(this.domain, SETTLEMENT_TYPES, message, signature, payout.terms.host);
    const mine = message.payments.find(payment => same(payment.player, this.channel!.opening.player));
    if (!same(message.tableId, payout.source) || !mine || BigInt(mine.amount) !== BigInt(payout.amount))
      throw new Error(`The casino offers ${payout.amount} wei where the host awarded ${mine?.amount ?? 0}`);
  }
  /** Tell the open game's own server who is playing. The wallet states the page's origin itself, so
   * a token taken by one game is useless at another's server. It authorizes nothing at the casino. */
  async identify(this: CasinoWallet, origin: string, nonce: string) {
    if (!this.channel?.key) throw new Error('Open a channel first');
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error('Invalid nonce');
    const message = {
      player: this.channel!.opening.player,
      channelId: this.channelId,
      origin,
      nonce,
      expiresAt: String(Math.floor(Date.now() / 1000) + 300),
    };
    return {
      message,
      signature: await this.channelSigner().signTypedData(this.domain, IDENTITY_TYPES, message),
      player: this.channel!.opening.player,
      signer: this.channelSigner().address,
    };
  }
  // --- The bankroll fund -------------------------------------------------------------------

  /** Invest in the casino's bankroll: a transfer from this channel that buys shares at the going
   * price. The money becomes the casino's to bet with. A share is the casino's promise of a part of
   * the bankroll, not protected principal: the wallet can prove what it holds, never what it is worth. */
  async invest(this: CasinoWallet, amount: Integer, operationId: string = crypto.randomUUID()) {
    return this.perform('invest', { amount, source: FUND_ID }, null, operationId);
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
   * collected into the open channel like a table's payout. */
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

  /** Collect what tables, the fund and the games this player develops owe them. A table's payout is
   * checked against the host's signed settlement and the fund's against this wallet's own share
   * statement before the wallet signs the credit; commission is simply collected. */
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
              null,
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
          await this.perform('divest', { amount: payout.amount, source: FUND_ID }, null, `divest:${payout.index}`),
        );
        await this.exclusive(() => this.save(undefined, { fund: { ...this.fund, owed: owed.toSpliced(at, 1) } }), {
          wait: true,
        });
        continue;
      }
      const id = String(payout.source).toLowerCase();
      // A table pays the channel that bought into it: its money never arrives as another asset.
      if (!this.channel.tables?.[id]) continue;
      try {
        this.verifyPayout(payout);
      } catch (error: any) {
        // A payout nobody entitled signed is recorded for the player; the wallet signs nothing for it.
        await this.noteTable(id, { alert: error.message });
        continue;
      }
      const saved = this.channel.tables?.[id];
      collected.push(
        await this.perform(
          'payout',
          { amount: payout.amount, source: id },
          null,
          `payout:${id}:${payout.index}`,
          saved?.game && this.game?.key === saved.game.key ? saved.game : undefined,
        ),
      );
    }
    return collected;
  }
  async noteTable(this: CasinoWallet, id: string, values: Record<string, unknown>) {
    await this.exclusive(
      async () => {
        const c = this.channel;
        if (!c?.tables?.[id]) return;
        c.tables = { ...c.tables, [id]: { ...c.tables[id], ...values } };
        await this.save();
      },
      { wait: true },
    );
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
  /** A declined bet on this channel's own round comes back with the round's secret. A seat a hosted
   * round declined, or one the player withdrew, learns the secret and the host's seed once that
   * round is closed; the wallet then records what the bet would have paid. A round nobody closed
   * never had an outcome anybody knew. */
  async auditRejections(this: CasinoWallet) {
    const c = this.channel;
    if (!c?.key || this.recoveryOnly) return [];
    const audited: any[] = [];
    for (const receipt of this.history) {
      if (receipt.status !== 'rejected' || receipt.kind !== 'bet' || receipt.wouldHavePaid !== undefined) continue;
      if (receipt.unaudited || !same(receipt.request?.channelId, c.state.channelId)) continue;
      const round = await this.api(`/api/rounds/${receipt.request.round}`).catch(error => {
        // A round the casino does not know will never be revealed.
        if (error.status === 404) return null;
        throw error;
      });
      if (round && !round.secret) continue;
      if (round && !same(roundId(round.secret), receipt.request.round))
        throw new Error('The revealed secret does not match the rejected wager');
      const seed = receipt.seed ?? round?.seed;
      audited.push(
        round && bytes32(seed) && same(seedHash(seed), receipt.request.seedHash)
          ? { ...receipt, wouldHavePaid: String(outcome(receipt.request.prizes, seed, round.secret).payout) }
          : { ...receipt, unaudited: true },
      );
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
    const c = this.channel;
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
