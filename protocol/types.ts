import type { BigNumberish, TypedDataDomain } from 'ethers';

/** Wire integers may arrive from JSON or ethers; arithmetic always uses bigint. */
export type Integer = BigNumberish;
export type Domain = TypedDataDomain;
export type Json<T> = 0 extends 1 & T
  ? any
  : T extends bigint
    ? string
    : T extends readonly (infer V)[]
      ? Json<V>[]
      : T extends object
        ? { [K in keyof T]: Json<T[K]> }
        : T;

export interface Opening {
  channelId: string;
  player: string;
  signer: string;
  deposit: Integer;
}
export interface Checkpoint {
  channelId: string;
  sequence: Integer;
  previousStateHash: string;
  transitionHash: string;
  balance: Integer;
}
/** A bet pays `payout` when its round's 64-bit outcome falls in [rangeStart, rangeEnd). Prizes may overlap. */
export interface Prize {
  rangeStart: Integer;
  rangeEnd: Integer;
  payout: Integer;
}
/** A game's name: its developer, who earns half of every bet's commission, and the name it goes by, the
 * one its developer published it under or, for a game loaded straight from its manifest, that manifest's URL. */
export interface GameName {
  developer: string;
  name: string;
}
/** What an operation means to the wallet and the casino, beside what the contract settles. The operation
 * signs only its hash, `memo`; the request carries it whole, and both sides keep it with the evidence. */
export interface Details {
  /** The wallet's name for the operation, as a hash: an exact retry is the same operation. */
  id: string;
  /** The game that asked for a bet or a payment. */
  game?: GameName;
  /** A label the game gives its bets and payments, such as a hand or a match, to show and find them together. */
  group?: string;
  /** What a debit pays into or a credit collects from: the bankroll fund, a developer's bank, a bet that
   * settled later, a developer's earnings or the faucet. A game's payment pays the bankroll and names nothing. */
  counterparty?: string;
  /** A bet that settles later: a debit that names its game, and the referee who settles it. */
  bet?: LaterBet;
}
/** Prizes on the wire: decimal strings. */
export type WirePrizes = { rangeStart: string; rangeEnd: string; payout: string }[];
/** A bet its game's referee settles by its deadline, or its stake comes back. With `prizes`, it names the
 * referee's open round and the hash of the seed the referee committed to it, so its outcome is fixed before it
 * is placed; the referee draws the round against the bankroll, and the bet pays what its prizes pay on the
 * round's outcome. With `terms`, the referee signs what it pays, and the developer's bank pays what that comes
 * to beyond the stake. */
export type LaterBet = {
  /** The key the game's developer published to settle its bets. */
  referee: string;
  /** Unix milliseconds. Unsettled by then, the stake is refunded. */
  deadline: number;
} & ({ round: string; seedHash: string; prizes: WirePrizes } | { terms: Record<string, unknown> });
/** What drew a round: the referee's seed and the casino's secret, which hash to the seed hash and the round
 * its bets named. Every bet on the round rides their one outcome. */
export interface Draw {
  seed: string;
  secret: string;
}
/** A bet that settles later, as anyone may read it by its hash (the hash of the operation that placed it). */
export interface PublicBet {
  bet: string;
  /** The game's key. */
  game: string;
  group?: string;
  asset: 'eth' | 'test';
  uname: string | null;
  alias: string | null;
  referee: string;
  stake: string;
  placedAt: number;
  deadline: number;
  status: 'open' | 'settled';
  /** A bet with prizes: the round it rides, the hash of the seed its referee committed to the round, and its
   * prizes; once the round is drawn, what drew it. */
  round?: string;
  seedHash?: string;
  prizes?: WirePrizes;
  draw?: Draw;
  /** A bet with terms: its terms, and once it is settled, the referee's signed split. */
  terms?: Record<string, unknown>;
  settlement?: { player: string; casino: string; signature: string };
  /** What it paid the player, once settled. */
  payout?: string;
  /** Its stake came back: its deadline passed first, or, with a `draw`, the casino could not take it in its round. */
  refunded?: true;
  settledAt?: number;
}
/** An account's bet that settles later, across its channels in one asset: open, or settled and whether
 * what it paid has been collected into a channel. */
export interface PlayerBet {
  bet: string;
  game: GameName;
  group?: string;
  asset: 'eth' | 'test';
  status: 'open' | 'settled';
  stake: string;
  deadline: number;
  payout?: string;
  refunded?: true;
  settledAt?: number;
  collected: boolean;
}
/** Pass cursor as after for the next page. Settled cursors can be saved and resumed on later polls.
 * Open pages describe the current set; start at the beginning on each refresh. */
