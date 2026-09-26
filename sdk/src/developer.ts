/**
 * The server side of a game with developer bets: its developer's key. It is the account the game is published from, so
 * the server holds everything that account holds: its games, their commission and its bank. A developer who wants
 * their server to hold less publishes the game from an account of its own.
 *
 * Players' wallets place developer bets by themselves: each pays its stake into this developer's bank at once, and the
 * developer settles it, on its word. A bet's meta is the game's own JSON: the casino keeps it and never reads it.
 *
 * A game that wants its developer bets provably fair makes them so itself, on a round: the casino names the round by
 * the hash of a secret it keeps, the game publishes the hash of the seed this kit derives for it before anybody bets,
 * and the developer's casino bet on the round, from its bank against the bankroll, reveals the outcome. What the game
 * commits to before that, such as which bets the casino bet backs, goes in the casino bet's meta, which the casino
 * keeps with the reveal. Roulette is the reference.
 *
 * Everything here uses the casino's public API and runs wherever `fetch` does: Node, or a Cloudflare Worker.
 */
import { Wallet, getBytes, keccak256 } from 'ethers';
import {
  authorization,
  domain,
  gameKey,
  hashJSON,
  roundId,
  same,
  seedHash as hashOfSeed,
  assertProtocol,
  DEVELOPER_ACCESS_TYPES,
  DEVELOPER_PROTOCOL,
  LIMITS,
  SETTLEMENT_TYPES,
  BANK_CASINO_BET_TYPES,
  MAX_DEVELOPER_BETS,
  MAX_META_BYTES,
  validMeta,
} from '../../protocol/protocol.ts';
import type { AssetId } from '../../protocol/protocol.ts';
import type { PublicDeveloperBet, Round, WirePrizes } from '../../protocol/types.ts';

export type { AssetId, PublicDeveloperBet, Round, WirePrizes };
/** A game's key, as its developer and the name they published it under make it. */
export { gameKey };
/** What a casino's `GET /api/config` names for this kit to use it, as `developerProtocol` and `limits`: a stub casino
 * in a server's test answers with them. */
export { DEVELOPER_PROTOCOL, LIMITS };
/** What one developer bet is paid: `player` to its player and `casino` to the casino, both from the developer's bank,
 * which took the stake when the bet was placed. Give the casino about half of what the bet was expected to earn
 * you: that is the casino's policy, and nothing enforces it. */
export interface Settlement {
  bet: string;
  player: string | bigint;
  casino: string | bigint;
}
/** The developer's casino bet on one of its rounds: its stake and prizes against the bankroll, from the developer's
 * bank, and its meta, the developer's own JSON, which the casino keeps with the reveal and never reads. */
export interface BankCasinoBet {
  round: string;
  stake: string | bigint;
  prizes: WirePrizes;
  meta: Record<string, unknown>;
}
/** A page of a game's developer bets, and the cursor for the next. */
export interface DeveloperBetPage {
  bets: PublicDeveloperBet[];
  cursor: string;
  more: boolean;
}
export interface Developer {
  address: string;
  /** The key of the game this kit serves. */
  game: string;
  /** Every bound a bet is held to: the most prizes one bet holds, the size of the space a prize range lies in, the
   * most a bet's meta takes, the longest group. */
  limits: {
    prizes: number;
    outcomeSpace: string;
    meta: number;
    group: number;
  };
  /** A new round in an asset, for this developer's casino bet: named by the casino by the hash of a secret it keeps. */
  openRound(asset: AssetId): Promise<Round>;
  /** The hash of the seed this developer's casino bet on a round brings. Published before anybody bets, it fixes the
   * round's outcome, since the casino fixed its secret first; the seed is derived from this key and the round. */
  seedHash(round: string): Promise<string>;
  /** A round as anyone may read it, revealed or not. */
  round(id: string): Promise<Round>;
  /** Place this developer's casino bet on one of its rounds, from its bank: `stake` and `prizes` against the
   * bankroll, and `meta`, which the casino keeps with the reveal. It reveals the round; declined by the bankroll, it
   * moves no money. The seed is derived from this key and the round, so placing it again after a lost reply is the
   * same bet, and gets the same answer. */
  casinoBet(bet: BankCasinoBet): Promise<Round>;
  /** Settle developer bets, each with a settlement signed here, paid from this developer's bank. They go to the casino
   * `MAX_DEVELOPER_BETS` at a time, and it takes each batch whole or, if the bank cannot pay it, not at all. A bet
   * settled before answers with what settled it. */
  settle(settlements: Settlement[]): Promise<PublicDeveloperBet[]>;
  /** This game's developer bets, open or settled, of one group if you name one, a page at a time: open ones as they
   * stand, read from the start; settled ones in the order they settled, so a saved cursor never misses one. */
  bets(query?: {
    status?: 'open' | 'settled';
    group?: string;
    after?: string;
    limit?: number;
  }): Promise<DeveloperBetPage>;
  /** A developer bet as anyone may read it; null for one the casino does not know. */
  bet(hash: string): Promise<PublicDeveloperBet | null>;
}

