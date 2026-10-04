import type { TypedDataField } from 'ethers';
import type {
  Details,
  GameName,
  Domain,
  Opening,
  Checkpoint,
  Operation,
  Step,
  Evidence,
  EvidenceBundle,
  Integer,
  Json,
  Quote,
  CollateralOffer,
} from './types.ts';
import {
  AbiCoder,
  TypedDataEncoder,
  verifyTypedData,
  getAddress,
  id,
  keccak256,
  ZeroHash,
  ZeroAddress,
  toUtf8Bytes,
} from 'ethers';
import { OUTCOME_SPACE, MAX_BALANCE, admits, uint256 } from './risk.ts';
export const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v));
export const plain = <T>(value: T): Json<T> => JSON.parse(json(value));
export const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const fields = (source: string) =>
  source.split(',').map(f => {
    const [type, name] = f.split(' ');
    return { type, name };
  });
export const MAX_JSON_BYTES = 1_000_000;
// JSON-stable commitment: integer amounts are decimal strings; object order is irrelevant.
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
/** A game's developer settles its game's developer bets, opens its rounds and places its casino bets from its bank,
 * and proves itself with its own key, as an account does on its channel. */
export const DEVELOPER_ACCESS_TYPES = {
  DeveloperAccess: fields('address developer,uint256 expiresAt'),
};
/** A developer settles a developer bet on one of its games: `player` is what the player is paid and `casino` what the
 * casino is given, both from the developer's bank, which took the stake when the bet was placed. `bet` is the hash
 * of the operation that placed the developer bet, which signs its meta. */
export const SETTLEMENT_TYPES = {
  Settlement: fields('bytes32 bet,uint256 player,uint256 casino'),
};
/** A developer's casino bet from its bank, on one of its rounds: settled against the bankroll at once, it reveals the
 * round. Like every casino bet it signs the hash of the seed it brings, so only that seed settles it. `group` is the
 * label its game gives the bets that belong together, and `meta` the hash of its meta, the developer's own JSON,
 * which the casino keeps with the reveal and never reads: whatever the developer commits to there, it committed to
 * before the outcome was revealed. `game` is the one whose commission it earns. A stake, chance and prize of zero
 * bet nothing and only reveal the round. */
export const BANK_CASINO_BET_TYPES = {
  BankCasinoBet: fields(
    'bytes32 round,bytes32 game,uint256 stake,uint64 chance,uint256 prize,string group,bytes32 seedHash,bytes32 meta',
  ),
};
/** The `authorization` header carrying a signed `Access` or `DeveloperAccess` message. */
export const authorization = (message: unknown, signature: string) =>
  'HookedIn ' + btoa(json({ message, signature })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const domain = (chainId: Integer, casino: string) => ({
  name: 'HookedIn',
  version: '1',
  chainId: String(chainId),
  verifyingContract: getAddress(casino),
});
export const hashState = (d: Domain, s: Checkpoint) => TypedDataEncoder.hash(d, STATE_TYPES, s);
export const hashOperation = (d: Domain, s: Operation) => TypedDataEncoder.hash(d, OP_TYPES, s);
/** The key a channel goes by off-chain, and the ID of its close's claim on-chain: an account's first channel has
 * `index` 0, and each one whose close started is followed by the next. Nothing signs it. */
export const channelId = (player: string, index: Integer) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [player, index]));
/** A channel's status on-chain: an account's current channel is active from the start, with nothing to open, and
 * takes play and money until its close starts. */
export const STATUS = { active: 0, closing: 1, finalized: 2 } as const;
/** Whether a channel's balance plays: the channel active, and every deposit the balance took in held on-chain. One a
 * reorganisation took back waits for the money to land again: a close nets out what the chain does not hold, so a bet
 * on it would risk nothing. */
