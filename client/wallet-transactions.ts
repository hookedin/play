import type { TransactionReceipt, TransactionResponse, TransactionRequest } from 'ethers';
import type { Checkpoint, Integer } from '../protocol/types.ts';
import type { ChainBlock } from '../protocol/chain-observer.ts';
import type { CasinoWallet } from './wallet.ts';
import { exact } from './activity.ts';
import { ZeroAddress, getAddress, keccak256, Transaction } from 'ethers';
import {
  KIND,
  STATUS,
  channelId,
  plain,
  same,
  hashState,
  hashOperation,
  withdrawalRecorded,
  verifyEvidence,
  checkpointEvidence,
  quoteTerms,
  offerTerms,
  verifyOffer,
  STATE_TYPES,
  DEPOSIT_FEE_ID,
} from '../protocol/protocol.ts';
import { mapBounded } from '../protocol/concurrency.ts';
import {
  confirmedReceipt,
  depositFee,
  findNonceTransaction,
  gasLimitFor,
  sameTransactionIntent,
} from '../protocol/transaction-recovery.ts';
/** What the wallet signs by itself as money comes into the balance: a deposit taken in, and its network fee the casino
 * pays. It goes before anything else the player signs. */
export const inbound = (kind?: string) => kind === 'taken-in' || kind === 'deposit-fee';
/** ETH that arrived at the account's address, as Activity lists it. */
export const addressReceipt = (amount: bigint, createdAt: string) => ({
  kind: 'received',
  operationId: 'received:' + createdAt,
  amount: String(amount),
  status: 'confirmed',
  createdAt,
});
/** The most gas a withdrawal fee may pay for, twice what sending a withdrawal costs: the wallet signs no fee above it
 * at the gas price it reads itself. */
const MOST_WITHDRAWAL_GAS = 300_000n;
/** Everything that signs or recovers an on-chain transaction: deposits, withdrawals, closes, claims,
 * challenges, fee caps, nonce recovery and confirmed-receipt bookkeeping. The wallet
 * class is a chain: `CasinoWallet` extends `GameSessions` extends `ChannelClient`
 * extends this, so each method declares `this: CasinoWallet`. */
