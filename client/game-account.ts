import type { GameIdentity } from '../protocol/game-types.ts';
import { getAddress, ZeroAddress } from 'ethers';
import { gameKey as keyOf } from '../protocol/protocol.ts';
import type { GameName } from '../protocol/types.ts';

/** A game is its developer and the name it goes by: the slug its developer published it under, or, for a
 * game loaded straight from its manifest, that manifest's URL. Where it is served may change; the game
 * does not, so a receipt and a pending operation survive a move. Every bet and payment signs it. */
export function gameName(identity: GameIdentity): GameName {
  const developer = getAddress(identity.developer);
  if (developer === ZeroAddress) throw new Error('A developer fee recipient is required');
  for (const url of [identity.manifestURL, identity.entryURL])
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Game URLs must use HTTP(S)');
  return { developer, name: identity.slug ?? identity.manifestURL };
}
/** The one value a game's bets, commission and public record are kept under. */
export const gameKey = (identity: GameIdentity) => keyOf(gameName(identity));
export function gameAmount(value: unknown, positive = true) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('Use decimal wei amounts');
  const n = BigInt(value);
  if (n >= 1n << 256n || (positive && n === 0n)) throw new Error('Amount is outside the supported range');
  return n;
}
/** A game names its own operations; the wallet scopes them by channel and game. */
export function gameOperationKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(value))
    throw new Error('A game operation ID is 1–64 characters of letters, digits, ".", "_", ":" or "-"');
}
