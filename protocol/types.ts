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
  /** The game that asked for a bet, a payment or a pot entry. */
  game?: GameName;
  /** What a debit pays into or a credit collects from: the bankroll fund, a developer's bank, a pot, a
   * developer's earnings or the faucet. A game's payment pays the bankroll and names nothing. */
  counterparty?: string;
  /** A pot entry's terms beyond its stake: the prizes it holds, and a referee's quote for them. */
  entry?: EntryTerms;
}
/** Prizes of a house or developer pot's entry, on the wire; a players' pot's entry has none. */
export interface EntryTerms {
  prizes?: { rangeStart: string; rangeEnd: string; payout: string }[];
  /** The referee's price for a developer's pot: its signed `Quote`, good until `expiresAt` (unix seconds). */
  quote?: { expiresAt: string; signature: string };
}
/** Who pays a pot beyond its entries: the casino's bankroll, the developer's bank, or nobody. */
export type Bank = 'house' | 'developer' | 'players';
/** A pot as anyone may read it: the game it is for, its referee and bank, its entries by the names their
 * players answer to, and, once it ends, what ended it. It names no operation, channel or address. */
export interface PotStatus {
  id: string;
  /** The game's key. */
  game: string;
  referee: string;
  bank: Bank;
  asset: 'eth' | 'test';
  status: 'open' | 'resolved' | 'void';
  /** A house pot's seed hash: its referee's seed, which with the casino's secret picks the outcome. */
  seedHash?: string;
  /** A developer's pot names its outcomes 0 to `outcomes - 1`. */
  outcomes?: number;
  /** A players' pot takes at most this rake, in basis points of its entries. */
  rake?: number;
  /** No entry after this (unix milliseconds): null for a house pot nobody has entered. */
  closesAt: number | null;
  /** Unresolved by then (unix milliseconds), the pot is void and every entry refunded. */
  deadline: number;
  entries: { uname: string | null; alias: string | null; stake: string; prizes?: EntryTerms['prizes'] }[];
  /** How it ended: a house pot's seed and the casino's secret, or the referee's signed result. */
  seed?: string;
  secret?: string;
  result?: PotResult;
  signature?: string;
}
/** What a referee says a pot came to: a developer's pot's outcome, or a players' pot's split of its
 * entries (each entry's payout, by index) and the rake it keeps. */
export type PotResult = { outcome: number } | { split: { entry: number; amount: string }[]; rake: string };
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
  /** A pot entry's number among the pot's entries. */
  entry?: number;
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
/** What a bet names: a round and the hash of the seed every bet on it shares. */
export interface Round {
  id: string;
  seedHash: string;
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
