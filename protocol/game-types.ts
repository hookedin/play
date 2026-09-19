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
  /** Oracles the player allowed to decide this open game's matches. */
  oracles?: string[];
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
/** A match against other players: the casino holds every stake until the oracle in the terms decides. */
export interface GameStake {
  id: string;
  match: import('./types.ts').MatchTerms;
}
/** What the wallet pushes to the game: its spending limit and whether an operation awaits recovery. */
export interface GameLimit {
  balance: string;
  pending: boolean;
  /** The balance is practice money: same bets and odds, nothing real won or lost. */
  practice: boolean;
}
