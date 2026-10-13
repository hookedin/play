import type { TypedDataField } from 'ethers';
import type {
  Details,
  Domain,
  StepResult,
  StepTable,
  Opening,
  Checkpoint,
  Operation,
  Step,
  Evidence,
  EvidenceBundle,
  Json,
  Quote,
  CollateralOffer,
  OnchainChannel,
} from './types.ts';
import {
  AbiCoder,
  TypedDataEncoder,
  verifyTypedData,
  getAddress,
  getBytes,
  id,
  isAddress,
  keccak256,
  ZeroHash,
  ZeroAddress,
  toUtf8Bytes,
} from 'ethers';
import { OUTCOME_SPACE, MAX_BALANCE, UINT256_MAX, admits, uint256 } from './risk.ts';
/** A value as JSON: every bigint a decimal string, the one form the readers below take back. */
export const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v));
export const plain = <T>(value: T): Json<T> => JSON.parse(json(value));
export const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const fields = (source: string) =>
  source.split(',').map(f => {
    const [type, name] = f.split(' ');
    return { type, name };
  });
export const MAX_JSON_BYTES = 1_000_000;
// JSON-stable commitment: a bigint is its decimal string; object order is irrelevant.
export function canonicalJSON(value: any): string {
  if (typeof value === 'bigint') return JSON.stringify(String(value));
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw new Error('JSON numbers must be safe integers');
    if (value === undefined) throw new Error('Undefined JSON value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k]))
      .join(',') +
    '}'
  );
}
export function hashJSON(context: unknown) {
  if (context == null) return ZeroHash;
  const bytes = toUtf8Bytes(canonicalJSON(context));
  if (bytes.length > MAX_JSON_BYTES) throw new Error('JSON payload is too large');
  return keccak256(bytes);
}
export const STATE_TYPES = {
  Checkpoint: fields(
    'address player,uint256 index,uint256 sequence,bytes32 previousStateHash,bytes32 transitionHash,uint256 balance,uint256 deposited,uint256 withdrawn',
  ),
};
export const OP_TYPES = {
  Operation: fields(
    'bytes32 previousStateHash,uint256 kind,uint256 amount,address recipient,uint256 fee,uint64 chance,uint256 prize,bytes32 round,bytes32 seedHash,bytes32 memo',
  ),
};
/** The casino's quote for the casino bet that follows the checkpoint `previousStateHash`: the round it settles
 * on and the virtual bankroll it is admitted against, until `expiresAt`, in seconds. The casino settles every casino bet
 * its quote covers; the account disputes one it does not settle on-chain, before the quote expires. */
export const QUOTE_TYPES = {
  Quote: fields('bytes32 previousStateHash,bytes32 round,uint256 virtualBankroll,uint256 expiresAt'),
};
/** How long a quote holds, in seconds. */
export const QUOTE_PERIOD = 24 * 60 * 60;
/** The casino's offer of collateral for the channel `index` of the account `player`: `amount` of house cash, locked
 * into the channel for `price`, which whoever buys it pays the contract, once and before `expiresAt`, in seconds. */
export const OFFER_TYPES = {
  CollateralOffer: fields('address player,uint256 index,uint256 amount,uint256 price,uint256 expiresAt'),
};
/** What `amount` of collateral costs at the casino's rate, in millionths of the amount: rounded up, so it costs
 * something. */
export const collateralPrice = (amount: bigint, rate: bigint) => (amount * rate + 999_999n) / 1_000_000n;
/** An account proves itself to the casino with its own key, for every one of its channels. */
export const ACCESS_TYPES = {
  Access: fields('address player,uint256 expiresAt'),
};
/** A game's developer names the key its server signs with: `server` settles the game's developer bets, opens its rounds
 * and places its casino bets from its bank, and nothing else. Until the developer names one, it is the developer's own
 * key. The casino keeps the signed message, so a wallet checks a settlement against the developer's own signature. */
export const GAME_SERVER_TYPES = {
  GameServer: fields('string game,address server'),
};
/** A game's server proves itself with its key, as an account does on its channel. */
export const DEVELOPER_ACCESS_TYPES = {
  DeveloperAccess: fields('address server,uint256 expiresAt'),
};
/** A game's server settles a developer bet on the game: `player` is what the player is paid and `casino` what the casino
 * is given, both from the game's bank, which took the stake when the bet was placed. `bet` is the hash of the
 * operation that placed the developer bet, which signs its meta, and the round it rides on if it names one: a
 * settlement of that bet comes with the round's secret, which needs no signature, since it hashes to the round. */
export const SETTLEMENT_TYPES = {
  Settlement: fields('bytes32 bet,uint256 player,uint256 casino'),
};
/** A game's casino bet from its bank, on one of its rounds, signed by its server: settled against the bankroll at
 * once, it reveals the round. Like every casino bet it signs the hash of the seed it brings, so only that seed settles
 * it. `group` is the label the game gives the bets that belong together, and `meta` the hash of its meta, the
 * developer's own JSON, which the casino keeps with the reveal and never reads: whatever the developer commits to
 * there, it committed to before the outcome was revealed. A stake, chance and prize of zero bet nothing and only
 * reveal the round. */
