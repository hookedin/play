import type { TransactionReceipt, TransactionResponse, TransactionRequest } from 'ethers';
import type { Integer, Opening } from '../protocol/types.ts';
import type { ChainBlock } from '../protocol/chain-observer.ts';
import type { CasinoWallet } from './wallet.ts';
import { Wallet, formatEther, parseEther, getAddress, keccak256, Transaction } from 'ethers';
import {
  plain,
  same,
  channelId,
  validateOpening,
  CLOSE_TYPES,
  assertSignature,
  initialState,
  hashState,
} from '../protocol/protocol.ts';
import { mapBounded } from '../protocol/concurrency.ts';
import { confirmedReceipt, findNonceTransaction, sameTransactionIntent } from '../protocol/transaction-recovery.ts';
import { withLock } from './storage.ts';
export const MIN_GAS_RESERVE = 1000000000000000n;
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
    'signer',
    'deposit',
    'initialHash',
    'status',
    'deadline',
    'closingSequence',
    'closingHash',
    'closingBalance',
  ]);

/** Everything that signs or recovers an on-chain transaction: deposits, closes, claims,
 * challenges, fee limits, nonce recovery and confirmed-receipt bookkeeping. The wallet
 * class is a chain: `CasinoWallet` extends `GameAllocations` extends `ChannelClient`
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
      const fees = await this.transactionFees(method, args, value);
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
      const reserve = [
        'startClose',
        'challengeClose',
        'finalizeClose',
        'claim',
        'claimTo',
        'cooperativeClose',
      ].includes(method)
        ? 0n
        : MIN_GAS_RESERVE;
      if (balance < value + fees.maxCost + reserve) {
        throw new Error(
          `Keep at least ${formatEther(MIN_GAS_RESERVE)} ETH in your wallet, plus up to ${formatEther(fees.maxCost)} ETH for this transaction’s fee. Add ETH or reduce the deposit amount.`,
        );
      }
      await this.assertNetwork();
      if (
        address !== this.address ||
        signer !== this.signer ||
        provider !== this.provider ||
        contract !== this.contract
      )
        throw new Error('The connected wallet changed. Check the amount and try again.');
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
      this.transactionIntent = {
        method,
        args: plain(args),
        value: String(value),
        nonce,
        to: await contract.getAddress(),
        data: contract.interface.encodeFunctionData(method, args),
        fees: plain(fees.overrides),
      };
      if (this.mode === 'demo') {
        const populated = await contract[method].populateTransaction(...args, pinnedOverrides);
        const raw = await signer.signTransaction(populated);
        Object.assign(this.transactionIntent, { raw, hash: keccak256(raw) });
        await this.save();
        return provider.broadcastTransaction(raw);
      }
      await this.save();
      try {
        const tx = await contract[method](...args, pinnedOverrides);
        this.transactionIntent.hash = tx.hash;
        await this.save();
        return tx;
      } catch (error: any) {
        if (error.code === 'ACTION_REJECTED') {
          this.transactionIntent = null;
          await this.save();
        }
        throw error;
      }
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
  async maxDeposit(this: CasinoWallet) {
    return this.exclusive(async () => {
      if (this.current) throw new Error('Close the active channel before another deposit');
      await this.assertNetwork();
      const balance = await this.provider.getBalance(this.address, 'pending'),
        fees = await this.provider.getFeeData();
      if (!fees.maxFeePerGas) throw new Error('Fee estimate unavailable');
      this.checkTransactionBudget(300000n, fees.maxFeePerGas);
      const maxFee = 300000n * fees.maxFeePerGas;
      return {
        address: this.address,
        nativeBalance: balance,
        maxFee,
        reserve: MIN_GAS_RESERVE,
        amount: balance > MIN_GAS_RESERVE + maxFee ? balance - MIN_GAS_RESERVE - maxFee : 0n,
      };
    });
  }
  async deposit(this: CasinoWallet, amount: Integer) {
    return this.exclusive(async () => {
      if (BigInt(amount) <= 0n || BigInt(amount) >= 1n << 256n)
        throw new Error('Deposit must be a positive uint256 amount');
      if (this.current || this.pending || this.missingChannel)
        throw new Error('Close or recover the existing channel before depositing');
      await this.assertNetwork();
      const key = Wallet.createRandom().privateKey;
      const signer = new Wallet(key).address;
      const opening = {
        channelId: channelId(this.address, signer, amount),
        player: this.address,
        signer,
        deposit: String(amount),
      };
      const id = opening.channelId;
      this.currentId = id;
      this.channels[id] = {
        key,
        opening,
        state: initialState(opening),
        playerSignature: '0x',
        casinoSignature: '0x',
        onchain: { status: '0' },
      };
      await this.save();
      this.onProgress('Opening your channel and protecting the deposit…');
      const tx = await this.sendTransaction('openChannel', [opening.signer], { value: BigInt(amount) });
      await this.waitTransaction(tx);
      await this.activate();
      await this.save();
      return tx.hash;
    });
  }
  async verifyRegisteredOpening(this: CasinoWallet, opening: Opening) {
    validateOpening(opening);
    const observation = await this.observer.observe();
    const value = await this.observer.contractRead(this.reader, 'channels', [opening.channelId], observation.block);
    if (
      Number(value.status) !== 1 ||
      !same(value.player, opening.player) ||
      !same(value.signer, opening.signer) ||
      BigInt(value.deposit) !== BigInt(opening.deposit) ||
      !same(value.initialHash, hashState(this.domain, initialState(opening)))
    )
      throw new Error('Registered channel differs from the opening');
    await this.observer.accept(observation);
    return value;
  }
  async activate(this: CasinoWallet) {
    this.lastChainCheck = 0;
    await this.assertNetwork();
    const c = this.current!,
      opening = c.opening;
    const value = await this.verifyRegisteredOpening(opening);
    c.onchain = channelRecord(value);
    this.lastChainCheck = Date.now();
    await this.save();
    if (this.recoveryOnly) return;
    const reply = await this.api(`/api/channels/${c.state.channelId}/activate`, { opening });
    this.updateBankroll(reply.bankroll);
  }
  async setupDemo(this: CasinoWallet) {
    if (!this.isLocalDevelopment || this.mode !== 'demo') throw new Error('Automatic funding is local only');
    await this.api('/api/faucet', { address: this.address });
    await this.deposit(parseEther('1'));
    await this.refresh();
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
    let amount = status === 'confirmed' ? intent?.value || '0' : '0';
    for (const log of receipt.logs || []) {
      if (status !== 'confirmed' || !same(log.address, intent?.to || this.config.contractAddress)) continue;
      try {
        const event = this.reader.interface.parseLog(log);
        if (event?.name === 'ClaimPayment' && same(event.args.beneficiary, this.address))
          amount = String(event.args.amount);
      } catch {}
    }
    return {
      kind:
        status !== 'confirmed'
          ? 'transaction'
          : intent?.method === 'openChannel'
            ? 'deposit'
            : ['claim', 'claimTo'].includes(intent?.method)
              ? 'withdrawal'
              : ['cooperativeClose', 'finalizeClose'].includes(intent?.method)
                ? 'closure'
                : 'dispute',
      operationId: 'tx:' + receipt.hash,
      amount,
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
    if (replace || !intent.hash) {
      let original: Pick<
        Transaction,
        'from' | 'to' | 'data' | 'value' | 'nonce' | 'gasLimit' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasPrice'
      > | null = intent.raw
        ? Transaction.from(intent.raw)
        : intent.hash
          ? await this.provider.getTransaction(intent.hash)
          : null;
      if (!original) {
        const savedFees = intent.fees;
        original = {
          from: this.address,
          to: intent.to,
          data: intent.data,
          value: BigInt(intent.value),
          nonce: intent.nonce,
          gasPrice: null,
          gasLimit: BigInt(savedFees.gasLimit),
          maxFeePerGas: BigInt(savedFees.maxFeePerGas ?? savedFees.gasPrice),
          maxPriorityFeePerGas: BigInt(savedFees.maxPriorityFeePerGas ?? 0),
        };
      }
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
      intent.attempts ??= intent.hash ? [{ hash: intent.hash, raw: intent.raw }] : [];
      intent.fees = plain({ gasLimit: request.gasLimit, maxFeePerGas, maxPriorityFeePerGas });
      if (this.mode === 'demo') {
        const raw = await this.signer.signTransaction(request),
          hash = keccak256(raw);
        intent.attempts.push({ hash, raw });
        Object.assign(intent, { raw, hash });
        await this.save();
        await this.provider.broadcastTransaction(raw);
      } else {
        await this.save(); // The nonce remains recoverable if the prompt's reply is lost.
        const tx = await this.signer.sendTransaction(request);
        intent.attempts.push({ hash: tx.hash });
        intent.hash = tx.hash;
        await this.save();
      }
    } else if (intent.raw && !(await this.provider.getTransaction(intent.hash))) {
      await this.provider.broadcastTransaction(intent.raw);
    }
    if (!intent.hash)
      throw new Error('Injected transaction outcome is unknown. Check the funding wallet before retrying');
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
  async withdraw(this: CasinoWallet) {
    const result = await this.exclusive(async () => {
      if (!this.current) throw new Error('No active channel');
      if (this.pending) throw new Error('Recover the pending operation or start unilateral closure');
      await this.assertNetwork();
      const c = this.current,
        evidence = this.evidence(),
        message = {
          channelId: c.state.channelId,
          stateHash: hashState(this.domain, c.state),
        };
      c.closing = true;
      await this.save();
      const signature = await this.signer.signTypedData(this.domain, CLOSE_TYPES, message);
      c.closeSignature = signature;
      await this.save();
      const casino = await this.api(`/api/channels/${c.state.channelId}/close`, { evidence, signature });
      assertSignature(this.domain, CLOSE_TYPES, message, casino.signature, this.operator);
      const tx = await this.sendTransaction('cooperativeClose', [evidence, signature, casino.signature]);
      c.closeTx = tx.hash;
      await this.save();
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh();
    return result;
  }
  async startClose(this: CasinoWallet) {
    const result = await this.exclusive(async () => {
      if (!this.current) throw new Error('No active channel');
      await this.assertNetwork();
      this.current.closing = true;
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
  async finalizeClose(this: CasinoWallet, channelId = this.currentId) {
    const result = await this.exclusive(async () => {
      const tx = await this.sendTransaction('finalizeClose', [channelId]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh({ channelId });
    return result;
  }
  async challengeClose(this: CasinoWallet, channelId = this.currentId) {
    const result = await this.exclusive(async () => {
      const tx = await this.sendTransaction('challengeClose', [this.evidence(this.channels[channelId!])]);
      await this.waitTransaction(tx);
      return tx.hash;
    });
    await this.refresh({ channelId });
    return result;
  }
}
