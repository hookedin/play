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
export interface GameRequest {
  /** The game's own idempotency key: an exact retry returns the saved receipt. */
  id: string;
  /** Paid to enter. */
  stake: string;
  /** Each prize pays `payout` when the round's 64-bit outcome falls in [rangeStart, rangeEnd); overlapping prizes add. */
  prizes: { rangeStart: string; rangeEnd: string; payout: string }[];
}
/** An entry into a pot of this game. A house or developer pot's entry holds prizes over the pot's outcome;
 * a developer's needs its referee's `quote` for them; a players' pot's entry is only its stake. */
export interface EntryRequest {
  id: string;
  pot: string;
  stake: string;
  prizes?: GameRequest['prizes'];
  quote?: { expiresAt: string; signature: string };
}
/** What a game learns about an operation, under its own `id`: how it ended, never the signed evidence. */
export interface GameReceipt {
  id: string;
  kind: 'bet' | 'payment' | 'entry';
  /** `signed`: settled, or for an entry, in its pot. `rejected`: a verified rejection; the balance is unchanged. */
  status: 'signed' | 'rejected';
  verified: boolean;
  /** A bet's or an entry's terms. */
  stake?: string;
  prizes?: GameRequest['prizes'];
  /** An entry's pot. */
  pot?: string;
  /** A resolved entry's outcome or refund, after the wallet has verified and collected it. */
  resolution?: 'outcome' | 'refund';
  resolvedAt?: number;
  /** A settled bet: the round's 64-bit outcome, and what the prizes holding it paid in total. An entry,
   * once its pot has ended and the wallet has collected: the outcome that picked its prizes, if the pot
   * had one, and what the entry was paid. */
  outcome?: string;
  payout?: string;
  reason?: string;
}
/** What the wallet pushes to the game: its spending limit and whether an operation awaits recovery. */
export interface GameLimit {
  balance: string;
  pending: boolean;
}
