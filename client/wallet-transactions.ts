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
const picked = (value: Record<string, any>, keys: string[]) => plain(Object.fromEntries(keys.map(k => [k, value[k]])));
/** The durable projection of an on-chain channel record. */
export const channelRecord = (value: Record<string, any>) =>
  picked(value, [
    'player',
    'deposited',
    'principal',
    'claimed',
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
  /** Send everything at this account's address, less the network fee, to another address: how Withdraw empties it
   * while no balance is open. Under the wallet's lock. Returns the transaction's receipt. */
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
    if (!receipt || receipt.status !== 1) throw new Error('The withdrawal did not go through');
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
  /** Withdraw `amount` of the balance, or all of it, to an address: another HookedIn account's address puts it into that
   * account's balance. The balance pays it at once, and the contract makes it a claim once anyone sends the operation
   * and the casino's signature after it, which the casino does straight away: it pays the address what the channel's
   * deposits and house cash cover, and the rest as house cash arrives. One the casino cannot pay now is declined, with
   * why. With no balance open, everything at this account's address goes to the address. */
  async withdraw(this: CasinoWallet, to: string, amount?: Integer) {
    const recipient = getAddress(to.trim());
    if (same(recipient, ZeroAddress) || same(recipient, this.config.contractAddress))
      throw new Error('A withdrawal cannot pay that address: name another.');
    const c = this.channel;
    if (!c || Number(c.onchain?.status) !== 1 || c.closing) {
      const receipt = await this.exclusive(() => this.sendAll(recipient));
      await this.refresh();
      return receipt;
    }
    const balance = BigInt(c.state.balance),
      value = amount === undefined ? balance : BigInt(amount);
    if (value <= 0n || value > balance) throw new Error('Not that much is in your balance.');
    // The open game may risk no more than stays in the balance.
    if (this.game && BigInt(this.game.balance) > balance - value) this.game.balance = String(balance - value);
    const receipt = await this.perform('withdrawal', { amount: value, recipient }, crypto.randomUUID());
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this withdrawal.');
    return receipt;
  }
  /** Lock in the balance: withdraw all of it to the contract itself, which puts it into this account's channel as
   * deposits it holds, for the balance to take in. The channel's deposits pay back what they cover, and house cash pays
   * the rest, the winnings. The casino sends it at once, and pays its fee. */
  async lockIn(this: CasinoWallet) {
    const c = this.channel,
      balance = BigInt(c?.state.balance || 0);
    if (!c || Number(c.onchain?.status) !== 1 || c.closing || !balance) throw new Error('No balance to lock in.');
    // All of it goes out and back in: the open game risks nothing meanwhile.
    if (this.game) this.game.balance = '0';
    const receipt = await this.perform(
      'lock-in',
      { amount: balance, recipient: this.config.contractAddress },
      crypto.randomUUID(),
    );
    if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined locking in.');
    return receipt;
  }
  /** Send a withdrawal the casino has not sent yet: this account sends its proof and pays the fee, and the contract
   * makes it a claim and pays it. The casino sends each straight away too. */
  async sendWithdrawal(this: CasinoWallet, operationId: string) {
    const entry = this.history.find(record => record.operationId === operationId);
    if (!entry?.withdrawal || entry.recorded || entry.returned)
      throw new Error('That withdrawal is not waiting to be sent.');
    const hash = await this.exclusive(async () => {
      await this.assertNetwork();
      const tx = await this.sendTransaction('withdraw', [entry.proof]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refreshDetails();
    return hash;
  }
  /** Where a withdrawal stands on-chain. Once sent it is a claim under its ID, whose event names the transaction that
   * recorded it, looked for among recent blocks. It pays the claim's recipient, which its account can change, and is
   * paid once nothing of the claim remains; until then what can be collected now is read with it. One never recorded
   * by the time its channel's close is final came back with the close. A withdrawal paid or returned keeps the block it
   * was read at (`settledAt`). */
  async withdrawalState(this: CasinoWallet, entry: any, block: ChainBlock) {
    const op = entry.proof.step.operation,
      here = { number: block.number, hash: block.hash };
    const [claim, payable] = await Promise.all([
      this.observer.contractRead(this.reader, 'claims', [entry.withdrawal], block),
      this.observer.contractRead(this.reader, 'collectable', [entry.withdrawal], block),
    ]);
    // Nothing read of it before stands: a reorganisation can take back a recording, a payment or a new recipient.
    const { recorded, owed, winningsRemaining, collectable, recordedIn, returned, settledAt, ...sent } = entry;
    if (same(claim.beneficiary, ZeroAddress)) {
      const channel = await this.observer.contractRead(this.reader, 'channels', [op.channelId], block);
      return plain({
        ...sent,
        to: getAddress(op.recipient),
        paid: false,
        ...(Number(channel.status) === 3 ? { returned: true, settledAt: here } : {}),
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
      // A withdrawal paid in full at once keeps no recipient of its own.
      to: getAddress(same(claim.recipient, ZeroAddress) ? op.recipient : claim.recipient),
      recorded: true,
      paid: !left,
      owed: left,
      winningsRemaining: claim.winningsRemaining,
      collectable: payable,
      recordedIn: event?.transactionHash ?? recordedIn,
      ...(left ? {} : { settledAt: here }),
    });
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
