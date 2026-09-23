/** What the wallet knows about a game: its identity, what its manifest declares, and, for this tab
 * only, a spending limit. */
export interface GameIdentity {
  manifestURL: string;
  entryURL: string;
  developer: string;
  /** The name its developer published it under. A game loaded straight from its manifest has none, and
   * goes by its manifest URL instead. */
  slug?: string;
  /** What the game calls itself. */
  name: string;
  /** The key its developer published to settle its bets that settle later, if it has one. */
  referee?: string;
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
/** A bet, in one of three forms. With `prizes` alone it settles at once on the player's own round. With a
 * `deadline` it settles later, by the game's referee: with `prizes`, it rides the referee's open round, which
 * the referee draws against the bankroll, and it pays what its prizes pay on the round's outcome; with `terms`,
 * the referee signs what it pays, and the developer's bank pays what that comes to beyond the stake. */
export interface GameRequest {
  /** The game's own idempotency key: an exact retry returns the saved receipt. */
  id: string;
  /** Paid to enter. */
  stake: string;
  /** Each prize pays `payout` when the round's 64-bit outcome falls in [rangeStart, rangeEnd); overlapping prizes add. */
  prizes?: { rangeStart: string; rangeEnd: string; payout: string }[];
  /** What the game and the player agree for a bet its referee settles, in the game's own form. */
  terms?: Record<string, unknown>;
  /** When a bet that settles later is refunded if its referee has not settled it (unix milliseconds). */
  deadline?: number;
  /** A label for bets that belong together, such as the steps of one hand. */
  group?: string;
}
/** What a game learns about an operation, under its own `id`: how it ended, never the signed evidence. */
export interface GameReceipt {
  id: string;
  kind: 'bet' | 'payment';
  /** `signed`: settled, or for a bet that settles later, placed. `rejected`: a verified rejection; the balance is unchanged. */
  status: 'signed' | 'rejected';
  verified: boolean;
  /** A bet's terms, as it was placed. */
  stake?: string;
  prizes?: GameRequest['prizes'];
  terms?: Record<string, unknown>;
  deadline?: number;
  group?: string;
  /** A bet that settles later: the hash that names it at the casino, and to its referee. */
  bet?: string;
  /** A bet with prizes: the 64-bit outcome of the round or draw that settled it. */
  outcome?: string;
  /** What a settled bet paid, after the wallet has verified it, and for a bet that settled later, collected it. */
  payout?: string;
  reason?: string;
}
/** What the wallet pushes to the game: its spending limit and whether an operation awaits recovery. */
export interface GameLimit {
  balance: string;
  pending: boolean;
}
