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
  /** Decimal wei the game may still risk: its allowance, as the player sees and sets it. */
  allowance: string;
  /** Decimal wei the player has allowed it since it opened: every raise of its allowance, added up. */
  allowed: string;
  /** Decimal wei its settled operations have paid less what they staked since it opened, what its groups hold
   * included. */
  net: string;
  /** Whether the player let it place developer bets, which its developer settles. */
  developerBets: boolean;
  /** What each group's bets have won and the game has not shown yet, by group: it stays out of the allowance and
   * the balance the player sees until the game ends the group, and only that group's bets may stake it. */
  table: Record<string, string>;
}
/** A casino bet: settled against the casino's bankroll in the request that places it, on the player's own round.
 * The stake is paid to enter, and the bet pays `prize` when the round's 64-bit outcome is below `chance`. */
export interface CasinoBetRequest {
  /** The game's own name for the operation: the same request again returns the saved receipt. */
  id: string;
  stake: string;
  /** The bet's probability, counted in outcomes out of 2^64, from 1 to 2^64 − 1. */
  chance: string;
  /** What the bet pays when it wins. */
  prize: string;
  /** A label for bets that belong together, such as the steps of one hand. */
  group?: string;
  /** What of its group's cash stays out of the bet and with the group, such as the least a step of a round is sure to
   * leave it: the wallet keeps it out of the allowance it shows, as it does what the group won, until the group ends. */
  kept?: string;
}
/** A developer bet: a bet against the game's developer, whose game's bank takes the stake at once and whose server
 * settles it when it chooses. `meta` is the game's own JSON, saying what the bet is, which the casino keeps and never reads. The
 * player trusts the developer to pay, and it is paid what the developer settles. */
export interface DeveloperBetRequest {
  id: string;
  stake: string;
  meta: Record<string, unknown>;
  group?: string;
}
/** What a game learns about an operation, under its own `id`: how it ended, never the signed evidence.
 * A casino bet or a payment is `settled` (done, and what it paid is in the channel) or `rejected` (declined with
 * a signed checkpoint that leaves the balance unchanged). A developer bet is `rejected` (the casino did not take it),
 * `open` (its stake is with the developer) or `settled` (its developer settled it, and the wallet collected what
 * that pays). A casino bet's payout is its prize or nothing, on an outcome the wallet checked; a developer bet's is its
 * developer's word. */
export interface GameReceipt {
  id: string;
  kind: 'casino-bet' | 'developer-bet' | 'payment';
  status: 'settled' | 'rejected' | 'open';
  /** A bet as it was placed: its stake, and a casino bet's chance and prize or a developer bet's meta. */
  stake?: string;
  chance?: string;
  prize?: string;
  meta?: Record<string, unknown>;
  group?: string;
  /** A developer bet: the hash that names it at the casino and to its developer. */
  bet?: string;
  /** A casino bet, once its round is revealed: the round's 64-bit outcome. */
  outcome?: string;
  /** What a settled bet paid. */
  payout?: string;
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
  allowance: string;
  pending: boolean;
  developerBets: boolean;
}
