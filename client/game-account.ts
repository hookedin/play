import type { GameIdentity } from '../protocol/game-types.ts';

/** The game an operation is for, as a bet or a payment signs it: its key, which stays the same wherever the game
 * is served. */
export function gameRef(identity: GameIdentity): string {
  for (const url of [identity.manifestURL, identity.entryURL])
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Game URLs must use HTTP(S)');
  if (!/^0x[0-9a-f]{64}$/.test(identity.key)) throw new Error('A game key is a lowercase 32-byte hash');
  return identity.key;
}
export function gameAmount(value: unknown, positive = true) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('Use decimal wei amounts');
  const n = BigInt(value);
  if (n >= 1n << 256n || (positive && n === 0n)) throw new Error('Amount is outside the supported range');
  return n;
}
/** A game names its own operations; the wallet scopes them by player, asset and game. */
export function gameOperationKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(value))
    throw new Error('A game operation ID is 1–64 characters of letters, digits, ".", "_", ":" or "-"');
}
/** Where a developer bet this wallet placed stands: `open` until the wallet has collected what its developer paid;
 * then `settled` if that is what it is owed, `returned` if its developer did not cover it and paid its stake back,
 * or `shorted` if it was paid less than it is owed. A bet with terms is owed what its developer says. */
export function developerBetStatus(receipt: any): 'open' | 'settled' | 'returned' | 'shorted' {
  if (receipt.payout === undefined) return 'open';
  if (receipt.details?.developerBet?.terms) return 'settled';
  if (BigInt(receipt.payout) < BigInt(receipt.owed)) return 'shorted';
  return receipt.covered ? 'settled' : 'returned';
}
