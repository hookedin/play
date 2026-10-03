/**
 * The server side of a game with developer bets: its developer's key. It is the account the game is published from, so
 * the server holds everything that account holds: its games, their commission and its bank. A developer who wants
 * their server to hold less publishes the game from an account of its own.
 *
 * Players' wallets place developer bets by themselves: each pays its stake into this developer's bank at once, and the
 * developer settles it, on its word. A bet's meta is the game's own JSON: the casino keeps it and never reads it.
 *
 * A game that wants its developer bets provably fair makes them so itself, on rounds: the casino names each round by
 * the hash of a secret it keeps, this kit derives the seed from its key and the round, and the developer's casino bet
 * on the round, from its bank against the bankroll, reveals the outcome. What the game commits to before that, such as
 * which bets its casino bets back, goes in a casino bet's meta, which the casino keeps with the reveal. Roulette is the
 * reference: each spin is a few binary casino bets, one per round, walked down `@hookedin/play/sdk/steps`.
 *
 * Everything here uses the casino's public API and runs wherever `fetch` does: Node, or a Cloudflare Worker.
 */
import { Wallet, getBytes, keccak256 } from 'ethers';
import {
  authorization,
  domain,
  gameKey,
  hashJSON,
  outcome,
  roundId,
  same,
  seedHash as hashOfSeed,
  assertProtocol,
  DEVELOPER_ACCESS_TYPES,
  DEVELOPER_PROTOCOL,
  SETTLEMENT_TYPES,
  BANK_CASINO_BET_TYPES,
  MAX_DEVELOPER_BETS,
  MAX_META_BYTES,
  validMeta,
} from '../../protocol/protocol.ts';
import type { PublicDeveloperBet, Round } from '../../protocol/types.ts';

export type { PublicDeveloperBet, Round };
/** What a casino's `GET /api/config` names as `developerProtocol` for this kit to take it: a stub casino in a server's
 * test answers with it. */
export { DEVELOPER_PROTOCOL };
/** What one developer bet is paid: `player` to its player and `casino` to the casino, both from the developer's bank,
 * which took the stake when the bet was placed. Give the casino about half of what the bet was expected to earn
 * you: that is the casino's policy, and nothing enforces it. */
export interface Settlement {
  bet: string;
  player: string | bigint;
  casino: string | bigint;
}
/** The developer's casino bet on one of its rounds, from the developer's bank against the bankroll: its stake pays
 * `prize` when the round's outcome is below `chance`, counted in outcomes out of 2^64. `group` is the label its game
 * gives the bets that belong together, and `meta` the developer's own JSON, which the casino keeps with the reveal and
 * never reads. */
