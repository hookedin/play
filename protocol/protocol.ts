import type { TypedDataField } from 'ethers';
import type {
  Details,
  EntryTerms,
  GameName,
  PotResult,
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
import { OUTCOME_SPACE, MAX_BALANCE, MAX_PRIZES, uint256 } from './risk.ts';
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
    'bytes32 channelId,bytes32 previousStateHash,uint256 sequence,uint256 kind,uint256 amount,Prize[] prizes,bytes32 round,bytes32 seedHash,bytes32 memo',
  ),
  Prize: fields('uint256 rangeStart,uint256 rangeEnd,uint256 payout'),
};
export const CLOSE_TYPES = {
  Close: fields('bytes32 channelId,bytes32 stateHash'),
};
export const ACCESS_TYPES = {
  Access: fields('bytes32 channelId,uint256 expiresAt'),
};
/** A game's referee proves itself with its own key, as a channel does with its signer. Only the referee
 * a game's developer published opens, resolves or voids that game's pots. */
export const REFEREE_ACCESS_TYPES = {
  RefereeAccess: fields('address referee,uint256 expiresAt'),
};
/** A referee's price for one entry into a developer's pot: the stake and prizes it will pay, until
 * `expiresAt` (unix seconds). `prizes` is the hash (`hashJSON`) of the entry's prizes. */
export const QUOTE_TYPES = {
  Quote: fields('bytes32 pot,uint256 stake,bytes32 prizes,uint256 expiresAt'),
};
/** A referee names what a pot it resolves by signature came to: `result` is the hash (`hashJSON`) of
 * `{outcome}` for a developer's pot, or `{split, rake}` for a players' pot. */
export const RESOLUTION_TYPES = {
  Resolution: fields('bytes32 pot,bytes32 result'),
};
/** The `authorization` header carrying a signed `Access` or `RefereeAccess` message. */
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
/** What a channel holds. ETH channels are opened and settled on-chain. Test coins are the casino's
 * own play money: a test channel is opened at the casino alone, starts empty and is filled from the
 * faucet, and nothing about it ever reaches the contract. Both count in units of 10^-18. */
export type AssetId = 'eth' | 'test';
export const ASSETS = {
  eth: { id: 'eth', symbol: 'ETH', decimals: 18 },
  test: { id: 'test', symbol: 'TEST', decimals: 18 },
} as const;
const COIN = 10n ** 18n;
/** The test-coin bankroll the casino starts with. */
export const TEST_BANKROLL = 10_000_000n * COIN;
/** The faucet pays this much to a test channel that holds less than `FAUCET_BELOW`: a credit that names
 * `FAUCET_ID`, signed by the channel's key like any other payout. */
export const FAUCET_ID = id('HOOKEDIN/FAUCET');
export const FAUCET_AMOUNT = 100n * COIN;
export const FAUCET_BELOW = 10n * COIN;
/** A test channel's ID. Its first word is a hash, never an address, so it cannot be the ID of a
 * channel the contract knows: nothing signed for a test channel settles on-chain. */
export const testChannelId = (player: string, signer: string) =>
  keccak256(
    AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'address'], [id('HOOKEDIN/TESTCOINS'), player, signer]),
  );
