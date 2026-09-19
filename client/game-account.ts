import type { GameIdentity } from '../protocol/game-types.ts';
import { getAddress, id, ZeroAddress } from 'ethers';

export function gameKey(identity: GameIdentity) {
  const developer = getAddress(identity.developer);
  if (developer === ZeroAddress) throw new Error('A developer fee recipient is required');
  for (const url of [identity.manifestURL, identity.entryURL])
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Game URLs must use HTTP(S)');
  return id(JSON.stringify([identity.manifestURL, identity.entryURL, developer.toLowerCase()]));
}
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
