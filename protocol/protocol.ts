import type { TypedDataField } from 'ethers';
import type {
  Domain,
  Opening,
  Checkpoint,
  Operation,
  Step,
  Evidence,
  EvidenceBundle,
  Integer,
  Json,
  Prize,
  Settlement,
  TableSeat,
  TableTerms,
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
import { WORD_SPACE, MAX_BALANCE, MAX_PRIZES, uint256 } from './risk.ts';
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
    'bytes32 channelId,bytes32 previousStateHash,uint256 sequence,uint256 kind,uint256 amount,Prize[] prizes,bytes32 seed,bytes32 roundHead,bytes32 operationId,address developer,bytes32 counterparty',
  ),
  Prize: fields('uint256 rangeStart,uint256 rangeEnd,uint256 payout'),
};
/** A table: players buy in against each other, the casino holds the pot, and the host they all
 * named pays it out. A buy-in is a transfer whose counterparty is the table's ID. */
export const TABLE_TYPES = {
  Table: fields('address host,address developer,uint256 expiresAt,bytes32 nonce'),
};
/** The host pays players out of the pot, and takes `rake` for the developer and the casino.
 * Settlements are numbered from zero, so each applies exactly once. */
export const SETTLEMENT_TYPES = {
  Settlement: fields('bytes32 tableId,uint256 sequence,Payment[] payments,uint256 rake'),
  Payment: fields('address player,uint256 amount'),
};
/** Most payments one settlement holds. */
export const MAX_PAYMENTS = 32;
/** A wallet tells a game's own server who is playing: the channel key signs the page's origin, which
 * the wallet knows for itself, and the server's nonce. It authorizes nothing at the casino. */
export const IDENTITY_TYPES = {
  Identity: fields('bytes32 channelId,string origin,bytes32 nonce,uint256 expiresAt'),
};
export const CLOSE_TYPES = {
  Close: fields('bytes32 channelId,bytes32 stateHash'),
};
export const ACCESS_TYPES = {
  Access: fields('bytes32 channelId,uint256 expiresAt'),
};
/** A hash chain belongs to an address: a channel's signer for its own bets, or the key of whoever
 * hosts rounds. Only that key asks for its next head or settles anything against it. */
export const CHAIN_ACCESS_TYPES = {
  ChainAccess: fields('address owner,uint256 expiresAt'),
};
/** The `authorization` header carrying a signed `Access` or `ChainAccess` message. */
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
/** A game's server checks who is playing: the origin is its own page's, the nonce the one it issued,
 * and the token still valid. Returns the key that signed, to be matched against the `signer` the
 * casino reports for a seat of the server's table. */
export function identitySigner(
  d: Domain,
  { message, signature }: { message: Record<string, any>; signature: string },
  expected: { origin: string; nonce: string; now?: number },
) {
  if (
    message?.origin !== expected.origin ||
    !same(message.nonce, expected.nonce) ||
    BigInt(message.expiresAt) * 1000n <= BigInt(expected.now ?? Date.now())
  )
    throw new Error('Identity is not for this game');
  return verifyTypedData(d, IDENTITY_TYPES, message, signature);
}
/** Every buy-in signs this as its counterparty, so one signature binds the host, the developer and the deadline. */
export const tableId = (d: Domain, terms: TableTerms) => TypedDataEncoder.hash(d, TABLE_TYPES, terms);
/** Wire terms as exact integers: a stake and the prizes it can pay. */
export const betTerms = (stake: Integer, prizes: Prize[]) => ({
  stake: BigInt(stake),
  prizes: (Array.isArray(prizes) ? prizes : []).map(prize => ({
    rangeStart: BigInt(prize.rangeStart),
    rangeEnd: BigInt(prize.rangeEnd),
    payout: BigInt(prize.payout),
  })),
});
export function validateTable(terms: TableTerms) {
  if (
    !terms ||
    same(getAddress(terms.host), ZeroAddress) ||
    same(getAddress(terms.developer), ZeroAddress) ||
    !/^0x[0-9a-fA-F]{64}$/.test(terms.nonce) ||
    BigInt(terms.expiresAt) <= 0n
  )
    throw new Error('Invalid table terms');
}
/** The shape of a settlement; returns what it takes from the pot. Whether the pot holds that much,
 * and whether every player bought in, is for whoever knows the table. */