export interface BankCasinoBet {
  round: string;
  stake: string | bigint;
  chance: string | bigint;
  prize: string | bigint;
  group: string;
  meta: Record<string, unknown>;
}
export interface Developer {
  /** The casino's virtual bankroll, half its bankroll, as it last reported it: what it admits casino bets against, and
   * so what to price them against, not a promise to admit them. */
  virtualBankroll(): Promise<bigint>;
  /** A new round for this developer's casino bet: named by the casino by the hash of a secret it keeps. */
  openRound(): Promise<Round>;
  /** The hash of the seed this developer's casino bet on a round brings. Published before anybody bets, it fixes the
   * round's outcome, since the casino fixed its secret first; the seed is derived from this key and the round. */
  seedHash(round: string): Promise<string>;
  /** A round as anyone may read it, revealed or not. */
  round(id: string): Promise<Round>;
  /** Place this developer's casino bet on one of its rounds, from its bank against the bankroll, with `meta`, which
   * the casino keeps with the reveal. It reveals the round; declined by the bankroll, it moves no money. The seed is
   * derived from this key and the round, so placing it again after a lost reply is the same bet, and gets the same
   * answer. */
  casinoBet(bet: BankCasinoBet): Promise<Round>;
  /** Reveal one of this developer's rounds without betting anything, in a group and with meta like a casino bet: a
   * casino bet of stake, chance and prize zero. */
  reveal(bet: { round: string; group: string; meta: Record<string, unknown> }): Promise<Round>;
  /** Settle developer bets, each with a settlement signed here, paid from this developer's bank. They go to the casino
   * `MAX_DEVELOPER_BETS` at a time, and it takes each batch whole or, if the bank cannot pay it, not at all. A bet
   * settled before answers with what settled it. */
  settle(settlements: Settlement[]): Promise<PublicDeveloperBet[]>;
  /** This game's developer bets, open or settled, a page at a time, with the cursor for the next: open ones in the
   * order they were placed, so a cursor goes on to the bets placed since; settled ones in the order they settled, so a
   * saved cursor never misses one. With `wait`, a page of open bets with none is held up to that many seconds, 1 to 25,
   * until a bet on the game is placed: how a server follows its game's bets as they come. */
  bets(query?: {
    status?: 'open' | 'settled';
    after?: string;
    wait?: number;
  }): Promise<{ bets: PublicDeveloperBet[]; cursor: string; more: boolean }>;
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
      // A request the casino never answers gives up after a minute, so a server that follows its bets asks again.
      const signal = AbortSignal.timeout(60_000),
        response = await fetch(
          casinoURL + path,
          body === undefined ? { headers, signal } : { method: 'POST', body: JSON.stringify(body), headers, signal },
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
  const asDeveloper = async (path: string, body?: unknown) => {
    const message = { developer: signer.address, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    return api(path, body, {
      authorization: authorization(message, await signer.signTypedData(d, DEVELOPER_ACCESS_TYPES, message)),
    });
  };
  // The seed of the developer's casino bet on a round: this key's signature of the round, hashed. Nobody without the
  // key can know it before the bet, and the same round always gets the same seed.
  const seedOf = async (round: string) => keccak256(await signer.signMessage(getBytes(round)));
  const placeCasinoBet = async ({ round, stake, chance, prize, group, meta }: BankCasinoBet) => {
    if (!validMeta(meta))
      throw Object.assign(new Error(`A casino bet's meta is a JSON object of up to ${MAX_META_BYTES} bytes`), {
        status: 400,
        code: 'invalid',
      });
    const bet = {
        round: round.toLowerCase(),
        game,
        stake: String(stake),
        chance: String(chance),
        prize: String(prize),
        group,
      },
      seed = await seedOf(bet.round),
      signature = await signer.signTypedData(d, BANK_CASINO_BET_TYPES, {
        ...bet,
        seedHash: hashOfSeed(seed),
        meta: hashJSON(meta),
      });
    const revealed: Round = await asDeveloper(`/api/rounds/${bet.round}/casino-bet`, {
      ...bet,
      meta,
      seed,
      signature,
    });
    // The reveal is the round's: its secret, this bet's seed and signature, and the outcome of the two.
    if (
      !revealed.secret ||
      !same(roundId(revealed.secret), bet.round) ||
      !same(revealed.seed ?? '', seed) ||
      revealed.casinoBet?.signature !== signature ||
      revealed.outcome !== String(outcome(seed, revealed.secret).value)
    )
      throw new Error('The casino revealed another round or bet than this one');
    return revealed;
  };
  return {
    virtualBankroll: async () => BigInt((await api('/api/status')).virtualBankroll),
    openRound: () => asDeveloper('/api/rounds', {}),
    seedHash: async round => hashOfSeed(await seedOf(round.toLowerCase())),
    round: id => api(`/api/rounds/${id}`),
    casinoBet: placeCasinoBet,
    reveal: ({ round, group, meta }) => placeCasinoBet({ round, stake: 0n, chance: 0n, prize: 0n, group, meta }),
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
    bets: ({ status = 'open', after, wait } = {}) => {
      const path =
        `/api/developer-bets?game=${game}&status=${status}` +
        (after === undefined ? '' : `&after=${encodeURIComponent(after)}`);
      // Only the game's developer may wait for its bets.
      return wait ? asDeveloper(`${path}&wait=${wait}`) : api(path);
    },
  };
}
