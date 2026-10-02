/** What the bridge and the round helper share, safe in Node: amounts as a player reads them, and whose saved state is
 * whose. The bridge carries amounts as decimal strings of whole wei; players read and type them in µETH, a millionth of
 * an ETH, 10^12 wei. */

const DECIMALS = 12;

/** What the player typed, in µETH, as whole wei. */
export function parseAmount(value: string) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value.trim()))
    throw new Error('Enter an amount in µETH, with up to 12 decimal places.');
  const [whole, fractional = ''] = value.trim().split('.');
  const wei = BigInt(whole!) * 10n ** BigInt(DECIMALS) + BigInt(fractional.padEnd(DECIMALS, '0'));
  if (wei <= 0n) throw new Error('Enter an amount greater than zero.');
  return wei.toString();
}

/** Wei as the player reads them, in µETH: thousands grouped, cut off (never rounded) at `places` decimals, a gwei by
 * default, or whole µETH with none, as a balance reads, without trailing zeros. A positive amount too small for that
 * reads `<0.001`, or `<1`. */
export function formatAmount(value: string | number | bigint, places = 3) {
  try {
    const wei = BigInt(value),
      sign = wei < 0n ? '-' : '',
      positive = wei < 0n ? -wei : wei,
      unit = 10n ** BigInt(DECIMALS),
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