export const BANK_CASINO_BET_TYPES = {
  BankCasinoBet: fields(
    'bytes32 round,string game,uint256 stake,uint64 chance,uint256 prize,string group,bytes32 seedHash,bytes32 meta',
  ),
};
/** The `authorization` header carrying a signed `Access` or `DeveloperAccess` message. */
export const authorization = (message: unknown, signature: string) =>
  'HookedIn ' + btoa(json({ message, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const domain = (chainId: bigint, casino: string) => ({
  name: 'HookedIn',
  version: '1',
  chainId,
  verifyingContract: getAddress(casino),
});
export const hashState = (d: Domain, s: Checkpoint) => TypedDataEncoder.hash(d, STATE_TYPES, s);
export const hashOperation = (d: Domain, s: Operation) => TypedDataEncoder.hash(d, OP_TYPES, s);
/** The key a channel goes by off-chain, and the ID of its close's claim on-chain: an account's first channel has
 * `index` 0, and each one whose close started is followed by the next. Nothing signs it. */
export const channelId = (player: string, index: bigint) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [player, index]));
/** A channel's status on-chain: an account's current channel is active from the start, with nothing to open, and
 * takes play and money until its close starts. */
export const STATUS = { active: 0n, closing: 1n, finalized: 2n } as const;
/** The fields of the contract's `Channel`, as `channels()` returns it and `ChannelChanged` carries it. */
export const CHANNEL_FIELDS = [
  'deposited',
  'principal',
  'collateral',
  'claimed',
  'status',
  'deadline',
  'closingSequence',
  'closingHash',
  'closingBalance',
  'disputedPrize',
  'disputeHold',
] as const;
/** A channel as the contract holds it, from what `channels()` returns or `ChannelChanged` carries. */
export function onchainChannel(c: any): OnchainChannel {
  const channel = Object.fromEntries(CHANNEL_FIELDS.map(field => [field, c[field]]));
  if (!CHANNEL_FIELDS.every(field => (field === 'closingHash' ? validHash : isUint)(channel[field])))
    throw new Error('The contract returned no channel');
  return channel as unknown as OnchainChannel;
}
const isUint = (value: unknown) => typeof value === 'bigint' && value >= 0n && value <= UINT256_MAX;
/** A channel the contract never changed: active, and holding nothing. */
export const UNTOUCHED_CHANNEL = {
  ...Object.fromEntries(CHANNEL_FIELDS.map(field => [field, 0n])),
  closingHash: ZeroHash,
} as OnchainChannel;
/** Whether a channel's balance plays: the channel active, and every deposit the balance took in held on-chain. One a
 * reorganisation took back waits for the money to land again: a close nets out what the chain does not hold, so a bet
 * on it would risk nothing. */
export const playsOn = (
  onchain: { status: bigint; deposited: bigint } | null | undefined,
  state: { deposited: bigint },
) => !!onchain && onchain.status === STATUS.active && state.deposited <= onchain.deposited;
/** A casino bet's terms, from the operation that signs them: the stake, the chance out of 2^64 and the prize. */
export const betTerms = (op: Pick<Operation, 'amount' | 'chance' | 'prize'>) => ({
  stake: op.amount,
  chance: op.chance,
  prize: op.prize,
});
/** The bankroll fund. Investing is a debit that names it as its counterparty, and divesting a credit
 * from it. An investor trusts the casino completely: a share is its promise of a part of the
 * bankroll, not money the contract protects. */
export const FUND_ID = id('HOOKEDIN/BANKROLL');
/** The casino signs a statement for every change to a holding. `shares` is what the holder has
 * afterwards. `equity` and `totalShares` are the fund just before the change, which fix the price
 * `amount` was converted at. `cause` is the hash of the holder's own signed investment or `Redeem`. */
export const SHARE_TYPES = {
  ShareStatement: fields(
    'address holder,uint256 sequence,uint256 shares,uint256 amount,uint256 equity,uint256 totalShares,bytes32 cause',
  ),
};
/** The public state of the fund, signed when asked for: a quote the casino can be held to. */
export const FUND_TYPES = {
  Fund: fields('uint256 sequence,uint256 totalShares,uint256 houseShares,uint256 equity,uint256 overdrawn,uint256 at'),
};
/** A holder converts shares back into money. `sequence` is the statement it will produce, so a
 * redemption can be used once. */
export const REDEEM_TYPES = {
  Redeem: fields('address holder,uint256 shares,uint256 sequence'),
};
export const hashRedeem = (d: Domain, s: { holder: string; shares: bigint; sequence: bigint }) =>
  TypedDataEncoder.hash(d, REDEEM_TYPES, s);
/** The characters a uname is written in: no `l`, `0`, `1` or `u`, so no two of them read alike. */
export const UNAME_ALPHABET = '23456789abcdefghijkmnopqrstvwxyz';
export const UNAME_LENGTH = 24;
/** A player's uname, which the casino derives from their address. */
export const UNAME = new RegExp(`^[${UNAME_ALPHABET}]{${UNAME_LENGTH}}$`);
/** A Discord username: 2 to 32 lowercase letters, digits, underscores or periods. */
export const DISCORD_USERNAME = /^[a-z0-9_.]{2,32}$/;
/** Case, `l`/`1`/`i` and `0`/`o` are not differences: the form names are compared and found by, so nobody can pass for
 * somebody else with a lookalike. */
export const fold = (name: string) => name.toLowerCase().replaceAll('l', 'i').replaceAll('1', 'i').replaceAll('0', 'o');
/** Another player as a counterparty: their uname, written `~uname`. A debit that pays another player names them, and
 * the credit that player collects it with names the player it came from. */
const PLAYER = new RegExp(`^~[${UNAME_ALPHABET}]{${UNAME_LENGTH}}$`);
/** The uname of the player a counterparty names, or null for any other counterparty. */
export const counterpartyPlayer = (counterparty: unknown) =>
  typeof counterparty === 'string' && PLAYER.test(counterparty) ? counterparty.slice(1) : null;
/** A game's bank: the game's money at the casino. Half the commission of the casino bets in the game and the stake of
 * every developer bet on it go in, and it pays the settlements and the casino bets the game's server signs. Its
 * developer puts money in with a debit from their own channel that names the game's ID as its counterparty, answered
 * with a statement of the balance, and takes it out with a signed `BankWithdraw`, collected with a credit that names
 * the game's ID. The casino signs the balance after every deposit and withdrawal: `cause` is the hash of the
 * developer's signed deposit or `BankWithdraw`. */
export const BANK_TYPES = {
  BankStatement: fields('string game,uint256 sequence,uint256 balance,bytes32 cause'),
};
/** A game's developer takes money out of its bank. `sequence` is the statement it will produce, so it works once. */
export const BANK_WITHDRAW_TYPES = {
  BankWithdraw: fields('string game,uint256 amount,uint256 sequence'),
};
export const hashBankWithdraw = (d: Domain, s: { game: string; amount: bigint; sequence: bigint }) =>
  TypedDataEncoder.hash(d, BANK_WITHDRAW_TYPES, s);
/** Where the casino's signing history ended when it signed: its last record's ID and that record's digest, which
 * commits to every record before it. Every answer on a channel carries the latest the casino signed, and a wallet keeps
 * the newest it holds and checks it against the casino's history again and again: a history rewritten up to that record
 * cannot give it back. */
export const HEAD_TYPES = {
  HistoryHead: fields('string record,bytes32 digest'),
};
/** Shares bought by `amount` when the fund holds `equity` for `totalShares`. The first shares cost one wei each. */
export function sharesFor(amount: bigint, equity: bigint, totalShares: bigint) {
  if (amount <= 0n) throw new Error('Invalid investment');
  if (totalShares === 0n) return amount;
  if (equity <= 0n) throw new Error('The bankroll is not open to investment');
  return (amount * totalShares) / equity;
}
/** What `shares` are worth when the fund holds `equity` for `totalShares`, rounded down. */
export function valueOf(shares: bigint, equity: bigint, totalShares: bigint) {
  if (shares < 0n || shares > totalShares) throw new Error('Invalid shares');
  return totalShares === 0n || equity <= 0n ? 0n : (shares * equity) / totalShares;
}
/** A statement follows the holder's last one and states exactly what the price implies. `burned`
 * is set for a redemption and absent for an investment. Returns the shares it moved. */
export function verifyShareStatement(
  d: Domain,
  { message, signature }: { message: any; signature: string },
  operator: string,
  expected: {
    holder: string;
    previous: { sequence: bigint; shares: bigint };
    cause: string;
    amount?: bigint;
    burned?: bigint;
  },
) {
  if (!canonical(SHARE_TYPES, message)) throw new Error('The share statement is not in its one form');
  assertSignature(d, SHARE_TYPES, message, signature, operator);
  if (
    !same(message.holder, expected.holder) ||
    message.sequence !== expected.previous.sequence + 1n ||
    !same(message.cause, expected.cause)
  )
    throw new Error('Share statement does not follow this holding');
  const before = expected.previous.shares;
  if (expected.burned === undefined) {
    const minted = sharesFor(message.amount, message.equity, message.totalShares);
    if (message.amount !== expected.amount || message.shares !== before + minted)
      throw new Error('Share statement does not match the investment');
    return minted;
  }
  const burned = expected.burned;
  if (message.shares !== before - burned || message.amount !== valueOf(burned, message.equity, message.totalShares))
    throw new Error('Share statement does not match the redemption');
  return burned;
}
/** The largest `s` the contract recovers a signature with: half the curve's order. */
const MAX_S = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
/** A signature in the one form the contract recovers, in lowercase: 65 bytes, an `s` of at most half the curve's order
 * and a v of 27 or 28. ethers recovers a compact one, an `s` above that or a v of 0 or 1 as well, and each side keeps
 * the other's signatures as they came, as its evidence. */
export const validSignature = (signature: unknown): signature is string =>
  typeof signature === 'string' &&
  /^0x[0-9a-f]{128}1[bc]$/.test(signature) &&
  BigInt('0x' + signature.slice(66, 130)) <= MAX_S;
export function assertSignature(
  d: Domain,
  types: Record<string, TypedDataField[]>,
  message: Record<string, any>,
  signature: string,
  expected: string,
) {
  if (!validSignature(signature) || !same(verifyTypedData(d, types, message, signature), expected))
    throw new Error('Invalid signature');
}
/** The checkpoint a channel starts from: all zero but its account and index. The contract takes it with no signature. */
export function baseState(player: string, index: bigint): Checkpoint {
  return {
    player: getAddress(player),
    index,
    sequence: 0n,
    previousStateHash: ZeroHash,
    transitionHash: ZeroHash,
    balance: 0n,
    deposited: 0n,
    withdrawn: 0n,
  };
}
/** Whether evidence is its channel's base, unsigned. */
const unsignedBase = (d: Domain, evidence: Evidence) =>
  evidence.playerSignature === '0x' &&
  evidence.casinoSignature === '0x' &&
  hashState(d, evidence.base) === hashState(d, baseState(evidence.base.player, evidence.base.index));
/** What a close of the channel in `state` is owed: its balance, whatever of the channel's on-chain `deposited` it has
 * not taken in yet, and what it withdrew that is not yet a claim, less what the channel's claims took
 * (`claimed`) that it did not withdraw and what it took in that the chain does not hold; never below nothing. The
 * contract works it out the same way. */
export function owed(
  state: Pick<Checkpoint, 'balance' | 'deposited' | 'withdrawn'>,
  deposited: bigint,
  claimed: bigint,
) {
  const due = state.balance + deposited + state.withdrawn,
    taken = state.deposited + claimed;
  return due > taken ? due - taken : 0n;
}
/** The deposits of `principal`, those a channel still holds, that the contract pays a withdrawal out of when its
 * checkpoint took in `deposited` of the channel's `deposited`: a deposit it did not take in stays the channel's. */
export function depositsTakenIn(channel: { deposited: bigint }, principal: bigint, deposited: bigint) {
  const deposits = principal + deposited - channel.deposited;
  return deposits < 0n ? 0n : deposits > principal ? principal : deposits;
}
/** A channel's deposits and collateral once the contract has recorded `withdrawals`, those it owes, each with the
 * `deposited` of its checkpoint, in the order they were signed, and what they take of house cash: each is paid out of
 * the deposits its checkpoint took in, then the collateral, and the rest out of house cash. What a lock-in pays goes
 * back into the account's current channel as deposits, which this leaves out: no checkpoint before it took
 * them in. */
export function recordWithdrawals(
  channel: { deposited: bigint; principal: bigint; collateral: bigint },
  withdrawals: { amount: bigint; deposited: bigint }[],
) {
  let principal = channel.principal,
    collateral = channel.collateral,
    cash = 0n;
  for (const withdrawal of withdrawals) {
    const amount = withdrawal.amount,
      available = depositsTakenIn(channel, principal, withdrawal.deposited),
      deposits = amount < available ? amount : available,
      locked = amount - deposits < collateral ? amount - deposits : collateral;
    principal -= deposits;
    collateral -= locked;
    cash += amount - deposits - locked;
  }
  return { principal, collateral, cash };
}
/** What protects the balance of a channel in `state`: the deposits and collateral the contract holds for it once it has
 * recorded `withdrawals`, those it owes, and how much of the balance, with what the channel holds that it has not taken
 * in yet, they protect. `covered` is what a close then pays out of them, `uncovered` the winnings above them,
 * which only house cash pays, and `missing` the deposits the balance took in that the chain does not hold, which a
 * close is owed only once they land again; `spare` is what more it could win and have protected. */
export function protection(
  state: Pick<Checkpoint, 'balance' | 'deposited' | 'withdrawn'>,
  channel: { deposited: bigint; principal: bigint; collateral: bigint },
  withdrawals: { amount: bigint; deposited: bigint }[],
) {
  const left = recordWithdrawals(channel, withdrawals),
    held = left.principal + left.collateral,
    arriving = channel.deposited - state.deposited,
    balance = state.balance + (arriving > 0n ? arriving : 0n),
    // What a close is owed once they are recorded.
    due = owed(state, channel.deposited, state.withdrawn),
    covered = due < held ? due : held;
  return {
    deposits: left.principal,
    collateral: left.collateral,
    covered,
    uncovered: due - covered,
    missing: balance - due,
    spare: held - covered,
  };
}
/** Whether the contract has recorded the withdrawal `evidence` proves: it records a channel's withdrawals in the order
 * they were signed, so once the channel's `claimed` has passed the `withdrawn` of the checkpoint the withdrawal
 * follows. What stays owed of it is a claim under its ID; one paid in full at once leaves none. */
export const withdrawalRecorded = (claimed: bigint, evidence: Evidence) => claimed > evidence.base.withdrawn;
/** The operation that follows `base`, in its one form (`canonical`): zero but for `values`. */
export function operation(d: Domain, base: Checkpoint, values: Partial<Operation>): Operation {
  const op: Operation = {
    previousStateHash: hashState(d, base),
    kind: 0n,
    amount: 0n,
    recipient: ZeroAddress,
    fee: 0n,
    chance: 0n,
    prize: 0n,
    round: ZeroHash,
    seedHash: ZeroHash,
    memo: ZeroHash,
    ...values,
  };
  if (!canonical(OP_TYPES, op)) throw new RangeError('The operation is not in its one form');
  return op;
}
/** A quote the casino signed for the casino bet that follows `state`. */
export function verifyQuote(d: Domain, quote: Quote, state: Checkpoint, operator: string) {
  if (!only(quote, ['message', 'signature']) || !canonical(QUOTE_TYPES, quote.message))
    throw new Error('The quote is not in its one form');
  assertSignature(d, QUOTE_TYPES, quote.message, quote.signature, operator);
  const { previousStateHash, round, virtualBankroll } = quote.message;
  if (previousStateHash !== hashState(d, state) || round === ZeroHash || virtualBankroll >= MAX_BALANCE)
    throw new Error('The quote is not for this checkpoint');
  return quote;
}
/** Whether `quote` covers the casino bet `op` at `now`, in seconds: both in their one form, it names the bet's
 * checkpoint and round, has not expired, and its virtual bankroll, below the protocol's maximum, admits the bet's
 * terms. The contract checks the same when the bet is disputed. */
export const covers = (quote: Quote, op: Operation, now: number) =>
  canonical(QUOTE_TYPES, quote?.message) &&
  canonical(OP_TYPES, op) &&
  op.kind === KIND.casinoBet &&
  quote.message.previousStateHash === op.previousStateHash &&
  quote.message.round === op.round &&
  quote.message.expiresAt >= BigInt(now) &&
  quote.message.virtualBankroll < MAX_BALANCE &&
  admits(quote.message.virtualBankroll, betTerms(op));
/** A collateral offer the casino signed for `amount` on the channel `opening` names, at the price its `rate` gives. */
export function verifyOffer(
  d: Domain,
  offer: CollateralOffer,
  opening: Pick<Opening, 'player' | 'index'>,
  amount: bigint,
  rate: bigint,
  operator: string,
) {
  if (!only(offer, ['message', 'signature']) || !canonical(OFFER_TYPES, offer.message))
    throw new Error('The offer is not in its one form');
  assertSignature(d, OFFER_TYPES, offer.message, offer.signature, operator);
  const { message } = offer;
  if (!same(message.player, opening.player) || message.index !== opening.index || message.amount !== amount)
    throw new Error('The offer is not for this collateral');
  if (message.price !== collateralPrice(amount, rate)) throw new Error("The casino's offer is not at its rate");
  return offer;
}
/** What the contract takes of an offer to buy it, the price being what the buyer pays. */
export const offerTerms = ({ message, signature }: CollateralOffer) => [
  message.player,
  message.index,
  message.amount,
  message.expiresAt,
  signature,
];
/** What the contract takes of a quote when a bet is disputed: the operation names its checkpoint and round. */
export const quoteTerms = (quote: Quote) => ({
  virtualBankroll: quote.message.virtualBankroll,
  expiresAt: quote.message.expiresAt,
  signature: quote.signature,
});
/** The step of a casino bet the account disputes: its operation, the account's authorization and the seed, with no
 * secret and no casino signature, which the casino's settlement brings. */
export const disputedStep = (operation: Operation, authorization: string, seed: string): Step => ({
  operation,
  authorization,
  seed,
  secret: ZeroHash,
  casinoSignature: '0x',
});
/** A game's ID, a UUID: a published game's is the UUIDv7 of the record that first published it, its own whatever it is
 * renamed or moved to, and a game opened by its URL alone, which nobody publishes, has its URL's (`urlGameId`). */
export const GAME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A signing-history record's ID, a UUIDv7, which is the ID of the bet it placed too. */
export const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The ID of a game opened by its URL alone: a UUIDv8 of the first 16 bytes of the hash of the URL. */
export function urlGameId(url: string) {
  const hex = keccak256(toUtf8Bytes(url)).slice(2, 34),
    variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
/** The longest name a game is published under. */
export const MAX_GAME_NAME = 32;
/** The part of a game's address its name makes, `@username/<slug>`: the name's letters and digits, lowercase and
 * without their accents, each run of anything else one hyphen. */
export const gameSlug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
/** A name a game is published under, such as `Super Dice`: 1 to `MAX_GAME_NAME` printable characters, no space at
 * either end, whose slug has a letter or a digit and at most `MAX_GAME_NAME` characters too. */
export function validGameName(name: unknown): name is string {
  if (!printable(name)) return false;
  const slug = gameSlug(name);
  return name.length <= MAX_GAME_NAME && name === name.trim() && slug !== '' && slug.length <= MAX_GAME_NAME;
}
export const memo = (details: Details) => hashJSON(details);
const bytes32Pattern = /^0x[0-9a-f]{64}$/;
/** The longest group label a bet or a payment carries. */
export const MAX_GROUP = 64;
/** Whether every string in a JSON value, its keys too, is well-formed text without a NUL: all a database holds, so the
 * casino refuses anything else before it can reach a record. */
export const validText = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.isWellFormed() && !value.includes('\0')
    : value === null ||
      typeof value !== 'object' ||
      Object.entries(value).every(([key, item]) => validText(key) && validText(item));
/** Text as everyone sees it: no control, format, private-use or unassigned character, nor half a surrogate pair, any
 * of which could hide or reorder what it shows. */
export const printable = (text: unknown): text is string => typeof text === 'string' && !/\p{C}/u.test(text);
/** A group label: 1 to `MAX_GROUP` printable characters. */
export const validGroup = (group: unknown): group is string =>
  printable(group) && group.length > 0 && group.length <= MAX_GROUP;
/** The most a bet's meta takes, as canonical JSON. */
export const MAX_META_BYTES = 4096;
/** The most developer bets one request settles, and one page lists. */
export const MAX_DEVELOPER_BETS = 256;
/** The most payouts one reply lists. A wallet collects them, and the next reply lists the rest. */
export const MAX_PAYOUTS = 256;
/** The most results a game's step has; the most pairs of an amount below the step's cash and one above it, or with none
 * above it, of an amount below it and the highest, that the wallet splits it into, each one or two casino bets; the
 * bound below its results' total weight; and the longest label of a result. */
export const MAX_RESULTS = 128;
export const MAX_PAIRS = 64;
export const MAX_WEIGHT = 1n << 256n;
export const MAX_LABEL = 64;
/** Every bound a bet is held to, as the wallet reports it to a game and the casino to a developer. They are part
 * of the protocol revision, so a wallet or a developer that holds other ones stops before it signs anything. */
export const BOUNDS = {
  /** The size of the space a round's outcome and a bet's chance are counted in. */
  outcomeSpace: OUTCOME_SPACE,
  /** The most a bet's meta takes as canonical JSON, and the longest group label. */
  meta: MAX_META_BYTES,
  group: MAX_GROUP,
  /** A step's table: its results, its pairs, its total weight and its labels. */
  results: MAX_RESULTS,
  pairs: MAX_PAIRS,
  weight: MAX_WEIGHT,
  label: MAX_LABEL,
};
/** The pairs the wallet splits a step of these amounts into, at `cash`: each amount below it with each above it, or
 * with none above it, each below it with the highest, or with the cash itself when one result keeps it. */
export function stepPairs(cash: bigint, amounts: ReadonlySet<bigint>) {
  let lows = 0,
    highs = 0;
  for (const amount of amounts) amount < cash ? lows++ : amount > cash ? highs++ : 0;
  return highs ? lows * highs : amounts.has(cash) ? lows : Math.max(lows - 1, 0);
}
/** A step's results in their one form, at `cash`, its cash in its own one form: 1 to `MAX_RESULTS` of them, each a
 * whole-number weight above zero, the cash it leaves the player below 2^96 and, if it has one, a label of 1 to
 * `MAX_LABEL` printable characters, weighing together less than `MAX_WEIGHT`, that pair up into at most `MAX_PAIRS`.
 * A step whose results all leave one amount keeps its cash: it leaves no other. */
export function validResults(cash: unknown, results: unknown): results is StepResult[] {
  if (typeof cash !== 'bigint' || cash < 1n || cash >= MAX_BALANCE) return false;
  if (!Array.isArray(results) || results.length < 1 || results.length > MAX_RESULTS) return false;
  let total = 0n;
  const amounts = new Set<bigint>();
  for (const result of results) {
    if (
      !only(result, ['weight', 'cash', 'label']) ||
      typeof result.weight !== 'bigint' ||
      result.weight < 1n ||
      typeof result.cash !== 'bigint' ||
      result.cash < 0n ||
      result.cash >= MAX_BALANCE ||
      (result.label !== undefined &&
        !(printable(result.label) && result.label.length > 0 && result.label.length <= MAX_LABEL))
    )
      return false;
    total += result.weight;
    amounts.add(result.cash);
  }
  return total < MAX_WEIGHT && (amounts.size > 1 || amounts.has(cash)) && stepPairs(cash, amounts) <= MAX_PAIRS;
}
/** A step's table as a bet signs it in its details: its cash and results, and for a step of several amounts, which the
 * wallet split into bets, the virtual bankroll of the quote it split it at. */
export const validTable = (table: unknown): table is StepTable =>
  only(table, ['cash', 'bankroll', 'results']) &&
  validResults(table.cash, table.results) &&
  (new Set(table.results.map((result: StepResult) => result.cash)).size > 1
    ? typeof table.bankroll === 'bigint' && table.bankroll >= 0n && table.bankroll < MAX_BALANCE
    : table.bankroll === undefined);
/** Whether a casino bet is one its step's table can place: it stakes at most the step's cash, and what it keeps and
 * what it keeps with its prize are amounts the table leaves. */
export const betOfTable = (table: StepTable, bet: { amount: bigint; prize: bigint }) =>
  bet.amount <= table.cash &&
  table.results.some(result => result.cash === table.cash - bet.amount) &&
  table.results.some(result => result.cash === table.cash - bet.amount + bet.prize);
/** The one shape details have for each kind: a casino bet names its game, and the table of the step it was drawn from
 * if it was; a debit its game (a payment, with what it leaves with its group if it has one, or a developer bet, whose
 * meta alone says what it is, with the round it rides on if it names one) or what it pays into (an investment, a game's bank, named by the game's ID, or another player); a
 * credit what it collects from; a deposit, a withdrawal and a lock-in nothing but themselves, a withdrawal's recipient
 * being in the operation. Only what names a game carries a group. Every field is in one form, so one meaning has one
 * memo. */
export function checkDetails(kind: bigint, details: Details) {
  const { game, group, meta, table, round, kept } = details ?? {};
  const named = typeof game === 'string' && GAME_ID.test(game);
  const counterparty =
    typeof details?.counterparty === 'string' &&
    (bytes32Pattern.test(details.counterparty) ||
      GAME_ID.test(details.counterparty) ||
      counterpartyPlayer(details.counterparty) !== null);
  if (
    !only(details, ['id', 'game', 'group', 'counterparty', 'meta', 'table', 'round', 'kept']) ||
    !validHash(details.id) ||
    (game !== undefined && !named) ||
    (details.counterparty !== undefined && !counterparty) ||
    (group !== undefined && (!named || !validGroup(group))) ||
    (meta !== undefined && (!named || !validMeta(meta))) ||
    (table !== undefined && (kind !== KIND.casinoBet || !validTable(table))) ||
    (round !== undefined && (meta === undefined || kind !== KIND.debit || !validHash(round))) ||
    (kept !== undefined &&
      (kind !== KIND.debit ||
        group === undefined ||
        meta !== undefined ||
        details.counterparty !== undefined ||
        typeof kept !== 'bigint' ||
        kept < 0n ||
        kept >= MAX_BALANCE)) ||
    !(kind === KIND.casinoBet
      ? named && !counterparty && meta === undefined
      : kind === KIND.debit
        ? named !== counterparty
        : kind === KIND.credit
          ? counterparty && !named
          : (kind === KIND.deposit || kind === KIND.withdrawal || kind === KIND.lockIn) && !counterparty && !named)
  )
    throw Object.assign(new Error('Invalid operation details'), { code: 'invalid' });
}
/** Whether `value` is a JSON object with no field but `fields`. */
export const only = (value: unknown, fields: string[]): value is Record<string, any> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every(key => fields.includes(key));
/** A whole number as JSON holds it, in its one form: a decimal string, without a sign, a space or a leading zero. */
export const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
/** An address in its one form: checksummed. */
export const checksummed = (value: unknown): value is string =>
  typeof value === 'string' && isAddress(value) && getAddress(value) === value;
/** A hash in its one form: 32 bytes of lowercase hex. */
export const validHash = (value: unknown): value is string => typeof value === 'string' && bytes32Pattern.test(value);
/** Whether `message` is a message of `types`' one struct in its one form: exactly its fields, each uint a bigint within
 * its width, each bytes32 a hash, each address checksummed and each string well-formed text. ethers signs many
 * spellings of one value alike, so two spellings of one message never both pass, and what is signed is what is kept. */
export function canonical(types: Record<string, TypedDataField[]>, message: unknown): boolean {
  const [fields] = Object.values(types) as [TypedDataField[]];
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
  const value = message as Record<string, unknown>;
  return (
    Object.keys(value).length === fields.length &&
    fields.every(({ name, type }) => {
      if (!Object.hasOwn(value, name)) return false;
      const field = value[name],
        width = /^uint(\d+)$/.exec(type)?.[1];
      if (type === 'address') return checksummed(field);
      if (type === 'bytes32') return validHash(field);
      if (type === 'string') return typeof field === 'string' && validText(field);
      return width !== undefined && typeof field === 'bigint' && field >= 0n && field < 1n << BigInt(width);
    })
  );
}
/** A casino bet's terms in their one form: a stake and a prize of 1 to 2^96 − 1 wei and a chance of 1 to 2^64 − 1
 * outcomes. */
export const validBet = (stake: unknown, chance: unknown, prize: unknown) =>
  typeof stake === 'bigint' &&
  typeof chance === 'bigint' &&
  typeof prize === 'bigint' &&
  stake > 0n &&
  stake < MAX_BALANCE &&
  chance > 0n &&
  chance < OUTCOME_SPACE &&
  prize > 0n &&
  prize < MAX_BALANCE;
/** Meta in its one form, a developer bet's and a developer's casino bet's alike: a JSON object of up to
 * `MAX_META_BYTES` of canonical JSON, whose numbers are whole and whose text is well-formed, without a NUL. The casino
 * keeps it and never reads it. */
export function validMeta(meta: unknown): meta is Record<string, unknown> {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta) || !validText(meta)) return false;
  try {
    // JSON itself, not what it writes a bigint as.
    JSON.stringify(meta);
    return toUtf8Bytes(canonicalJSON(meta)).length <= MAX_META_BYTES;
  } catch {
    return false;
  }
}
/** A round is named by the hash of its secret. */
export const roundId = (secret: string) => keccak256(secret);
/** A bet names its seed by its hash, so whoever knows the round's secret cannot know the outcome
 * before the seed is out. */
