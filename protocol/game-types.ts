/** What the wallet knows about a game: where it is served, its key, its developer, and, for this tab only, a
 * spending limit. */
export interface GameIdentity {
  manifestURL: string;
  entryURL: string;
  /** Made from its developer and the name they published it under; a game loaded straight from its manifest has
   * the key of its manifest's developer and URL. */
  key: string;
  /** The account that publishes it, which its manifest names too: it earns the game's commission and settles its
   * bets that settle later. */
  developer: string;
  /** The name its developer published it under. A game loaded straight from its manifest has none, and takes no
   * bets that settle later. */
  slug?: string;
  /** What the game calls itself. */
  name: string;
}
/** The open game in this tab. Never persisted: closing the tab or leaving the game releases the limit. */
export interface GameSession {
  key: string;
  identity: GameIdentity;
  /** What the limit below is in. A game opened before the wallet has one starts with neither. */
  asset?: 'eth' | 'test';
  /** Decimal wei the game may still risk, including its winnings. */
  balance: string;
}
type Prizes = { rangeStart: string; rangeEnd: string; payout: string }[];
/** A bet that settles at once on the player's own round: the stake is paid to enter, and every prize whose
 * range holds the round's 64-bit outcome pays. */
export interface GameBet {
  /** The game's own name for the operation: the same request again returns the saved receipt. */
  id: string;
  stake: string;
  /** Each prize pays `payout` when the round's 64-bit outcome falls in [rangeStart, rangeEnd); overlapping prizes add. */
  prizes: Prizes;
  /** A label for bets that belong together, such as the steps of one hand. */
  group?: string;
}
/** A bet its game's referee settles later. With `prizes` it rides the referee's open `round`, is admitted
 * against the bankroll as it is placed, and pays what its prizes pay when the referee draws the round, or its
 * stake comes back at the round's deadline. With `terms` the referee signs what it pays, and its own bank pays
 * what that comes to beyond the stake; unsettled by `deadline` (unix milliseconds), its stake comes back. */
export type GamePlace = { id: string; stake: string; group?: string } & (
  { prizes: Prizes; round: string } | { terms: Record<string, unknown>; deadline: number }
);
/** What a game learns about an operation, under its own `id`: how it ended, never the signed evidence.
 * `settled`: done, and what it paid is in the channel. `rejected`: declined with a signed checkpoint that
 * leaves the balance unchanged. `placed`: a bet that settles later, its stake taken and the bet final.
 * `refunded`: a placed bet nobody settled by its deadline, its stake back in the channel. */
export interface GameReceipt {
  id: string;
  kind: 'bet' | 'payment';
  status: 'settled' | 'rejected' | 'placed' | 'refunded';
  /** What a settled bet's payout rests on: `outcome`, the round's revealed secret and seed, which the wallet
   * checked against the hashes the bet signed; or `referee`, the referee's signed split, which is its word. */
  basis?: 'outcome' | 'referee';
  /** A bet's terms, as it was placed. */
  stake?: string;
  prizes?: Prizes;
  terms?: Record<string, unknown>;
  round?: string;
  deadline?: number;
  group?: string;
  /** A bet that settles later: the hash that names it at the casino, and to its referee. */
  bet?: string;
  /** A bet with prizes: the 64-bit outcome of the round that settled it. */
  outcome?: string;
  /** What a settled bet paid, and what a refund gave back. */
  payout?: string;
  reason?: string;
}
/** What the wallet pushes to the game: its spending limit and whether an operation awaits recovery. */
export interface GameLimit {
  balance: string;
  pending: boolean;
}
