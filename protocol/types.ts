import type { TypedDataDomain } from 'ethers';

export type Domain = TypedDataDomain;
/** A value as JSON holds it: every bigint a decimal string (protocol.ts `json`), which the readers there take back. */
export type Json<T> = 0 extends 1 & T
  ? any
  : T extends bigint
    ? string
    : T extends readonly (infer V)[]
      ? Json<V>[]
      : T extends object
        ? { [K in keyof T]: Json<T[K]> }
        : T;

/** A channel: the account, which signs for it, and which of the account's channels it is, with the key it goes by
 * off-chain. */
export interface Opening {
  channelId: string;
  player: string;
  /** 0 for the account's first channel, and one more after each whose close started. */
  index: bigint;
}
export interface Checkpoint {
  player: string;
  index: bigint;
  sequence: bigint;
  previousStateHash: string;
  transitionHash: string;
  balance: bigint;
  /** How much of the channel's on-chain deposits the balance has taken in. A close adds the rest. */
  deposited: bigint;
  /** How much the balance has paid out in withdrawals and lock-ins. A close adds what did not become a claim. */
  withdrawn: bigint;
}
/** What an operation means to the wallet and the casino, beside what the contract settles. The operation
 * signs only its hash, `memo`; the request carries it whole, and both sides keep it with the evidence. */
export interface Details {
  /** The wallet's name for the operation, as a hash: an exact retry is the same operation. */
  id: string;
  /** The ID of the game that asked for a casino bet, a developer bet or a payment. */
  game?: string;
  /** A label the game gives its bets and payments, such as a hand or a match, to show and find them together. */
  group?: string;
  /** What a debit pays into or a credit collects from: the bankroll fund, a game's bank, named by the game's ID, a
   * settled developer bet, a deposit's network fee, or another player, written `~uname`: a debit that pays a player
   * names them, and the credit that collects it the player it came from. A game's payment pays the bankroll and names
   * nothing. */
  counterparty?: string;
  /** A developer bet's meta: the game's own JSON, saying what the bet is, which the casino keeps and never reads. A
   * debit that names its game and carries meta is a developer bet: a bet against the game's developer, whose bank
   * takes the stake at once and whose server settles it when it chooses. */
  meta?: Record<string, unknown>;
  /** A developer bet's round: the hash of a secret its developer committed to before the bet, which its settlement
   * reveals, so what the bet rides on was fixed before the player signed it. */
  round?: string;
  /** A casino bet's step: the table of results the game offered, which the wallet split into the bets it drew this one
   * from. */
  table?: StepTable;
  /** A game's payment in a group: the cash it leaves with the group, which with what it pays is what the round held. */
  kept?: bigint;
}
/** One way a game's step can end: how likely, as a whole-number weight against the other results', the cash it leaves
 * the player, and what the game calls it. */
export interface StepResult {
  weight: bigint;
  cash: bigint;
  label?: string;
}
/** A game's step: the cash it holds and the results it can end in. As a bet signs it, a step of several amounts also
 * names the bankroll the wallet split it at into casino bets: its quote's virtual bankroll. */
export interface StepTable {
  cash: bigint;
  bankroll?: bigint;
  results: StepResult[];
}
/** A developer bet, as anyone may read it by its hash (the hash of the operation that placed it). */
export interface PublicDeveloperBet {
  bet: string;
  /** The game's ID. */
  game: string;
  group?: string;
  uname: string | null;
  discordUsername: string | null;
  stake: bigint;
  placedAt: number;
  status: 'open' | 'settled';
  /** The game's own JSON, as the player signed it. */
  meta: Record<string, unknown>;
  /** The round it rides on, if the player signed one: the hash of the secret its settlement reveals. */
  round?: string;
  /** Once settled: the settlement the game's server signed, what it pays the player and gives the casino, with the
   * secret of the bet's round for a bet that names one. `server` is the developer's signed `GameServer` naming the key
   * that signed it; none when the developer's own key did. */
  settlement?: { player: bigint; casino: bigint; secret?: string; signature: string; server?: SignedStatement };
  settledAt?: number;
}
/** A game an account has published, taken down since or not, as its developer sees it: where it is served, or was last,
 * when it was taken down (null while it is published), the address its server signs with, and its bank with the
 * casino's latest statement of it. */
