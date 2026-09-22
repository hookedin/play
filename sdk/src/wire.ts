/** What travels between a game page, the wallet and the game's own server. */

/** A round a game's host opened: every bet that names it shares one outcome. `id` is the hash of a
 * secret the casino drew, and `seedHash` the hash of a seed the host keeps until it closes the
 * round, so nobody knows the outcome while bets are taken. */
export interface Round {
  id: string;
  seedHash: string;
}

/** The two names a player answers to. A uname is theirs for good; an alias is what they are
 * called today. */
export interface PlayerNames {
  uname?: string | null;
  alias?: string | null;
}
/** How a player is written: an alias wears `@`, a uname wears `~`. */
export const showName = (names: PlayerNames | null | undefined) =>
  names?.alias ? '@' + names.alias : names?.uname ? '~' + names.uname : '—';
/** What tells one player's saved state from another's: the chain, the asset in play, and the
 * player's uname, which an alias never changes. Games that share a host, accounts that share a
 * browser, and the same player's ETH and test-coin play must not read each other's state. */
export const playerScope = (names: (PlayerNames & { chainId?: string }) | null | undefined, asset: string) =>
  `${names?.chainId ?? 'chain'}:${asset}:${String(names?.uname ?? 'anonymous').toLowerCase()}`;