export const playsOn = (
  onchain: { status: Integer; deposited: Integer } | null | undefined,
  state: { deposited: Integer },
) => !!onchain && Number(onchain.status) === STATUS.active && BigInt(state.deposited) <= BigInt(onchain.deposited);
/** Wire terms as exact integers: a stake, the bet's chance out of 2^64 and the prize it pays. */
export const betTerms = (stake: Integer, chance: Integer, prize: Integer) => ({
  stake: BigInt(stake),
  chance: BigInt(chance),
  prize: BigInt(prize),
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
export const hashRedeem = (d: Domain, s: { holder: string; shares: Integer; sequence: Integer }) =>
  TypedDataEncoder.hash(d, REDEEM_TYPES, s);
/** A developer's bank: the developer's money at the casino. Every developer bet on the developer's games pays its
 * stake into it, and it pays the settlements and the casino bets the developer's key signs. A deposit is a debit that
 * names it, from the developer's own channel, answered with a statement of the balance; money leaves it only by the
 * developer's own signed `BankWithdraw`, settlement or casino bet. */
export const BANK_ID = id('HOOKEDIN/BANK');
/** The characters a uname is written in: no `l`, `0`, `1` or `u`, so no two of them read alike. */
export const UNAME_ALPHABET = '23456789abcdefghijkmnopqrstvwxyz';
export const UNAME_LENGTH = 24;
/** A player's uname, which the casino derives from their address. */
export const UNAME = new RegExp(`^[${UNAME_ALPHABET}]{${UNAME_LENGTH}}$`);
/** Another player as a counterparty: their uname, written `~uname`. A debit that pays another player names them, and
 * the credit that player collects it with names the player it came from. */
const PLAYER = new RegExp(`^~[${UNAME_ALPHABET}]{${UNAME_LENGTH}}$`);
/** The uname of the player a counterparty names, or null for any other counterparty. */
export const counterpartyPlayer = (counterparty: unknown) =>
  typeof counterparty === 'string' && PLAYER.test(counterparty) ? counterparty.slice(1) : null;
/** The casino signs the balance of a developer's bank after every deposit and withdrawal. `cause` is the hash of the
 * developer's signed deposit or `BankWithdraw`. */
export const BANK_TYPES = {
  BankStatement: fields('address developer,uint256 sequence,uint256 balance,bytes32 cause'),
};
/** A developer takes money out of their bank. `sequence` is the statement it will produce, so it works once. */
export const BANK_WITHDRAW_TYPES = {
  BankWithdraw: fields('address developer,uint256 amount,uint256 sequence'),
};
export const hashBankWithdraw = (d: Domain, s: { developer: string; amount: Integer; sequence: Integer }) =>
  TypedDataEncoder.hash(d, BANK_WITHDRAW_TYPES, s);
/** Shares bought by `amount` when the fund holds `equity` for `totalShares`. The first shares cost one wei each. */
export function sharesFor(amount: Integer, equity: Integer, totalShares: Integer) {
  if (BigInt(amount) <= 0n) throw new Error('Invalid investment');
  if (BigInt(totalShares) === 0n) return BigInt(amount);
  if (BigInt(equity) <= 0n) throw new Error('The bankroll is not open to investment');
  return (BigInt(amount) * BigInt(totalShares)) / BigInt(equity);
}
/** What `shares` are worth when the fund holds `equity` for `totalShares`, rounded down. */
export function valueOf(shares: Integer, equity: Integer, totalShares: Integer) {
  if (BigInt(shares) < 0n || BigInt(shares) > BigInt(totalShares)) throw new Error('Invalid shares');
  return BigInt(totalShares) === 0n || BigInt(equity) <= 0n
    ? 0n
    : (BigInt(shares) * BigInt(equity)) / BigInt(totalShares);
}
/** A statement follows the holder's last one and states exactly what the price implies. `burned`
 * is set for a redemption and absent for an investment. Returns the shares it moved. */
export function verifyShareStatement(
  d: Domain,
  { message, signature }: { message: any; signature: string },
  operator: string,
  expected: {
    holder: string;
    previous: { sequence: Integer; shares: Integer };
    cause: string;
    amount?: Integer;
    burned?: Integer;
  },
) {
  assertSignature(d, SHARE_TYPES, message, signature, operator);
  if (
    !same(message.holder, expected.holder) ||
    BigInt(message.sequence) !== BigInt(expected.previous.sequence) + 1n ||
    !same(message.cause, expected.cause)
  )
    throw new Error('Share statement does not follow this holding');
  const before = BigInt(expected.previous.shares);
  if (expected.burned === undefined) {
    const minted = sharesFor(message.amount, message.equity, message.totalShares);
    if (BigInt(message.amount) !== BigInt(expected.amount!) || BigInt(message.shares) !== before + minted)
      throw new Error('Share statement does not match the investment');
    return minted;
  }
  const burned = BigInt(expected.burned);
  if (
    BigInt(message.shares) !== before - burned ||
    BigInt(message.amount) !== valueOf(burned, message.equity, message.totalShares)
  )
    throw new Error('Share statement does not match the redemption');
  return burned;
}
/** A signature in the one form the contract recovers: 65 bytes, v 27 or 28. ethers recovers a compact one or a v of 0
 * or 1 as well, and each side keeps the other's signatures as they came, as its evidence. */
export function assertSignature(
  d: Domain,
  types: Record<string, TypedDataField[]>,
  message: Record<string, any>,
  signature: string,
  expected: string,
) {
  if (!/^0x[0-9a-f]{128}1[bc]$/i.test(signature) || !same(verifyTypedData(d, types, message, signature), expected))
    throw new Error('Invalid signature');
}
/** The checkpoint a channel starts from: all zero but its account and index. The contract takes it with no signature. */
export function baseState(player: string, index: Integer): Checkpoint {
  return {
    player: getAddress(player),
    index: String(index),
    sequence: '0',
    previousStateHash: ZeroHash,
    transitionHash: ZeroHash,
    balance: '0',
    deposited: '0',
    withdrawn: '0',
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
  deposited: Integer,
  claimed: Integer,
) {
  const due = BigInt(state.balance) + BigInt(deposited) + BigInt(state.withdrawn),
    taken = BigInt(state.deposited) + BigInt(claimed);
  return due > taken ? due - taken : 0n;
}
/** The deposits of `principal`, those a channel still holds, that the contract pays a withdrawal out of when its
 * checkpoint took in `deposited` of the channel's `deposited`: a deposit it did not take in stays the channel's. */
export function depositsTakenIn(channel: { deposited: Integer }, principal: bigint, deposited: Integer) {
  const deposits = principal + BigInt(deposited) - BigInt(channel.deposited);
  return deposits < 0n ? 0n : deposits > principal ? principal : deposits;
}
/** A channel's deposits and collateral once the contract has recorded `withdrawals`, those it owes, each with the
 * `deposited` of its checkpoint, in the order they were signed, and what they take of house cash: each is paid out of
 * the deposits its checkpoint took in, then the collateral, and the rest out of house cash. What a lock-in pays goes
 * back into the account's current channel as deposits, which this leaves out: no checkpoint before it took
 * them in. */
export function recordWithdrawals(
  channel: { deposited: Integer; principal: Integer; collateral: Integer },
  withdrawals: { amount: Integer; deposited: Integer }[],
) {
  let principal = BigInt(channel.principal),
    collateral = BigInt(channel.collateral),
    cash = 0n;
  for (const withdrawal of withdrawals) {
    const amount = BigInt(withdrawal.amount),
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
  channel: { deposited: Integer; principal: Integer; collateral: Integer },
  withdrawals: { amount: Integer; deposited: Integer }[],
) {
  const left = recordWithdrawals(channel, withdrawals),
    held = left.principal + left.collateral,
    arriving = BigInt(channel.deposited) - BigInt(state.deposited),
    balance = BigInt(state.balance) + (arriving > 0n ? arriving : 0n),
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
export const withdrawalRecorded = (claimed: Integer, evidence: Evidence) =>
  BigInt(claimed) > BigInt(evidence.base.withdrawn);
export function operation(d: Domain, base: Checkpoint, values: Partial<Operation>) {
  return plain({
    previousStateHash: hashState(d, base),
    kind: 0,
    amount: 0,
    recipient: ZeroAddress,
    fee: 0,
    chance: 0n,
    prize: 0n,
    round: ZeroHash,
    seedHash: ZeroHash,
    memo: ZeroHash,
    ...values,
  });
}
/** A quote the casino signed for the casino bet that follows `state`. */
export function verifyQuote(d: Domain, quote: Quote, state: Checkpoint, operator: string) {
  assertSignature(d, QUOTE_TYPES, quote?.message, quote?.signature, operator);
  const { previousStateHash, round, virtualBankroll } = quote.message;
  if (!same(previousStateHash, hashState(d, state)) || same(round, ZeroHash) || BigInt(virtualBankroll) >= MAX_BALANCE)
    throw new Error('The quote is not for this checkpoint');
  return quote;
}
/** Whether `quote` covers the casino bet `op` at `now`, in seconds: it names the bet's checkpoint and round, has not
 * expired, and its virtual bankroll admits the bet's terms. The contract checks the same when the bet is disputed. */
export const covers = (quote: Quote, op: Operation, now: number) =>
  Number(op.kind) === KIND.casinoBet &&
  same(quote.message.previousStateHash, op.previousStateHash) &&
  same(quote.message.round, op.round) &&
  BigInt(quote.message.expiresAt) >= BigInt(now) &&
  admits(BigInt(quote.message.virtualBankroll), betTerms(op.amount, op.chance, op.prize));
/** A collateral offer the casino signed for `amount` on the channel `opening` names, at the price its `rate` gives. */
export function verifyOffer(
  d: Domain,
  offer: CollateralOffer,
  opening: Pick<Opening, 'player' | 'index'>,
  amount: bigint,
  rate: bigint,
  operator: string,
) {
  assertSignature(d, OFFER_TYPES, offer?.message, offer?.signature, operator);
  const { message } = offer;
  if (
    !same(message.player, opening.player) ||
    BigInt(message.index) !== BigInt(opening.index) ||
    BigInt(message.amount) !== amount
  )
    throw new Error('The offer is not for this collateral');
  if (BigInt(message.price) !== collateralPrice(amount, rate)) throw new Error("The casino's offer is not at its rate");
  return offer;
}
/** What the contract takes of an offer to buy it, the price being what the buyer pays. */
export const offerTerms = ({ message, signature }: CollateralOffer) => [
  message.player,
  String(message.index),
  String(message.amount),
  String(message.expiresAt),
  signature,
];
/** What the contract takes of a quote when a bet is disputed: the operation names its checkpoint and round. */
export const quoteTerms = (quote: Quote) => ({
  virtualBankroll: String(quote.message.virtualBankroll),
  expiresAt: String(quote.message.expiresAt),
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
/** A game's key: the one value its bets, its commission and its public record are kept under, made from its
 * developer and the name they publish it under, so it is the same wherever the game is served. A game opened by
 * its URL alone has the key of the zero address and that URL. */
export const gameKey = ({ developer, name }: GameName) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'string'], [developer, name]));
export const memo = (details: Details) => hashJSON(details);
const bytes32Pattern = /^0x[0-9a-f]{64}$/;
/** The longest group label a bet or a payment carries. */
export const MAX_GROUP = 64;
/** The most a bet's meta takes, as canonical JSON. */
export const MAX_META_BYTES = 4096;
/** The most developer bets one request settles, and one page lists. */
export const MAX_DEVELOPER_BETS = 256;
/** The most payouts one reply lists. A wallet collects them, and the next reply lists the rest. */
export const MAX_PAYOUTS = 256;
/** Every bound a bet is held to, as the wallet reports it to a game and the casino to a developer. They are part
 * of the protocol revision, so a wallet or a developer that holds other ones stops before it signs anything. */
export const BOUNDS = {
  /** The size of the space a round's outcome and a bet's chance are counted in, as a decimal string. */
  outcomeSpace: String(OUTCOME_SPACE),
  /** The most a bet's meta takes as canonical JSON, and the longest group label. */
  meta: MAX_META_BYTES,
  group: MAX_GROUP,
};
/** The one shape details have for each kind: a casino bet names its game; a debit its game (a payment, or a
 * developer bet, whose meta alone says what it is) or what it pays into (an investment, a bank deposit or another
 * player); a credit what it collects from; a deposit, a withdrawal and a lock-in nothing but themselves, a withdrawal's
 * recipient being in the operation. Only what names a game carries a group. Every field
 * is in one form, so one meaning has one memo. */
export function checkDetails(kind: number, details: Details) {
  const { game, group, meta } = details ?? {},
    keys = details && typeof details === 'object' ? Object.keys(details) : [];
  const named = typeof game === 'string' && bytes32Pattern.test(game);
  const counterparty =
    typeof details?.counterparty === 'string' &&
    (bytes32Pattern.test(details.counterparty) || counterpartyPlayer(details.counterparty) !== null);
  if (
    !keys.every(key => ['id', 'game', 'group', 'counterparty', 'meta'].includes(key)) ||
    typeof details.id !== 'string' ||
    !bytes32Pattern.test(details.id) ||
    (game !== undefined && !named) ||
    (details.counterparty !== undefined && !counterparty) ||
    (group !== undefined && (!named || typeof group !== 'string' || !group.length || group.length > MAX_GROUP)) ||
    (meta !== undefined && (!named || !validMeta(meta))) ||
    !(kind === KIND.casinoBet
      ? named && !counterparty && meta === undefined
      : kind === KIND.debit
        ? named !== counterparty
        : kind === KIND.credit
          ? counterparty && !named
          : [KIND.deposit, KIND.withdrawal, KIND.lockIn].includes(kind as 4) && !counterparty && !named)
  )
    throw Object.assign(new Error('Invalid operation details'), { code: 'invalid' });
}
const decimal = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
/** A casino bet's terms in their one form: decimal strings, a stake and a prize below 2^96 and a chance of 1 to
 * 2^64 − 1 outcomes. */
export function validBet(stake: unknown, chance: unknown, prize: unknown) {
  return (
    [stake, chance, prize].every(decimal) &&
    BigInt(stake as string) > 0n &&
    BigInt(stake as string) < MAX_BALANCE &&
    BigInt(chance as string) > 0n &&
    BigInt(chance as string) < OUTCOME_SPACE &&
    BigInt(prize as string) > 0n &&
    BigInt(prize as string) < MAX_BALANCE
  );
}
/** Meta in its one form, a developer bet's and a developer's casino bet's alike: a JSON object of up to
 * `MAX_META_BYTES` of canonical JSON, whose numbers are whole. The casino keeps it and never reads it. */
export function validMeta(meta: unknown): meta is Record<string, unknown> {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false;
  try {
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
/** What a casino bet pays on an outcome: its prize when the outcome is below its chance, and nothing otherwise. The
 * stake was paid to enter. */
export const betPayout = (bet: { chance: Integer; prize: Integer }, value: bigint) =>
  value < BigInt(bet.chance) ? BigInt(bet.prize) : 0n;
/** What an operation does to the balance. Every signed operation names one of these. A casino bet settles in
 * the operation itself; a developer bet is a debit that pays its stake to its developer's bank; a deposit takes in
 * money the player deposited into the channel on-chain; a withdrawal takes out what the contract owes its recipient,
 * and a lock-in what it puts into the account's current channel as deposits, each paying the casino its fee for
 * sending it. */
export const KIND = {
  none: 0,
  casinoBet: 1,
  debit: 2,
  credit: 3,
  deposit: 4,
  withdrawal: 5,
  lockIn: 6,
} as const;
export function deriveState(d: Domain, base: Checkpoint, op: Operation, secret = ZeroHash, seed = ZeroHash) {
  if (!same(hashState(d, base), op.previousStateHash)) throw new Error('Operation is not next in this channel');
  const next = {
    ...base,
    sequence: String(BigInt(base.sequence) + 1n),
    previousStateHash: hashState(d, base),
    transitionHash: keccak256(
      AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [hashOperation(d, op), secret]),
    ),
  };
  const kind = Number(op.kind),
    balance = uint256(BigInt(base.balance)),
    amount = uint256(BigInt(op.amount)),
    fee = uint256(BigInt(op.fee));
  const casinoBet = kind === KIND.casinoBet,
    credit = kind === KIND.credit,
    deposit = kind === KIND.deposit,
    withdrawal = kind === KIND.withdrawal,
    pays = withdrawal || kind === KIND.lockIn;
  if (!Object.values(KIND).includes(kind as 1) || kind === KIND.none) throw new Error('Unknown operation');
  // Every field a kind does not use must be zero: one meaning, one encoding. A casino bet names its
  // round, the hash of a secret the casino fixed first, and the hash of its seed; only those two settle it.
  const chance = BigInt(op.chance),
    prize = BigInt(op.prize);
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
    next.balance = String(balance + amount);
    // A deposit takes in money the contract holds for this channel; a close checks it does.
    if (deposit) next.deposited = String(BigInt(base.deposited) + amount);
  } else {
    // A withdrawal or a lock-in pays its fee as well.
    if (amount + fee > balance)
      throw new Error(casinoBet ? 'Invalid casino bet commitment or balance' : 'Insufficient balance');
    next.balance = String(balance - amount - fee + (casinoBet ? betPayout(op, outcome(seed, secret).value) : 0n));
    // A withdrawal counts what it takes out, so a close can tell what never became a claim.
    if (pays) next.withdrawn = String(BigInt(base.withdrawn) + amount);
  }
  if ([next.balance, next.deposited, next.withdrawn].some(amount => BigInt(amount) >= MAX_BALANCE))
    throw new Error('Balance exceeds the protocol maximum');
  return next;
}
/** A joint checkpoint above an authorized casino bet, debit, withdrawal or lock-in supersedes it without
 * consuming entropy or money. */
export function rejectionCheckpoint(d: Domain, base: Checkpoint, op: Operation): Checkpoint {
  if (
    ![KIND.casinoBet, KIND.debit, KIND.withdrawal, KIND.lockIn].includes(Number(op.kind) as 1) ||
    !same(op.previousStateHash, hashState(d, base))
  )
    throw new Error('Rejection must identify the next casino bet, debit, withdrawal or lock-in');
  return {
    ...base,
    sequence: String(uint256(BigInt(base.sequence) + 2n)),
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
    kind: 0,
    amount: 0,
    recipient: ZeroAddress,
    fee: 0,
    chance: 0,
    prize: 0,
    round: ZeroHash,
    seedHash: ZeroHash,
    memo: ZeroHash,
  },
  authorization: '0x',
  seed: ZeroHash,
  secret: ZeroHash,
  casinoSignature: '0x',
});
const isEmptyStep = (d: Domain, step: Step) =>
  step.authorization === '0x' &&
  step.casinoSignature === '0x' &&
  same(step.secret, ZeroHash) &&
  same(step.seed, ZeroHash) &&
  same(hashOperation(d, step.operation), hashOperation(d, emptyStep().operation));
export function checkpointEvidence(state: Checkpoint, playerSignature = '0x', casinoSignature = '0x'): Evidence {
  return { base: state, playerSignature, casinoSignature, step: emptyStep() };
}
/** The checkpoint a bundle proves, once every signature in it checks out. Its base names its channel: the account,
 * which signs for it, and the index. */
export function verifyEvidence(bundle: EvidenceBundle): { state: Checkpoint } {
  const d = domain(bundle.chainId, bundle.casino),
    { operator, evidence } = bundle,
    player = evidence.base.player;
  if (!/^0x[0-9a-fA-F]{40}$/.test(player) || same(player, ZeroAddress)) throw new Error('Evidence names no account');
  // The channel's base needs no signature.
  if (!unsignedBase(d, evidence)) {
    assertSignature(d, STATE_TYPES, evidence.base, evidence.playerSignature, player);
    assertSignature(d, STATE_TYPES, evidence.base, evidence.casinoSignature, operator);
  }
  // A checkpoint-only proof carries the canonical empty step: one meaning, one encoding.
  if (!Number(evidence.step.operation.kind) && !isEmptyStep(d, evidence.step))
    throw new Error('Checkpoint evidence must carry an empty step');
  const state = Number(evidence.step.operation.kind)
    ? verifyStep(d, evidence.base, evidence.step, player, operator)
    : evidence.base;
  if ([state.balance, state.deposited, state.withdrawn].some(amount => BigInt(amount) >= MAX_BALANCE))
    throw new Error('Balance exceeds the protocol maximum');
  // The details beside a step say what it meant, and are only as good as the memo it signed.
  if (bundle.details !== undefined && !same(memo(bundle.details), evidence.step.operation.memo))
    throw new Error('Details differ from the operation they describe');
  // A casino bet the casino has not settled follows the checkpoint itself: the account signed it with its seed, on the
  // casino's quote for that checkpoint and its round.
  if (bundle.dispute !== undefined) {
    const { step, quote } = bundle.dispute,
      op = step.operation;
    if (
      Number(evidence.step.operation.kind) ||
      Number(op.kind) !== KIND.casinoBet ||
      !same(op.previousStateHash, hashState(d, state)) ||
      !same(seedHash(step.seed), op.seedHash) ||
      !same(step.secret, ZeroHash) ||
      step.casinoSignature !== '0x' ||
      !same(quote.message.previousStateHash, op.previousStateHash) ||
      !same(quote.message.round, op.round)
    )
      throw new Error('The disputed bet does not follow the checkpoint');
    assertSignature(d, OP_TYPES, op, step.authorization, player);
    assertSignature(d, QUOTE_TYPES, quote.message, quote.signature, operator);
  }
  return { state };
}
/** A developer's commission. It accrues to the developer's address, the developer's own channel shows
 * what that address has earned and collected, and it is collected like redeemed shares: a credit that
 * names this as its counterparty, signed by the developer's account. */
export const DEVELOPER_ID = id('HOOKEDIN/DEVELOPER');
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
    DEVELOPER_ACCESS_TYPES,
    SETTLEMENT_TYPES,
    BANK_CASINO_BET_TYPES,
    SHARE_TYPES,
    FUND_TYPES,
    REDEEM_TYPES,
    BANK_TYPES,
    BANK_WITHDRAW_TYPES,
  ]) +
    canonicalJSON({
      kinds: KIND,
      outcome: OUTCOME_TAG,
      counterparties: {
        fund: FUND_ID,
        bank: BANK_ID,
        developer: DEVELOPER_ID,
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