export interface PlayerBets {
  bets: PlayerBet[];
  cursor: string;
  more: boolean;
}
export interface Operation {
  channelId: string;
  previousStateHash: string;
  sequence: Integer;
  kind: Integer;
  /** A bet's stake, paid to enter; otherwise the amount debited or credited. */
  amount: Integer;
  prizes: Prize[];
  /** A bet's round: the hash of the secret that settles it. */
  round: string;
  /** A bet's seed, named by its hash. */
  seedHash: string;
  /** The hash of the operation's details: what it means to the wallet and the casino. */
  memo: string;
}
export interface Step {
  operation: Operation;
  authorization: string;
  /** A bet's step reveals its seed and its round's secret. */
  seed: string;
  secret: string;
  casinoSignature: string;
}
export interface Evidence {
  base: Checkpoint;
  playerSignature: string;
  casinoSignature: string;
  step: Step;
}
export interface EvidenceBundle {
  /** Evidence of a test channel proves a balance of test coins to its holder; it settles nowhere. */
  asset?: 'test';
  /** What the step's operation means, whose hash it signed as its memo. */
  details?: Details;
  chainId: Integer;
  casino: string;
  operator: string;
  opening: Opening;
  evidence: Evidence;
}
export interface Deployment {
  chainId: Integer;
  contractAddress: string;
  operator: string;
  runtimeHash?: string;
  rpcUrl?: string;
  witnessRpcUrl?: string;
}
/** On-chain channel storage as the service and wallet project it (decimal strings). */
export interface OnchainChannel {
  player: string;
  signer: string;
  deposit: string;
  initialHash: string;
  status: string;
  deadline: string;
  closingSequence: string;
  closingHash: string;
  closingBalance: string;
}
export interface OnchainClaim {
  beneficiary: string;
  stateHash: string;
  amount: string;
  paid: string;
  protectedRemaining: string;
  winningsRemaining: string;
  finalizedAt: string;
}
/** A signed casino response: an executed step, or a joint rejection checkpoint above the request. */
export interface OperationResponse {
  status: 'signed' | 'rejected';
  reason?: string;
  request?: Operation;
  /** What the operation means, whose hash it signed as its memo. */
  details: Details;
  /** A declined bet's round, revealed with the rejection. */
  secret?: string;
  /** A declined bet names a round the casino has no open record of, so there is no secret to reveal. */
  lost?: true;
  state: Checkpoint;
  casinoSignature: string;
  evidence: Evidence;
  operationId: string;
  commission: string;
  bankroll?: string;
  /** An investment's response carries the casino's signed statement of the holding, and a bank
   * deposit the statement of the bank. */
  statement?: SignedStatement;
}
/** What a wallet sends the casino: its signed operation, what the operation means, and its
 * countersignature of the previous response. A bet brings the seed it names. */
export interface Submission {
  request: Operation;
  details: Details;
  signature: string;
  acknowledgment?: { stateHash: string; signature: string };
  seed?: string;
}
/** A referee's open round: the casino's round, the hash of the seed the referee will draw it with, and the
 * referee's `Commit(round, seedHash)` over the two. A bet to be drawn names the round and the seed hash. */
export interface Round {
  id: string;
  seedHash: string;
  signature: string;
}
/** The bankroll fund: every share in issue, and how many of them are the house's own capital. */
export interface FundState {
  /** Fund changes applied so far; each signing-history fund record carries the next number. */
  sequence: number;
  totalShares: string;
  houseShares: string;
  /** Wei the owner withdrew beyond the house's own shares: a loss the other holders bore. */
  overdrawn: string;
}
export interface SignedStatement {
  message: Record<string, any>;
  signature: string;
}
/** One investor's holding, keyed by player address so it outlives any one channel. */
export interface FundHolder {
  holder: string;
  shares: string;
  sequence: number;
  statement: SignedStatement;
}
/** The service projection of one channel. Everything financial here is replayable from the signing log. */
export interface ChannelRow {
  opening: Opening;
  /** Test coins; an ETH channel leaves it out. */
  asset?: 'test';
  state: Checkpoint;
  playerSignature: string;
  casinoSignature: string;
  acknowledged: boolean;
  onchain: OnchainChannel | null;
  claim?: OnchainClaim | null;
  observedAt?: number;
  observedBlock?: number;
  closing: boolean;
  lastResponse?: OperationResponse | null;
}
