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
export interface Operation {
  channelId: string;
  previousStateHash: string;
  sequence: Integer;
  kind: Integer;
  /** A bet's stake, paid to enter; otherwise the amount paid, transferred or received. */
  amount: Integer;
  prizes: Prize[];
  /** A bet's seed, named by its hash. */
  seedHash: string;
  /** A bet's round: the hash of the secret that settles it. */
  round: string;
  operationId: string;
  /** The game that asked for a bet or a payment, named by the hash of its manifest URL. */
  game: string;
  developer: string;
  counterparty: string;
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
  state: Checkpoint;
  casinoSignature: string;
  evidence: Evidence;
  operationId: string;
  developer: string | null;
  commission: string;
  bankroll?: string;
  /** An investment's response carries the casino's signed statement of the holding. */
  statement?: SignedStatement;
}
/** One seat in a round: the player's signed bet and their countersignature of the previous response.
 * A bet on the channel's own round brings its `seed`; in a hosted round the host reveals it at the close. */
export interface RoundBet {
  request: Operation;
  signature: string;
  acknowledgment?: { stateHash: string; signature: string };
  seed?: string;
}
/** What a bet names: a round and the hash of the seed every bet on it shares. */
export interface Round {
  id: string;
  seedHash: string;
}
/** A round at the casino. Its host asked for it and got its ID, the hash of a secret the casino
 * keeps. The host opens it with the hash of a seed, players' wallets join it with their bets, and
 * the host closes it with the seed: the casino reveals the secret and settles every seat on the one
 * outcome. Until then nobody knows that outcome. A round that is declined or left open too long is
 * revealed too, and settles nobody. */
export interface RoundStatus {
  id: string;
  host: string;
  /** What every seat of the round bets with. */
  asset: 'eth' | 'test';
  status: 'created' | 'open' | 'revealed';
  seedHash: string | null;
  /** The seed its host closed the round with. */
  seed: string | null;
  /** Unix milliseconds after which the casino reveals an open round by itself and rejects its seats.
   * It is the host's betting window once somebody is seated, and much longer while the round is empty. */
  expiresAt: number | null;
  seats: RoundSeat[];
  secret: string | null;
  bankroll: string;
}
export interface RoundSeat {
  /** The names the seat's player answers to, `~uname` and `@alias`: a round is public, and nothing
   * else of them is. */
  uname: string;
  alias: string | null;
  operationId: string;
  stake: Integer;
  prizes: Prize[];
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
export interface TransferOffer {
  request: Operation;
  signature: string;
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
  transfer?: TransferOffer;
}
