/**
 * The server side of a game with pots: its referee. A referee is a key its developer publishes with the
 * game; it holds no money and has no account at the casino. It opens the game's pots, prices entries into a
 * developer's pot, and ends each pot: a house pot with the seed it opened it by the hash of, a developer's
 * or players' pot with a result it signs. Players' wallets enter pots by themselves, and each wallet
 * checks what ended a pot before it collects what the pot paid.
 *
 * Everything here uses the casino's public API and runs wherever `fetch` does: Node, or a Cloudflare Worker.
 */
import { Wallet, hexlify, randomBytes } from 'ethers';
import {
  authorization,
  domain,
  outcome,
  seedHash,
  hashJSON,
  assertProtocol,
  REFEREE_ACCESS_TYPES,
  QUOTE_TYPES,
  RESOLUTION_TYPES,
} from '@hookedin/play/protocol/protocol.ts';
import type { AssetId } from '@hookedin/play/protocol/protocol.ts';
import type { Bank, EntryTerms, GameName, PotResult, PotStatus } from '@hookedin/play/protocol/types.ts';

export type { AssetId, Bank, GameName, PotResult, PotStatus };
/** The betting windows a casino takes for a house pot, in milliseconds, counted from its first entry. */
export interface WindowLimits {
  min: number;
  max: number;
}
export interface OpenOptions {
  bank: Bank;
  /** What the pot is played with: ETH unless you say `test`. Run a pot for each asset your game takes. */
  asset?: AssetId;
  /** A house pot's betting time, counted from its first entry: how long a player's entry waits on you.
   * Resolve the pot within it, or it is void. `window.max` unless you ask for less. */
  window?: number;
  /** A developer's pot names its outcomes 0 to `outcomes - 1`. */
  outcomes?: number;
  /** A players' pot takes at most this rake, in basis points of its entries. */
  rake?: number;
  /** A developer's or players' pot: no entry after `closesAt`, and void if unresolved by `deadline`
   * (unix milliseconds, within 30 days). */
  closesAt?: number;
  deadline?: number;
}
export interface Referee {
  address: string;
  /** The betting windows this casino takes for a house pot. */
  window: WindowLimits;
  /** Open a pot. A house pot's seed is drawn here and only its hash sent: keep `seed` with your game
   * state and show it to nobody, because resolving the pot needs it and anyone holding it early could
   * know the outcome. */
  open(options: OpenOptions): Promise<{ pot: PotStatus; seed?: string }>;
  /** Your price for one entry into a developer's pot: the stake and the prizes it pays over the pot's
   * outcomes, good until `expiresAt` (unix seconds). The player's wallet enters with it. */
  quote(
    pot: string,
    stake: string | bigint,
    prizes: NonNullable<EntryTerms['prizes']>,
    expiresAt?: number,
  ): Promise<{ expiresAt: string; signature: string }>;
  /** End a pot: a house pot with its seed, a developer's pot with its outcome, a players' pot with its
   * split and rake. The result is signed here, so every wallet can check it came from you. Asking again
   * after a lost reply is the same answer. */
  resolve(pot: string, ending: { seed: string } | PotResult): Promise<PotStatus>;
  /** Call a pot off: every entry is refunded. */
  void(pot: string): Promise<PotStatus>;
  /** A pot as anyone may read it; null for one the casino does not know. */
  pot(id: string): Promise<PotStatus | null>;
}
/** The 64-bit outcome of a house pot, once its seed and secret are out. */
export const roundOutcome = (seed: string, secret: string) => outcome([], seed, secret).value;

export async function createReferee({
  casinoURL,
  key,
  game,
}: {
  casinoURL: string;
  /** The referee's private key. Its address is what the game's developer publishes the game with. */
  key: string;
  /** The game this referee runs: its developer and the name it is published under. */
  game: GameName;
}): Promise<Referee> {
  const signer = new Wallet(key),
    api = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(
        casinoURL + path,
        body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers },
      );
      const value: any = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(value.error || 'Casino unavailable'), {
          status: response.status,
          code: value.code,
        });
      return value;
    },
    config = await api('/api/config');
  assertProtocol(config);
  const d = domain(config.chainId, config.contractAddress);
  /** A request only the referee may make: signed with its key, good for a minute. */
  const asReferee = async (path: string, body: unknown = {}) => {
    const message = { referee: signer.address, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    return api(path, body, {
      authorization: authorization(message, await signer.signTypedData(d, REFEREE_ACCESS_TYPES, message)),
    });
  };
  const window: WindowLimits = config.limits.window;
  return {
    address: signer.address,
    window,
    async open({ bank, asset = 'eth', window: ms = window.max, ...rest }) {
      if (bank !== 'house') return { pot: await asReferee('/api/pots', { game, bank, asset, ...rest }) };
      if (!Number.isFinite(ms) || ms < window.min || ms > window.max)
        throw new Error(`This casino takes a betting window of ${window.min} to ${window.max} milliseconds`);
      // Only the seed's hash leaves: the casino draws its secret without knowing what it would settle.
      const seed = hexlify(randomBytes(32));
      return {
        pot: await asReferee('/api/pots', { game, bank, asset, window: ms, seedHash: seedHash(seed) }),
        seed,
      };
    },
    async quote(pot, stake, prizes, expiresAt = Math.floor(Date.now() / 1000) + 60) {
      const message = { pot, stake: String(stake), prizes: hashJSON(prizes), expiresAt: String(expiresAt) };
      return { expiresAt: message.expiresAt, signature: await signer.signTypedData(d, QUOTE_TYPES, message) };
    },
    async resolve(pot, ending) {
      if ('seed' in ending) return asReferee(`/api/pots/${pot}/resolve`, ending);
      const signature = await signer.signTypedData(d, RESOLUTION_TYPES, { pot, result: hashJSON(ending) });
      return asReferee(`/api/pots/${pot}/resolve`, { result: ending, signature });
    },
    void: pot => asReferee(`/api/pots/${pot}/void`),
    pot: id =>
      api(`/api/pots/${id}`).catch(error => {
        if (error.status === 404) return null;
        throw error;
      }),
  };
}
