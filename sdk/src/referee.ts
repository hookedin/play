/**
 * The server side of a game with a referee. A referee is a key its developer publishes with the game; it
 * holds no money and has no account at the casino. Players' wallets place the game's bets by themselves, and
 * the referee settles them. It draws bets with prizes against the bankroll: it opens a round, which the casino
 * names and the referee commits the seed it will draw it with to, and players' bets ride the open round, so
 * each bet's outcome is fixed before it is placed. It signs what a bet with terms pays, which the developer's
 * bank pays beyond the stake. Each wallet checks what settled its bet before it collects.
 *
 * Everything here uses the casino's public API and runs wherever `fetch` does: Node, or a Cloudflare Worker.
 */
import { Wallet, getBytes, keccak256 } from 'ethers';
import {
  authorization,
  domain,
  gameKey,
  outcome,
  roundId,
  same,
  seedHash,
  assertProtocol,
  REFEREE_ACCESS_TYPES,
  SETTLEMENT_TYPES,
  COMMIT_TYPES,
} from '@hookedin/play/protocol/protocol.ts';
import type { AssetId } from '@hookedin/play/protocol/protocol.ts';
import type { GameName, PublicBet, Round } from '@hookedin/play/protocol/types.ts';

export type { AssetId, GameName, PublicBet, Round };
/** What one bet with terms pays: `player` to its player and `casino` to the casino. Your bank keeps the rest
 * of the stake, or pays what the two come to beyond it. Give the casino about half of what the bet was
 * expected to earn you: that is the casino's policy, and nothing enforces it. */
export interface Settlement {
  bet: string;
  player: string | bigint;
  casino: string | bigint;
}
/** A round's draw as the casino recorded it: the round, its seed and secret and their 64-bit outcome, and
 * every bet that rode it as it stands now: paid, refunded because the draw could not take it, or refunded at
 * its deadline. A round with no open bets is not drawn, and has no seed or outcome yet. */
export interface Drawn {
  round: string;
  seed?: string;
  secret?: string;
  outcome?: bigint;
  bets: PublicBet[];
}
export interface Referee {
  address: string;
  /** Every bound this casino holds a bet and a draw to: the most bets one round takes, the furthest deadline. */
  limits: { prizes: number; outcomeSpace: string; bets: number; cells: number; deadline: number };
  /** This referee's open round in an asset: named by the casino, and committed to the seed this key will draw
   * it with. Players' wallets bet on it, so open one before players bet. */
  open(asset: AssetId): Promise<Round>;
  /** Draw the open round in an asset: every open bet on it rides one outcome against the bankroll, admitted in
   * the order the casino took them, and each admitted bet is owed what its prizes pay; one that does not fit is
   * refunded. The next round is then open. The seed is derived from this key, so asking again after a lost
   * reply is the same draw. */
  draw(asset: AssetId): Promise<Drawn>;
  /** Settle bets with terms, each with a split signed here. The casino takes the batch whole or, if your bank
   * cannot pay it, not at all. A bet settled before answers with what settled it. */
  settle(settlements: Settlement[]): Promise<PublicBet[]>;
  /** This game's open bets, or those of one group, in the order they were placed. */
  bets(group?: string): Promise<PublicBet[]>;
  /** A bet that settles later as anyone may read it; null for one the casino does not know. */
  bet(hash: string): Promise<PublicBet | null>;
}

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
  const asReferee = async (path: string, body: unknown) => {
    const message = { referee: signer.address, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    return api(path, body, {
      authorization: authorization(message, await signer.signTypedData(d, REFEREE_ACCESS_TYPES, message)),
    });
  };
  // The seed a round is drawn with: this key's signature of the round, hashed. Nobody without the key can know
  // it before the draw, and the same round always gets the same seed.
  const seedOf = async (round: string) => keccak256(await signer.signMessage(getBytes(round)));
  // Each asset's open round, as this referee committed it.
  const rounds: Partial<Record<AssetId, Round>> = {};
  const commit = async (asset: AssetId, round: string) => {
    const hash = seedHash(await seedOf(round));
    return (rounds[asset] = (await asReferee(`/api/rounds/${round}/commit`, {
      seedHash: hash,
      signature: await signer.signTypedData(d, COMMIT_TYPES, { round, seedHash: hash }),
    })) as Round);
  };
  const open = async (asset: AssetId) =>
    rounds[asset] ?? commit(asset, (await asReferee('/api/rounds', { game, asset })).id);
  return {
    address: signer.address,
    limits: config.limits,
    open,
    async draw(asset) {
      const round = await open(asset);
      let drawn;
      try {
        drawn = await asReferee(`/api/rounds/${round.id}/draw`, { seed: await seedOf(round.id) });
      } catch (error: any) {
        // A round the casino no longer knows is opened afresh.
        if (error.status === 404) delete rounds[asset];
        throw error;
      }
      if (drawn.secret !== undefined && !same(roundId(drawn.secret), round.id))
        throw new Error("The casino revealed a secret that is not the round's");
      if (!same(drawn.next, round.id)) {
        delete rounds[asset];
        // The next round opens at once, so players can bet on it; if that fails, the next `open` or `draw` does.
        await commit(asset, drawn.next).catch(() => {});
      }
      return {
        round: round.id,
        bets: drawn.bets,
        ...(drawn.secret === undefined
          ? {}
          : { seed: drawn.seed, secret: drawn.secret, outcome: outcome([], drawn.seed, drawn.secret).value }),
      };
    },
    async settle(settlements) {
      const signed = await Promise.all(
        settlements.map(async ({ bet, player, casino }) => {
          const message = { bet, player: String(player), casino: String(casino) };
          return { ...message, signature: await signer.signTypedData(d, SETTLEMENT_TYPES, message) };
        }),
      );
      return asReferee('/api/bets/settle', { settlements: signed });
    },
    bets: group =>
      api(`/api/bets?game=${gameKey(game)}${group === undefined ? '' : `&group=${encodeURIComponent(group)}`}`),
    bet: hash =>
      api(`/api/bets/${hash}`).catch(error => {
        if (error.status === 404) return null;
        throw error;
      }),
  };
}
