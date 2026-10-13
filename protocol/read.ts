/** The JSON layer's way in. JSON holds every whole number as a decimal string (protocol.ts `json`); each reader here
 * takes a value as JSON holds it, in its one form, and gives it back as code holds it, every whole number a bigint, or
 * throws: nothing else is taken for it, whatever it could be read as. */
import type { TypedDataField } from 'ethers';
import type {
  Carried,
  Checkpoint,
  CollateralOffer,
  Deployment,
  Details,
  DeveloperCasinoBet,
  Evidence,
  EvidenceBundle,
  OnchainChannel,
  Operation,
  OperationResponse,
  PublicDeveloperBet,
  Quote,
  Round,
  SignedStatement,
  Step,
  StepTable,
  Submission,
} from './types.ts';
import {
  BANK_TYPES,
  CHANNEL_FIELDS,
  GAME_SERVER_TYPES,
  HEAD_TYPES,
  OFFER_TYPES,
  OP_TYPES,
  QUOTE_TYPES,
  SHARE_TYPES,
  STATE_TYPES,
  UNAME,
  DISCORD_USERNAME,
  GAME_ID,
  MAX_RESULTS,
  RECORD_ID,
  canonical,
  checksummed,
  decimal,
  only,
  validHash,
  validMeta,
  validGroup,
  validSignature,
  validTable,
  validText,
} from './protocol.ts';

export type Reader<T> = (value: unknown) => T;
/** Refuses a value that is not in its one form. */
export const refuse = (what = 'A value'): never => {
  throw Object.assign(new Error(`${what} is not in its one form`), { code: 'invalid' });
};
/** A value `test` takes as it is. */
export const exactly =
  <T>(test: (value: unknown) => value is T, what?: string): Reader<T> =>
  value =>
    test(value) ? value : refuse(what);
/** A whole number: a decimal string, read as a bigint. */
export const whole: Reader<bigint> = value => (decimal(value) ? BigInt(value) : refuse('A whole number'));
/** A whole number that may be below zero, such as what a player's bets came to: a decimal string, with a minus sign
 * before any but zero, read as a bigint. */
export const integer: Reader<bigint> = value =>
  typeof value === 'string' && /^(0|-?[1-9][0-9]{0,77})$/.test(value) ? BigInt(value) : refuse('A whole number');
/** How many of something there are, which JSON holds as a number. */
export const count = exactly(
  (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0,
  'A count',
);
export const hash = exactly(validHash, 'A hash');
export const address = exactly(checksummed, 'An address');
/** Well-formed text without a NUL. */
export const text = exactly((value: unknown): value is string => typeof value === 'string' && validText(value), 'Text');
export const flag = exactly((value: unknown): value is boolean => typeof value === 'boolean', 'A flag');
/** A time in Unix milliseconds, as a date can show it. */
export const time = exactly(
  (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15,
  'A time',
);
/** A signature in the one form the contract recovers (protocol.ts `validSignature`). */
export const signature = exactly((value: unknown): value is string => validSignature(value), 'A signature');
/** A signature, or `0x` where nothing is signed. */
export const signatureOrNone = exactly(
  (value: unknown): value is string => value === '0x' || validSignature(value),
  'A signature',
);
/** Meta, a game's own JSON (protocol.ts `validMeta`). */
export const meta = exactly(validMeta, 'Meta');
const matching = (pattern: RegExp, what: string) =>
  exactly((value: unknown): value is string => typeof value === 'string' && pattern.test(value), what);
export const uname = matching(UNAME, 'A uname');
export const discordUsername = matching(DISCORD_USERNAME, 'A Discord username');
export const gameId = matching(GAME_ID, 'A game');
export const recordId = matching(RECORD_ID, 'A record');
export const group = exactly(validGroup, 'A group');
/** One of `values`, exactly. */
export const oneOf =
  <const T extends readonly unknown[]>(...values: T): Reader<T[number]> =>
  value =>
    values.includes(value) ? (value as T[number]) : refuse();
/** What the first of `readers` that takes it reads. */
export const firstOf =
  <T>(...readers: Reader<T>[]): Reader<T> =>
  value => {
    for (const read of readers)
      try {
        return read(value);
      } catch {}
    return refuse();
  };
export const optional =
  <T>(read: Reader<T>): Reader<T | undefined> =>
  value =>
    value === undefined ? undefined : read(value);
export const nullable =
  <T>(read: Reader<T>): Reader<T | null> =>
  value =>
    value === null ? null : read(value);
/** An array of at most `max` values, each read by `read`. */
export const list =
  <T>(read: Reader<T>, max: number): Reader<T[]> =>
  value =>
    Array.isArray(value) && value.length <= max ? value.map(read) : refuse('A list');
/** An object of no field but `shape`'s, each read by its reader: a field its reader reads as undefined is left out. */
export const object =
  <T extends object>(shape: { [K in keyof T]-?: Reader<T[K]> }): Reader<T> =>
  value => {
    if (!only(value, Object.keys(shape))) return refuse('An object');
    const read: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape) as [string, Reader<unknown>][]) {
      const item = field(value[key]);
      if (item !== undefined) read[key] = item;
    }
    return read as T;
  };
