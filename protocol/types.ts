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
/** What a game's key is made from: its developer, the account that publishes it, and the name they publish it
 * under; or, for a game loaded straight from its manifest, that manifest's developer and URL. */
export interface GameName {
  developer: string;
  name: string;
}
/** What an operation means to the wallet and the casino, beside what the contract settles. The operation
 * signs only its hash, `memo`; the request carries it whole, and both sides keep it with the evidence. */
export interface Details {
  /** The wallet's name for the operation, as a hash: an exact retry is the same operation. */
  id: string;
  /** The key of the game that asked for a casino bet, a developer bet or a payment. */
  game?: string;
  /** A label the game gives its bets and payments, such as a hand or a match, to show and find them together. */
  group?: string;
  /** What a debit pays into or a credit collects from: the bankroll fund, a developer's bank, a settled developer
   * bet, a developer's earnings or the faucet. A game's payment pays the bankroll and names nothing. */
  counterparty?: string;
  /** A developer bet's meta: the game's own JSON, saying what the bet is, which the casino keeps and never reads. A
   * debit that names its game and carries meta is a developer bet: a bet against the game's developer, whose bank
   * takes the stake at once and who settles it when they choose. */
  meta?: Record<string, unknown>;
}
/** A developer bet, as anyone may read it by its hash (the hash of the operation that placed it). */
export interface PublicDeveloperBet {
  bet: string;
  /** The game's key. */
  game: string;
  group?: string;
  asset: 'eth' | 'test';
  uname: string | null;
  alias: string | null;
  /** The game's developer, whose bank took the stake and whose key settles it. */
  developer: string;
  stake: string;
  placedAt: number;
  status: 'open' | 'settled';
  /** The game's own JSON, as the player signed it. */
  meta: Record<string, unknown>;
  /** Once settled: the developer's signed settlement, what it pays the player and gives the casino. */
  settlement?: { player: string; casino: string; signature: string };
  settledAt?: number;
}
/** An account's developer bet, across its channels in one asset: open, or settled and whether what it paid has been
 * collected into a channel. */
export interface PlayerDeveloperBet {
  bet: string;
  /** The game's key. */
  game: string;
  group?: string;
  asset: 'eth' | 'test';
  status: 'open' | 'settled';
  stake: string;
  payout?: string;
  settledAt?: number;
  collected: boolean;
}
/** Pass cursor as after for the next page. Settled cursors can be saved and resumed on later polls.
 * Open pages describe the current set; start at the beginning on each refresh. */
export interface PlayerDeveloperBets {
  bets: PlayerDeveloperBet[];
  cursor: string;
  more: boolean;
}
export interface Operation {
  channelId: string;
  previousStateHash: string;
  sequence: Integer;
  kind: Integer;
  /** A casino bet's stake, paid to enter; otherwise the amount debited or credited. */
  amount: Integer;
  /** A casino bet's probability, counted in outcomes out of 2^64: it wins when its round's outcome is below this. */
  chance: Integer;
  /** What a casino bet pays when it wins. */
  prize: Integer;
  /** A casino bet's round: the hash of the secret that settles it. */
  round: string;
  /** A casino bet's seed, named by its hash. */
  seedHash: string;
  /** The hash of the operation's details: what it means to the wallet and the casino. */
  memo: string;
}
export interface Step {
  operation: Operation;
  authorization: string;
  /** A casino bet's step reveals its seed and its round's secret. */
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
  /** A declined casino bet's round, revealed with the rejection. */
  secret?: string;
  /** A declined casino bet names a round the casino has no open record of, so there is no secret to reveal. */
  lost?: true;
  /** A game's operation declined because its player already carried it out on another channel. */
  used?: true;
  state: Checkpoint;
  casinoSignature: string;
  evidence: Evidence;
  operationId: string;
  commission: string;
  /** A casino bet: the developer of its game, who earns half of its commission. A game nobody publishes has
   * none. */
  developer?: string;
  bankroll?: string;
  /** An investment's response carries the casino's signed statement of the holding, and a bank
   * deposit the statement of the bank. */
  statement?: SignedStatement;
}
/** What a wallet sends the casino: its signed operation, what the operation means, and its
 * countersignature of the previous response. A casino bet brings the seed it names. */
export interface Submission {
  request: Operation;
  details: Details;
  signature: string;
  acknowledgment?: { stateHash: string; signature: string };
  seed?: string;
}
/** A developer's round, as anyone may read it: the hash of a secret the casino keeps, named for one developer in
 * one asset, for the developer's casino bet. That casino bet reveals it: its seed, the casino's secret and their
 * outcome, and the casino bet itself, which may bet nothing and only reveal the round. */
export interface Round {
  id: string;
  developer: string;
  asset: 'eth' | 'test';
  /** `open` until the developer's casino bet on it reveals it. */
  status: 'open' | 'revealed';
  seed?: string;
  secret?: string;
  /** The 64-bit outcome of the seed and the secret, once revealed. */
  outcome?: string;
  casinoBet?: DeveloperCasinoBet;
}
/** The developer's casino bet on its round, as it signed it (`BankCasinoBet`, with the round's id and the hash of its
 * meta), and whether the bankroll took it. A stake, chance and prize of zero bet nothing and only reveal the round. */
export interface DeveloperCasinoBet {
  /** The game whose commission it earns. */
  game: string;
  stake: string;
  /** Its probability, counted in outcomes out of 2^64: it wins when the round's outcome is below this. */
  chance: string;
  /** What it pays when it wins. */
  prize: string;
  /** The label its game gives the bets that belong together. */
  group: string;
  /** The developer's own JSON, which the casino keeps with the reveal and never reads. */
  meta: Record<string, unknown>;
  signature: string;
  /** Declined, it moved no money. */
  accepted: boolean;
  /** What it paid the developer's bank, once accepted. */
  payout?: string;
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