export const seedHash = (seed: string) => keccak256(seed);
/** Every bet on one round and seed sees the same 64-bit outcome, whoever signed it. */
const OUTCOME_TAG = 'HOOKEDIN/OUTCOME';
export function outcome(seed: string, secret: string) {
  const randomHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'bytes32'], [id(OUTCOME_TAG), seed, secret]),
  );
  return { randomHash, value: BigInt(randomHash) & (OUTCOME_SPACE - 1n) };
}
/** What the wallet draws a game's step with, from the seed it signs the step's bet with: under a tag, the bytes of
 * keccak256(abi.encode(keccak256(tag), seed, i)) for i = 0, 1, 2, … read in turn. A value below `limit` takes as many
 * bytes as `limit − 1` needs, the first cut to the bits it needs, read big-endian, and is taken again from the next
 * bytes until it is below `limit`. */
const BRANCH_TAG = 'HOOKEDIN/BRANCH',
  RESULT_TAG = 'HOOKEDIN/RESULT';
function stream(tag: string, seed: string) {
  let block = 0n,
    bytes: Uint8Array = new Uint8Array(0),
    offset = 0;
  const byte = () => {
    if (offset === bytes.length) {
      bytes = getBytes(
        keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'uint256'], [id(tag), seed, block++])),
      );
      offset = 0;
    }
    return bytes[offset++]!;
  };
  return (limit: bigint) => {
    if (limit === 1n) return 0n;
    const bits = (limit - 1n).toString(2).length,
      length = Math.ceil(bits / 8);
    for (;;) {
      let value = BigInt(byte() & (0xff >>> (length * 8 - bits)));
      for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(byte());
      if (value < limit) return value;
    }
  };
}
/** One of these whole-number weights, from a value `random` draws below their total: the first whose running total
 * exceeds it, counting from 0. */
