/** What the bridge and the round helper share, safe in Node: amounts as a player reads them, and whose saved state is
 * whose. Amounts are bigints of whole wei; players read and type them in METH, a millionth of an ETH, 10^12 wei. */

const DECIMALS = 12;
/** A METH, in wei. */
export const METH = 10n ** BigInt(DECIMALS);
/** What METH means, said wherever a page labels an amount with it: the title the label shows on hover. */
export const METH_TITLE = 'A millionth of an ETH: 1 METH = 0.000001 ETH';
/** What a game says before its first bet while it has no allowance: only the player sets one, in the wallet's top bar. */
export const NO_ALLOWANCE = 'Set an allowance in the top bar to play.';
/** Why a bet the allowance does not cover is refused, whichever refuses it: only the player sets an allowance, in the
 * wallet's top bar, which offers to create a wallet or deposit when there is nothing to allow yet. */
export const NOT_ENOUGH_ALLOWANCE =
  'Not enough allowance for this bet: it is what you let this game play with. Set it in the top bar, creating a wallet or depositing first if it asks.';
/** Why a developer bet is refused while the player has not allowed them, whichever refuses it: they allow them with the
 * allowance, in the wallet's top bar. */
export const NO_DEVELOPER_BETS = 'Allow developer bets with the allowance in the top bar.';
/** A refusal a game can act on. `code` is stable; the message is for people. The wallet's own codes:
 * `invalid-request`, `unknown-method`, `busy`, `insufficient-allowance`, `developer-bets-not-allowed`,
 * `pending-operation`, `id-conflict`, `id-used`, `not-found`, `game-closed` and `failed`; a refusal by the casino
 * carries the casino's code. */
export class HookedInError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HookedInError';
    this.code = code;
  }
}

/** What the player typed, a whole number of METH, as wei: every stake a player chooses is whole METH. */
export function parseAmount(value: string) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.trim()))
    throw new Error('Enter a whole number of METH.');
  const wei = BigInt(value.trim()) * METH;
  if (wei <= 0n) throw new Error('Enter an amount greater than zero.');
  return wei;
}

/** The stake a player can choose at or below `wei`: whole METH, and at least one. */
export function wholeStake(wei: bigint) {
  const whole = wei - (wei % METH);
  return whole > 0n ? whole : METH;
}

/** Wei as the player reads them, in METH: thousands grouped, cut off (never rounded) at `places` decimals, a gwei by
 * default, or whole METH with none, as a balance reads, without trailing zeros. A positive amount too small for that
 * reads `<0.001`, or `<1`. Anything but a bigint shows as none. */
export function formatAmount(wei: bigint, places = 3) {
  if (typeof wei !== 'bigint') return '—';
  const sign = wei < 0n ? '-' : '',
    positive = wei < 0n ? -wei : wei,
    whole = (positive / METH).toString().replace(/\B(?=(\d{3})+$)/g, ','),
    fractional = (positive % METH).toString().padStart(DECIMALS, '0').slice(0, places).replace(/0+$/, '');
  if (positive > 0n && whole === '0' && !fractional) return `${sign}<${places ? `0.${'0'.repeat(places - 1)}` : ''}1`;
  return `${sign}${whole}${fractional ? '.' + fractional : ''}`;
}

/** Every digit of an amount, ungrouped: what belongs in a field the player edits. */
export const exactAmount = (wei: bigint) => formatAmount(wei, DECIMALS).replaceAll(',', '');

/** What tells one player's saved state from another's: the chain, and the player's uname, which a Discord username
 * never changes. Games that share a host and accounts that share a browser must not read each other's state. */
export const playerScope = (names: { uname?: string | null; chainId?: bigint } | null | undefined) =>
  `${names?.chainId ?? 'chain'}:${String(names?.uname ?? 'anonymous').toLowerCase()}`;