export function validateSettlement(settlement: Settlement) {
  const payments = settlement?.payments;
  if (
    !settlement ||
    !/^0x[0-9a-fA-F]{64}$/.test(settlement.tableId) ||
    BigInt(settlement.sequence) < 0n ||
    !Array.isArray(payments) ||
    payments.length > MAX_PAYMENTS ||
    new Set(payments.map(payment => getAddress(payment.player))).size !== payments.length ||
    payments.some(payment => BigInt(payment.amount) <= 0n || BigInt(payment.amount) >= MAX_BALANCE) ||
    BigInt(settlement.rake) < 0n ||
    BigInt(settlement.rake) >= MAX_BALANCE ||
    (!payments.length && !BigInt(settlement.rake))
  )
    throw new Error('Invalid settlement');
  return payments.reduce((sum, payment) => sum + BigInt(payment.amount), BigInt(settlement.rake));
}
/** What a table nobody settled returns at its deadline: the pot, shared among the players by the
 * part of their buy-ins the host never paid back. The rounding dust stays in the bankroll. */
export function closingPayments(seats: TableSeat[], pot: Integer) {
  const owed = seats.map(seat => {
      const net = BigInt(seat.bought) - BigInt(seat.paid);
      return net > 0n ? net : 0n;
    }),
    total = owed.reduce((sum, net) => sum + net, 0n);
  return seats
    .map((seat, i) => ({ player: seat.player, amount: total ? (BigInt(pot) * owed[i]) / total : 0n }))
    .filter(payment => payment.amount > 0n);
}
/** The bankroll fund. Investing is a transfer whose counterparty is this ID, and divesting a credit
 * from it, exactly as a buy-in and a payout name their table. An investor trusts the casino
 * completely: a share is its promise of a part of the bankroll, not protected principal. */
export const FUND_ID = id('HOOKEDIN/BANKROLL');
/** The casino signs a statement for every change to a holding. `shares` is what the holder has
 * afterwards. `equity` and `totalShares` are the fund just before the change, which fix the price
 * `amount` was converted at. `cause` is the hash of the holder's own signed transfer or `Redeem`. */
export const SHARE_TYPES = {
  ShareStatement: fields(
    'address holder,uint256 sequence,uint256 shares,uint256 amount,uint256 equity,uint256 totalShares,bytes32 cause',
  ),
};
/** A holder converts shares back into money. `sequence` is the statement it will produce, so a
 * redemption can be used once. */
/** The public state of the fund, signed when asked for: a quote the casino can be held to. */
export const FUND_TYPES = {
  Fund: fields('uint256 sequence,uint256 totalShares,uint256 houseShares,uint256 equity,uint256 overdrawn,uint256 at'),
};
export const REDEEM_TYPES = {
  Redeem: fields('address holder,uint256 shares,uint256 sequence'),
};
export const hashRedeem = (d: Domain, s: { holder: string; shares: Integer; sequence: Integer }) =>
  TypedDataEncoder.hash(d, REDEEM_TYPES, s);
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
    prizes: [],
    seed: ZeroHash,
    roundHead: ZeroHash,
    operationId: ZeroHash,
    developer: ZeroAddress,
    counterparty: ZeroHash,
    ...values,
  });
}
/** Every bet on one round head and seed sees the same 64-bit outcome, whichever channel signed it.
 * The stake is paid to enter; every prize whose range holds the outcome pays, so overlapping prizes add. */