export interface AccountGame {
  id: string;
  name: string;
  slug: string;
  url: string;
  takenDownAt: number | null;
  server: string;
  bank: bigint;
  sequence: bigint;
  statement: SignedStatement | null;
  createdAt: number;
}
/** An account's developer bet, across its channels: open, or settled and whether what it paid has been collected into
 * a channel. */
export interface PlayerDeveloperBet {
  bet: string;
  /** The game's ID. */
  game: string;
  group?: string;
  status: 'open' | 'settled';
  stake: bigint;
  payout?: bigint;
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
/** One entry of an account's history of a game, as the casino keeps it: an operation of the game it carried out, with
 * the details and evidence the wallet checks it by and the developer bet it placed, if it placed one; or a group the
 * game ended with meta. `at` is when the casino made the record. */
export type AccountHistoryEntry =
  | { type: 'operation'; at: number; details: Details; evidence: Evidence; bet?: PublicDeveloperBet }
  | { type: 'end'; at: number; game: string; group: string; meta: Record<string, unknown> };
export interface AccountHistory {
  entries: AccountHistoryEntry[];
  cursor: string;
  more: boolean;
}
export interface Operation {
  /** The hash of the checkpoint it follows, which names its channel and its place. */
  previousStateHash: string;
  kind: bigint;
  /** A casino bet's stake, paid to enter; otherwise the amount debited or credited. */
  amount: bigint;
  /** Whom a withdrawal pays; the zero address for any other kind, a lock-in going into the account's own channel. */
  recipient: string;
  /** What a withdrawal or a lock-in pays the casino for sending it to the contract, out of the balance; zero for any
   * other kind. */
  fee: bigint;
  /** A casino bet's probability, counted in outcomes out of 2^64: it wins when its round's outcome is below this. */
  chance: bigint;
  /** What a casino bet pays when it wins. */
  prize: bigint;
  /** A casino bet's round: the hash of the secret that settles it. */
  round: string;
  /** A casino bet's seed, named by its hash. */
  seedHash: string;
  /** The hash of the operation's details: what it means to the wallet and the casino. */
  memo: string;
}
/** The casino's signed quote for the casino bet that follows a checkpoint (`QUOTE_TYPES`). */
export interface Quote {
  message: {
    previousStateHash: string;
    /** The round the bet settles on. */
    round: string;
    /** What the bet is admitted against: half the casino's bankroll when it quoted. */
    virtualBankroll: bigint;
    /** Until when, in seconds, the bet can be disputed on-chain. */
    expiresAt: bigint;
  };
  signature: string;
}
/** The casino's signed offer of collateral for a channel (`OFFER_TYPES`), which anyone buys on-chain. */
export interface CollateralOffer {
  message: {
    player: string;
    index: bigint;
    /** The house cash it locks into the channel. */
    amount: bigint;
    /** What buying it pays the contract. */
    price: bigint;
    /** Until when, in seconds, it can be bought. */
    expiresAt: bigint;
  };
  signature: string;
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
  /** What the step's operation means, whose hash it signed as its memo. */
  details?: Details;
  chainId: bigint;
  casino: string;
  operator: string;
  /** The channel's latest evidence, whose base names the channel. */
  evidence: Evidence;
  /** The evidence of each of the account's withdrawals the contract may still owe something: the operation the account
   * signed and the casino's signature after it. Each is a claim of its own once recorded, under the operation's hash. */
  withdrawals?: Evidence[];
  /** The casino bet the account sent with its seed on a quote that covers it, which the casino has not settled: its
   * disputed step, which follows the checkpoint `evidence` proves, and the quote. Anyone disputes it with them. */
  dispute?: { step: Step; quote: Quote };
}
export interface Deployment {
  chainId: bigint;
  contractAddress: string;
  operator: string;
  rpcUrl?: string;
  witnessRpcUrl?: string;
  /** The block the contract was deployed in, where the casino's chain log starts. */
  block?: number;
}
/** A channel as the contract holds it. */
export interface OnchainChannel {
  /** Everything ever deposited into the channel: what a state is owed is worked out from it. */
  deposited: bigint;
  /** The deposits the contract still holds for the channel, which withdrawals are paid out of first, each only out of
   * those its checkpoint took in. */
  principal: bigint;
  /** House cash the collateral bought for the channel and its disputes lock into it: it pays what the deposits do not,
   * before house cash, and what the close is not owed returns to house cash. */
  collateral: bigint;
  /** Everything the channel's withdrawals have made into claims. */
  claimed: bigint;
  status: bigint;
  deadline: bigint;
  closingSequence: bigint;
  closingHash: string;
  closingBalance: bigint;
  /** The prize of the casino bet the close disputes, until evidence at its sequence settles it; 0 with none. */
  disputedPrize: bigint;
  /** The part of `collateral` the dispute locked, until evidence settles the bet; 0 with none. */
  disputeHold: bigint;
}
/** An executed step, or a rejection checkpoint above the request. A rejection with casinoSignature `0x` proposes
 * the checkpoint for the player to sign; the completed rejection carries both signatures in its evidence. */
export interface OperationResponse {
  status: 'signed' | 'rejected';
  reason?: string;
  request?: Operation;
  /** What the operation means, whose hash it signed as its memo. */
  details: Details;
  /** A game's operation declined because its player already carried it out on another channel. */
  used?: true;
  /** A casino bet its quote covers, declined as `used`: the operation the account signed on the other channel. */
  carried?: Carried;
  state: Checkpoint;
  casinoSignature: string;
  evidence: Evidence;
  operationId: string;
  commission: bigint;
  /** A casino bet: the developer of its game when it settled, whose game's bank takes half of its commission. A game
   * nobody publishes has none. */
  developer?: string;
  /** The quote for the channel's next casino bet, which follows `state`. */
  quote?: Quote;
  /** An investment's response carries the casino's signed statement of the holding, and a deposit into a game's
   * bank the statement of the bank. */
  statement?: SignedStatement;
  /** The casino's latest signed `HistoryHead`: where its signing history ended, which the wallet keeps and checks. */
  head?: SignedStatement;
}
/** An operation an account signed, with what it means and the checkpoint it follows, which names its channel: the
 * proof that a game's operation was carried out elsewhere. */
export interface Carried {
  base: Checkpoint;
  operation: Operation;
  authorization: string;
  details: Details;
}
/** What a wallet sends the casino: its signed operation, what the operation means, and its
 * countersignature of the previous response. A casino bet brings the seed it names and the quote it relies on. */
export interface Submission {
  request: Operation;
  details: Details;
  signature: string;
  acknowledgment?: { stateHash: string; signature: string };
  /** The player's signature of a proposed rejection checkpoint, completing its cancellation. */
  rejectionSignature?: string;
  seed?: string;
  quote?: Quote;
}
/** A game's round, as anyone may read it: the hash of a secret the casino keeps, named for one game, for the game's
 * casino bet. That casino bet reveals it: its seed, the casino's secret and their outcome, and the casino bet itself,
 * which may bet nothing and only reveal the round. */
export interface Round {
  id: string;
  /** The ID of the game it was opened for. */
  game: string;
  /** When the game's server opened it, in Unix milliseconds. */
  createdAt: number;
  /** `open` until the game's casino bet on it reveals it. */
  status: 'open' | 'revealed';
  seed?: string;
  secret?: string;
  /** The 64-bit outcome of the seed and the secret, once revealed. */
  outcome?: bigint;
  casinoBet?: DeveloperCasinoBet;
}
/** A game's casino bet on its round, as its server signed it (`BankCasinoBet`, with the round's id and the hash of its
 * meta), and whether the bankroll took it. A stake, chance and prize of zero bet nothing and only reveal the round. */
export interface DeveloperCasinoBet {
  /** The game whose bank it is placed from. */
  game: string;
  stake: bigint;
  /** Its probability, counted in outcomes out of 2^64: it wins when the round's outcome is below this. */
  chance: bigint;
  /** What it pays when it wins. */
  prize: bigint;
  /** The label its game gives the bets that belong together. */
  group: string;
  /** The developer's own JSON, which the casino keeps with the reveal and never reads. */
  meta: Record<string, unknown>;
  signature: string;
  /** Declined, it moved no money. */
  accepted: boolean;
  /** What it paid the game's bank, once accepted. */
  payout?: bigint;
}
export interface SignedStatement {
  message: Record<string, any>;
  signature: string;
}