function pick(random: (limit: bigint) => bigint, weights: readonly bigint[]) {
  let value = random(weights.reduce((sum, weight) => sum + weight, 0n)),
    index = 0;
  while (value >= weights[index]!) value -= weights[index++]!;
  return index;
}
/** The branch of a game's step `seed` draws, before the wallet signs its bet: one of the step's branches, of these
 * whole-number weights, from the stream tagged HOOKEDIN/BRANCH. */
export const drawStep = (seed: string, weights: readonly bigint[]) => BigInt(pick(stream(BRANCH_TAG, seed), weights));
/** Where a game's step lands once its branch has left the player `cash`: the result `seed` draws among the step's
 * results that leave that cash, by their weights, from the stream tagged HOOKEDIN/RESULT, as its place in the table,
 * and the 64-bit value drawn after it, which the game shows the result with. */
export function landStep(seed: string, results: readonly StepResult[], cash: bigint) {
  const random = stream(RESULT_TAG, seed),
    landed = results.flatMap((result, i) => (result.cash === cash ? [i] : []));
  if (!landed.length) throw new Error('No result of the step leaves that cash');
  const result =
    landed[
      pick(
        random,
        landed.map(i => results[i]!.weight),
      )
    ]!;
  return { result: BigInt(result), draw: random(OUTCOME_SPACE) };
}
/** What a casino bet pays on an outcome: its prize when the outcome is below its chance, and nothing otherwise. The
 * stake was paid to enter. */
