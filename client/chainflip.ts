/** Paying with another coin through Chainflip (chainflip.io), a cross-chain swap protocol HookedIn does not run. Its
 * public backend opens a deposit channel, a one-time address on the coin's own chain, and Chainflip swaps what arrives
 * there for ETH sent to the account's deposit address, which the wallet takes in like any deposit. Chainflip's broker
 * takes its commission; HookedIn takes nothing. What Chainflip answers is read here in its one form, or refused. */
import { formatUnits, getAddress } from 'ethers';
import { printable } from '../protocol/protocol.ts';
import * as read from '../protocol/read.ts';

const BACKEND = 'https://chainflip-swap.chainflip.io';
const STATE_CHAIN = 'https://rpc.mainnet.chainflip.io';

export interface Coin {
  chain: 'Bitcoin' | 'Solana' | 'Ethereum' | 'Arbitrum';
  asset: 'BTC' | 'SOL' | 'ETH' | 'USDC' | 'USDT';
  decimals: number;
}
/** The coins a player can pay with, as Chainflip names them. */
export const COINS: Coin[] = [
  { chain: 'Bitcoin', asset: 'BTC', decimals: 8 },
  { chain: 'Solana', asset: 'SOL', decimals: 9 },
  { chain: 'Solana', asset: 'USDC', decimals: 6 },
  { chain: 'Solana', asset: 'USDT', decimals: 6 },
  { chain: 'Ethereum', asset: 'USDC', decimals: 6 },
  { chain: 'Ethereum', asset: 'USDT', decimals: 6 },
  { chain: 'Arbitrum', asset: 'ETH', decimals: 18 },
  { chain: 'Arbitrum', asset: 'USDC', decimals: 6 },
  { chain: 'Arbitrum', asset: 'USDT', decimals: 6 },
];
/** An amount of `coin`, every digit, in whole coins. */
export const inCoin = (amount: bigint, coin: Coin) =>
  `${formatUnits(amount, coin.decimals).replace(/\.0$/, '')} ${coin.asset}`;

const ADDRESS = {
  Bitcoin: /^(bc1[02-9ac-hj-np-z]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  Solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  Ethereum: /^0x[0-9a-fA-F]{40}$/,
  Arbitrum: /^0x[0-9a-fA-F]{40}$/,
};
/** An address on `chain` in its one form, or null: on Ethereum and Arbitrum checksummed, on Bitcoin and Solana as the
 * chain writes it. Chainflip checks a Bitcoin or Solana address in full before it opens a channel for it. */
export function chainAddress(chain: Coin['chain'], value: unknown) {
  if (typeof value !== 'string' || !ADDRESS[chain].test(value)) return null;
  if (chain === 'Bitcoin' || chain === 'Solana') return value;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}
/** The refund address the player typed, in its one form: a Bitcoin address may be typed in capitals. */
export function typedRefund(coin: Coin, text: string) {
  const typed = text.trim();
  return chainAddress(coin.chain, coin.chain === 'Bitcoin' && /^BC1/.test(typed) ? typed.toLowerCase() : typed);
}

/** The least ETH per coin a swap may fill at, as Chainflip's fill-or-kill takes it: `price`, ETH per whole coin as a
 * quote states it, less `bps`, in the two assets' smallest units and times 2^128. */
export function minPriceX128(price: string, bps: number, coin: Coin) {
  const [whole, fraction = ''] = price.split('.');
  return (
    (BigInt(whole + fraction) * BigInt(10000 - bps) * 2n ** 128n * 10n ** 18n) /
    (10n ** BigInt(fraction.length + coin.decimals) * 10000n)
  );
}

const fields = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : read.refuse('Chainflip’s answer');
const percent = (value: unknown) =>
  typeof value === 'number' && value >= 0 && value <= 100 ? Math.round(value * 100) : read.refuse('A percentage');
/** A duration of at most `most`, in the units its field counts. */
const upTo = (most: number) => (value: unknown) =>
  typeof value === 'number' && value >= 0 && value <= most ? value : read.refuse('A duration');
const hex = (value: unknown) =>
  typeof value === 'string' && /^0x[0-9a-f]{1,32}$/.test(value) ? BigInt(value) : read.refuse('An amount');
const price = (value: unknown) =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,30})(\.[0-9]{1,40})?$/.test(value) ? value : read.refuse('A price');
const sameAsset = (value: unknown, chain: string, asset: string) => {
  const { chain: c, asset: a } = fields(value);
  return c === chain && a === asset;
};

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
    body = await response.json().catch(() => null),
    said = body?.message;
  if (response.ok) return body;
  throw new Error(
    `Chainflip: ${typeof said === 'string' && said.length <= 200 && printable(said) ? said : `HTTP ${response.status}`}`,
  );
}

/** The commission Chainflip's broker takes, in basis points. */
async function commission() {
  const bps = fields(await call(`${BACKEND}/api/networkInfo`)).cfBrokerCommissionBps;
  return Number.isSafeInteger(bps) && (bps as number) >= 0 && (bps as number) <= 1000
    ? (bps as number)
    : read.refuse('A commission');
}
/** The least of `coin` a channel takes: Chainflip keeps a smaller deposit. */
async function minimum(coin: Coin) {
  const { result } = fields(
    await call(STATE_CHAIN, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cf_environment', params: [] }),
    }),
  );
  const amounts = fields(fields(fields(result).ingress_egress).minimum_deposit_amounts);
  return hex(fields(amounts[coin.chain])[coin.asset]);
}

export interface Quote {
  egressAmount: bigint;
  estimatedPrice: string;
  slippageBps: number;
  livePriceBps: number | null;
  retryMinutes: number;
  seconds: number;
  dcaParams?: { numberOfChunks: number; chunkIntervalBlocks: number };
}
/** What Chainflip quotes for swapping `amount` of `coin` to ETH on Ethereum, less its broker's `bps`: a regular swap,
 * and for a large amount a DCA swap in chunks beside it, of which the one paying more ETH is taken. */
