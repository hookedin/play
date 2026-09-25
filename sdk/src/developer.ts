/**
 * The server side of a game with developer bets: its developer's key. It is the account the game is published from, so
 * the server holds everything that account holds: its games, their commission and its bank. A developer who wants
 * their server to hold less publishes the game from an account of its own.
 *
 * Players' wallets place developer bets by themselves: each pays its stake into this developer's bank at once, and the
 * developer settles it. A developer bet with prizes names one of the developer's rounds: the casino names the round and
 * this kit commits the seed of the developer's casino bet on it, the game tells its players the round, and each bet
 * names it, so its outcome is fixed before it is placed. When betting ends, the developer places its own casino bet
 * on the round from its bank, naming the developer bets it covers, and the round's outcome decides what each is owed:
 * its prizes' payout if covered, its stake back if not. Each wallet checks what it was paid.
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
  DEVELOPER_ACCESS_TYPES,
  SETTLEMENT_TYPES,
  COMMIT_TYPES,
  BANK_CASINO_BET_TYPES,
} from '../../protocol/protocol.ts';
import type { AssetId } from '../../protocol/protocol.ts';
import type { PublicDeveloperBet, Round, WirePrizes } from '../../protocol/types.ts';

export type { AssetId, PublicDeveloperBet, Round, WirePrizes };
/** A game's key, as its developer and the name they published it under make it. */
export { gameKey };
/** What one developer bet is paid: `player` to its player and `casino` to the casino, both from the developer's bank,
 * which took the stake when the bet was placed. Give the casino about half of what the bet was expected to earn
 * you: that is the casino's policy, and nothing enforces it. */
export interface Settlement {
  bet: string;
  player: string | bigint;
  casino: string | bigint;
}
/** The developer's casino bet on one of its rounds: its stake and prizes against the bankroll, from the
 * developer's bank, and the developer bets that name the round which it covers. */
export interface BankCasinoBet {
  round: string;
  stake: string | bigint;
  prizes: WirePrizes;
  covers: string[];
}
/** What a developer bet with prizes is owed once its round is revealed: what its prizes pay on the round's outcome if
 * the developer's accepted casino bet on the round covers it, and its stake back otherwise. A round never revealed
 * covers nothing, and neither does a bet with terms: what one is owed is the developer's to say. */
export function owed(bet: PublicDeveloperBet, round: Round | null): bigint {
  const casinoBet = round?.casinoBet;
  return casinoBet?.accepted && casinoBet.covers.some(cover => same(cover, bet.bet)) && bet.prizes && round?.seed
    ? outcome(bet.prizes, round.seed, round.secret!).payout
    : BigInt(bet.stake);
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
  /** Every bound a bet is held to: the most prizes one bet holds, the most developer bets one casino bet covers or one
   * batch settles, the most a developer bet's terms take. */
  limits: {
    prizes: number;
    outcomeSpace: string;
    covers: number;
    terms: number;
    group: number;
  };
  /** A new round for developer bets with prizes, in an asset: named by the casino, and committed to the seed of this
   * developer's casino bet on it. Tell your players its `id`: their wallets name it in their developer bets. */
  openRound(asset: AssetId): Promise<Round>;
  /** A round as anyone may read it, revealed or not. */
  round(id: string): Promise<Round>;
  /** Place this developer's casino bet on one of its rounds, from its bank: `stake` and `prizes` against the
   * bankroll, covering the developer bets in `covers` that name the round. It reveals the round, whose outcome decides
   * every developer bet on it: a covered bet is owed what its prizes pay, any other its stake back. Declined by the
   * bankroll, it moves no money and covers nothing. The seed is derived from this key and the round, so placing it
   * again after a lost reply is the same bet, and gets the same answer. */
  casinoBet(bet: BankCasinoBet): Promise<Round>;
  /** Settle developer bets, each with a settlement signed here, paid from this developer's bank. The casino takes the
   * batch whole or, if the bank cannot pay it, not at all. A bet settled before answers with what settled it. */
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
    async openRound(asset) {
      const round: Round = await asDeveloper('/api/rounds', { asset });
      const hash = seedHash(await seedOf(round.id));
      return asDeveloper(`/api/rounds/${round.id}/commit`, {
        seedHash: hash,
        signature: await signer.signTypedData(d, COMMIT_TYPES, { round: round.id, seedHash: hash }),
      });
    },
    round: id => api(`/api/rounds/${id}`),
    async casinoBet({ round, stake, prizes, covers }) {
      const message = {
        round: round.toLowerCase(),
        game,
        stake: String(stake),
        prizes,
        covers: covers.map(cover => cover.toLowerCase()),
      };
      const revealed: Round = await asDeveloper(`/api/rounds/${message.round}/casino-bet`, {
        ...message,
        seed: await seedOf(message.round),
        signature: await signer.signTypedData(d, BANK_CASINO_BET_TYPES, message),
      });
      if (!revealed.secret || !same(roundId(revealed.secret), message.round))
        throw new Error("The casino revealed a secret that is not the round's");
      return revealed;
    },
    async settle(settlements) {
      const signed = await Promise.all(
        settlements.map(async ({ bet, player, casino }) => {
          const message = { bet, player: String(player), casino: String(casino) };
          return { ...message, signature: await signer.signTypedData(d, SETTLEMENT_TYPES, message) };
        }),
      );
      return asDeveloper('/api/developer-bets/settle', { settlements: signed });
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