export const betPayout = (bet: { chance: bigint; prize: bigint }, value: bigint) =>
  value < bet.chance ? bet.prize : 0n;
/** What an operation does to the balance. Every signed operation names one of these. A casino bet settles in
 * the operation itself; a developer bet is a debit that pays its stake to its game's bank; a deposit takes in
 * money the player deposited into the channel on-chain; a withdrawal takes out what the contract owes its recipient,
 * and a lock-in what it puts into the account's current channel as deposits, each paying the casino its fee for
 * sending it. */
export const KIND = {
  none: 0n,
  casinoBet: 1n,
  debit: 2n,
  credit: 3n,
  deposit: 4n,
  withdrawal: 5n,
  lockIn: 6n,
} as const;
export function deriveState(d: Domain, base: Checkpoint, op: Operation, secret = ZeroHash, seed = ZeroHash) {
  if (!canonical(OP_TYPES, op) || !validHash(secret) || !validHash(seed))
    throw new Error('Operation is not in its one form');
  if (!same(hashState(d, base), op.previousStateHash)) throw new Error('Operation is not next in this channel');
  const next = {
    ...base,
    sequence: base.sequence + 1n,
    previousStateHash: hashState(d, base),
    transitionHash: keccak256(
      AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [hashOperation(d, op), secret]),
    ),
  };
  const { kind, amount, fee, chance, prize } = op,
    balance = base.balance;
  const casinoBet = kind === KIND.casinoBet,
    credit = kind === KIND.credit,
    deposit = kind === KIND.deposit,
    withdrawal = kind === KIND.withdrawal,
    pays = withdrawal || kind === KIND.lockIn;
  if (kind === KIND.none || kind > KIND.lockIn) throw new Error('Unknown operation');
  // Every field a kind does not use must be zero: one meaning, one encoding. A casino bet names its
  // round, the hash of a secret the casino fixed first, and the hash of its seed; only those two settle it.
  if (
    (casinoBet
      ? chance <= 0n ||
        chance >= OUTCOME_SPACE ||
        prize <= 0n ||
        prize >= MAX_BALANCE ||
        same(op.seedHash, ZeroHash) ||
        same(op.round, ZeroHash) ||
        !same(roundId(secret), op.round) ||
        !same(seedHash(seed), op.seedHash)
      : chance !== 0n ||
        prize !== 0n ||
        !same(op.seedHash, ZeroHash) ||
        !same(op.round, ZeroHash) ||
        !same(secret, ZeroHash) ||
        !same(seed, ZeroHash)) ||
    // Only a withdrawal names a recipient, never nobody and never the contract, and only it and a lock-in pay a fee.
    (withdrawal
      ? same(op.recipient, ZeroAddress) || same(op.recipient, d.verifyingContract)
      : !same(op.recipient, ZeroAddress)) ||
    (!pays && fee !== 0n) ||
    amount === 0n ||
    amount >= MAX_BALANCE ||
    fee >= MAX_BALANCE
  )
    throw new Error(
      casinoBet
        ? 'Invalid casino bet commitment or balance'
        : credit
          ? 'Invalid credit'
          : deposit
            ? 'Invalid deposit'
            : withdrawal
              ? 'Invalid withdrawal'
              : pays
                ? 'Invalid lock-in'
                : 'Invalid debit',
    );
  if (credit || deposit) {
    next.balance = balance + amount;
    // A deposit takes in money the contract holds for this channel; a close checks it does.
    if (deposit) next.deposited = base.deposited + amount;
  } else {
    // A withdrawal or a lock-in pays its fee as well.
    if (amount + fee > balance)
      throw new Error(casinoBet ? 'Invalid casino bet commitment or balance' : 'Insufficient balance');
    next.balance = balance - amount - fee + (casinoBet ? betPayout(op, outcome(seed, secret).value) : 0n);
    // A withdrawal counts what it takes out, so a close can tell what never became a claim.
    if (pays) next.withdrawn = base.withdrawn + amount;
  }
  if ([next.balance, next.deposited, next.withdrawn].some(amount => amount >= MAX_BALANCE))
    throw new Error('Balance exceeds the protocol maximum');
  return next;
}
/** A joint checkpoint above an authorized casino bet, debit, withdrawal or lock-in supersedes it without
 * consuming entropy or money. */
