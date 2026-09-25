/** What the wallet knows about a game: where it is served, its key, its developer, and, for this tab only, a
 * spending limit. */
export interface GameIdentity {
  manifestURL: string;
  entryURL: string;
  /** Made from its developer and the name they published it under; a game loaded straight from its manifest has
   * the key of its manifest's developer and URL. */
  key: string;
  /** The account that publishes it, which its manifest names too: it earns the game's commission, and its bank
   * takes the game's developer bets, which it settles. */
  developer: string;
  /** The name its developer published it under. A game loaded straight from its manifest has none, and takes no
   * developer bets. */
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
/** A casino bet: settled against the casino's bankroll in the request that places it, on the player's own round.
 * The stake is paid to enter, and every prize whose range holds the round's 64-bit outcome pays. */
export interface CasinoBetRequest {
  /** The game's own name for the operation: the same request again returns the saved receipt. */
  id: string;
  stake: string;
  /** Each prize pays `payout` when the round's 64-bit outcome falls in [rangeStart, rangeEnd); overlapping prizes add. */
  prizes: Prizes;
  /** A label for bets that belong together, such as the steps of one hand. */
  group?: string;
}
/** A developer bet: a bet against the game's developer, whose bank takes the stake at once and who settles it when
 * they choose. The player trusts the developer to pay. With `prizes` it names one of the developer's open rounds
 * and is provably fair: it is owed what its prizes pay on the round's outcome if the developer's casino bet on the
 * round covers it, and its stake back otherwise. With `terms` it is owed what the developer says. */
export type DeveloperBetRequest = { id: string; stake: string; group?: string } & (
  { prizes: Prizes; round: string } | { terms: Record<string, unknown> }
);
/** What a game learns about an operation, under its own `id`: how it ended, never the signed evidence.
 * A casino bet or a payment is `settled` (done, and what it paid is in the channel) or `rejected` (declined with
 * a signed checkpoint that leaves the balance unchanged). A developer bet is `rejected` (the casino did not take it),
 * `open` (its stake is with the developer), `settled` (paid what it is owed), `returned` (its developer did not
 * cover it and paid its stake back) or `shorted` (paid less than it is owed, which the wallet can prove). */
export interface GameReceipt {
  id: string;
  kind: 'casino-bet' | 'developer-bet' | 'payment';
  status: 'settled' | 'rejected' | 'open' | 'returned' | 'shorted';
  /** What a settled developer bet's payout rests on: `outcome`, its prizes on its round's revealed outcome, which the
   * wallet checked; or `developer`, a bet with terms, settled on its developer's word. */
  basis?: 'outcome' | 'developer';
  /** A bet's terms, as it was placed. */
  stake?: string;
  prizes?: Prizes;
  terms?: Record<string, unknown>;
  round?: string;
  group?: string;
  /** A developer bet: the hash that names it at the casino and to its developer. */
  bet?: string;
  /** A bet with prizes, once its round is revealed: the round's 64-bit outcome. */
  outcome?: string;
  /** A developer bet with prizes, once settled: what it is owed, its prizes' payout if the developer covered it and
   * its stake if not. */
  owed?: string;
  /** What a settled bet paid. */
  payout?: string;
  reason?: string;
}
/** What the wallet pushes to the game: its spending limit and whether an operation awaits recovery. */
export interface GameLimit {
  balance: string;
  pending: boolean;
}
