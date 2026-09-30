/** What the bridge and the round helper share, safe in Node: ETH amounts as a player reads them, and whose saved state
 * is whose. The bridge carries amounts as decimal strings of whole wei. */

/** What the player typed, in ETH, as whole wei. */
export function parseAmount(value: string) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value.trim()))
    throw new Error('Enter a positive stake with up to 18 decimal places.');
  const [whole, fractional = ''] = value.trim().split('.');
  const wei = BigInt(whole!) * 10n ** 18n + BigInt(fractional.padEnd(18, '0'));
  if (wei <= 0n) throw new Error('Your stake must be greater than zero.');
  return wei.toString();
}

/** Wei as the player reads them, in ETH, truncated to `places` decimal places. */
export function formatAmount(value: string | number | bigint, places = 6) {
  try {
    const wei = BigInt(value),
      sign = wei < 0n ? '-' : '',
      positive = wei < 0n ? -wei : wei,
      whole = positive / 10n ** 18n,
      fractional = (positive % 10n ** 18n).toString().padStart(18, '0').slice(0, places).replace(/0+$/, '');
    if (positive > 0n && whole === 0n && !fractional) return `${sign}<0.${'0'.repeat(places - 1)}1`;
    return `${sign}${whole}${fractional ? '.' + fractional : ''}`;
  } catch {
    return '—';
  }
}

/** Every digit of an amount: what belongs in a field the player edits. */
export const exactAmount = (value: string | number | bigint) => formatAmount(value, 18);

/** What tells one player's saved state from another's: the chain, and the player's uname, which an alias never
 * changes. Games that share a host and accounts that share a browser must not read each other's state. */
export const playerScope = (names: { uname?: string | null; chainId?: string } | null | undefined) =>
  `${names?.chainId ?? 'chain'}:${String(names?.uname ?? 'anonymous').toLowerCase()}`;