export class WalletTransactions {
  /** Sign, save and broadcast one transaction from this account's address, under the wallet's lock. `whole` marks a
   * deposit of everything the address held, which kept back the most its transaction can cost, which the casino pays. */
  async sendTransaction(
    this: CasinoWallet,
    method: string,
    args: any[] = [],
    overrides: TransactionRequest = {},
    { whole = false } = {},
  ) {
    this.requireDurableState();
    await this.assertNetwork();
    const { address, signer, provider, contract } = this;
    const value = BigInt(overrides.value ?? 0);
    if (value < 0n) throw new Error('Transaction value cannot be negative.');
    // A deposit of everything the address holds is priced before its value is known, and keeps that price.
    const fees = overrides.gasLimit
      ? {
          maxCost: BigInt(overrides.gasLimit) * BigInt(overrides.maxFeePerGas!),
          overrides: {
            gasLimit: BigInt(overrides.gasLimit),
            maxFeePerGas: BigInt(overrides.maxFeePerGas!),
            maxPriorityFeePerGas: BigInt(overrides.maxPriorityFeePerGas!),
            type: 2,
          },
        }
      : await this.transactionFees(method, args, value);
    const [balance, latestNonce, pendingNonce] = await Promise.all([
      provider.getBalance(address, 'pending'),
      provider.send('eth_getTransactionCount', [address, 'latest']),
      provider.send('eth_getTransactionCount', [address, 'pending']),
    ]);
    // Public RPCs may omit pending debits from balance queries. Do not build a
    // second transaction against that balance until the first one is mined.
    if (BigInt(latestNonce) !== BigInt(pendingNonce))
      throw new Error('A wallet transaction is pending. Wait for confirmation before sending another.');
    const nonce = Number(BigInt(pendingNonce));
    if (overrides.nonce != null && BigInt(overrides.nonce) !== BigInt(pendingNonce))
      throw new Error('The wallet nonce changed. Recover the pending operation before sending again.');
    if (balance < value + fees.maxCost) {
      throw new Error(
        `Your address holds too little for this transaction: its fee can be up to ${exact(fees.maxCost)} METH. Send that much ETH to ${address} first, with "Add ETH that arrives at my deposit address to my balance" off in Settings.`,
      );
    }
    await this.assertNetwork();
    if (address !== this.address || signer !== this.signer || provider !== this.provider || contract !== this.contract)
      throw new Error('The account changed. Check the amount and try again.');
    // Pin the same gas limit and fee caps used by the reserve check. Neither
    // the caller nor a later provider estimate can raise this cost silently.
    const pinnedOverrides = {
      value,
      nonce,
      chainId: this.expectedChainId,
      ...fees.overrides,
    };
    this.requireDurableState();
    if (this.transactionIntent) throw new Error('Recover the saved transaction before sending another');
    // `send` pays ETH straight to the address it names, calling no contract.
    const recipient = method === 'send' ? getAddress(args[0]) : null;
    // Signed, then saved, then broadcast: a lost reply leaves exactly this transaction to look for or send again.
    const raw = await signer.signTransaction(
      recipient
        ? { to: recipient, data: '0x', ...pinnedOverrides }
        : await contract[method].populateTransaction(...args, pinnedOverrides),
    );
    this.transactionIntent = {
      method,
      args: plain(args),
      value: String(value),
      nonce,
      to: recipient ?? (await contract.getAddress()),
      data: recipient ? '0x' : contract.interface.encodeFunctionData(method, args),
      fees: plain(fees.overrides),
      ...(whole ? { whole } : {}),
      raw,
      hash: keccak256(raw),
    };
    // The signed close and its fence are one durable write. An estimate or signing failure leaves the channel
    // usable; once signed, its evidence must stay frozen even if the transaction is replaced or reorganized out.
    if (method === 'startClose' || method === 'dispute')
      this.channels[channelId(args[0].base.player, args[0].base.index)].closing = true;
    await this.save();
    return provider.broadcastTransaction(raw);
  }
  async transactionFees(this: CasinoWallet, method: string, args: any[] = [], value = 0n) {
    const [estimate, fees] = await Promise.all([
      this.contract[method].estimateGas(...args, {
        value,
        chainId: this.expectedChainId,
      }),
      this.provider.getFeeData(),
    ]);
    if (
      typeof estimate !== 'bigint' ||
      estimate <= 0n ||
      typeof fees.maxFeePerGas !== 'bigint' ||
      fees.maxFeePerGas <= 0n ||
      typeof fees.maxPriorityFeePerGas !== 'bigint' ||
      fees.maxPriorityFeePerGas < 0n ||
      fees.maxPriorityFeePerGas > fees.maxFeePerGas
    ) {
      throw new Error('Network fees could not be estimated. Try again before choosing an amount.');
    }
    const gasLimit = gasLimitFor(estimate);
    this.checkTransactionBudget(gasLimit, fees.maxFeePerGas);
    return {
      maxCost: gasLimit * fees.maxFeePerGas,
      overrides: {
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        type: 2,
      },
    };
  }
  checkTransactionBudget(this: CasinoWallet, gasLimit: bigint, feePerGas: bigint) {
    if (
      gasLimit <= 0n ||
      feePerGas <= 0n ||
      gasLimit > 2000000n ||
      feePerGas > 200000000000n ||
      gasLimit * feePerGas > 50000000000000000n
    )
      throw new Error(
        'Transaction exceeds the fee caps (2,000,000 gas, 200 gwei, 50,000 METH total). Check the RPC or use independent recovery with reviewed fees',
      );
  }
  /** What this account's address can put into its balance: everything but the deposit's own fee, priced once for both
   * the amount and the transaction. */
  async depositable(this: CasinoWallet) {
    await this.assertNetwork();
    const [balance, fees] = await Promise.all([
      this.provider.getBalance(this.address, 'pending'),
      this.transactionFees('deposit', [this.address], 1n),
    ]);
    const rest = balance - fees.maxCost;
    this.depositFee = fees.maxCost;
    return { amount: rest > 0n ? rest : 0n, fee: fees.maxCost, overrides: fees.overrides };
  }
  /** Move money from this account's address into its channel: the contract opens the channel with the account's first
   * deposit, and the balance takes the money in once the casino has seen it confirmed. With no amount, everything the
   * address holds. */
  async deposit(this: CasinoWallet, amount?: Integer) {
    await this.exclusive(async () => {
      if (amount !== undefined) return this.depositLocked(amount);
      const { amount: all, overrides } = await this.depositable();
      if (!all) throw new Error('Your address holds too little to add after network fees.');
      return this.depositLocked(all, overrides, true);
    });
    await this.refresh();
    await this.takeDeposits();
  }
  /** ETH at this address goes into its balance while the wallet `sweeps`. An amount smaller than its own fee stays
   * where it is. */
  async sweep(this: CasinoWallet) {
    // While collateral is offered, ETH at the address pays for it first.
    if (this.buying) return this.buyOffered();
    if (!this.sweeps) return;
    const added = await this.exclusive(
      async () => {
        if (!this.sweeps) return null;
        const { amount, fee, overrides } = await this.depositable();
        return amount > fee ? this.depositLocked(amount, overrides, true) : null;
      },
      { wait: true },
    );
    if (added) {
      await this.refresh();
      await this.takeDeposits();
    }
  }
  /** Buy `amount` of collateral for the balance at the casino's rate: the casino offers it, signed, and this
   * account pays its price from its address in one transaction, which locks the collateral into its channel or does
   * nothing. ETH the address does not hold yet is waited for while the offer lasts, and the sweep buys with it before
   * it adds anything to the balance. Says whether it is bought. */
  async buyCollateral(this: CasinoWallet, amount: bigint) {
    const c = this.channel;
    if (!this.playable || !c) throw new Error('Open a balance before buying collateral.');
    if (this.recoveryOnly || this.config.collateralRate == null)
      throw new Error('The casino offers no collateral now.');
    const { offer } = await this.api(`/api/channels/${c.opening.channelId}/collateral`, { amount: String(amount) });
    this.buying = verifyOffer(this.domain, offer, c.opening, amount, BigInt(this.config.collateralRate), this.operator);
    this.render();
    return this.buyOffered();
  }
  /** Buy the collateral offered once this account's address holds its price and fee, under the wallet's lock. An
   * offer about to expire is let go, and so is one whose balance has started closing: ETH that arrives then is for
   * the close's fees, and collateral would only protect the close. */
  async buyOffered(this: CasinoWallet) {
    const bought = await this.exclusive(
      async () => {
        const offer = this.buying;
        if (!offer) return false;
        if (
          !this.playable ||
          channelId(offer.message.player, offer.message.index) !== this.channel!.opening.channelId ||
          // Sent this late, it could expire before a block takes it.
          BigInt(offer.message.expiresAt) < BigInt(Math.floor(Date.now() / 1000) + 120)
        ) {
          this.buying = null;
          return false;
        }
        const price = BigInt(offer.message.price),
          balance = await this.provider.getBalance(this.address, 'pending');
        if (balance <= price) return false;
        const fees = await this.transactionFees('buyCollateral', offerTerms(offer), price).catch(error => {
          if (error.code !== 'CALL_EXCEPTION') throw error;
          // One the contract refuses stays refused: the house cash it would lock is gone.
          this.buying = null;
          throw new Error(
            'The contract refuses this offer now: the house cash it would lock is spoken for. Ask again.',
          );
        });
        if (balance < price + fees.maxCost) return false;
        // Sent, the offer is bought or spent.
        this.buying = null;
        this.onProgress('Buying collateral…');
        await this.waitTransaction(
          await this.sendTransaction('buyCollateral', offerTerms(offer), { value: price, ...fees.overrides }),
        );
        return true;
      },
      { wait: true },
    );
    this.render();
    if (bought) await this.refresh();
    return bought;
  }
  /** A deposit into this account's channel, under the wallet's lock. While it runs, `depositing` says what it adds: a
   * deposit of everything the address holds (`whole`), priced in `fees`, with its network fee the casino pays. */
  async depositLocked(this: CasinoWallet, amount: Integer, fees: Record<string, any> = {}, whole = false) {
    if (BigInt(amount) <= 0n || BigInt(amount) >= 1n << 256n)
      throw new Error('Deposit must be a positive uint256 amount');
    if (this.missingChannel)
      throw new Error(
        'The casino holds another state of your balance than this browser: import your recovery bundle first.',
      );
    // An operation waits for its channel; one a reorganisation took a deposit back from plays again once it lands.
    if (this.pending && !inbound(this.pending.kind) && this.playable)
      throw new Error('Finish the saved operation before depositing.');
    // Once the close is on-chain, a deposit goes into the account's next channel.
    if (this.channel?.closing) throw new Error('Your balance is closing. Deposit once the close is on-chain.');
    this.depositing =
      BigInt(amount) +
      (whole ? this.depositFeePaid(BigInt(amount), BigInt(fees.gasLimit) * BigInt(fees.maxFeePerGas)) : 0n);
    this.render();
    try {
      this.onProgress('Adding ETH to your balance…');
      const tx = await this.sendTransaction('deposit', [this.address], { value: BigInt(amount), ...fees }, { whole });
      await this.waitTransaction(tx);
      return true;
    } finally {
      this.depositing = 0n;
    }
  }
  /** What the casino pays of the network fee of a deposit of `amount` that kept back `fee` for it: all of it, when it is
   * at most the casino's `depositFeeLimit` in millionths of the deposit and its daily budget has room, and otherwise
   * nothing. */
  depositFeePaid(this: CasinoWallet, amount: bigint, fee: bigint) {
    const limit = this.config.depositFeeLimit;
    return limit != null && fee * 1_000_000n <= amount * BigInt(limit) ? fee : 0n;
  }
  /** Take into the balance what was deposited into its channel and not taken in yet: a deposit operation, which
   * the casino signs once it has seen the money confirmed. Then collect the network fee of each deposit of everything
   * the address held, which the casino pays: what its transaction kept back, so the balance holds all the address had,
   * up to what the rule the wallet prices its transactions by allows (`depositFee`). One that is waiting for the casino
   * is asked again. */
  async takeDeposits(this: CasinoWallet) {
    const c = this.channel,
      pending = this.pending;
    if (pending)
      return inbound(pending.kind)
        ? this.takeIn(pending.kind, pending.request.amount, pending.details.id, pending.operationId)
        : null;
    if (!this.playable || !c || !c.registered) return null;
    const waiting = BigInt(c.onchain.deposited) - BigInt(c.state.deposited);
    // Named for the state it follows, so each take-in has an ID of its own.
    if (waiting > 0n)
      await this.perform('taken-in', { amount: waiting }, `taken-in:${c.opening.channelId}:${c.state.sequence}`);
    const paid = new Set(this.history.filter(entry => entry.kind === 'deposit-fee').map(entry => entry.operationId));
    const deposit = this.history.find(
      entry =>
        entry.kept &&
        entry.status === 'confirmed' &&
        same(entry.channelId, c.opening.channelId) &&
        !paid.has(`deposit-fee:${entry.txHash}`) &&
        this.depositFeePaid(BigInt(entry.amount), BigInt(entry.kept)),
    );
    if (!deposit) return null;
    const receipt = await this.provider.getTransactionReceipt(deposit.txHash),
      before = receipt && (await this.provider.getBlock(receipt.blockNumber - 1));
    if (!receipt || before?.baseFeePerGas == null) return null;
    const { fees } = deposit.intent,
      amount = depositFee(
        {
          gasLimit: BigInt(fees.gasLimit),
          maxFeePerGas: BigInt(fees.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
        },
        receipt.gasUsed,
        before.baseFeePerGas,
      );
    return this.takeIn('deposit-fee', amount, deposit.txHash, `deposit-fee:${deposit.txHash}`);
  }
  /** Sign and send money coming into the balance. A deposit's fee the casino does not pay, because it pays no more today
   * or answered it at a state this wallet has since taken up from another device, is refused when asked again, for
   * good: its deposit asks no more. */
  async takeIn(this: CasinoWallet, kind: string, amount: Integer, transaction: string, operationId: string) {
    try {
      const fee = kind === 'deposit-fee' ? { transaction, source: DEPOSIT_FEE_ID } : {};
      return await this.perform(kind, { amount, ...fee }, operationId);
    } catch (error: any) {
      if (kind !== 'deposit-fee' || !['id-conflict', 'not-due'].includes(error.code) || error.status !== 409)
        throw error;
      await this.exclusive(
        async () => {
          if (this.pending?.operationId !== operationId) return;
          const deposit = this.history.find(entry => entry.kept && same(entry.txHash ?? '', transaction));
          this.pending = null;
          this.pendingError = null;
          if (!deposit) return this.save();
          const { kept, ...answered } = deposit;
          await this.save(answered);
        },
        { wait: true },
      );
      return null;
    }
  }
  /** Send everything at this account's address, less the network fee, to another address, as a saved transaction like
   * any other: how withdrawAddress empties the address. Under the wallet's lock. Returns the withdrawal's record. */
  async sendAll(this: CasinoWallet, recipient: string) {
    await this.assertNetwork();
    const [fees, balance, gasLimit] = await Promise.all([
      this.provider.getFeeData(),
      this.provider.getBalance(this.address, 'pending'),
      this.provider.estimateGas({ from: this.address, to: recipient, value: 1n }),
    ]);
    if (!fees.maxFeePerGas || fees.maxPriorityFeePerGas == null)
      throw new Error('Network fees could not be estimated. Try again.');
    this.checkTransactionBudget(gasLimit, fees.maxFeePerGas);
    const amount = balance - gasLimit * fees.maxFeePerGas;
    if (amount <= 0n) throw new Error('Your address holds too little to withdraw after network fees.');
    this.onProgress('Withdrawing…');
    const tx = await this.sendTransaction('send', [recipient], {
      value: amount,
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chainId: this.expectedChainId,
      type: 2,
    });
    const receipt = await this.waitTransaction(tx);
    return this.history.find(entry => entry.txHash === receipt.hash);
  }
  /** Register this account's channel with the casino, or look it up there: either way the casino answers with the state
   * it holds. A channel still at its base is taken up there. A later state is the reply to this wallet's saved
   * operation, which it lost, or play on this account from another device or before this browser's data was lost. */
  async activate(this: CasinoWallet) {
    if (this.recoveryOnly) return;
    const reply = await this.api(`/api/channels/${this.channel!.opening.channelId}/activate`, {}),
      head = this.newerHead(reply.head);
    this.noteNames(reply);
    // Saving reloads the wallet's channels, so the channel is read after.
    if (head) await this.save(undefined, { head });
    const c = this.channel!;
    if (same(hashState(this.domain, reply.state), hashState(this.domain, c.state))) {
      if (c.registered) return;
      this.missingChannel = null;
      c.registered = true;
      return this.save();
    }
    // Until this wallet holds the state the casino does, it plays nothing on the channel and puts nothing into it.
    if (!c.registered) this.missingChannel = c.opening.channelId;
    const last = reply.lastResponse,
      pending = this.pending,
      answered = last && (last.status === 'rejected' ? last.request : last.evidence.step.operation);
    if (
      pending?.request &&
      answered &&
      same(hashOperation(this.domain, answered), hashOperation(this.domain, pending.request))
    )
      return this.accept(last, pending.operationId, pending.kind);
    if (last && BigInt(reply.state.sequence) > BigInt(c.state.sequence)) return this.takeUp(reply.state, last);
    throw new Error('The casino holds another state of your balance than this browser: import your recovery bundle.');
  }
  /** Take up the casino's state of this account's channel, with the reply that signed it, or none at its base. The
   * casino cannot make one up: its evidence carries this account's own signatures, and a declined operation's state
   * moves no money. A saved operation is void, since it names another state. */
  async takeUp(this: CasinoWallet, state: Checkpoint, last: any) {
    const c = this.channel!,
      rejected = last?.status === 'rejected';
    const next = verifyEvidence({
      chainId: this.expectedChainId,
      casino: this.config.contractAddress,
      operator: this.operator,
      evidence: last?.evidence ?? checkpointEvidence(state),
    }).state;
    if (
      channelId(next.player, next.index) !== c.opening.channelId ||
      !same(hashState(this.domain, next), hashState(this.domain, state))
    )
      throw new Error("The casino's state of your balance differs from its evidence.");
    const casinoSignature = !last
        ? '0x'
        : rejected
          ? last.evidence.casinoSignature
          : last.evidence.step.casinoSignature,
      playerSignature = !last
        ? '0x'
        : rejected
          ? last.evidence.playerSignature
          : await this.signer.signTypedData(this.domain, STATE_TYPES, next);
    this.channels[c.opening.channelId] = {
      ...c,
      state: next,
      playerSignature,
      casinoSignature,
      lastResponse: last,
      pending: null,
      registered: true,
      quote: undefined,
    };
    this.missingChannel = null;
    await this.save();
  }
  /** What the casino holds of this account, as it answers the account itself: its channel's state with the reply that
   * signed it, its bankroll shares and what it owes the account. Each part it did not give is its error. */
  async casinoRecord(this: CasinoWallet) {
    const ask = (path: string, body?: unknown) =>
        this.api(path, body).catch((error: any) => ({ error: error.message })),
      id = this.channel?.opening.channelId;
    const [channel, fund, payouts] = await Promise.all([
      id ? ask(`/api/channels/${id}/activate`, {}) : null,
      ask('/api/account/fund'),
      ask('/api/account/payouts'),
    ]);
    return { channel, fund, payouts };
  }
  /** Take up the casino's state of this account's channel whatever this browser holds: an earlier state, or another at
   * the same sequence, which the wallet never takes up by itself, and a saved operation is dropped. `stateHash` names the
   * state the player agreed to: one the casino has moved on from is refused. */
  async takeUpCasinoState(this: CasinoWallet, stateHash: string) {
    await this.exclusive(
      async () => {
        const c = this.channel;
        if (!c || c.closing || this.transactionIntent)
          throw new Error("Only an open balance with no transaction in flight takes up the casino's state.");
        const reply = await this.api(`/api/channels/${c.opening.channelId}/activate`, {});
        if (!same(hashState(this.domain, reply.state), stateHash))
          throw new Error("The casino's state changed since you compared: compare again.");
        await this.takeUp(reply.state, reply.lastResponse);
        this.pendingError = null;
      },
      { wait: true },
    );
  }
  /** A local casino sends this account's address demo ETH, and the sweep puts it into the balance. */
  async setupDemo(this: CasinoWallet) {
    if (!this.isLocalDevelopment) throw new Error('Automatic funding is local only');
    await this.api('/api/demo-eth', { address: this.address });
    await this.refresh();
    await this.sweep();
  }
  async waitTransaction(this: CasinoWallet, tx: TransactionResponse) {
    this.lastChainCheck = 0;
    let receipt;
    try {
      receipt = await tx.wait(this.config.confirmations, 90000);
    } catch (error: any) {
      if (!['TRANSACTION_REPLACED', 'CALL_EXCEPTION'].includes(error.code) || !error.receipt) throw error;
      receipt = error.receipt;
    }
    receipt = await confirmedReceipt(this.transactionRecovery(), receipt?.hash || tx.hash);
    if (!receipt) throw new Error('Transaction is awaiting corroborated confirmation; recover again shortly');
    await this.acceptTransaction(receipt);
    return receipt;
  }
  transactionRecord(this: CasinoWallet, receipt: TransactionReceipt, intent: any, status = 'confirmed') {
    const sent = intent?.method === 'send';
    let amount = status === 'confirmed' ? intent?.value || '0' : '0',
      to: string | undefined = sent ? intent.to : undefined,
      collateral: string | undefined,
      deposited: string | undefined;
    for (const log of receipt.logs || []) {
      // ETH sent from the address calls no contract: whatever its recipient logs is not the casino's.
      if (sent || status !== 'confirmed' || !same(log.address, intent?.to || this.config.contractAddress)) continue;
      try {
        const event = this.reader.interface.parseLog(log);
        // What a claim paid, and where: this account's address, or the one it named.
        if (event?.name === 'ClaimPayment') {
          amount = String(event.args.amount);
          to = event.args.recipient;
        }
        // What a close recorded as owed to the balance, collected later.
        if (event?.name === 'CloseFinalized') amount = String(event.args.amount);
        if (event?.name === 'CollateralBought') collateral = String(event.args.amount);
        if (event?.name === 'ChannelDeposit') deposited = channelId(event.args.player, event.args.index);
      } catch {}
    }
    // What a deposit of everything the address held kept back for its fee, which the casino pays: the transaction that
    // mined must be the one those fees priced.
    const kept =
      intent?.whole && deposited && same(receipt.hash, intent.hash)
        ? String(BigInt(intent.fees.gasLimit) * BigInt(intent.fees.maxFeePerGas))
        : undefined;
    return {
      kind:
        status !== 'confirmed'
          ? 'transaction'
          : intent?.method === 'deposit'
            ? 'deposit'
            : intent?.method === 'buyCollateral'
              ? 'collateral'
              : ['claim', 'claimTo', 'send'].includes(intent?.method)
                ? 'withdrawal'
                : intent?.method === 'startClose'
                  ? 'close-started'
                  : intent?.method === 'dispute'
                    ? 'bet-disputed'
                    : intent?.method === 'finalizeClose'
                      ? 'closure'
                      : 'dispute',
      operationId: 'tx:' + receipt.hash,
      amount,
      ...(to && !same(to, this.address) ? { to } : {}),
      ...(collateral ? { collateral } : {}),
      ...(kept ? { kept, channelId: deposited } : {}),
      txHash: receipt.hash,
      ...(receipt.fee === undefined ? {} : { fee: String(receipt.fee) }),
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      intent,
      status,
      createdAt: new Date().toISOString(),
    };
  }
  async recordTransaction(this: CasinoWallet, receipt: TransactionReceipt, status = 'confirmed') {
    const record = this.transactionRecord(receipt, this.transactionIntent, status);
    // What the address held before the block the transaction is in, beyond the last look, arrived meanwhile; what it
    // held once it had run is the next look's start. A state too old to read starts the next look afresh.
    const [before, after] = await Promise.all(
      [receipt.blockNumber - 1, receipt.blockNumber].map(async block => this.provider.getBalance(this.address, block)),
    ).catch(() => [null, null]);
    if (before !== null && this.atAddress !== null && before > BigInt(this.atAddress))
      this.history = [addressReceipt(before - BigInt(this.atAddress), record.createdAt), ...this.history];
    await this.save(record, { transactionIntent: null, atAddress: after === null ? null : String(after) });
  }
  transactionRecovery(this: CasinoWallet) {
    return { provider: this.provider, observer: this.observer, confirmations: this.config.confirmations };
  }
  async transactionStatus(this: CasinoWallet, receipt: TransactionReceipt, intent: any) {
    const read = async (provider: any) => {
      const tx = await provider.getTransaction(receipt.hash);
      return tx && { from: tx.from, to: tx.to, nonce: tx.nonce, data: tx.data, value: tx.value };
    };
    const transaction = await this.observer.corroborate('transaction intent', read);
    if (!transaction) throw new Error('Confirmed transaction data is unavailable; recover again shortly');
    return !sameTransactionIntent(transaction, intent, this.address)
      ? 'replaced'
      : receipt.status === 1
        ? 'confirmed'
        : 'reverted';
  }
  async acceptTransaction(this: CasinoWallet, receipt: TransactionReceipt) {
    if (!this.transactionIntent) return;
    const status = await this.transactionStatus(receipt, this.transactionIntent);
    await this.recordTransaction(receipt, status);
    if (status === 'replaced')
      throw new Error(
        'Saved transaction was cancelled or replaced with a different action. No channel payment was recorded',
      );
    if (status === 'reverted') throw new Error('Saved transaction reverted; retry the intended action');
  }
  async observeTransactionHistory(this: CasinoWallet, block: ChainBlock, history = this.history) {
    // Activity is capped at 100 entries. Share block checks across transactions
    // and only fetch receipts again when their saved branch changed when first observed.
    const blocks = new Map();
    // Whether the block at `number` is still the one with `hash`, so that what was read there stands.
    const canonical = async (number: number, hash: string) => {
      if (!hash || number > block.number) return false;
      if (!blocks.has(number))
        blocks.set(
          number,
          this.observer.corroborate('transaction blocks', async p => (await p.getBlock(number))?.hash || null),
        );
      return (await blocks.get(number)) === hash;
    };
    return mapBounded(history, async entry => {
      // A withdrawal is read again until it is paid or returned, and after that when the block that said so has left
      // the chain.
      if (entry.withdrawal)
        return (entry.paid || entry.returned) && (await canonical(entry.settledAt?.number, entry.settledAt?.hash))
          ? entry
          : this.withdrawalState(entry, block);
      if (!entry.txHash) return entry;
      if ((await canonical(entry.blockNumber, entry.blockHash)) && entry.status !== 'orphaned') return entry;
      const receipt = await confirmedReceipt(this.transactionRecovery(), entry.txHash);
      if (!receipt || receipt.blockNumber > block.number)
        return { ...entry, status: 'orphaned', previousStatus: entry.previousStatus || entry.status };
      if (entry.intent)
        return {
          ...this.transactionRecord(receipt, entry.intent, await this.transactionStatus(receipt, entry.intent)),
          createdAt: entry.createdAt,
        };
      throw new Error('Transaction history has no saved intent');
    });
  }
  async recoverTransaction(this: CasinoWallet, { replace = false, wait = true } = {}) {
    this.requireDurableState();
    const intent = this.transactionIntent;
    if (!intent) return;
    this.lastChainCheck = 0;
    await this.assertNetwork();
    const options = this.transactionRecovery();
    for (const hash of new Set([intent.hash, ...(intent.attempts ?? [])])) {
      const receipt = await confirmedReceipt(options, hash);
      if (receipt) return this.acceptTransaction(receipt);
    }
    const replacement = await findNonceTransaction({ ...options, address: this.address, nonce: intent.nonce });
    if (replacement) return this.acceptTransaction(replacement.receipt);
    // A consumed nonce may be awaiting the configured confirmation depth.
    if ((await this.provider.getTransactionCount(this.address, 'latest')) > intent.nonce)
      throw new Error('Replacement is awaiting confirmation; recover again shortly');
    if (replace) {
      const original = Transaction.from(intent.raw);
      if (!sameTransactionIntent(original, intent, this.address))
        throw new Error('Saved transaction differs from the original intent');
      const fees = await this.provider.getFeeData(),
        bump = (n: any) => (BigInt(n) * 9n + 7n) / 8n + 1n;
      const maxFeePerGas = [
        bump(original.maxFeePerGas ?? original.gasPrice),
        (fees.maxFeePerGas ?? fees.gasPrice)!,
      ].reduce((a, b) => (a > b ? a : b));
      const maxPriorityFeePerGas = bump(original.maxPriorityFeePerGas ?? 0n);
      this.checkTransactionBudget(original.gasLimit, maxFeePerGas);
      if ((await this.provider.getBalance(this.address)) < original.value + original.gasLimit * maxFeePerGas)
        throw new Error('Add ETH to your deposit address before speeding up');
      const request = {
        to: original.to,
        data: original.data,
        value: original.value,
        gasLimit: original.gasLimit,
        nonce: original.nonce,
        chainId: this.expectedChainId,
        type: 2,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
      await this.assertNetwork();
      intent.attempts ??= [intent.hash];
      intent.fees = plain({ gasLimit: request.gasLimit, maxFeePerGas, maxPriorityFeePerGas });
      const raw = await this.signer.signTransaction(request),
        hash = keccak256(raw);
      intent.attempts.push(hash);
      Object.assign(intent, { raw, hash });
      await this.save();
      await this.provider.broadcastTransaction(raw);
    } else if (!(await this.provider.getTransaction(intent.hash))) {
      await this.provider.broadcastTransaction(intent.raw);
    }
    if (!wait) return intent.hash;
    await this.provider.waitForTransaction(intent.hash, options.confirmations, 90000);
    const receipt = await confirmedReceipt(options, intent.hash);
    if (!receipt) throw new Error('Transaction remains pending; recover or speed it up');
    await this.acceptTransaction(receipt);
  }
  async speedUpTransaction(this: CasinoWallet) {
    const hash = await this.exclusive(() => this.recoverTransaction({ replace: true, wait: false }));
    await this.refresh();
    return hash;
  }
  /** Withdraw `amount` of the balance, or all it can, to an address. In one operation the balance pays it and pays the
   * casino its fee for sending it, and the contract makes it a claim once anyone sends the operation and the casino's
   * signature after it, which the casino does straight away: it pays the address what the deposits the balance has
   * taken in and house cash cover, and the rest as house cash arrives. One the casino cannot pay now is declined, with
   * why. */
  async withdraw(this: CasinoWallet, to: string, amount?: Integer) {
    const recipient = this.recipient(to),
      c = this.channel;
    if (!c || !this.playable) throw new Error('No balance is open to withdraw from.');
    const fee = await this.signedWithdrawalFee(),
      withdrawable = this.withdrawable(),
      value = amount === undefined ? withdrawable : BigInt(amount);
    if (value <= 0n || value > withdrawable)
      throw new Error(
        `Not that much is in your balance: ${exact(withdrawable)} METH can go, after the fee of ${exact(fee)} METH for sending it.`,
      );
    // The open game may risk no more than stays in the balance, what its groups hold included.
    if (this.game && BigInt(this.game.allowance) + this.inPlay() > withdrawable - value) {
      const left = withdrawable - value - this.inPlay();
      this.game.allowance = String(left < 0n ? 0n : left);
    }
    const receipt = await this.perform('withdrawal', { amount: value, recipient, fee }, crypto.randomUUID());
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this withdrawal.');
    return receipt;
  }
  /** Transfer `amount` of the balance to another player, as their public profile names them: a debit that names their
   * uname, which their wallet collects into their balance, deposit or none. Nothing goes on-chain, so it
   * costs no fee and tells nobody either account's address; it is the casino's to pay until they collect it. */
  async transfer(this: CasinoWallet, to: { uname: string; discordUsername: string | null }, amount: Integer) {
    const c = this.channel,
      value = BigInt(amount),
      balance = BigInt(c?.state.balance || 0);
    if (!c || !this.playable) throw new Error('No balance is open to transfer from.');
    if (to.uname === this.uname) throw new Error('A transfer goes to another player.');
    if (value <= 0n || value > balance)
      throw new Error(`Not that much is in your balance: ${exact(balance)} METH can go.`);
    // The open game may risk no more than stays in the balance, what its groups hold included.
    if (this.game && BigInt(this.game.allowance) + this.inPlay() > balance - value) {
      const left = balance - value - this.inPlay();
      this.game.allowance = String(left < 0n ? 0n : left);
    }
    const receipt = await this.perform(
      'transfer',
      { amount: value, source: '~' + to.uname, name: to.discordUsername ? '@' + to.discordUsername : '~' + to.uname },
      crypto.randomUUID(),
    );
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this transfer.');
    return receipt;
  }
  /** Send everything at this account's address to another address, less the network fee: the way out for ETH that
   * stays at the address, which never touches the balance. */
  async withdrawAddress(this: CasinoWallet, to: string) {
    const recipient = this.recipient(to);
    const receipt = await this.exclusive(() => this.sendAll(recipient));
    await this.refresh();
    return receipt;
  }
  /** An address a withdrawal can pay: never the zero address or the contract. */
  recipient(this: CasinoWallet, to: string) {
    const recipient = getAddress(to.trim());
    if (same(recipient, ZeroAddress) || same(recipient, this.config.contractAddress))
      throw new Error('A withdrawal cannot pay that address: name another.');
    return recipient;
  }
  /** What a withdrawal or a lock-in can take of the open balance: all of it but the casino's fee for sending it, as last
   * asked for. */
  withdrawable(this: CasinoWallet) {
    const c = this.channel,
      left = BigInt(c?.state.balance || 0) - this.withdrawalFee;
    return left > 0n ? left : 0n;
  }
  /** Ask the casino what sending a withdrawal or a lock-in to the contract costs now: the fee it pays out of the
   * balance, up to `MOST_WITHDRAWAL_GAS` at the gas price the wallet reads itself. */
  async quoteWithdrawalFee(this: CasinoWallet) {
    const [{ fee }, { gasPrice }] = await Promise.all([this.api('/api/withdrawal-fee'), this.provider.getFeeData()]);
    if (!/^(0|[1-9][0-9]{0,28})$/.test(fee)) throw new Error('The casino sent no valid withdrawal fee');
    if (gasPrice == null || BigInt(fee) > MOST_WITHDRAWAL_GAS * gasPrice)
      throw new Error(`The casino asks a withdrawal fee of ${exact(BigInt(fee))} METH, more than sending one costs.`);
    this.withdrawalFee = BigInt(fee);
    this.render();
    return this.withdrawalFee;
  }
  /** The fee a withdrawal or a lock-in signs: what the casino asks now, which must be no more than the fee the player
   * was last shown. */
  async signedWithdrawalFee(this: CasinoWallet) {
    const shown = this.withdrawalFee,
      fee = await this.quoteWithdrawalFee();
    if (shown && fee > shown)
      throw new Error(`Sending it costs a fee of ${exact(fee)} METH now, more than shown: check and try again.`);
    return fee;
  }
  /** Lock in the balance: all of it but the fee for sending it goes into this account's current channel as
   * deposits the contract holds, for the balance to take in. The deposits the balance has taken in pay back what they
   * cover, and house cash pays the rest, the winnings. The casino sends it at once. */
  async lockIn(this: CasinoWallet) {
    const c = this.channel,
      fee = await this.signedWithdrawalFee(),
      amount = this.withdrawable();
    if (!c || !this.playable || !amount) throw new Error('No balance to lock in.');
    // All of it goes out and back in: the open game risks nothing meanwhile, and shows what its groups held.
    if (this.game) Object.assign(this.game, { allowance: '0', developerBets: false, table: {} });
    const receipt = await this.perform('lock-in', { amount, fee }, crypto.randomUUID());
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined locking in.');
    return receipt;
  }
  /** Where a withdrawal or a lock-in goes: the address a withdrawal pays, or for a lock-in this account's own channel,
   * which the contract's address stands for, as it does for a claim paid into it. */
  destination(this: CasinoWallet, op: { kind: Integer; recipient: string }) {
    return getAddress(Number(op.kind) === KIND.lockIn ? this.config.contractAddress : op.recipient);
  }
  /** Whether the contract would record this withdrawal next: it records a channel's withdrawals in the order they were
   * signed, so one waits while an earlier one of its channel is not a claim yet. */
  nextToRecord(this: CasinoWallet, entry: any) {
    const { player, index, sequence } = entry.proof.base;
    return !this.history.some(
      other =>
        other.withdrawal &&
        !other.recorded &&
        !other.returned &&
        same(other.proof.base.player, player) &&
        BigInt(other.proof.base.index) === BigInt(index) &&
        BigInt(other.proof.base.sequence) < BigInt(sequence),
    );
  }
  /** Where a withdrawal stands on-chain. Once sent it is recorded, as its channel's `claimed` shows, and its event names
   * the transaction that recorded it, looked for among recent blocks. What stays owed of it is a claim under its ID,
   * paying the claim's recipient, which its account can change; it is paid once nothing is owed, and until then what
   * can be collected now is read with it. One never recorded by the time its channel's close is final came back
   * with the close. A withdrawal paid or returned keeps the block it was read at (`settledAt`). */
  async withdrawalState(this: CasinoWallet, entry: any, block: ChainBlock) {
    const op = entry.proof.step.operation,
      here = { number: block.number, hash: block.hash };
    const [claim, payable, channel] = await Promise.all([
      this.observer.contractRead(this.reader, 'claims', [entry.withdrawal], block),
      this.observer.contractRead(this.reader, 'collectable', [entry.withdrawal], block),
      this.observer.contractRead(this.reader, 'channels', [entry.proof.base.player, entry.proof.base.index], block),
    ]);
    // Nothing read of it before stands: a reorganisation can take back a recording, a payment or a new recipient.
    const { recorded, owed, winningsRemaining, collectable, recordedIn, returned, settledAt, ...sent } = entry;
    if (!withdrawalRecorded(channel.claimed, entry.proof)) {
      return plain({
        ...sent,
        to: this.destination(op),
        paid: false,
        ...(Number(channel.status) === STATUS.finalized ? { returned: true, settledAt: here } : {}),
      });
    }
    const [event] = recordedIn
      ? []
      : await this.reader
          .queryFilter(
            this.reader.filters.Withdrawal(entry.withdrawal),
            Math.max(0, block.number - 10000),
            block.number,
          )
          .catch(() => []);
    const left = BigInt(claim.protectedRemaining) + BigInt(claim.winningsRemaining);
    return plain({
      ...sent,
      // A withdrawal paid in full at once leaves no claim, and so no recipient but its own.
      to: same(claim.recipient, ZeroAddress) ? this.destination(op) : getAddress(claim.recipient),
      recorded: true,
      paid: !left,
      owed: left,
      winningsRemaining: claim.winningsRemaining,
      collectable: payable,
      recordedIn: event?.transactionHash ?? recordedIn,
      ...(left ? {} : { settledAt: here }),
    });
  }
  /** Close the balance without the casino. A pending casino bet the casino's quote covers is disputed with it: the
   * casino then has 7 days to settle it on-chain, or it counts as won. */
  async startClose(this: CasinoWallet) {
    const result = await this.exclusive(async () => {
      if (!this.channel) throw new Error('No active channel');
      // Keep ETH added for the close's fees at the address, including after a failed estimate or gas check.
      if (this.autoDeposit) await this.save(undefined, { autoDeposit: false });
      const tx = this.disputable()
        ? await this.sendTransaction('dispute', [this.disputeEvidence(), quoteTerms(this.pending.quote)])
        : await this.sendTransaction('startClose', [this.evidence()]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh();
    return result;
  }
  /** Collect a claim: a closed balance's, under its channel's ID, or a withdrawal's, under the withdrawal's. */
  async claim(this: CasinoWallet, id: string, recipient?: string) {
    const result = await this.exclusive(async () => {
      this.onProgress('Collecting what the claim is owed…');
      const tx = await this.sendTransaction(
        recipient ? 'claimTo' : 'claim',
        recipient ? [id, getAddress(recipient)] : [id],
      );
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh(this.channels[id] ? { channelId: id } : {});
    return result;
  }
  async finalizeClose(this: CasinoWallet, key = this.closingChannel?.opening.channelId) {
    const result = await this.exclusive(async () => {
      const { player, index } = this.channels[key!].opening;
      const tx = await this.sendTransaction('finalizeClose', [player, index]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh({ channelId: key });
    return result;
  }
  /** Challenge a close with this wallet's newer evidence, or, when the close stops short of a pending casino bet the
   * casino's quote covers, by disputing the bet. */
  async challengeClose(this: CasinoWallet, channelId = this.closingChannel?.opening.channelId) {
    const result = await this.exclusive(async () => {
      const c = this.channels[channelId!];
      const tx = this.disputesClose(c)
        ? await this.sendTransaction('dispute', [this.disputeEvidence(c), quoteTerms(c.pending.quote)])
        : await this.sendTransaction('challengeClose', [this.evidence(c)]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh({ channelId });
    return result;
  }
}