export const testOpening = (player: string, signer: string): Opening => ({
  channelId: testChannelId(player, signer),
  player: getAddress(player),
  signer: getAddress(signer),
  deposit: '0',
});
export function validateOpening(opening: Opening, asset: AssetId = 'eth') {
  if (asset === 'test') {
    if (
      opening.channelId !== testChannelId(opening.player, opening.signer) ||
      same(opening.signer, ZeroAddress) ||
      same(opening.player, ZeroAddress) ||
      BigInt(opening.deposit) !== 0n
    )
      throw new Error('Invalid channel opening');
    return;
  }
  if (
    opening.channelId !== channelId(opening.player, opening.signer, opening.deposit) ||
    same(opening.signer, ZeroAddress) ||
    same(opening.player, ZeroAddress) ||
    BigInt(opening.deposit) <= 0n ||
    BigInt(opening.deposit) >= MAX_BALANCE
  )
    throw new Error('Invalid channel opening');
}
/** Wire terms as exact integers: a stake and the prizes it can pay. */
export const betTerms = (stake: Integer, prizes: Prize[]) => ({
  stake: BigInt(stake),
  prizes: (Array.isArray(prizes) ? prizes : []).map(prize => ({
    rangeStart: BigInt(prize.rangeStart),
    rangeEnd: BigInt(prize.rangeEnd),
    payout: BigInt(prize.payout),
  })),
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
/** A developer's bank: the developer's own money, per asset, that pays what their pots owe beyond their
 * entries and receives what they keep. A deposit is a debit that names it, answered with a statement of
 * the balance; money leaves it only by the developer's own signed `Withdraw` or a pot it pays. */
export const BANK_ID = id('HOOKEDIN/BANK');
/** The casino signs the balance of a developer's bank in one asset after every deposit and withdrawal.
 * `cause` is the hash of the developer's signed deposit or `Withdraw`. */
export const BANK_TYPES = {
  BankStatement: fields('address developer,string asset,uint256 sequence,uint256 balance,bytes32 cause'),
};
/** A developer takes money out of their bank. `sequence` is the statement it will produce, so it works once. */
export const WITHDRAW_TYPES = {
  Withdraw: fields('address developer,string asset,uint256 amount,uint256 sequence'),
};
export const hashWithdraw = (d: Domain, s: { developer: string; asset: string; amount: Integer; sequence: Integer }) =>
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
    prizes: [],
    round: ZeroHash,
    seedHash: ZeroHash,
    memo: ZeroHash,
    ...values,
  });
}
/** A game's key: the one value its bets, its commission and its public record are kept under. It does not
 * depend on where the game is served, so a game that moves hosts keeps its history. */
export const gameKey = ({ developer, name }: GameName) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'string'], [developer, name]));
export const memo = (details: Details) => hashJSON(details);
const bytes32Pattern = /^0x[0-9a-f]{64}$/;
/** The one shape details have for each kind: a bet names its game; a debit its game (a payment), what it
 * pays into (an investment, a bank deposit) or both (a pot entry, which alone carries terms); a credit what
 * it collects from. Every field is in one form, so one meaning has one memo. */
export function checkDetails(kind: number, details: Details) {
  const game = details?.game,
    entry = details?.entry,
    keys = details && typeof details === 'object' ? Object.keys(details) : [];
  const named =
    game !== undefined &&
    game !== null &&
    typeof game === 'object' &&
    Object.keys(game).length === 2 &&
    typeof game.developer === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(game.developer) &&
    getAddress(game.developer) === game.developer &&
    game.developer !== ZeroAddress &&
    typeof game.name === 'string' &&
    game.name.length > 0 &&
    game.name.length <= 2048;
  const counterparty = typeof details?.counterparty === 'string' && bytes32Pattern.test(details.counterparty);
  if (
    !keys.every(key => ['id', 'game', 'counterparty', 'entry'].includes(key)) ||
    typeof details.id !== 'string' ||
    !bytes32Pattern.test(details.id) ||
    (game !== undefined && !named) ||
    (details.counterparty !== undefined && !counterparty) ||
    (entry !== undefined && !validEntry(entry)) ||
    !(kind === KIND.bet
      ? named && !counterparty && entry === undefined
      : kind === KIND.debit
        ? (named || counterparty) && (entry === undefined || (named && counterparty))
        : kind === KIND.credit && counterparty && !named && entry === undefined)
  )
    throw Object.assign(new Error('Invalid operation details'), { code: 'invalid' });
}
const decimal = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
/** An entry's terms in their one form: decimal strings, at most `MAX_PRIZES` well-formed prizes. */
function validEntry(entry: EntryTerms) {
  const only = (value: any, keys: string[]) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every(k => keys.includes(k));
  if (!only(entry, ['prizes', 'quote'])) return false;
  const { prizes, quote } = entry;
  if (
    prizes !== undefined &&
    (!Array.isArray(prizes) ||
      !prizes.length ||
      prizes.length > MAX_PRIZES ||
      !prizes.every(
        prize =>
          only(prize, ['rangeStart', 'rangeEnd', 'payout']) &&
          [prize.rangeStart, prize.rangeEnd, prize.payout].every(decimal) &&
          BigInt(prize.rangeStart) < BigInt(prize.rangeEnd) &&
          BigInt(prize.rangeEnd) <= OUTCOME_SPACE &&
          BigInt(prize.payout) > 0n &&
          BigInt(prize.payout) < MAX_BALANCE,
      ))
  )
    return false;
  return (
    quote === undefined ||
    (only(quote, ['expiresAt', 'signature']) &&
      decimal(quote.expiresAt) &&
      typeof quote.signature === 'string' &&
      /^0x[0-9a-fA-F]{130}$/.test(quote.signature))
  );
}
/** What each entry of a pot is owed when it ends, in entry order. A refund returns every stake. A
 * house pot's round, or a developer's pot's named outcome, picks the prizes each entry holds. A players'
 * pot pays each entry what its referee's split gives it, and the split with its rake must account for
 * every entry, within the rake the pot was opened with. The casino pays by this and the wallet checks by it. */
