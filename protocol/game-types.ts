import type { StepResult } from './types.ts';
/** What the wallet knows about a game: where it is served, its ID, its developer, and, for this tab only, an
 * allowance. */
export interface GameIdentity {
  /** The page the wallet frames: a game is its URL. */
  url: string;
  /** Its ID (protocol.ts `GAME_ID`): the one the casino gave it when it was first published, or for a game opened by its
   * URL alone, its URL's. */
  id: string;
  /** The account that publishes it: the game's bank takes half its commission and its developer bets, and the
   * developer names the key that settles them. The zero address for a game opened by its URL alone. */
  developer: string;
  /** Its address on its developer's profile, `@username/<slug>`, made from the name they published it under. A game
   * opened by its URL alone has none, and takes no developer bets. */
  slug?: string;
  /** What the wallet calls it: the name its developer published it under, or its URL's host. */
  name: string;
}
/** The open game in this tab. Never persisted: closing the tab or leaving the game releases the allowance. */
export interface GameSession {
  identity: GameIdentity;
  /** The wei the game may still risk: its allowance, as the player sees and sets it. */
  allowance: bigint;
  /** The wei the player has allowed it since it opened: every raise of its allowance, added up. */
  allowed: bigint;
  /** The wei its settled operations have paid less what they staked since it opened, what its groups hold
   * included. */
  net: bigint;
  /** Whether the player let it place developer bets, which its developer settles. */
  developerBets: boolean;
  /** What each group's bets have won and the game has not shown yet, by group: it stays out of the allowance and
   * the balance the player sees until the game ends the group, and only that group's bets may stake it. */
  table: Record<string, bigint>;
}
/** A step of a game: the cash it holds, and the table of results it can end in, which the wallet splits into casino
 * bets, draws one of with the seed it signs that bet with, and lands on a result of with the same seed once the bet has
 * settled, so neither the page nor the casino chooses what happens: settled against the casino's bankroll in the request
 * that places it, on the player's own round. A step whose results all keep its cash places no bet, and only draws one
 * of them. */
export interface CasinoBetRequest {
  /** The game's own name for the operation: the same request again returns the saved receipt. */
  id: string;
  /** What the step holds: each bet stakes part of it, and what a bet keeps stays with the group, or outside one with the
   * allowance. */
  cash: bigint;
  /** Each way the step can end: how likely, as a whole-number weight against the others', what it leaves the player, and
   * what the game calls it. */
  results: StepResult[];
  /** A label for bets that belong together, such as the steps of one hand. */
  group?: string;
}
/** A developer bet: a bet against the game's developer, whose game's bank takes the stake at once and whose server
 * settles it when it chooses. `meta` is the game's own JSON, saying what the bet is, which the casino keeps and never reads. The
 * player trusts the developer to pay, and it is paid what the developer settles. */
export interface DeveloperBetRequest {
  id: string;
  stake: bigint;
  meta: Record<string, unknown>;
  /** The round the bet rides on: the hash of a secret the developer committed to before the bet, which its settlement
   * must reveal. */
  round?: string;
  group?: string;
}
/** What a game learns about an operation, under its own `id`: how it ended, never the signed evidence.
 * A casino bet or a payment is `settled` (done, and what it paid is in the channel) or `rejected` (declined with
 * a signed checkpoint that leaves the balance unchanged); a step that drew no bet is `kept`. A developer
 * bet is `rejected` (the casino did not take it), `open` (its stake is with the developer) or `settled` (its developer
 * settled it, and the wallet collected what that pays). A casino bet's payout is its prize or nothing, on an outcome
 * the wallet checked; a developer bet's is its developer's word. */
export interface GameReceipt {
  id: string;
  kind: 'casino-bet' | 'developer-bet' | 'payment';
  status: 'settled' | 'rejected' | 'open' | 'kept';
  /** A bet as it was placed: its stake, and a casino bet's chance and prize or a developer bet's meta. */
  stake?: bigint;
  chance?: bigint;
  prize?: bigint;
  meta?: Record<string, unknown>;
  group?: string;
  /** A developer bet: the hash that names it at the casino and to its developer. */
  bet?: string;
  /** A step this wallet drew: the result it landed on, as its place in the step's table, counting from 0, and a 64-bit
   * value the wallet drew after it, which the game shows the result with. */
  result?: bigint;
  draw?: bigint;
  /** A casino bet: the round's 64-bit outcome. */
  outcome?: bigint;
  /** What a settled bet paid. */
  payout?: bigint;
  reason?: string;
}
/** One of the game's earlier operations, on any channel or device of the player's: its receipt as the wallet checked
 * it, without the game's own ID, which the casino keeps only as a hash, and `at`, when the casino recorded it, in
 * milliseconds. Only what the casino carried out is listed: a casino bet or a payment `settled`, a developer bet `open`
 * or `settled`. */
export type PastOperation = Omit<GameReceipt, 'id' | 'reason'> & { at: number };
/** A group the game ended with `meta`, its own JSON saying how the group went, through `game.end`. */
export interface EndedGroup {
  kind: 'end';
  group: string;
  meta: Record<string, unknown>;
  at: number;
}
/** A page of the game's history for its player, newest first: pass `cursor` back as `after` for older entries while
 * `more` is true. */
export interface GameHistory {
  entries: (PastOperation | EndedGroup)[];
  cursor: string;
  more: boolean;
}
/** What the game may stake, whether an operation awaits recovery, and whether it may place developer bets. */
export interface GameAllowance {
  allowance: bigint;
  pending: boolean;
  developerBets: boolean;
}
