import type { TransactionReceipt, TransactionResponse, TransactionRequest } from 'ethers';
import type { Integer } from '../protocol/types.ts';
import type { ChainBlock } from '../protocol/chain-observer.ts';
import type { CasinoWallet } from './wallet.ts';
import { ZeroAddress, formatEther, getAddress, keccak256, Transaction } from 'ethers';
import { plain, same, hashState } from '../protocol/protocol.ts';
import { mapBounded } from '../protocol/concurrency.ts';
import { confirmedReceipt, findNonceTransaction, sameTransactionIntent } from '../protocol/transaction-recovery.ts';
import { withLock } from './storage.ts';
export const TRANSACTION_LIMITS = Object.freeze({
  gas: 2000000n,
  feePerGas: 200000000000n,
  totalFee: 50000000000000000n,
});
export const picked = (value: Record<string, any>, keys: string[]) =>
  plain(Object.fromEntries(keys.map(k => [k, value[k]])));
/** The durable projection of an on-chain channel record. */
export const channelRecord = (value: Record<string, any>) =>
  picked(value, [
    'player',
    'deposited',
    'principal',
    'paidOut',
    'status',
    'deadline',
    'closingSequence',
    'closingHash',
    'closingBalance',
  ]);

/** Everything that signs or recovers an on-chain transaction: deposits, withdrawals, closes, claims,
 * challenges, fee limits, nonce recovery and confirmed-receipt bookkeeping. The wallet
 * class is a chain: `CasinoWallet` extends `GameSessions` extends `ChannelClient`
 * extends this, so each method declares `this: CasinoWallet`. */
