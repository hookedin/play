/**
 * The server side of a game whose bets settle later: its referee, which is its developer's key. It is the account
 * the game is published from, so the server holds everything that account holds: its games, their commission and
 * its bank, which pays the splits the key signs. A developer who wants their server to hold less publishes the game
 * from an account of its own. Players' wallets place the game's bets by themselves, and the referee settles them.
 * It draws bets with prizes on its rounds: the casino names a round and the referee commits the seed it will draw
 * it with, the game tells its players the round, and each bet names it, so its outcome is fixed before it is
 * placed. It signs what a bet with terms pays. Each wallet checks what settled its bet before it collects.
 *
 * Everything here uses the casino's public API and runs wherever `fetch` does: Node, or a Cloudflare Worker.
 */
import { Wallet, getBytes, keccak256 } from 'ethers';
import {
  authorization,
  domain,
  gameKey,
  roundId,
  same,
  seedHash,
  assertProtocol,
  REFEREE_ACCESS_TYPES,
  SETTLEMENT_TYPES,
  COMMIT_TYPES,
} from '../../protocol/protocol.ts';
import type { AssetId } from '../../protocol/protocol.ts';
import type { PublicBet, Round } from '../../protocol/types.ts';

export type { AssetId, PublicBet, Round };
/** What one bet with terms pays: `player` to its player and `casino` to the casino. The developer's bank keeps the
 * rest of the stake, or pays what the two come to beyond it. Give the casino about half of what the bet was
 * expected to earn you: that is the casino's policy, and nothing enforces it. */
export interface Settlement {
  bet: string;
  player: string | bigint;
  casino: string | bigint;
}
/** A round's draw as the casino recorded it: the round, its seed and secret and their 64-bit outcome, and
 * every bet that rode it as it stands now, paid or, past the round's deadline, refunded. A round with no open
 * bets is not drawn, and has no seed or outcome yet. */
export interface Drawn {
  round: string;
  seed?: string;
  secret?: string;
  outcome?: string;
  bets: PublicBet[];
}
export interface Referee {
  address: string;
  /** Every bound a bet and a round are held to: the most bets one round takes, how long a round takes bets, the
   * furthest deadline of a bet with terms. */
  limits: {
    prizes: number;
    outcomeSpace: string;
    bets: number;
    cells: number;
    round: number;
    deadline: number;
    terms: number;
    group: number;
  };
  /** Your game's round in an asset that takes bets: named by the casino, with the deadline it is drawn by, and
   * committed to the seed this key will draw it with. It is the same round until it is drawn or its deadline
   * passes, so asking again is safe. Tell your players its `id`: their wallets bet on it by name. */
  open(asset: AssetId): Promise<Round>;
  /** Draw the round named `round`: every open bet on it rides one outcome, and each is paid what its prizes pay.
   * The casino took each against the bankroll as it was placed. The seed is derived from this key and the
   * round, so drawing again after a lost reply is the same draw. Save the round you are drawing before you draw
   * it: that is the round to ask again for. */
  draw(round: string): Promise<Drawn>;
  /** A round as anyone may read it, drawn or not. */
  round(id: string): Promise<Round>;
  /** Settle bets with terms, each with a split signed here. The casino takes the batch whole or, if the
   * developer's bank cannot pay it, not at all. A bet settled before answers with what settled it. */
  settle(settlements: Settlement[]): Promise<PublicBet[]>;
  /** This game's open bets, or those of one group, in the order they were placed. */
  bets(group?: string): Promise<PublicBet[]>;
  /** A bet that settles later as anyone may read it; null for one the casino does not know. */
  bet(hash: string): Promise<PublicBet | null>;
}

export async function createReferee({
  casinoURL,
  key,
  name,
}: {
  casinoURL: string;
  /** The private key of the game's developer, the account it is published from. */
  key: string;
  /** The name the game is published under. With the key's address it makes the game's key. */
  name: string;
}): Promise<Referee> {
  const signer = new Wallet(key),
    game = gameKey({ developer: signer.address, name }).toLowerCase(),
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
  assertProtocol(config, true);
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
  return {
    address: signer.address,
    limits: config.limits,
    async open(asset) {
      const round: Round = await asReferee('/api/rounds', { game, asset });
      if (round.seedHash) return round;
      const hash = seedHash(await seedOf(round.id));
      return asReferee(`/api/rounds/${round.id}/commit`, {
        seedHash: hash,
        signature: await signer.signTypedData(d, COMMIT_TYPES, { round: round.id, seedHash: hash }),
      });
    },
    async draw(round) {
      const drawn: Drawn = await asReferee(`/api/rounds/${round}/draw`, { seed: await seedOf(round) });
      if (drawn.secret !== undefined && !same(roundId(drawn.secret), round))
        throw new Error("The casino revealed a secret that is not the round's");
      return drawn;
    },
    round: id => api(`/api/rounds/${id}`),
    async settle(settlements) {
      const signed = await Promise.all(
        settlements.map(async ({ bet, player, casino }) => {
          const message = { bet, player: String(player), casino: String(casino) };
          return { ...message, signature: await signer.signTypedData(d, SETTLEMENT_TYPES, message) };
        }),
      );
      return asReferee('/api/bets/settle', { settlements: signed });
    },
    bets: group => api(`/api/bets?game=${game}${group === undefined ? '' : `&group=${encodeURIComponent(group)}`}`),
    bet: hash =>
      api(`/api/bets/${hash}`).catch(error => {
        if (error.status === 404) return null;
        throw error;
      }),
  };
}
