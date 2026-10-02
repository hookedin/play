/** What the bridge and the round helper share, safe in Node: amounts as a player reads them, and whose saved state is
 * whose. The bridge carries amounts as decimal strings of whole wei; players read and type them in µETH, a millionth of
 * an ETH, 10^12 wei. */

const DECIMALS = 12;
/** A µETH, in wei. */
export const MICRO_ETH = 10n ** BigInt(DECIMALS);

/** What the player typed, a whole number of µETH, as wei: every stake a player chooses is whole µETH. */
export function parseAmount(value: string) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.trim()))
    throw new Error('Enter a whole number of µETH.');
  const wei = BigInt(value.trim()) * MICRO_ETH;
  if (wei <= 0n) throw new Error('Enter an amount greater than zero.');
  return wei.toString();
}

/** The stake a player can choose at or below `wei`: whole µETH, a multiple of `units` of them, and at least that. */
export function wholeStake(wei: bigint | string, units = 1n) {
  const step = units * MICRO_ETH,
    whole = BigInt(wei) - (BigInt(wei) % step);
  return whole > 0n ? whole : step;
}

/** Wei as the player reads them, in µETH: thousands grouped, cut off (never rounded) at `places` decimals, a gwei by
 * default, or whole µETH with none, as a balance reads, without trailing zeros. A positive amount too small for that
 * reads `<0.001`, or `<1`. */
export function formatAmount(value: string | number | bigint, places = 3) {
  try {
    const wei = BigInt(value),
      sign = wei < 0n ? '-' : '',
      positive = wei < 0n ? -wei : wei,
      unit = MICRO_ETH,
      whole = (positive / unit).toString().replace(/\B(?=(\d{3})+$)/g, ','),
      fractional = (positive % unit).toString().padStart(DECIMALS, '0').slice(0, places).replace(/0+$/, '');
    if (positive > 0n && whole === '0' && !fractional) return `${sign}<${places ? `0.${'0'.repeat(places - 1)}` : ''}1`;
    return `${sign}${whole}${fractional ? '.' + fractional : ''}`;
  } catch {
    return '—';
  }
}

/** Every digit of an amount, ungrouped: what belongs in a field the player edits. */
export const exactAmount = (value: string | number | bigint) => formatAmount(value, DECIMALS).replaceAll(',', '');

/** What tells one player's saved state from another's: the chain, and the player's uname, which an alias never
 * changes. Games that share a host and accounts that share a browser must not read each other's state. */
export const playerScope = (names: { uname?: string | null; chainId?: string } | null | undefined) =>
  `${names?.chainId ?? 'chain'}:${String(names?.uname ?? 'anonymous').toLowerCase()}`;