export function potPayouts(
  pot: { rake?: number; outcomes?: number; entries: { stake: string; prizes?: EntryTerms['prizes'] }[] },
  ending: { refund: true } | { value: bigint } | PotResult,
): bigint[] {
  const entries = pot.entries;
  if ('refund' in ending) return entries.map(entry => BigInt(entry.stake));
  const picked = (value: bigint) =>
    entries.map(entry =>
      (entry.prizes ?? []).reduce(
        (sum, prize) =>
          value >= BigInt(prize.rangeStart) && value < BigInt(prize.rangeEnd) ? sum + BigInt(prize.payout) : sum,
        0n,
      ),
    );
  if ('value' in ending) return picked(ending.value);
  if ('outcome' in ending) {
    if (!Number.isSafeInteger(ending.outcome) || ending.outcome < 0 || ending.outcome >= (pot.outcomes ?? 0))
      throw new Error('The outcome is not one this pot names');
    return picked(BigInt(ending.outcome));
  }
  const paid = entries.map(() => 0n),
    total = entries.reduce((sum, entry) => sum + BigInt(entry.stake), 0n);
  if (!Array.isArray(ending.split) || !decimal(ending.rake)) throw new Error('Invalid split');
  for (const { entry, amount } of ending.split) {
    if (
      !Number.isSafeInteger(entry) ||
      entry < 0 ||
      entry >= entries.length ||
      paid[entry] ||
      !decimal(amount) ||
      !BigInt(amount)
    )
      throw new Error('Invalid split');
    paid[entry] = BigInt(amount);
  }
  const rake = BigInt(ending.rake);
  if (paid.reduce((sum, amount) => sum + amount, 0n) + rake !== total)
    throw new Error('The split and its rake do not account for every entry');
  if (rake * 10000n > total * BigInt(pot.rake ?? 0)) throw new Error('The rake exceeds what the pot was opened with');
  return paid;
}
/** A round is named by the hash of its secret. */
export const roundId = (secret: string) => keccak256(secret);
/** A bet names its seed by its hash, so whoever knows the round's secret cannot know the outcome
 * before the seed is out. */
export const seedHash = (seed: string) => keccak256(seed);
/** Every bet on one round and seed sees the same 64-bit outcome, whichever channel signed it.
 * The stake is paid to enter; every prize whose range holds the outcome pays, so overlapping prizes add. */
