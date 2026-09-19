import type { JsonRpcProvider, Signer, TransactionRequest, TransactionReceipt } from 'ethers';
import type { ChainObserver } from './chain-observer.ts';
import type { Integer } from './types.ts';
export interface JournalEntry {
  action: string;
  raw: string;
  hash: string;
  status?: string;
  createdAt: number;
  updatedAt: number;
  attempts: { hash: string; raw: string }[];
  payout?: any;
  receipt?: Pick<TransactionReceipt, 'hash' | 'blockHash' | 'blockNumber' | 'status'> | null;
}
export interface JournalState {
  schema: string;
  signer?: string;
  chainId?: string;
  casino?: string;
  pending: JournalEntry | null;
  lastCompleted: JournalEntry | null;
}
export interface JournalOptions {
  file?: string;
  signer: Signer;
  provider: JsonRpcProvider;
  observer?: ChainObserver;
  chainId: Integer;
  confirmations?: number;
  now?: () => number;
  replaceAfterMs?: number;
  maxGasLimit?: bigint;
  maxFeePerGas?: bigint;
  initialState?: Partial<JournalState>;
  persist?: (state: JournalState) => void;
  /** Resolves once everything `persist` recorded is durable, for a store that writes behind. Awaited before any broadcast. */
  durable?: () => Promise<void>;
}
import fs from 'node:fs';
import path from 'node:path';
import { keccak256, Transaction } from 'ethers';
import { json, same } from './protocol.ts';
import { confirmedReceipt, confirmedNonce } from './transaction-recovery.ts';

