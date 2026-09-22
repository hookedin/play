/** What the wallet knows about a game: its identity, what its manifest declares, and, for this tab
 * only, a spending limit. */
export interface GameIdentity {
  manifestURL: string;
  entryURL: string;
  developer: string;
  name: string;
  /** This game bets on rounds its own host opens, so its host draws their seed. The player allows it
   * before the game is framed, or the game is not opened. */
  rounds?: boolean;
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
  /** A round a game's host opened. The wallet joins it with this bet, and the host closes it. */
  round?: import('./types.ts').Round;
}
/** What a game learns about an operation, under its own `id`: how it ended, never the signed evidence. */
export interface GameReceipt {
  id: string;
  kind: 'bet' | 'payment' | 'transfer';
  /** `signed`: settled. `rejected`: a verified rejection; the balance is unchanged. */
  status: 'signed' | 'rejected';
  verified: boolean;
  /** A bet's terms as they played. A seat changed as its round closed played the chips it had. */
  stake?: string;
  prizes?: GameRequest['prizes'];
  /** A settled bet: the round's 64-bit outcome, and what the prizes holding it paid in total. */
  outcome?: string;
  payout?: string;
  reason?: string;
}
/** A bet seated in a shared round its host has not closed, or a transfer its recipient has not
 * accepted. Sending the same request again finds the result. */
export interface PendingReceipt {
  id: string;
  status: 'pending';
  verified: false;
}
/** What the wallet pushes to the game: its spending limit and whether an operation awaits recovery. */
export interface GameLimit {
  balance: string;
  pending: boolean;
}
