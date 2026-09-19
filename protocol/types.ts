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
  seed: string;
  roundHead: string;
  operationId: string;
  developer: string;
  counterparty: string;
}
export interface Step {
  operation: Operation;
  authorization: string;
  preimage: string;
  casinoSignature: string;
}
export interface Evidence {
  base: Checkpoint;
  playerSignature: string;
  casinoSignature: string;
  step: Step;
}
export interface EvidenceBundle {
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
  status?: 'rejected';
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
/** One seat in a round: the player's signed bet and their countersignature of the previous response. */
export interface RoundBet {
  request: Operation;
  signature: string;
  acknowledgment?: { stateHash: string; signature: string };
}
/** The next unopened position of an owner's private chain. Every bet settled against it shares its preimage. */
export interface RoundPosition {
  /** The address the chain belongs to. */
  owner: string;
  epoch: number;
  index: number;
  /** Positions in this epoch's chain; the next head after the last one comes from a new epoch. */
  length: number;
  roundHead: string;
}
/** One player's place in a match: what they stake, and the share of the pot, in millionths, they
 * receive under each outcome. */
export interface MatchSeat {
  channelId: string;
  stake: Integer;
  shares: Integer[];
}
/** Terms every player signs into their stake: who decides, until when, and who gets what share of
 * the pot. With no prizes the pot is the stakes. With prizes the stakes are one bet, settled when the
 * match opens against `roundHead`, the next round of its host's chain, and the pot is what it paid. */
export interface MatchTerms {
  oracle: string;
  developer: string;
  expiresAt: Integer;
  nonce: string;
  roundHead: string;
  prizes: Prize[];
  seats: MatchSeat[];
}
/** How a match's pot was settled: every seat's seed and the preimage that opened the round head. */
export interface MatchPot {
  pot: string;
  seeds: string[];
  preimage: string;
  /** The 64-bit outcome of the pot bet; absent when the pot is simply the stakes. */
  potOutcome?: string;
  /** Where the pot bet was settled; absent when the pot is simply the stakes. */
  round?: Pick<RoundPosition, 'owner' | 'epoch' | 'index'>;
}
/** The casino's record of a match. The pot sits in its escrow until the oracle resolves it or it expires. */
export interface MatchRow extends MatchPot {
  id: string;
  terms: MatchTerms;
  status: 'open' | 'resolved' | 'void';
  outcome?: string;
  signature?: string;
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
export interface PayoutRow {
  id: string;
  developer: string;
  amount: string;
  status: 'pending' | 'paid' | 'failed';
  raw?: string;
  hash?: string;
  attempts?: { hash: string; raw?: string }[];
  previousAttempts?: { hash: string; raw?: string }[];
  createdAt?: number;
  updatedAt?: number;
  receiptBlock?: number;
  receiptBlockHash?: string;
}
