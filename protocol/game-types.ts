/** What the wallet knows about a game: its identity and, for this tab only, a spending limit. */
export interface GameIdentity {
  manifestURL: string;
  entryURL: string;
  developer: string;
  name: string;
}
/** The open game in this tab. Never persisted: closing the tab or leaving the game releases the limit. */
export interface GameSession {
  key: string;
  identity: GameIdentity;
  /** Decimal wei the game may still risk, including its winnings. */
  balance: string;
  /** The game plays with practice money: the wallet draws every outcome itself and no channel is touched. */
  practice?: boolean;
  /** Practice results by the game's operation ID, so an exact retry returns the same one. */
  practiceReceipts?: Map<string, Record<string, unknown>>;
  /** The player allowed this open game to bet on rounds whose seed its host draws. Like the limit, it lasts only while the game stays open. */
  hostedRounds?: boolean;
  /** Hosts the player allowed to pay out this open game's tables. */
  hosts?: string[];
}
export interface GameRequest {
  /** The game's own idempotency key: an exact retry returns the saved receipt. */
  id: string;
  /** Paid to enter. */
  stake: string;
  /** Each prize pays `payout` when the round's 64-bit outcome falls in [rangeStart, rangeEnd); overlapping prizes add. */
  prizes: { rangeStart: string; rangeEnd: string; payout: string }[];
  /** A round another channel owns. The wallet signs the bet and returns it for that owner to submit. */
  round?: { owner: string; epoch: number; index: number; roundHead: string; seed: string };
}
/** Money put on a table shared with other players: the casino holds it until the host in the terms pays it out. */
export interface GameBuyIn {
  id: string;
  table: import('./types.ts').TableTerms;
  amount: string;
}
/** What the wallet pushes to the game: its spending limit and whether an operation awaits recovery. */
export interface GameLimit {
  balance: string;
  pending: boolean;
  /** The balance is practice money: same bets and odds, nothing real won or lost. */
  practice: boolean;
}