export function rejectionCheckpoint(d: Domain, base: Checkpoint, op: Operation): Checkpoint {
  if (
    !canonical(OP_TYPES, op) ||
    ![KIND.casinoBet, KIND.debit, KIND.withdrawal, KIND.lockIn].includes(op.kind as 1n) ||
    op.previousStateHash !== hashState(d, base)
  )
    throw new Error('Rejection must identify the next casino bet, debit, withdrawal or lock-in');
  return {
    ...base,
    sequence: uint256(base.sequence + 2n),
    previousStateHash: hashState(d, base),
    transitionHash: hashOperation(d, op),
  };
}
/** The checkpoint a step establishes, with the casino's signature over it checked. The player's
 * authorization is left to the caller: `verifyStep` checks it, and a wallet that signed it compares it. */
export function settleStep(d: Domain, base: Checkpoint, step: Step, casinoSigner: string) {
  const next = deriveState(d, base, step.operation, step.secret, step.seed);
  assertSignature(d, STATE_TYPES, next, step.casinoSignature, casinoSigner);
  return next;
}
export function verifyStep(d: Domain, base: Checkpoint, step: Step, playerSigner: string, casinoSigner: string) {
  assertSignature(d, OP_TYPES, step.operation, step.authorization, playerSigner);
  return settleStep(d, base, step, casinoSigner);
}
const emptyStep = (): Step => ({
  operation: {
    previousStateHash: ZeroHash,
    kind: 0n,
    amount: 0n,
    recipient: ZeroAddress,
    fee: 0n,
    chance: 0n,
    prize: 0n,
    round: ZeroHash,
    seedHash: ZeroHash,
    memo: ZeroHash,
  },
  authorization: '0x',
  seed: ZeroHash,
  secret: ZeroHash,
  casinoSignature: '0x',
});
/** Whether `step` is the empty step, in its one form. */
const isEmptyStep = (step: Step) => canonicalJSON(step) === canonicalJSON(emptyStep());
export function checkpointEvidence(state: Checkpoint, playerSignature = '0x', casinoSignature = '0x'): Evidence {
  return { base: state, playerSignature, casinoSignature, step: emptyStep() };
}
/** The checkpoint a bundle proves, once every signature in it checks out. Its base names its channel: the account,
 * which signs for it, and the index. */
