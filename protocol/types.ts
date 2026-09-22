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
  /** What a debit pays into or a credit collects from: the bankroll fund, a developer's earnings or the
   * faucet. A game's payment pays the bankroll and names nothing. */
  counterparty?: string;
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
  /** An investment's response carries the casino's signed statement of the holding. */
  statement?: SignedStatement;
}
/** One seat in a round: the player's signed bet, what it means, and their countersignature of the
 * previous response. A bet on the channel's own round brings its `seed`; in a hosted round the host
 * reveals it at the close. */
export interface RoundBet {
  request: Operation;
  details: Details;
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
