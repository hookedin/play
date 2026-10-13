import type { Block, Contract, TransactionReceipt } from 'ethers';
export type ChainBlock = Pick<Block, 'number' | 'hash' | 'timestamp'>;
interface ObserverOptions {
  provider: JsonRpcProvider;
  witnessProvider?: JsonRpcProvider;
  chainId: bigint;
  finality?: number;
  now?: () => number;
  maxAgeMs?: number;
}
export interface Observation {
  block: ChainBlock;
  tips: ChainBlock[];
  advanced: boolean;
  reorg: { previous: Pick<ChainBlock, 'number' | 'hash'>; replacementHash: string } | null;
}
import { canonicalJSON, plain } from './protocol.ts';
import { FeeData, FetchRequest, JsonRpcProvider, Network } from 'ethers';

export const RPC_TIMEOUT_MS = 10000;
/** How long the confirmed chain may stand still before an observation counts as stale. */
const MAX_STALL_MS = 60000;
/** Bound the transport itself: a late response cannot resume a failed read. Given the chain it serves, the provider
 * skips its own detection round trip; every observation checks the chain ID anyway. Each call is a request of its own:
 * every RPC answers those, while public ones cap what a batch may cost (Tenderly's refuses six contract calls in one). */
/** The least tip a transaction offers block builders, 0.1 gwei: RPCs suggest none, and a transaction without one can
 * wait unmined. */
export const MIN_PRIORITY_FEE = 100_000_000n;
export function createRpcProvider(url: string, chainId: bigint | undefined = undefined) {
  const request = new FetchRequest(url);
  request.timeout = RPC_TIMEOUT_MS;
  const options = { cacheTimeout: -1, batchMaxCount: 1 };
  const provider =
    chainId === undefined
      ? new JsonRpcProvider(request, undefined, options)
      : new JsonRpcProvider(request, Network.from(chainId), { ...options, staticNetwork: true });
  // Every fee it suggests tips at least MIN_PRIORITY_FEE, and its cap rises by as much.
  const feeData = provider.getFeeData.bind(provider);
  provider.getFeeData = async () => {
    const fees = await feeData();
    if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null || fees.maxPriorityFeePerGas >= MIN_PRIORITY_FEE)
      return fees;
    const raise = MIN_PRIORITY_FEE - fees.maxPriorityFeePerGas;
    return new FeeData(fees.gasPrice, fees.maxFeePerGas + raise, MIN_PRIORITY_FEE);
  };
  return provider;
}

export const blockReference = (block: Pick<ChainBlock, 'hash'>) => ({ blockHash: block.hash, requireCanonical: true });
/** One of the contract's view functions, read at `block`. */
export async function readContract(
  provider: JsonRpcProvider,
  contract: Contract,
  method: string,
  args: readonly unknown[],
  block: Pick<ChainBlock, 'hash'>,
) {
  const encoded = await provider.send('eth_call', [
    { to: await contract.getAddress(), data: contract.interface.encodeFunctionData(method, args) },
    blockReference(block),
  ]);
  const decoded = contract.interface.decodeFunctionResult(method, encoded);
  return decoded.length === 1 ? decoded[0] : decoded;
}
export async function requireCanonicalBlock(provider: JsonRpcProvider, block: ChainBlock) {
  if ((await provider.getBlock(block.number))?.hash !== block.hash) throw new Error('Chain changed during observation');
}

/** Confirm a progressing canonical view without putting RPC calls on the bet path. */
export class ChainObserver {
  declare provider: JsonRpcProvider;
  declare witnessProvider: JsonRpcProvider | undefined;
  declare chainId: bigint;
  declare finality: number;
  declare now: () => number;
  declare maxAgeMs: number;
  declare local: boolean;
  declare last: Pick<ChainBlock, 'number' | 'hash'> | null;
  /** Whether the RPCs' chain was read since the last failed observation. */
  declare chainChecked: boolean;
  declare lastProgress: number;