export function verifyEvidence(bundle: EvidenceBundle): { state: Checkpoint } {
  const d = domain(bundle.chainId, bundle.casino),
    { operator, evidence } = bundle,
    base = evidence?.base;
  // Everything in its one form, as it was signed: what is kept is what was signed.
  if (
    !only(evidence, ['base', 'playerSignature', 'casinoSignature', 'step']) ||
    !canonical(STATE_TYPES, base) ||
    base.player === ZeroAddress
  )
    throw new Error('Evidence names no account, or is not in its one form');
  const player = base.player;
  // The channel's base needs no signature.
  if (!unsignedBase(d, evidence)) {
    assertSignature(d, STATE_TYPES, base, evidence.playerSignature, player);
    assertSignature(d, STATE_TYPES, base, evidence.casinoSignature, operator);
  }
  // A checkpoint-only proof carries the empty step: one meaning, one encoding.
  const empty = evidence.step?.operation?.kind === 0n;
  if (
    !only(evidence.step, ['operation', 'authorization', 'seed', 'secret', 'casinoSignature']) ||
    (empty && !isEmptyStep(evidence.step))
  )
    throw new Error('Checkpoint evidence must carry an empty step');
  const state = empty ? base : verifyStep(d, base, evidence.step, player, operator);
  if ([state.balance, state.deposited, state.withdrawn].some(amount => amount >= MAX_BALANCE))
    throw new Error('Balance exceeds the protocol maximum');
  // The details beside a step say what it meant, and are only as good as the memo it signed.
  if (bundle.details !== undefined && memo(bundle.details) !== evidence.step.operation.memo)
    throw new Error('Details differ from the operation they describe');
  // A casino bet the casino has not settled follows the checkpoint itself: the account signed it with its seed, on the
  // casino's quote for that checkpoint and its round.
  if (bundle.dispute !== undefined) {
    const { step, quote } = bundle.dispute ?? {},
      op = step?.operation;
    if (
      !empty ||
      !only(step, ['operation', 'authorization', 'seed', 'secret', 'casinoSignature']) ||
      !canonical(OP_TYPES, op) ||
      !only(quote, ['message', 'signature']) ||
      !canonical(QUOTE_TYPES, quote.message) ||
      op.kind !== KIND.casinoBet ||
      op.previousStateHash !== hashState(d, state) ||
      !validHash(step.seed) ||
      seedHash(step.seed) !== op.seedHash ||
      step.secret !== ZeroHash ||
      step.casinoSignature !== '0x' ||
      quote.message.previousStateHash !== op.previousStateHash ||
      quote.message.round !== op.round
    )
      throw new Error('The disputed bet does not follow the checkpoint');
    assertSignature(d, OP_TYPES, op, step.authorization, player);
    assertSignature(d, QUOTE_TYPES, quote.message, quote.signature, operator);
  }
  return { state };
}
/** The network fee of a deposit this account's address sent into its channel, which the casino pays: a credit that names
 * this as its counterparty and the deposit's transaction hash as its ID, so each deposit's fee is paid once. */