/** A message of `types`' one struct, each uint read as a bigint, in its one form (protocol.ts `canonical`). */
export const message =
  <T extends object = Record<string, any>>(types: Record<string, TypedDataField[]>): Reader<T> =>
  value => {
    const [fields] = Object.values(types) as [TypedDataField[]];
    if (
      !only(
        value,
        fields.map(({ name }) => name),
      )
    )
      return refuse('A message');
    const read = Object.fromEntries(
      fields.map(({ name, type }) => [name, type.startsWith('uint') ? whole(value[name]) : value[name]]),
    );
    return canonical(types, read) ? (read as T) : refuse('A message');
  };
/** A message of `types` and the signature over it. */
export const signed = <T extends object = Record<string, any>>(types: Record<string, TypedDataField[]>) =>
  object<{ message: T; signature: string }>({ message: message<T>(types), signature });

export const checkpoint = message<Checkpoint>(STATE_TYPES);
export const operation = message<Operation>(OP_TYPES);
export const quote = signed<Quote['message']>(QUOTE_TYPES);
export const offer = signed<CollateralOffer['message']>(OFFER_TYPES);
/** A game's step as a bet signs it (protocol.ts `validTable`). */
export const table: Reader<StepTable> = value =>
  exactly(
    validTable,
    'A step',
  )(
    object<StepTable>({
      cash: whole,
      bankroll: optional(whole),
      results: list(object({ weight: whole, cash: whole, label: optional(text) }), MAX_RESULTS),
    })(value),
  );
/** What an operation means: its fields' forms here, and the shape its kind gives them in protocol.ts `checkDetails`. */
export const details = object<Details>({
  id: hash,
  game: optional(text),
  group: optional(text),
  counterparty: optional(text),
  meta: optional(meta),
  round: optional(hash),
  table: optional(table),
  kept: optional(whole),
});
export const step = object<Step>({
  operation,
  authorization: signatureOrNone,
  seed: hash,
  secret: hash,
  casinoSignature: signatureOrNone,
});
export const evidence = object<Evidence>({
  base: checkpoint,
  playerSignature: signatureOrNone,
  casinoSignature: signatureOrNone,
  step,
});
/** The most withdrawals a bundle carries: each is one the contract may still owe something. */
const MAX_WITHDRAWALS = 256;
export const bundle = object<EvidenceBundle>({
  details: optional(details),
  chainId: whole,
  casino: address,
  operator: address,
  evidence,
  withdrawals: optional(list(evidence, MAX_WITHDRAWALS)),
  dispute: optional(object<NonNullable<EvidenceBundle['dispute']>>({ step, quote })),
});

export const carried = object<Carried>({ base: checkpoint, operation, authorization: signature, details });
/** A statement the casino signs of a holding in the fund, or of a game's bank. */
export const statement = firstOf<SignedStatement>(signed(SHARE_TYPES), signed(BANK_TYPES));
/** Where the casino's signing history ended when it signed. */
export const head = signed(HEAD_TYPES);
export const response = object<OperationResponse>({
  status: oneOf('signed', 'rejected'),
  reason: optional(text),
  request: optional(operation),
  details,
  used: optional(oneOf(true)),
  carried: optional(carried),
  state: checkpoint,
  casinoSignature: signatureOrNone,
  evidence,
  operationId: hash,
  commission: whole,
  developer: optional(address),
  quote: optional(quote),
  statement: optional(statement),
  head: optional(head),
});
export const submission = object<Submission>({
  request: operation,
  details,
  signature,
  acknowledgment: optional(object<NonNullable<Submission['acknowledgment']>>({ stateHash: hash, signature })),
  rejectionSignature: optional(signature),
  seed: optional(hash),
  quote: optional(quote),
});
/** A channel as the contract holds it (protocol.ts `onchainChannel`), as JSON holds it. */
export const onchain = object<OnchainChannel>(
  Object.fromEntries(CHANNEL_FIELDS.map(field => [field, field === 'closingHash' ? hash : whole])) as {
    [K in keyof OnchainChannel]-?: Reader<OnchainChannel[K]>;
  },
);
export const developerCasinoBet = object<DeveloperCasinoBet>({
  game: gameId,
  stake: whole,
  chance: whole,
  prize: whole,
  group: exactly((value: unknown): value is string => value === '' || validGroup(value), 'A group'),
  meta,
  signature,
  accepted: flag,
  payout: optional(whole),
});
export const round = object<Round>({
  id: hash,
  game: gameId,
  createdAt: time,
  status: oneOf('open', 'revealed'),
  seed: optional(hash),
  secret: optional(hash),
  outcome: optional(whole),
  casinoBet: optional(developerCasinoBet),
});
export const publicDeveloperBet = object<PublicDeveloperBet>({
  bet: hash,
  game: gameId,
  group: optional(group),
  uname: nullable(uname),
  discordUsername: nullable(discordUsername),
  stake: whole,
  placedAt: time,
  status: oneOf('open', 'settled'),
  meta,
  round: optional(hash),
  settlement: optional(
    object<NonNullable<PublicDeveloperBet['settlement']>>({
      player: whole,
      casino: whole,
      secret: optional(hash),
      signature,
      server: optional(signed(GAME_SERVER_TYPES)),
    }),
  ),
  settledAt: optional(time),
});
/** A deployment the wallet and the casino are pinned to: its chain, contract and operator, the RPCs to read it from and
 * the block it was deployed in. */
export const deployment = object<Deployment>({
  chainId: whole,
  contractAddress: address,
  operator: address,
  rpcUrl: optional(text),
  witnessRpcUrl: optional(text),
  block: optional(
    exactly((value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0, 'A block'),
  ),
});
