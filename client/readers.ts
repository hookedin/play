/** What the wallet reads from the casino beside the protocol's own structures, each as protocol/read.ts reads: a value
 * as JSON holds it, in its one form, given back with every whole number a bigint, or refused. */
import type { AccountGame, Checkpoint, OperationResponse, SignedStatement } from '../protocol/types.ts';
import * as read from '../protocol/read.ts';
import {
  BANK_TYPES,
  GAME_ID,
  MAX_GAMES,
  MAX_REDEEMS,
  REDEEM_TYPES,
  SHARE_TYPES,
  counterpartyPlayer,
  gameSlug,
  validGameName,
  validHash,
} from '../protocol/protocol.ts';

const { uname, discordUsername, gameId, recordId, count, integer } = read;
/** How a player is written: a Discord username wears `@`, a uname wears `~`. */
export const showName = (names: { uname?: string | null; discordUsername?: string | null } | null) =>
  names?.discordUsername ? '@' + names.discordUsername : names?.uname ? '~' + names.uname : '—';
/** A game as a profile lists it: its ID, the name it is published under with the slug that name makes, where it is
 * served, its developer and when it was first published. */
interface ProfileGame {
  id: string;
  name: string;
  slug: string;
  url: string;
  developer: string;
  createdAt: number;
}
/** A name a game is published under. */
export const gameName = read.exactly(validGameName, 'A game name');
const gameFields = {
  id: gameId,
  name: gameName,
  slug: read.text,
  url: read.text,
  developer: read.address,
  createdAt: read.time,
};
const named = <T extends { name: string; slug: string }>(game: T) =>
  game.slug === gameSlug(game.name) ? game : read.refuse('A game');
const profileGame = (value: unknown) => named(read.object<ProfileGame>(gameFields)(value));
/** One of the account's games as `GET /api/account/games` lists it, taken down or not: a profile's fields but its
 * developer, which is the account, with when it was taken down, the key its server signs with, its bank and the
 * casino's latest statement of it. */
export const accountGame = (value: unknown) =>
  named(
    read.object<AccountGame>({
      id: gameId,
      name: gameName,
      slug: read.text,
      url: read.text,
      takenDownAt: read.nullable(read.time),
      server: read.address,
      bank: read.whole,
      sequence: read.whole,
      statement: read.nullable(read.signed(BANK_TYPES)),
      createdAt: read.time,
    })(value),
  );
/** A player's public record, as `GET /api/players/:name` gives it: the names they answer to, when they last verified
 * their Discord account, their bets and what they came to, when the casino met them, and the games they publish. */
export interface Profile {
  uname: string;
  discordUsername: string | null;
  discordVerified: number | null;
  stats: { plays: number; net: bigint };
  createdAt: number;
  games: ProfileGame[];
}
export const profile = read.object<Profile>({
  uname,
  discordUsername: read.nullable(discordUsername),
  discordVerified: read.nullable(read.time),
  stats: read.object<Profile['stats']>({ plays: count, net: integer }),
  createdAt: read.time,
  games: read.list(profileGame, MAX_GAMES),
});
/** One published game, as `GET /api/players/:name/:slug` gives it, with the names of the player who publishes it. */
export const publishedGame = (value: unknown) =>
  named(
    read.object<ProfileGame & Pick<Profile, 'uname' | 'discordUsername'>>({
      ...gameFields,
      uname,
      discordUsername: read.nullable(discordUsername),
    })(value),
  );
/** A channel as the casino holds it, as `POST /api/channels/:id/activate` answers: the names its account answers to,
 * its latest checkpoint and the reply that signed it, and the latest head of the casino's signing history. */
export const channel = read.object<{
  uname: string;
  discordUsername: string | null;
  state: Checkpoint;
  lastResponse: OperationResponse | null;
  head: SignedStatement | null;
}>({
  uname,
  discordUsername: read.nullable(discordUsername),
  state: read.checkpoint,
  lastResponse: read.nullable(read.response),
  head: read.nullable(read.head),
});
/** A payout the casino owes this account, as it lists one: what it is owed for, another player (with the Discord
 * username they go by, or none), the fund, a game's bank or a developer bet; the record that made it owed; and an
 * amount above zero. */
export interface Payout {
  source: string;
  record: string;
  amount: bigint;
  discordUsername?: string | null;
}
export const payout = (value: unknown) => {
  const due = read.object<Payout>({
    source: read.text,
    record: recordId,
    amount: read.whole,
    discordUsername: read.optional(read.nullable(discordUsername)),
  })(value);
  return due.amount > 0n &&
    (counterpartyPlayer(due.source) !== null
      ? due.discordUsername !== undefined
      : due.discordUsername === undefined && (validHash(due.source) || GAME_ID.test(due.source)))
    ? due
    : read.refuse('A payout');
};
/** A holder's request to turn shares back into money (protocol.ts `REDEEM_TYPES`). */
export interface Redeem {
  holder: string;
  shares: bigint;
  sequence: bigint;
}
/** This account's holding in the fund, as `GET /api/account/fund` gives it: the casino's latest statement of it, and
 * the `Redeem`s the account signed after the sequence the wallet named, each with the statement it produced. */
export const holding = read.object<{
  statement: SignedStatement | null;
  redeems: { request: { message: Redeem; signature: string }; statement: SignedStatement }[];
}>({
  statement: read.nullable(read.signed(SHARE_TYPES)),
  redeems: read.list(
    read.object<{ request: { message: Redeem; signature: string }; statement: SignedStatement }>({
      request: read.signed<Redeem>(REDEEM_TYPES),
      statement: read.signed(SHARE_TYPES),
    }),
    MAX_REDEEMS,
  ),
});