  constructor({ provider, witnessProvider, chainId, finality = 1, now = Date.now, maxAgeMs = 60000 }: ObserverOptions) {
    Object.assign(this, { provider, witnessProvider, chainId, finality, now, maxAgeMs });
    if (!Number.isSafeInteger(finality) || finality < 1) throw new Error('Invalid confirmation depth');
    this.local = this.chainId === 31337n;
    if (!this.local && (!witnessProvider || witnessProvider === provider))
      throw new Error('An independent witness RPC is required off the local chain');
    this.last = null;
    this.chainChecked = false;
    this.lastProgress = 0;
  }
  /** One corroborated view of the chain. The RPCs' chain is read on the first one and on the one after a failure. */
  async observe(): Promise<Observation> {
    try {
      const observation = await this.observeOnce();
      this.chainChecked = true;
      return observation;
    } catch (error) {
      this.chainChecked = false;
      throw error;
    }
  }
  async observeOnce(): Promise<Observation> {
    const providers = this.witnessProvider ? [this.provider, this.witnessProvider] : [this.provider];
    const tips = await Promise.all(
      providers.map(async provider => {
        const [chain, tip] = await Promise.all([
          this.chainChecked ? null : provider.send('eth_chainId', []),
          provider.getBlock('latest'),
        ]);
        if (chain !== null && BigInt(chain) !== this.chainId) throw new Error('Observation RPC is on another chain');
        if (!tip || !Number.isSafeInteger(tip.number) || !tip.hash || !Number.isSafeInteger(tip.timestamp))
          throw new Error('Invalid chain head');
        const age = this.now() - tip.timestamp * 1000;
        if (!this.local && (age > this.maxAgeMs || age < -15000))
          throw new Error('Chain head timestamp is stale or in the future');
        return tip;
      }),
    );
    if (Math.max(...tips.map(t => t.number)) - Math.min(...tips.map(t => t.number)) > 4)
      throw new Error('Independent RPC heads disagree');
    const height = Math.max(0, Math.min(...tips.map(t => t.number)) - this.finality + 1);
    // The block just after the previous observation names it as its parent; one further on is compared with it at its
    // height, read with the block.
    const advanced = !this.last || height > this.last.number,
      follows = Boolean(this.last) && height === this.last!.number + 1;
    const [blocks, ancestors] = await Promise.all([
      Promise.all(providers.map(p => p.getBlock(height))),
      this.last && advanced && !follows ? Promise.all(providers.map(p => p.getBlock(this.last!.number))) : null,
    ]);
    const block = blocks[0];
    if (
      !block ||
      block.number !== height ||
      !block.hash ||
      !Number.isSafeInteger(block.timestamp) ||
      blocks.some(
        b =>
          !b ||
          b.number !== height ||
          b.hash !== block.hash ||
          b.parentHash !== block.parentHash ||
          b.timestamp !== block.timestamp,
      )
    )
      throw new Error('Independent RPC block hashes disagree');
    if (!this.local && this.now() - block.timestamp * 1000 > this.maxAgeMs + this.finality * 15000)
      throw new Error('Confirmed block timestamp is stale');
    if (this.last && (height < this.last.number || (height === this.last.number && block.hash !== this.last.hash)))
      throw new Error('Observed chain regressed or reorganized; wait for a newer corroborated block');
    if (!this.local && !advanced && this.now() - this.lastProgress > MAX_STALL_MS)
      throw new Error('Confirmed chain has stopped advancing');
    let reorg = null;
    if (follows && block.parentHash !== this.last!.hash)
      reorg = { previous: { ...this.last! }, replacementHash: block.parentHash };
    if (this.last && ancestors) {
      // A replacement fork can already be taller than our previous observation.
      // Compare the old height, rather than inferring ancestry from height alone.
      const ancestor = ancestors[0];
      if (
        !ancestor ||
        ancestor.number !== this.last.number ||
        !ancestor.hash ||
        ancestors.some(b => !b || b.number !== this.last!.number || b.hash !== ancestor.hash)
      )
        throw new Error('Independent RPC ancestry disagrees');
      if (ancestor.hash !== this.last.hash) reorg = { previous: { ...this.last }, replacementHash: ancestor.hash };
    }
    // The caller must finish and validate its block-specific reads before accepting this view.
    // Callers reconciling a reorg in batches must keep signing paused until the
    // complete projection is rebuilt, even while accepting fresh observations.
    return { block, tips, advanced, reorg };
  }
  async accept(observation: Observation) {
    const { block, advanced } = observation;
    if (
      !this.local &&
      (observation.tips.some(t => this.now() - t.timestamp * 1000 > this.maxAgeMs) ||
        (!advanced && this.now() - this.lastProgress > MAX_STALL_MS))
    )
      throw new Error('Chain observation became stale during reads');
    const providers = this.witnessProvider ? [this.provider, this.witnessProvider] : [this.provider];
    await Promise.all(providers.map(p => requireCanonicalBlock(p, block)));
    if (advanced) this.lastProgress = this.now();
    this.last = { number: block.number, hash: block.hash };
  }
  async corroborate<T>(label: string, read: (provider: JsonRpcProvider) => Promise<T>) {
    const providers = this.witnessProvider ? [this.provider, this.witnessProvider] : [this.provider];
    const values = await Promise.all(providers.map(read));
    if (values.some(value => canonicalJSON(plain(value)) !== canonicalJSON(plain(values[0]))))
      throw new Error(`Independent RPC ${label} disagree`);
    return values[0];
  }
  /** The newest block every RPC says the chain has finalized, which no reorganisation takes back, and never one above
   * `block`, a confirmed one. */
  async finalized(block: ChainBlock) {
    const providers = this.witnessProvider ? [this.provider, this.witnessProvider] : [this.provider];
    const numbers = await Promise.all(providers.map(async p => (await p.getBlock('finalized'))?.number));
    if (!numbers.every(Number.isSafeInteger)) throw new Error('Invalid finalized block');
    return Math.min(block.number, ...(numbers as number[]));
  }
  async balance(address: string, block: ChainBlock) {
    return BigInt(
      await this.corroborate('balances', provider => provider.send('eth_getBalance', [address, blockReference(block)])),
    );
  }
  async contractRead(contract: Contract, method: string, args: readonly unknown[], block: Pick<ChainBlock, 'hash'>) {
    return this.corroborate(`${method} state`, provider => readContract(provider, contract, method, args, block));
  }
  async receipt(hash: string) {
    const normalize = (r: TransactionReceipt | null) =>
      r && {
        hash: r.hash,
        blockHash: r.blockHash,
        blockNumber: r.blockNumber,
        status: r.status,
        gasUsed: r.gasUsed,
        from: r.from,
        to: r.to,
        index: r.index,
        logs: r.logs.map(l => ({ address: l.address, topics: [...l.topics], data: l.data, index: l.index })),
      };
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (this.witnessProvider) {
      const witness = await this.witnessProvider.getTransactionReceipt(hash);
      if (canonicalJSON(normalize(receipt)) !== canonicalJSON(normalize(witness)))
        throw new Error('Independent RPC transaction receipts disagree');
    }
    return receipt;
  }
}

export function requireIndependentRpc(primary: string, witness: string | undefined) {
  if (!witness) throw new Error('Configure an independent witness RPC URL');
  const a = new URL(primary),
    b = new URL(witness);
  if (!['https:', 'http:'].includes(b.protocol) || a.hostname === b.hostname)
    throw new Error('Witness RPC must use a different host; choose an independently operated provider');
  return witness;
}