export function outcome(op: Pick<Operation, 'seed' | 'prizes'>, preimage: string) {
  const randomHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'bytes32'], [id('HOOKEDIN/OUTCOME'), op.seed, preimage]),
  );
  const value = BigInt(randomHash) & (WORD_SPACE - 1n);
  const payout = op.prizes.reduce(
    (sum, prize) =>
      value >= BigInt(prize.rangeStart) && value < BigInt(prize.rangeEnd) ? sum + BigInt(prize.payout) : sum,
    0n,
  );
  return { randomHash, value, payout };
}
export function deriveState(d: Domain, base: Checkpoint, op: Operation, preimage = ZeroHash) {
  if (
    !same(base.channelId, op.channelId) ||
    !same(hashState(d, base), op.previousStateHash) ||
    BigInt(op.sequence) !== BigInt(base.sequence) + 1n ||
    same(op.operationId, ZeroHash)
  )
    throw new Error('Operation is not next in this channel');
  const next = {
    ...base,
    sequence: String(op.sequence),
    previousStateHash: hashState(d, base),
    transitionHash: keccak256(
      AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [hashOperation(d, op), preimage]),
    ),
  };
  const kind = Number(op.kind),
    balance = uint256(BigInt(base.balance)),
    amount = uint256(BigInt(op.amount));
  const wager = kind === 1,
    credit = kind === 5,
    // A transfer and its credit name the other side: another channel, or the table the money is
    // bought into and paid out of.
    linked = kind === 4 || credit;
  if (![1, 2, 4, 5].includes(kind)) throw new Error('Unknown operation');
  // Every field a kind does not use must be zero: one meaning, one encoding. A bet names its
  // round: the preimage must open the signed round head, whichever channel owns that chain.
  if (
    !Array.isArray(op.prizes) ||
    (wager
      ? !op.prizes.length ||
        op.prizes.length > MAX_PRIZES ||
        op.prizes.some(
          prize =>
            BigInt(prize.rangeStart) < 0n ||
            BigInt(prize.rangeStart) >= BigInt(prize.rangeEnd) ||
            BigInt(prize.rangeEnd) > WORD_SPACE ||
            BigInt(prize.payout) <= 0n ||
            BigInt(prize.payout) >= MAX_BALANCE,
        ) ||
        same(op.seed, ZeroHash) ||
        same(op.roundHead, ZeroHash) ||
        same(op.developer, ZeroAddress) ||
        !same(keccak256(preimage), op.roundHead)
      : op.prizes.length !== 0 ||
        !same(op.seed, ZeroHash) ||
        !same(op.roundHead, ZeroHash) ||
        !same(op.developer, ZeroAddress) ||
        !same(preimage, ZeroHash)) ||
    amount === 0n ||
    amount >= MAX_BALANCE ||
    (linked
      ? same(op.counterparty, ZeroHash) || same(op.counterparty, base.channelId)
      : !same(op.counterparty, ZeroHash))
  )
    throw new Error(wager ? 'Invalid bet commitment or balance' : linked ? 'Invalid transfer' : 'Invalid payment');
  if (credit) next.balance = String(balance + amount);
  else {
    if (amount > balance)
      throw new Error(
        wager ? 'Invalid bet commitment or balance' : kind === 4 ? 'Insufficient transfer balance' : 'Invalid payment',
      );
    next.balance = String(balance - amount + (wager ? outcome(op, preimage).payout : 0n));
  }
  if (BigInt(next.balance) >= MAX_BALANCE) throw new Error('Balance exceeds the protocol maximum');
  return next;
}
/** A joint checkpoint above an authorized bet or transfer supersedes it without consuming entropy or money. */
export function rejectionCheckpoint(d: Domain, base: Checkpoint, op: Operation): Checkpoint {
  if (
    ![1, 4].includes(Number(op.kind)) ||
    !same(op.channelId, base.channelId) ||
    !same(op.previousStateHash, hashState(d, base)) ||
    BigInt(op.sequence) !== BigInt(base.sequence) + 1n ||
    same(op.operationId, ZeroHash)
  )
    throw new Error('Rejection must identify the next bet or transfer');
  return {
    ...base,
    sequence: String(uint256(BigInt(op.sequence) + 1n)),
    previousStateHash: hashState(d, base),
    transitionHash: hashOperation(d, op),
  };
}
export function verifyStep(d: Domain, base: Checkpoint, step: Step, playerSigner: string, casinoSigner: string) {
  assertSignature(d, OP_TYPES, step.operation, step.authorization, playerSigner);
  const next = deriveState(d, base, step.operation, step.preimage);
  assertSignature(d, STATE_TYPES, next, step.casinoSignature, casinoSigner);
  return next;
}
export const emptyStep = (): Step => ({
  operation: {
    channelId: ZeroHash,
    previousStateHash: ZeroHash,
    sequence: 0,
    kind: 0,
    amount: 0,
    prizes: [],
    seed: ZeroHash,
    roundHead: ZeroHash,
    operationId: ZeroHash,
    developer: ZeroAddress,
    counterparty: ZeroHash,
  },
  authorization: '0x',
  preimage: ZeroHash,
  casinoSignature: '0x',
});
export const isEmptyStep = (d: Domain, step: Step) =>
  step.authorization === '0x' &&
  step.casinoSignature === '0x' &&
  same(step.preimage, ZeroHash) &&
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
  return {
    state,
    signaturesValid: true,
    chainObservationsVerified: false,
    limitation:
      'Opening identity and deposit require independent on-chain verification. A signed balance is a claim on the shared bankroll. Only a finalized on-chain claim establishes payment due. Inspect payments and remaining debt through an independent RPC.',
  };
}
export const PAYOUT_TYPES = {
  Payout: fields('bytes32 payoutId,address developer,uint256 amount,uint256 expiresAt'),
};