export function outcome(prizes: readonly Prize[], seed: string, secret: string) {
  const randomHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'bytes32'], [id('HOOKEDIN/OUTCOME'), seed, secret]),
  );
  const value = BigInt(randomHash) & (OUTCOME_SPACE - 1n);
  const payout = prizes.reduce(
    (sum, prize) =>
      value >= BigInt(prize.rangeStart) && value < BigInt(prize.rangeEnd) ? sum + BigInt(prize.payout) : sum,
    0n,
  );
  return { randomHash, value, payout };
}
/** What an operation does to the balance. Every signed operation names one of these. */
export const KIND = { none: 0, bet: 1, debit: 2, credit: 3 } as const;
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
  const wager = kind === KIND.bet,
    credit = kind === KIND.credit;
  if (![KIND.bet, KIND.debit, KIND.credit].includes(kind as 1)) throw new Error('Unknown operation');
  // Every field a kind does not use must be zero: one meaning, one encoding. A bet names its
  // round, the hash of a secret the casino fixed first, and the hash of its seed; only those two settle it.
  if (
    !Array.isArray(op.prizes) ||
    (wager
      ? !op.prizes.length ||
        op.prizes.length > MAX_PRIZES ||
        op.prizes.some(
          prize =>
            BigInt(prize.rangeStart) < 0n ||
            BigInt(prize.rangeStart) >= BigInt(prize.rangeEnd) ||
            BigInt(prize.rangeEnd) > OUTCOME_SPACE ||
            BigInt(prize.payout) <= 0n ||
            BigInt(prize.payout) >= MAX_BALANCE,
        ) ||
        same(op.seedHash, ZeroHash) ||
        same(op.round, ZeroHash) ||
        !same(roundId(secret), op.round) ||
        !same(seedHash(seed), op.seedHash)
      : op.prizes.length !== 0 ||
        !same(op.seedHash, ZeroHash) ||
        !same(op.round, ZeroHash) ||
        !same(secret, ZeroHash) ||
        !same(seed, ZeroHash)) ||
    amount === 0n ||
    amount >= MAX_BALANCE
  )
    throw new Error(wager ? 'Invalid bet commitment or balance' : credit ? 'Invalid credit' : 'Invalid debit');
  if (credit) next.balance = String(balance + amount);
  else {
    if (amount > balance) throw new Error(wager ? 'Invalid bet commitment or balance' : 'Insufficient balance');
    next.balance = String(balance - amount + (wager ? outcome(op.prizes, seed, secret).payout : 0n));
  }
  if (BigInt(next.balance) >= MAX_BALANCE) throw new Error('Balance exceeds the protocol maximum');
  return next;
}
/** A joint checkpoint above an authorized bet or debit supersedes it without consuming entropy or money. */
export function rejectionCheckpoint(d: Domain, base: Checkpoint, op: Operation): Checkpoint {
  if (
    ![KIND.bet, KIND.debit].includes(Number(op.kind) as 1) ||
    !same(op.channelId, base.channelId) ||
    !same(op.previousStateHash, hashState(d, base)) ||
    BigInt(op.sequence) !== BigInt(base.sequence) + 1n
  )
    throw new Error('Rejection must identify the next bet or debit');
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
    prizes: [],
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
  validateOpening(opening, bundle.asset ?? 'eth');
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
/** One value for the whole signed protocol: the hash of every typed structure. A wallet or a host
 * that was built against other structures learns so from `GET /api/config` before it signs anything. */
export const PROTOCOL = id(
  [
    STATE_TYPES,
    OP_TYPES,
    CLOSE_TYPES,
    ACCESS_TYPES,
    REFEREE_ACCESS_TYPES,
    QUOTE_TYPES,
    RESOLUTION_TYPES,
    SHARE_TYPES,
    FUND_TYPES,
    REDEEM_TYPES,
    BANK_TYPES,
    WITHDRAW_TYPES,
  ]
    .map(types => TypedDataEncoder.from(types).encodeType(Object.keys(types)[0]))
    .join(''),
);
export function assertProtocol(config: { protocol?: unknown }) {
  if (config?.protocol !== PROTOCOL)
    throw Object.assign(new Error('The casino speaks another revision of the protocol'), { code: 'protocol-mismatch' });
}
