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
import { OUTCOME_SPACE, MAX_BALANCE, uint256 } from './risk.ts';
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
    'bytes32 channelId,uint256 sequence,bytes32 previousStateHash,bytes32 transitionHash,uint256 balance',
  ),
};
export const OP_TYPES = {
  Operation: fields(
    'bytes32 channelId,bytes32 previousStateHash,uint256 sequence,uint256 kind,uint256 amount,uint64 chance,uint256 prize,bytes32 round,bytes32 seedHash,bytes32 memo',
  ),
};
export const CLOSE_TYPES = {
  Close: fields('bytes32 channelId,bytes32 stateHash'),
};
export const ACCESS_TYPES = {
  Access: fields('bytes32 channelId,uint256 expiresAt'),
};
/** A game's developer settles its game's developer bets, opens its rounds and places its casino bets from its bank,
 * and proves itself with its own key, as a channel does with its signer. */
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
export const channelId = (player: string, signer: string, deposit: Integer) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint256'], [player, signer, deposit]));
export function validateOpening(opening: Opening) {
  if (
    opening.channelId !== channelId(opening.player, opening.signer, opening.deposit) ||
    same(opening.signer, ZeroAddress) ||
    same(opening.player, ZeroAddress) ||
    BigInt(opening.deposit) <= 0n ||
    BigInt(opening.deposit) >= MAX_BALANCE
  )
    throw new Error('Invalid channel opening');
}
/** Wire terms as exact integers: a stake, the bet's chance out of 2^64 and the prize it pays. */
export const betTerms = (stake: Integer, chance: Integer, prize: Integer) => ({
  stake: BigInt(stake),
  chance: BigInt(chance),
  prize: BigInt(prize),
});
/** The bankroll fund. Investing is a debit that names it as its counterparty, and divesting a credit
 * from it. An investor trusts the casino completely: a share is its promise of a part of the
 * bankroll, not protected principal. */
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
 * developer's own signed `Withdraw`, settlement or casino bet. */
export const BANK_ID = id('HOOKEDIN/BANK');
/** The casino signs the balance of a developer's bank after every deposit and withdrawal. `cause` is the hash of the
 * developer's signed deposit or `Withdraw`. */
export const BANK_TYPES = {
  BankStatement: fields('address developer,uint256 sequence,uint256 balance,bytes32 cause'),
};
/** A developer takes money out of their bank. `sequence` is the statement it will produce, so it works once. */
export const WITHDRAW_TYPES = {
  Withdraw: fields('address developer,uint256 amount,uint256 sequence'),
};
export const hashWithdraw = (d: Domain, s: { developer: string; amount: Integer; sequence: Integer }) =>
  TypedDataEncoder.hash(d, WITHDRAW_TYPES, s);
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
export const hashClose = (d: Domain, s: { channelId: string; stateHash: string }) =>
  TypedDataEncoder.hash(d, CLOSE_TYPES, s);
export function assertSignature(
  d: Domain,
  types: Record<string, TypedDataField[]>,
  message: Record<string, any>,
  signature: string,
  expected: string,
) {
  if (!same(verifyTypedData(d, types, message, signature), expected)) throw new Error('Invalid signature');
}
export function initialState(opening: Pick<Opening, 'channelId' | 'deposit'>) {
  return {
    channelId: opening.channelId,
    sequence: '0',
    previousStateHash: ZeroHash,
    transitionHash: ZeroHash,
    balance: String(opening.deposit),
  };
}
export function operation(d: Domain, base: Checkpoint, values: Partial<Operation>) {
  return plain({
    channelId: base.channelId,
    previousStateHash: hashState(d, base),
    sequence: BigInt(base.sequence) + 1n,
    kind: 0,
    amount: 0,
    chance: 0n,
    prize: 0n,
    round: ZeroHash,
    seedHash: ZeroHash,
    memo: ZeroHash,
    ...values,
  });
}
/** A game's key: the one value its bets, its commission and its public record are kept under, made from its
 * developer and the name they publish it under, so it is the same wherever the game is served. A game loaded
 * straight from its manifest has the key of its manifest's developer and URL. */
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
export const LIMITS = {
  /** The size of the space a round's outcome and a bet's chance are counted in, as a decimal string. */
  outcomeSpace: String(OUTCOME_SPACE),
  /** The most a bet's meta takes as canonical JSON, and the longest group label. */
  meta: MAX_META_BYTES,
  group: MAX_GROUP,
};
/** The one shape details have for each kind: a casino bet names its game; a debit its game (a payment, or a
 * developer bet, whose meta alone says what it is) or what it pays into (an investment, a bank deposit); a credit
 * what it collects from. Only what names a game carries a group. Every field is in one form, so one meaning has
 * one memo. */
