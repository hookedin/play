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
  /** Whether the limit below is in test coins, the practice money this tab keeps, or in the channel's ETH. */
  practice: boolean;
  /** Decimal wei the game may still risk, including its winnings. */
  balance: string;
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
}
/** A developer bet: a bet against the game's developer, whose bank takes the stake at once and who settles it when
 * they choose. `meta` is the game's own JSON, saying what the bet is, which the casino keeps and never reads. The
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
/** What the wallet pushes to the game: its spending limit and whether an operation awaits recovery. */
export interface GameLimit {
  balance: string;
  pending: boolean;
}