export const DEPOSIT_FEE_ID = id('HOOKEDIN/DEPOSIT_FEE');
const encoded = (all: Record<string, TypedDataField[]>[]) =>
  all.map(types => TypedDataEncoder.from(types).encodeType(Object.keys(types)[0])).join('');
/** One value for the whole protocol a wallet shares with the casino: every typed structure, and every rule the
 * two apply alike, from the operation kinds and what names an outcome or a counterparty to every limit. A wallet
 * built against another revision learns so from `GET /api/config` before it signs anything. */
export const PROTOCOL = id(
  encoded([
    STATE_TYPES,
    OP_TYPES,
    QUOTE_TYPES,
    OFFER_TYPES,
    ACCESS_TYPES,
    GAME_SERVER_TYPES,
    DEVELOPER_ACCESS_TYPES,
    SETTLEMENT_TYPES,
    BANK_CASINO_BET_TYPES,
    SHARE_TYPES,
    FUND_TYPES,
    REDEEM_TYPES,
    BANK_TYPES,
    BANK_WITHDRAW_TYPES,
    HEAD_TYPES,
  ]) +
    canonicalJSON({
      kinds: KIND,
      outcome: OUTCOME_TAG,
      counterparties: {
        fund: FUND_ID,
        depositFee: DEPOSIT_FEE_ID,
        player: PLAYER.source,
      },
      bounds: BOUNDS,
    }),
);
/** What a developer's server shares with the casino, and nothing more: the three structures it signs, the outcome
 * and the bounds. A change to what only a wallet signs leaves it alone, so it does not stop every developer. */
export const DEVELOPER_PROTOCOL = id(
  encoded([DEVELOPER_ACCESS_TYPES, SETTLEMENT_TYPES, BANK_CASINO_BET_TYPES]) +
    canonicalJSON({ outcome: OUTCOME_TAG, bounds: BOUNDS }),
);
/** A wallet checks `protocol` in the casino's `GET /api/config`, and a developer's server `developerProtocol`. */
export function assertProtocol(config: { protocol?: unknown; developerProtocol?: unknown }, developer = false) {
  if (developer ? config?.developerProtocol !== DEVELOPER_PROTOCOL : config?.protocol !== PROTOCOL)
    throw Object.assign(new Error('The casino speaks another revision of the protocol'), { code: 'protocol-mismatch' });
}