export function checkDetails(kind: number, details: Details) {
  const { game, group, meta } = details ?? {},
    keys = details && typeof details === 'object' ? Object.keys(details) : [];
  const named = typeof game === 'string' && bytes32Pattern.test(game);
  const counterparty = typeof details?.counterparty === 'string' && bytes32Pattern.test(details.counterparty);
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
        : kind === KIND.credit && counterparty && !named)
  )
    throw Object.assign(new Error('Invalid operation details'), { code: 'invalid' });
}
const decimal = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
/** A casino bet's terms in their one form: decimal strings, a stake and a prize below 2^128 and a chance of 1 to
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
 * the operation itself; a developer bet is a debit that pays its stake to its developer's bank. */
export const KIND = { none: 0, casinoBet: 1, debit: 2, credit: 3 } as const;
export function deriveState(d: Domain, base: Checkpoint, op: Operation, secret = ZeroHash, seed = ZeroHash) {
  if (
    !same(base.channelId, op.channelId) ||
    !same(hashState(d, base), op.previousStateHash) ||
    BigInt(op.sequence) !== BigInt(base.sequence) + 1n
  )
    throw new Error('Operation is not next in this channel');
  const next = {
    ...base,
    sequence: String(op.sequence),
    previousStateHash: hashState(d, base),
    transitionHash: keccak256(
      AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [hashOperation(d, op), secret]),
    ),
  };
  const kind = Number(op.kind),
    balance = uint256(BigInt(base.balance)),
    amount = uint256(BigInt(op.amount));
  const casinoBet = kind === KIND.casinoBet,
    credit = kind === KIND.credit;
  if (![KIND.casinoBet, KIND.debit, KIND.credit].includes(kind as 1)) throw new Error('Unknown operation');
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
    amount === 0n ||
    amount >= MAX_BALANCE
  )
    throw new Error(
      casinoBet ? 'Invalid casino bet commitment or balance' : credit ? 'Invalid credit' : 'Invalid debit',
    );
  if (credit) next.balance = String(balance + amount);
  else {
    if (amount > balance)
      throw new Error(casinoBet ? 'Invalid casino bet commitment or balance' : 'Insufficient balance');
    next.balance = String(balance - amount + (casinoBet ? betPayout(op, outcome(seed, secret).value) : 0n));
  }
  if (BigInt(next.balance) >= MAX_BALANCE) throw new Error('Balance exceeds the protocol maximum');
  return next;
}
/** A joint checkpoint above an authorized casino bet or debit supersedes it without consuming entropy or money. */
export function rejectionCheckpoint(d: Domain, base: Checkpoint, op: Operation): Checkpoint {
  if (
    ![KIND.casinoBet, KIND.debit].includes(Number(op.kind) as 1) ||
    !same(op.channelId, base.channelId) ||
    !same(op.previousStateHash, hashState(d, base)) ||
    BigInt(op.sequence) !== BigInt(base.sequence) + 1n
  )
    throw new Error('Rejection must identify the next casino bet or debit');
  return {
    ...base,
    sequence: String(uint256(BigInt(op.sequence) + 1n)),
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
export const emptyStep = (): Step => ({
  operation: {
    channelId: ZeroHash,
    previousStateHash: ZeroHash,
    sequence: 0,
    kind: 0,
    amount: 0,
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
export const isEmptyStep = (d: Domain, step: Step) =>
  step.authorization === '0x' &&
  step.casinoSignature === '0x' &&
  same(step.secret, ZeroHash) &&
  same(step.seed, ZeroHash) &&
  same(hashOperation(d, step.operation), hashOperation(d, emptyStep().operation));
export function checkpointEvidence(state: Checkpoint, playerSignature = '0x', casinoSignature = '0x'): Evidence {
  return { base: state, playerSignature, casinoSignature, step: emptyStep() };
}
export function verifyEvidence(bundle: EvidenceBundle): {
  state: Checkpoint;
  signaturesValid: boolean;
  chainObservationsVerified: boolean;
  limitation: string;
} {
  const d = domain(bundle.chainId, bundle.casino),
    { opening, operator, evidence } = bundle;
  validateOpening(opening);
  if (!same(evidence.base.channelId, opening.channelId)) throw new Error('Evidence channel differs');
  if (!same(hashState(d, evidence.base), hashState(d, initialState(opening)))) {
    assertSignature(d, STATE_TYPES, evidence.base, evidence.playerSignature, opening.signer);
    assertSignature(d, STATE_TYPES, evidence.base, evidence.casinoSignature, operator);
  }
  // A checkpoint-only proof carries the canonical empty step: one meaning, one encoding.
  if (!Number(evidence.step.operation.kind) && !isEmptyStep(d, evidence.step))
    throw new Error('Checkpoint evidence must carry an empty step');
  const state = Number(evidence.step.operation.kind)
    ? verifyStep(d, evidence.base, evidence.step, opening.signer, operator)
    : evidence.base;
  // The details beside a step say what it meant, and are only as good as the memo it signed.
  if (bundle.details !== undefined && !same(memo(bundle.details), evidence.step.operation.memo))
    throw new Error('Details differ from the operation they describe');
  return {
    state,
    signaturesValid: true,
    chainObservationsVerified: false,
    limitation:
      'Opening identity and deposit require independent on-chain verification. A signed balance is a claim on the shared bankroll. Only a finalized on-chain claim establishes payment due. Inspect payments and remaining debt through an independent RPC.',
  };
}
/** A developer's commission. It accrues to the developer's address, the developer's own channel shows
 * what that address has earned and collected, and it is collected like redeemed shares: a credit that
 * names this as its counterparty, signed by the key of that channel. */
export const DEVELOPER_ID = id('HOOKEDIN/DEVELOPER');
const encoded = (all: Record<string, TypedDataField[]>[]) =>
  all.map(types => TypedDataEncoder.from(types).encodeType(Object.keys(types)[0])).join('');
/** One value for the whole protocol a wallet shares with the casino: every typed structure, and every rule the
 * two apply alike, from the operation kinds and what names an outcome or a counterparty to every limit. A wallet
 * built against another revision learns so from `GET /api/config` before it signs anything. */
export const PROTOCOL = id(
  encoded([
    STATE_TYPES,
    OP_TYPES,
    CLOSE_TYPES,
    ACCESS_TYPES,
    DEVELOPER_ACCESS_TYPES,
    SETTLEMENT_TYPES,
    BANK_CASINO_BET_TYPES,
    SHARE_TYPES,
    FUND_TYPES,
    REDEEM_TYPES,
    BANK_TYPES,
    WITHDRAW_TYPES,
  ]) +
    canonicalJSON({
      kinds: KIND,
      outcome: OUTCOME_TAG,
      counterparties: { fund: FUND_ID, bank: BANK_ID, developer: DEVELOPER_ID },
      limits: LIMITS,
    }),
);
/** What a developer's server shares with the casino, and nothing more: the three structures it signs, the outcome
 * and the limits. A change to what only a wallet signs leaves it alone, so it does not stop every developer. */
export const DEVELOPER_PROTOCOL = id(
  encoded([DEVELOPER_ACCESS_TYPES, SETTLEMENT_TYPES, BANK_CASINO_BET_TYPES]) +
    canonicalJSON({ outcome: OUTCOME_TAG, limits: LIMITS }),
);
/** A wallet checks `protocol` in the casino's `GET /api/config`, and a developer's server `developerProtocol`. */
export function assertProtocol(config: { protocol?: unknown; developerProtocol?: unknown }, developer = false) {
  if (developer ? config?.developerProtocol !== DEVELOPER_PROTOCOL : config?.protocol !== PROTOCOL)
    throw Object.assign(new Error('The casino speaks another revision of the protocol'), { code: 'protocol-mismatch' });
}