export function atomicJSON(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, json(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

/** Durable transaction outbox. Replacement preserves destination, value, calldata and nonce. */
export class TransactionJournal {
  declare file: string | undefined;
  declare signer: Signer;
  declare provider: JsonRpcProvider;
  declare observer: ChainObserver | undefined;
  declare chainId: bigint;
  declare confirmations: number;
  declare now: () => number;
  declare replaceAfterMs: number;
  declare maxGasLimit: bigint;
  declare maxFeePerGas: bigint;
  declare persist: ((state: JournalState) => void) | undefined;
  declare durable: (() => Promise<void>) | undefined;
  declare state: JournalState;
  declare failed: boolean | undefined;

  constructor({
    file,
    signer,
    provider,
    observer,
    chainId,
    confirmations = 1,
    now = Date.now,
    replaceAfterMs = 45000,
    maxGasLimit = 2000000n,
    maxFeePerGas = 200000000000n,
    initialState,
    persist,
    durable,
  }: JournalOptions) {
    Object.assign(this, {
      file,
      signer,
      provider,
      observer,
      chainId: BigInt(chainId),
      confirmations,
      now,
      replaceAfterMs,
      maxGasLimit,
      maxFeePerGas,
      persist,
      durable,
    });
    const saved =
      initialState ||
      (file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema: 'HOOKEDIN/TRANSACTIONS/1' });
    if (saved.schema !== 'HOOKEDIN/TRANSACTIONS/1') throw new Error('Unsupported transaction journal');
    this.state = {
      schema: saved.schema,
      signer: saved.signer,
      chainId: saved.chainId,
      casino: saved.casino,
      pending: saved.pending || null,
      lastCompleted: saved.lastCompleted || null,
    };
  }
  requireDurableState() {
    if (this.failed) throw new Error('Transaction journal persistence failed; restart from durable state');
  }
  save() {
    this.requireDurableState();
    try {
      if (this.persist) this.persist(this.state);
      else atomicJSON(this.file!, this.state);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  adopt(transaction: JournalEntry) {
    this.requireDurableState();
    if (this.state.pending) throw new Error('Another journaled transaction is pending');
    this.state.pending = { ...transaction, status: 'pending' };
    this.save();
  }
  async identity() {
    this.requireDurableState();
    if (BigInt(await this.provider.send('eth_chainId', [])) !== this.chainId)
      throw new Error('Transaction RPC changed networks');
    const signer = await this.signer.getAddress();
    if (this.state.signer && (!same(this.state.signer, signer) || this.state.chainId !== String(this.chainId)))
      throw new Error('Transaction journal belongs to another signer/network');
    this.state.signer = signer;
    this.state.chainId = String(this.chainId);
    return signer;
  }
  async confirmedReceipt(hash: string) {
    return confirmedReceipt(this, hash);
  }
  finish(status: string, receipt: TransactionReceipt | null = null) {
    this.requireDurableState();
    const completed = {
      ...this.state.pending!,
      status,
      receipt: receipt
        ? { hash: receipt.hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, status: receipt.status }
        : null,
    };
    this.state.lastCompleted = completed;
    this.state.pending = null;
    this.save();
    return completed;
  }
  async reconcile() {
    await this.identity();
    const pending = this.state.pending;
    if (!pending) return null;
    for (const attempt of pending.attempts || [pending]) {
      const receipt = await this.confirmedReceipt(attempt.hash);
      if (receipt) return this.finish(receipt.status === 1 ? 'confirmed' : 'reverted', receipt);
    }
    const tx = Transaction.from(pending.raw);
    if ((await confirmedNonce(this, this.state.signer!)) > BigInt(tx.nonce)) return this.finish('replaced');
    return null;
  }
  async submit(
    action: string,
    request: TransactionRequest | null,
    metadata: { payout?: any } = {},
  ): Promise<JournalEntry | { status: 'idle'; hash?: undefined }> {
    await this.identity();
    // Validate before reconciliation can consume the saved intent. A retry may
    // change fees, but never the action, destination, calldata or value.
    if (request && this.state.pending?.action === action) {
      const tx = Transaction.from(this.state.pending.raw);
      if (
        !same(tx.to, request.to ?? null) ||
        !same(tx.data, request.data ?? '0x') ||
        tx.value !== BigInt(request.value ?? 0)
      )
        throw new Error('Journaled transaction is bound to a different intent');
    }
    const completed = await this.reconcile();
    if (completed?.action === action && completed.status === 'confirmed') return completed;
    let pending = this.state.pending;
    if (pending && pending.action !== action) throw new Error('Another journaled transaction is pending');
    if (!pending) {
      if (!request) return completed || { status: 'idle' };
      const [latest, mempool] = await Promise.all(
        ['latest', 'pending'].map(tag => this.provider.getTransactionCount(this.state.signer!, tag)),
      );
      if (latest !== mempool) throw new Error('Another relayer transaction is pending');
      const populated = await this.signer.populateTransaction({ ...request, chainId: this.chainId, nonce: latest });
      if (
        BigInt(populated.gasLimit!) > this.maxGasLimit ||
        BigInt((populated.maxFeePerGas ?? populated.gasPrice)!) > this.maxFeePerGas
      )
        throw new Error('Recovery transaction exceeds configured gas budget');
      const raw = await this.signer.signTransaction(populated);
      pending = this.state.pending = {
        ...metadata,
        action,
        raw,
        hash: keccak256(raw),
        status: 'pending',
        createdAt: this.now(),
        updatedAt: this.now(),
        attempts: [],
      };
      pending.attempts.push({ hash: pending.hash, raw });
      this.save();
    } else if (this.now() - pending.updatedAt >= this.replaceAfterMs) {
      const tx = Transaction.from(pending.raw),
        fees = await this.provider.getFeeData();
      const bump = (n: Integer | null) => (BigInt(n!) * 9n + 7n) / 8n + 1n;
      const fee = bump(tx.maxFeePerGas ?? tx.gasPrice);
      const market = (fees.maxFeePerGas ?? fees.gasPrice)!;
      const nextFee = fee > market ? fee : market;
      if (nextFee > this.maxFeePerGas) throw new Error('Recovery fee cap reached; relayer needs attention');
      const request = {
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gasLimit: tx.gasLimit,
        chainId: tx.chainId,
        nonce: tx.nonce,
        type: tx.type,
        ...(tx.type === 2
          ? { maxFeePerGas: nextFee, maxPriorityFeePerGas: bump(tx.maxPriorityFeePerGas) }
          : { gasPrice: nextFee }),
      };
      const raw = await this.signer.signTransaction(request);
      Object.assign(pending, { raw, hash: keccak256(raw), updatedAt: this.now() });
      pending.attempts.push({ hash: pending.hash, raw });
      this.save();
    }
    // Persisted before all broadcasts, including replacement. A lost HTTP reply
    // leaves the exact signed transaction available to the next process.
    this.requireDurableState();
    await this.durable?.();
    const providers = this.observer?.witnessProvider ? [this.provider, this.observer.witnessProvider] : [this.provider];
    const outcomes = await Promise.allSettled(providers.map(p => p.broadcastTransaction(pending.raw)));
    if (outcomes.every(r => r.status === 'rejected') && !(await this.provider.getTransaction(pending.hash)))
      throw new Error('Broadcast uncertain; signed transaction retained for retry');
    return { ...pending, status: 'pending' };
  }
}