async function quote(coin: Coin, amount: bigint, bps: number): Promise<Quote> {
  const query = new URLSearchParams({
    amount: amount.toString(),
    srcChain: coin.chain,
    srcAsset: coin.asset,
    destChain: 'Ethereum',
    destAsset: 'ETH',
    brokerCommissionBps: String(bps),
    isVaultSwap: 'false',
    isOnChain: 'false',
    dcaV2Enabled: 'false',
  });
  const quotes = await call(`${BACKEND}/v2/quote?${query}`);
  if (!Array.isArray(quotes) || quotes.length < 1 || quotes.length > 2) return read.refuse('Chainflip’s quote');
  return quotes
    .map((value): Quote => {
      const q = fields(value);
      if (
        !sameAsset(q.srcAsset, coin.chain, coin.asset) ||
        !sameAsset(q.destAsset, 'Ethereum', 'ETH') ||
        read.whole(q.depositAmount) !== amount ||
        !['REGULAR', 'DCA'].includes(q.type as string)
      )
        return read.refuse('Chainflip’s quote');
      const dca = q.type === 'DCA' ? fields(q.dcaParams) : null;
      return {
        egressAmount: read.whole(q.egressAmount),
        estimatedPrice: price(q.estimatedPrice),
        slippageBps: percent(q.recommendedSlippageTolerancePercent),
        livePriceBps:
          q.recommendedLivePriceSlippageTolerancePercent == null
            ? null
            : percent(q.recommendedLivePriceSlippageTolerancePercent),
        retryMinutes: upTo(1440)(q.recommendedRetryDurationMinutes),
        seconds: upTo(86400)(q.estimatedDurationSeconds),
        ...(dca && {
          dcaParams: {
            numberOfChunks: read.count(dca.numberOfChunks),
            chunkIntervalBlocks: read.count(dca.chunkIntervalBlocks),
          },
        }),
      };
    })
    .reduce((best, q) => (q.egressAmount > best.egressAmount ? q : best));
}

export const STATES = ['WAITING', 'RECEIVING', 'SWAPPING', 'SENDING', 'SENT', 'COMPLETED', 'FAILED'] as const;
export type State = (typeof STATES)[number];
/** Where the swap through `channel` is, as Chainflip reports it: refused unless the channel is the one opened, paying
 * `destination` with refunds to `refund`. */
export async function status(
  id: string,
  channel: { coin: Coin; depositAddress: string; destination: string; refund: string },
) {
  const s = fields(await call(`${BACKEND}/v2/swaps/${encodeURIComponent(id)}`)),
    deposit = fields(s.depositChannel),
    { refundAddress } = fields(s.fillOrKillParams);
  if (
    s.srcChain !== channel.coin.chain ||
    s.srcAsset !== channel.coin.asset ||
    s.destChain !== 'Ethereum' ||
    s.destAsset !== 'ETH' ||
    chainAddress('Ethereum', s.destAddress) !== channel.destination ||
    deposit.id !== id ||
    chainAddress(channel.coin.chain, deposit.depositAddress) !== channel.depositAddress ||
    chainAddress(channel.coin.chain, refundAddress) !== channel.refund
  )
    return read.refuse('Chainflip’s channel');
  return {
    state: read.oneOf(...STATES)(s.state),
    expired: read.flag(deposit.isExpired),
    // What could not swap within the quote goes back to the refund address.
    refunded: s.refundEgress != null,
  };
}

export interface Channel {
  coin: Coin;
  amount: bigint;
  minimum: bigint;
  quote: Quote;
  id: string;
  depositAddress: string;
  destination: string;
  refund: string;
  expiresAt: number;
}
/** A deposit channel taking `amount` of `coin`, swapped to ETH for `destination`, refunded to `refund` if the swap
 * cannot fill within the quote's slippage. */
export async function openChannel(coin: Coin, amount: bigint, destination: string, refund: string): Promise<Channel> {
  const [bps, least] = await Promise.all([commission(), minimum(coin)]);
  if (amount < least) throw new Error(`Chainflip takes at least ${inCoin(least, coin)}.`);
  const q = await quote(coin, amount, bps);
  const opened = fields(
    await call(`${BACKEND}/api/openSwapDepositChannel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        srcAsset: { chain: coin.chain, asset: coin.asset },
        destAsset: { chain: 'Ethereum', asset: 'ETH' },
        destAddress: destination,
        amount: amount.toString(),
        dcaParams: q.dcaParams,
        fillOrKillParams: {
          retryDurationBlocks: Math.ceil(q.retryMinutes * 10),
          refundAddress: refund,
          minPriceX128: minPriceX128(q.estimatedPrice, q.slippageBps, coin).toString(),
          maxOraclePriceSlippage: q.livePriceBps,
        },
        takeCommission: true,
      }),
    }),
  );
  const id =
      typeof opened.id === 'string' && /^[0-9]{1,20}-[A-Za-z]{1,20}-[0-9]{1,20}$/.test(opened.id) ? opened.id : null,
    depositAddress = chainAddress(coin.chain, opened.depositAddress);
  if (!id || !depositAddress || opened.brokerCommissionBps !== bps) return read.refuse('Chainflip’s channel');
  const channel = {
    coin,
    amount,
    minimum: least,
    quote: q,
    id,
    depositAddress,
    destination,
    refund,
    expiresAt: read.time(opened.estimatedExpiryTime),
  };
  if ((await status(id, channel)).state !== 'WAITING') return read.refuse('Chainflip’s channel');
  return channel;
}
