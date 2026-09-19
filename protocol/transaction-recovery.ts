import type { JsonRpcProvider, TransactionResponse } from 'ethers';
import type { ChainObserver, ChainBlock } from './chain-observer.ts';
export interface RecoveryContext {
  provider: JsonRpcProvider;
  observer?: ChainObserver;
  confirmations?: number;
}
import { same } from './protocol.ts';
import { blockReference, requireCanonicalBlock } from './chain-observer.ts';

const providersFor = ({ provider, observer }: RecoveryContext) =>
  observer?.witnessProvider ? [provider, observer.witnessProvider] : [provider];
async function canonical(context: RecoveryContext, block: ChainBlock) {
  await Promise.all(providersFor(context).map(p => requireCanonicalBlock(p, block)));
}
async function blockAt(context: RecoveryContext, height: number) {
  const blocks = await Promise.all(providersFor(context).map(p => p.getBlock(height)));
  if (!blocks[0]?.hash || blocks.some(b => !b || b.number !== height || b.hash !== blocks[0]!.hash))
    throw new Error('Independent RPC transaction block hashes disagree');
  return blocks[0]!;
}
async function confirmedBlock(context: RecoveryContext) {
  const tips = await Promise.all(providersFor(context).map(p => p.getBlock('latest')));
  if (tips.some(t => !t || !Number.isSafeInteger(t.number))) throw new Error('Transaction chain head unavailable');
  return blockAt(context, Math.max(0, Math.min(...tips.map(b => b!.number)) - (context.confirmations ?? 1) + 1));
}
async function nonceAt(context: RecoveryContext, address: string, block: ChainBlock) {
  const read = (p: JsonRpcProvider) => p.send('eth_getTransactionCount', [address, blockReference(block)]).then(BigInt);
  return context.observer ? context.observer.corroborate('account nonce', read) : read(context.provider);
}

/** Read the consumed nonce on one corroborated branch, then check it is still canonical. */
export async function confirmedNonce(context: RecoveryContext, address: string) {
  const block = await confirmedBlock(context),
    nonce = await nonceAt(context, address, block);
  await canonical(context, block);
  return nonce;
}

/** Only receipts on an agreed canonical branch at the requested depth count. */
export async function confirmedReceipt(
  context: RecoveryContext,
  hash: string,
  anchor: ChainBlock | undefined = undefined,
) {
  const { provider, observer } = context;
  const receipt = observer ? await observer.receipt(hash) : await provider.getTransactionReceipt(hash);
  if (!receipt) return null;
  if (
    !Number.isSafeInteger(receipt.blockNumber) ||
    receipt.blockNumber < 0 ||
    !receipt.blockHash ||
    ![0, 1].includes(receipt.status!)
  )
    throw new Error('Invalid transaction receipt');
  anchor ??= await confirmedBlock(context);
  if (receipt.blockNumber > anchor.number) return null;
  const block = await blockAt(context, receipt.blockNumber);
  if (block.hash !== receipt.blockHash) return null;
  await canonical(context, block);
  await canonical(context, anchor);
  return receipt;
}

/** Search recent nonce history first, pinned to canonical hashes throughout. */
export async function findNonceTransaction(context: RecoveryContext & { address: string; nonce: number }) {
  const { provider, address, nonce } = context;
  const anchor = await confirmedBlock(context);
  let high = anchor.number;
  const count = async (height: number) => nonceAt(context, address, await blockAt(context, height));
  if ((await count(high)) <= BigInt(nonce)) {
    await canonical(context, anchor);
    return null;
  }
  let distance = 1,
    low = Math.max(0, high - distance);
  while (low > 0 && (await count(low)) > BigInt(nonce)) {
    high = low;
    distance *= 2;
    low = Math.max(0, high - distance);
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await count(middle)) > BigInt(nonce)) high = middle;
    else low = middle + 1;
  }
  const header = await blockAt(context, low),
    block = await provider.getBlock(header.hash!, true);
  const transaction = block?.prefetchedTransactions.find(tx => same(tx.from, address) && tx.nonce === nonce);
  if (!transaction)
    throw new Error('Account nonce was consumed without a matching transaction; inspect the funding wallet');
  const receipt = await confirmedReceipt(context, transaction.hash);
  if (!receipt || receipt.blockHash !== header.hash)
    throw new Error('Replacement branch changed; retry after confirmation');
  await canonical(context, anchor);
  return { transaction, receipt };
}

export function sameTransactionIntent(
  transaction: Pick<TransactionResponse, 'nonce' | 'to' | 'data' | 'value'> & { from: string | null },
  intent: { nonce: number; to: string | null; data: string; value: string },
  address: string,
) {
  return (
    same(transaction.from, address) &&
    transaction.nonce === intent.nonce &&
    same(transaction.to, intent.to) &&
    same(transaction.data, intent.data) &&
    transaction.value === BigInt(intent.value)
  );
}
