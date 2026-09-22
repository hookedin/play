/**
 * The server side of a game many players share. A host is only a key: it holds no money and has no
 * account at the casino.
 *
 * For a game against the house in which everyone shares one outcome, it opens a round with the hash
 * of a seed, players' wallets join it with their bets, and it closes the round with the seed. Until
 * then neither the host nor the casino knows the outcome.
 *
 * Everything here uses the casino's public API and runs wherever `fetch` does: Node, or a Cloudflare Worker.
 */
import { Wallet, hexlify, randomBytes } from 'ethers';
import {
  authorization,
  domain,
  outcome,
  seedHash,
  assertProtocol,
  HOST_ACCESS_TYPES,
} from '@hookedin/play/protocol/protocol.ts';
import type { AssetId } from '@hookedin/play/protocol/protocol.ts';
import type { RoundStatus } from '@hookedin/play/protocol/types.ts';
import type { Round } from './wire.ts';

export type { AssetId, Round, RoundStatus };
/** The betting windows a casino takes, in milliseconds, counted from a round's first seat. They come
 * from the casino, so a host holds no number of its own that a deployment could change under it. */
export interface WindowLimits {
  min: number;
  max: number;
}
/** A round the host has open. `round` is what the pages bet on; `seed` stays here until the close. */
export interface OpenedRound {
  round: Round;
  seed: string;
}
/** A round the host closed, with the seed and the secret that settled every seat. */
export type ClosedRound = RoundStatus & { seed: string; secret: string };
/** What the host of a shared round does: open rounds for the pages to bet on, and close them. */
export interface RoundHost {
  address: string;
  /** The betting windows this casino takes. `round` asks for `window.max` unless told otherwise. */
  window: WindowLimits;
  /** Open a round for the pages to bet on: a seed is drawn here and only its hash is sent, and the
   * casino names the round by the hash of a secret of its own. Keep the seed with your game state:
   * without it the round cannot be closed. A round is bet on in one asset, ETH unless you say
   * `test`; run one for each asset your game takes.
   *
   * `window` is your betting time in milliseconds, counted from the first seat and within the
   * casino's own `window` limits: close the round within it, because a player's bet is held until you
   * do. The casino reveals a round whose window runs out and declines every seat, so leave room for
   * the close itself. A round nobody joins waits much longer and costs its players nothing. */
  round(asset?: AssetId, window?: number): Promise<OpenedRound>;
  /** Who sits in a round and, once it is revealed, its seed and secret; null for a round the casino does not know. */
  seats(round: string): Promise<RoundStatus | null>;
  /** Close a round with its seed: the casino reveals its secret and settles every seat on the one
   * outcome. Closing again after a lost reply is the same answer. */
  close(round: string, seed: string): Promise<ClosedRound>;
}
export type Host = RoundHost;
/** The 64-bit outcome every bet on a round shares, once its seed and secret are out. */
export const roundOutcome = (seed: string, secret: string) => outcome([], seed, secret).value;

export async function createHost({
  casinoURL,
  key,
}: {
  casinoURL: string;
  /** The host's private key. It signs its own requests about rounds, and nothing else. */
  key: string;
}): Promise<Host> {
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
  /** A request only the round's host may make: signed with the host key, good for a minute. */
  const asHost = async (path: string, body: unknown = {}) => {
    const message = { host: signer.address, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    return api(path, body, {
      authorization: authorization(message, await signer.signTypedData(d, HOST_ACCESS_TYPES, message)),
    });
  };
  // Every bound this casino holds a round to. A window it would refuse is refused here, before a
  // seed is drawn and a round opened that no page could bet on.
  const window: WindowLimits = config.limits.window;
  return {
    address: signer.address,
    window,
    async round(asset = 'eth', ms = window.max) {
      if (!Number.isFinite(ms) || ms < window.min || ms > window.max)
        throw new Error(`This casino takes a betting window of ${window.min} to ${window.max} milliseconds`);
      // The host sends only the hash of its seed, so the casino cannot draw a secret to suit it; and
      // the host never sees that secret, so it cannot know the outcome while seats are taken.
      const seed = hexlify(randomBytes(32)),
        round = { id: '', seedHash: seedHash(seed) };
      round.id = (await asHost('/api/rounds', { seedHash: round.seedHash, asset, window: ms })).id;
      return { round, seed };
    },
    seats: id =>
      api(`/api/rounds/${id}`).catch(error => {
        if (error.status === 404) return null;
        throw error;
      }),
    close: (id, seed) => asHost(`/api/rounds/${id}/close`, { seed }),
  };
}