export async function createDeveloper({
  casinoURL,
  key,
  name,
}: {
  casinoURL: string;
  /** The private key of the game's developer, the account it is published from. */
  key: string;
  /** The name the game is published under. With the key's address it makes the game's key. */
  name: string;
}): Promise<Developer> {
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
  /** A request only the developer may make: signed with its key, good for a minute. */
  const asDeveloper = async (path: string, body: unknown) => {
    const message = { developer: signer.address, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    return api(path, body, {
      authorization: authorization(message, await signer.signTypedData(d, DEVELOPER_ACCESS_TYPES, message)),
    });
  };
  // The seed of the developer's casino bet on a round: this key's signature of the round, hashed. Nobody without the
  // key can know it before the bet, and the same round always gets the same seed.
  const seedOf = async (round: string) => keccak256(await signer.signMessage(getBytes(round)));
  return {
    address: signer.address,
    game,
    limits: config.limits,
    openRound: asset => asDeveloper('/api/rounds', { asset }),
    seedHash: async round => hashOfSeed(await seedOf(round.toLowerCase())),
    round: id => api(`/api/rounds/${id}`),
    async casinoBet({ round, stake, prizes, meta }) {
      if (!validMeta(meta))
        throw Object.assign(new Error(`A casino bet's meta is a JSON object of up to ${MAX_META_BYTES} bytes`), {
          status: 400,
          code: 'invalid',
        });
      const bet = { round: round.toLowerCase(), game, stake: String(stake), prizes },
        seed = await seedOf(bet.round);
      const revealed: Round = await asDeveloper(`/api/rounds/${bet.round}/casino-bet`, {
        ...bet,
        meta,
        seed,
        signature: await signer.signTypedData(d, BANK_CASINO_BET_TYPES, {
          ...bet,
          seedHash: hashOfSeed(seed),
          meta: hashJSON(meta),
        }),
      });
      if (!revealed.secret || !same(roundId(revealed.secret), bet.round))
        throw new Error("The casino revealed a secret that is not the round's");
      return revealed;
    },
    async settle(settlements) {
      const settled: PublicDeveloperBet[] = [];
      for (let i = 0; i < settlements.length; i += MAX_DEVELOPER_BETS) {
        const signed = await Promise.all(
          settlements.slice(i, i + MAX_DEVELOPER_BETS).map(async ({ bet, player, casino }) => {
            const message = { bet, player: String(player), casino: String(casino) };
            return { ...message, signature: await signer.signTypedData(d, SETTLEMENT_TYPES, message) };
          }),
        );
        settled.push(...(await asDeveloper('/api/developer-bets/settle', { settlements: signed })));
      }
      return settled;
    },
    bets: ({ status = 'open', group, after, limit } = {}) =>
      api(
        `/api/developer-bets?game=${game}&status=${status}` +
          (group === undefined ? '' : `&group=${encodeURIComponent(group)}`) +
          (after === undefined ? '' : `&after=${encodeURIComponent(after)}`) +
          (limit === undefined ? '' : `&limit=${limit}`),
      ),
    bet: hash =>
      api(`/api/developer-bets/${hash}`).catch(error => {
        if (error.status === 404) return null;
        throw error;
      }),
  };
}