export class WalletTransactions {
  async sendTransaction(this: CasinoWallet, method: string, args: any[] = [], overrides: TransactionRequest = {}) {
    this.requireDurableState();
    if (this.sending) throw new Error('The wallet is already sending a transaction.');
    this.sending = true;
    const send = async () => {
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
          `Your address holds too little for this transaction: its fee can be up to ${formatEther(fees.maxCost)} ETH. Send that much ETH to ${address} first, with "Add ETH that arrives at my deposit address to my balance" off in Settings.`,
        );
      }
      await this.assertNetwork();
      if (
        address !== this.address ||
        signer !== this.signer ||
        provider !== this.provider ||
        contract !== this.contract
      )
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
      if (!this.storageKey) return contract[method](...args, pinnedOverrides);
      if (this.transactionIntent) throw new Error('Recover the saved transaction before sending another');
      // Signed, then saved, then broadcast: a lost reply leaves exactly this transaction to look for or send again.
      const raw = await signer.signTransaction(await contract[method].populateTransaction(...args, pinnedOverrides));
      this.transactionIntent = {
        method,
        args: plain(args),
        value: String(value),
        nonce,
        to: await contract.getAddress(),
        data: contract.interface.encodeFunctionData(method, args),
        fees: plain(fees.overrides),
        raw,
        hash: keccak256(raw),
      };
      await this.save();
      return provider.broadcastTransaction(raw);
    };
    try {
      return await withLock(
        `hookedin:wallet-send:${this.expectedChainId}:${this.address?.toLowerCase()}`,
        false,
        held => {
          if (!held)
            throw new Error('This wallet is sending a transaction in another tab. Try again after confirmation.');
          return send();
        },
      );
    } finally {
      this.sending = false;
    }
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
    const gasLimit = (estimate * 120n + 99n) / 100n;
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
      gasLimit > TRANSACTION_LIMITS.gas ||
      feePerGas > TRANSACTION_LIMITS.feePerGas ||
      gasLimit * feePerGas > TRANSACTION_LIMITS.totalFee
    )
      throw new Error(
        'Transaction exceeds wallet fee limits (2,000,000 gas, 200 gwei, 0.05 ETH total). Check the RPC or use independent recovery with reviewed fees',
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
      return this.depositLocked(all, overrides);
    });
    await this.refresh();
    await this.takeDeposits();
  }
  /** ETH sent to this account's address goes into its balance by itself, all of it, while the wallet `sweeps`. An
   * amount smaller than its own fee stays where it is. */
  async sweep(this: CasinoWallet) {
    if (!this.sweeps) return;
    const added = await this.exclusive(
      async () => {
        if (!this.sweeps) return null;
        const { amount, fee, overrides } = await this.depositable();
        return amount > fee ? this.depositLocked(amount, overrides) : null;
      },
      { wait: true },
    );
    if (added) {
      await this.refresh();
      await this.takeDeposits();
    }
  }
  /** A deposit into this account's channel, under the wallet's lock. While it runs, `depositing` says what it adds. */
  async depositLocked(this: CasinoWallet, amount: Integer, fees: Record<string, any> = {}) {
    if (BigInt(amount) <= 0n || BigInt(amount) >= 1n << 256n)
      throw new Error('Deposit must be a positive uint256 amount');
    if (this.missingChannel)
      throw new Error(
        'This account has a balance open that this browser holds no evidence for: restore its backup first.',
      );
    // An operation waits for its channel; one a reorganisation took back to unopened opens again with a deposit.
    if (this.pending && this.pending.kind !== 'taken-in' && Number(this.channel?.onchain?.status) === 1)
      throw new Error('Finish the saved operation before depositing.');
    // Once the close is on-chain, a deposit opens the account's next channel.
    if (this.channel?.closing) throw new Error('Your balance is closing. Deposit once the close is on-chain.');
    this.depositing = BigInt(amount);
    this.render();
    try {
      this.onProgress('Adding ETH to your balance…');
      const tx = await this.sendTransaction('deposit', [this.address], { value: BigInt(amount), ...fees });
      await this.waitTransaction(tx);
      return true;
    } finally {
      this.depositing = 0n;
    }
  }
  /** Take into the balance what was deposited into the open channel and not taken in yet: a deposit operation, which
   * the casino signs once it has seen the money confirmed. One that is waiting for the casino is asked again. */
  async takeDeposits(this: CasinoWallet) {
    const c = this.channel,
      pending = this.pending;
    if (pending)
      return pending.kind === 'taken-in'
        ? this.perform('taken-in', { amount: pending.request.amount }, pending.operationId)
        : null;
    if (!this.funded || !c || !c.registered) return null;
    const waiting = BigInt(c.onchain.deposited) - BigInt(c.state.deposited);
    if (waiting <= 0n) return null;
    // Named for the state it follows, so each take-in has an ID of its own.
    return this.perform('taken-in', { amount: waiting }, `taken-in:${c.state.channelId}:${c.state.sequence}`);
  }
  /** Send everything at this account's address, less the transfer's fee, to another address: how Withdraw empties it
   * while no balance is open. Under the wallet's lock. Returns the transfer's receipt. */
  async transferAll(this: CasinoWallet, recipient: string) {
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
    const tx = await this.signer.sendTransaction({
      to: recipient,
      value: amount,
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chainId: this.expectedChainId,
      type: 2,
    });
    const receipt = await tx.wait(this.config.confirmations || 1, 90000);
    if (!receipt || receipt.status !== 1) throw new Error('The transfer did not go through');
    const saved = {
      kind: 'withdrawal',
      operationId: 'tx:' + receipt.hash,
      amount: String(amount),
      to: recipient,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      status: 'confirmed',
      createdAt: new Date().toISOString(),
    };
    await this.save(saved);
    return saved;
  }
  /** Register this account's channel with the casino, which answers with the state it holds. A channel still at its
   * base is taken up there; one the casino has seen played on needs this wallet's own evidence. */
  async activate(this: CasinoWallet) {
    const c = this.channel!;
    if (this.recoveryOnly) return;
    const reply = await this.api(`/api/channels/${c.state.channelId}/activate`, { opening: c.opening }, c);
    this.noteNames(reply);
    this.updateBankroll(reply.bankroll);
    if (c.registered) return;
    if (!same(hashState(this.domain, reply.state), hashState(this.domain, c.state))) {
      this.missingChannel = c.state.channelId;
      throw new Error("This balance was played in another browser: restore that wallet's backup to use it here.");
    }
    this.missingChannel = null;
    c.registered = true;
    await this.save();
  }
  /** The local chain's faucet fills this account's address, and the sweep puts it into the balance. */
  async setupDemo(this: CasinoWallet) {
    if (!this.isLocalDevelopment) throw new Error('Automatic funding is local only');
    await this.api('/api/faucet', { address: this.address });
    await this.refresh();
    await this.sweep();
  }
  async waitTransaction(this: CasinoWallet, tx: TransactionResponse) {
    this.lastChainCheck = 0;
    let receipt;
    try {
      receipt = await tx.wait(this.config.confirmations || 1, 90000);
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
    let amount = status === 'confirmed' ? intent?.value || '0' : '0',
      to: string | undefined;
    for (const log of receipt.logs || []) {
      if (status !== 'confirmed' || !same(log.address, intent?.to || this.config.contractAddress)) continue;
      try {
        const event = this.reader.interface.parseLog(log);
        // What a claim paid, and where: this account's address, or the one it named.
        if (event?.name === 'ClaimPayment') {
          amount = String(event.args.amount);
          to = event.args.recipient;
        }
      } catch {}
    }
    return {
      kind:
        status !== 'confirmed'
          ? 'transaction'
          : intent?.method === 'deposit'
            ? 'deposit'
            : ['claim', 'claimTo'].includes(intent?.method)
              ? 'withdrawal'
              : intent?.method === 'withdraw'
                ? 'withdrawal-sent'
                : intent?.method === 'startClose'
                  ? 'close-started'
                  : intent?.method === 'finalizeClose'
                    ? 'closure'
                    : 'dispute',
      operationId: 'tx:' + receipt.hash,
      amount,
      ...(to && !same(to, this.address) ? { to } : {}),
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      intent,
      status,
      createdAt: new Date().toISOString(),
    };
  }
  async recordTransaction(this: CasinoWallet, receipt: TransactionReceipt, status = 'confirmed') {
    await this.save(this.transactionRecord(receipt, this.transactionIntent, status), { transactionIntent: null });
  }
  transactionRecovery(this: CasinoWallet) {
    return { provider: this.provider, observer: this.observer, confirmations: this.config.confirmations || 1 };
  }
  async transactionStatus(this: CasinoWallet, receipt: TransactionReceipt, intent: any) {
    const read = async (provider: any) => {
      const tx = await provider.getTransaction(receipt.hash);
      return tx && { from: tx.from, to: tx.to, nonce: tx.nonce, data: tx.data, value: tx.value };
    };
    const transaction = this.observer
      ? await this.observer.corroborate('transaction intent', read)
      : await read(this.provider);
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
    return mapBounded(history, async entry => {
      if (entry.withdrawal && !entry.paid && !entry.returned) return this.withdrawalPaid(entry, block);
      if (!entry.txHash) return entry;
      if (entry.blockHash && entry.blockNumber <= block.number) {
        if (!blocks.has(entry.blockNumber))
          blocks.set(
            entry.blockNumber,
            this.observer.corroborate(
              'transaction blocks',
              async p => (await p.getBlock(entry.blockNumber))?.hash || null,
            ),
          );
        if ((await blocks.get(entry.blockNumber)) === entry.blockHash && entry.status !== 'orphaned') return entry;
      }
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
    for (const hash of new Set([intent.hash, ...(intent.attempts || []).map((a: any) => a.hash)].filter(Boolean))) {
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
      if (maxFeePerGas > 200000000000n || maxPriorityFeePerGas > maxFeePerGas)
        throw new Error('Speed-up exceeds the wallet fee cap; use the funding wallet');
      if ((await this.provider.getBalance(this.address)) < original.value + original.gasLimit * maxFeePerGas)
        throw new Error('Add ETH to the funding wallet before speeding up');
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
      intent.attempts ??= [{ hash: intent.hash, raw: intent.raw }];
      intent.fees = plain({ gasLimit: request.gasLimit, maxFeePerGas, maxPriorityFeePerGas });
      const raw = await this.signer.signTransaction(request),
        hash = keccak256(raw);
      intent.attempts.push({ hash, raw });
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
  /** Withdraw `amount` of the balance, or all of it: to an address, or with `transfer` into that account's HookedIn
   * balance. The balance pays it at once, and the contract pays it once anyone sends the operation and the casino's
   * signature after it, which the casino does straight away: out of the channel's deposits first and house cash for
   * the rest. One house cash cannot pay now is declined, with why. With no balance open, everything at this account's
   * address goes to the address. */
  async withdraw(this: CasinoWallet, to: string, amount?: Integer, { transfer = false } = {}) {
    const recipient = getAddress(to.trim());
    if (same(recipient, ZeroAddress) || same(recipient, this.config.contractAddress))
      throw new Error('A withdrawal cannot pay that address: name another.');
    const c = this.channel;
    if (!c || Number(c.onchain?.status) !== 1 || c.closing) {
      if (transfer) throw new Error('Open a balance before putting money into another.');
      const receipt = await this.exclusive(() => this.transferAll(recipient));
      await this.refresh();
      return receipt;
    }
    const balance = BigInt(c.state.balance),
      value = amount === undefined ? balance : BigInt(amount);
    if (value <= 0n || value > balance) throw new Error('Not that much is in your balance.');
    // The open game may risk no more than stays in the balance.
    if (this.game && BigInt(this.game.balance) > balance - value) this.game.balance = String(balance - value);
    const receipt = await this.perform(
      transfer ? 'transfer' : 'withdrawal',
      { amount: value, recipient },
      crypto.randomUUID(),
    );
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this withdrawal.');
    return receipt;
  }
  /** Lock in the balance: transfer all of it into this account's own balance, so the contract holds all of it as
   * deposits. The channel's deposits pay back what they cover, and house cash pays the rest, the winnings. */
  async lockIn(this: CasinoWallet) {
    const c = this.channel,
      balance = BigInt(c?.state.balance || 0);
    if (!c || Number(c.onchain?.status) !== 1 || c.closing || !balance) throw new Error('No balance to lock in.');
    // All of it goes out and back in: the open game risks nothing meanwhile.
    if (this.game) this.game.balance = '0';
    const receipt = await this.perform('lock-in', { amount: balance, recipient: this.address }, crypto.randomUUID());
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined locking in.');
    return receipt;
  }
  /** Have a withdrawal or transfer the contract has not paid yet paid now: this account sends its proof, and pays the
   * fee. The casino sends it too, as soon as house cash covers it. */
  async payWithdrawal(this: CasinoWallet, operationId: string) {
    const entry = this.history.find(record => record.operationId === operationId);
    if (!entry?.withdrawal || entry.paid) throw new Error('That withdrawal is not waiting to be paid.');
    const hash = await this.exclusive(async () => {
      await this.assertNetwork();
      const tx = await this.sendTransaction('withdraw', [entry.proof]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refreshDetails();
    return hash;
  }
  /** Whether the contract has paid a withdrawal or transfer: it records the ID it paid under, and its event names the
   * transaction, which is looked for among recent blocks. One never paid by the time its channel's close is final came
   * back with the close. */
  async withdrawalPaid(this: CasinoWallet, entry: any, block: ChainBlock) {
    if (!(await this.observer.contractRead(this.reader, 'withdrawals', [entry.withdrawal], block)))
      return Number(this.channels[entry.proof.base.channelId]?.onchain?.status) === 3
        ? { ...entry, returned: true }
        : entry;
    const [event] = await this.reader
      .queryFilter(this.reader.filters.Withdrawal(entry.withdrawal), Math.max(0, block.number - 10000), block.number)
      .catch(() => []);
    return { ...entry, paid: true, ...(event ? { paidIn: event.transactionHash } : {}) };
  }
  async startClose(this: CasinoWallet) {
    const result = await this.exclusive(async () => {
      if (!this.channel) throw new Error('No active channel');
      await this.assertNetwork();
      this.channel.closing = true;
      await this.save();
      const tx = await this.sendTransaction('startClose', [this.evidence()]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh();
    return result;
  }
  async claim(this: CasinoWallet, channelId: string, recipient?: string) {
    const result = await this.exclusive(async () => {
      this.onProgress('Collecting what the closed balance is owed…');
      const tx = await this.sendTransaction(
        recipient ? 'claimTo' : 'claim',
        recipient ? [channelId, getAddress(recipient)] : [channelId],
      );
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh({ channelId });
    return result;
  }
  async finalizeClose(this: CasinoWallet, channelId = this.closingChannel?.state.channelId) {
    const result = await this.exclusive(async () => {
      const tx = await this.sendTransaction('finalizeClose', [channelId]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh({ channelId });
    return result;
  }
  async challengeClose(this: CasinoWallet, channelId = this.closingChannel?.state.channelId) {
    const result = await this.exclusive(async () => {
      const tx = await this.sendTransaction('challengeClose', [this.evidence(this.channels[channelId!])]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh({ channelId });
    return result;
  }
}
