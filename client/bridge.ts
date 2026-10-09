import type { GameIdentity } from '../protocol/game-types.ts';
import { BOUNDS, GAME_ID, MAX_GROUP, MAX_META_BYTES, decimal, validGroup, validMeta } from '../protocol/protocol.ts';
import { MAX_BALANCE } from '../protocol/risk.ts';
/** Every method a game may call. */
export const METHODS = [
  'wallet.hello',
  'wallet.info',
  'wallet.round',
  'game.receipt',
  'game.history',
  'game.casinoBet',
  'game.developerBet',
  'game.payment',
  'game.allowance',
  'game.placesDeveloperBets',
  'game.end',
];
const methods = new Set(METHODS);
/** Questions the wallet answers at once, and what a game tells it, which signs nothing. Everything else signs, and
 * waits its turn. */
const IMMEDIATE = new Set([
  'wallet.hello',
  'wallet.info',
  'wallet.round',
  'game.receipt',
  'game.history',
  'game.allowance',
  'game.placesDeveloperBets',
  'game.end',
]);
/** Requests a game may have waiting for their turn. */
const MAX_QUEUE = 32;
/** The game an operation is for, as a bet or a payment signs it: its ID, which stays the same wherever the game
 * is served. */
export function gameRef(identity: GameIdentity): string {
  if (!['http:', 'https:'].includes(new URL(identity.url).protocol)) throw new Error('Game URLs must use HTTP(S)');
  if (!GAME_ID.test(identity.id)) throw new Error('A game ID is a lowercase UUID');
  return identity.id;
}
/** An amount a game names, in wei: a decimal string below 2^256, above zero unless `positive` is false. */
export function gameAmount(value: unknown, positive = true) {
  if (!decimal(value)) throw new Error('Use decimal wei amounts');
  const n = BigInt(value);
  if (n >= 1n << 256n || (positive && n === 0n)) throw new Error('Amount is outside the supported range');
  return n;
}
/** A game names its own operations; the wallet scopes them by player and game. */
export function gameOperationKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(value))
    throw new Error('A game operation ID is 1–64 characters of letters, digits, ".", "_", ":" or "-"');
}
/** An error a game can act on: `code` is stable, the message is for people. */
export const gameError = (code: string, message: string) => Object.assign(new Error(message), { code });
const invalid = (message: string) => gameError('invalid-request', message);
/** What meta must be, a developer bet's or an ended group's, as the protocol checks it. */
export const META = `Meta is a JSON object of up to ${MAX_META_BYTES} bytes, whose numbers are whole.`;
/** A code is the wallet's own or the casino's; anything else, such as a library's, is a plain failure. */
const errorCode = (error: any) =>
  typeof error?.code === 'string' && /^[a-z][a-z-]{0,39}$/.test(error.code) ? error.code : 'failed';
const object = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
/** The stake is paid to enter, and the bet pays its prize when the round's outcome is below its chance. */
function validateOdds(chance: unknown, prize: unknown) {
  if (gameAmount(prize) >= MAX_BALANCE) throw new Error('A prize is below 2^96.');
  if (gameAmount(chance) >= BigInt(BOUNDS.outcomeSpace))
    throw new Error('A chance counts winning outcomes out of 2^64, from 1 to 2^64 − 1.');
}
/** A bounded estimate of the serialized size that stops early, so an oversized message is never stringified. */
function withinSize(value: unknown, limit: number) {
  let size = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (typeof v === 'string') size += v.length + 2;
    else if (v === null || typeof v !== 'object') size += 8;
    else
      for (const [key, item] of Object.entries(v)) {
        size += key.length + 4;
        if (!visit(item, depth + 1)) return false;
      }
    return size <= limit;
  };
  return visit(value, 0);
}

export function validateRequest(data: any) {
  try {
    return validate(data);
  } catch (error: any) {
    throw error.code ? error : invalid(error.message);
  }
}
function validate(data: any) {
  if (!object(data) || !only(data, ['hookedin', 'id', 'method', 'params']) || data.hookedin !== true)
    throw new Error('Invalid HookedIn request.');
  if (!Number.isSafeInteger(data.id) || data.id < 0) throw new Error('Invalid request ID.');
  if (!methods.has(data.method)) throw gameError('unknown-method', 'This wallet method is not available to games.');
  if (!object(data.params ?? {})) throw new Error('Request parameters must be an object.');
  if (!withinSize(data, 70000)) throw new Error('Game request is too large.');
  const params = data.params ?? {};
  if (['wallet.hello', 'wallet.info', 'game.placesDeveloperBets'].includes(data.method)) {
    if (Object.keys(params).length) throw new Error('This method takes no parameters.');
  } else if (data.method === 'wallet.round') {
    if (!only(params, ['id']) || typeof params.id !== 'string' || !/^0x[0-9a-f]{64}$/.test(params.id))
      throw new Error('A round is named by its 32-byte hash, as 0x and 64 lowercase hex digits.');
  } else if (data.method === 'game.history') {
    if (!only(params, ['after', 'limit'])) throw new Error('Unexpected game request field.');
    if (params.after !== undefined && (typeof params.after !== 'string' || !/^([0-9a-f-]{36})?$/.test(params.after)))
      throw new Error('A history cursor is one the wallet gave.');
    if (params.limit !== undefined && !(Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 100))
      throw new Error('A history page holds 1 to 100 entries.');
  } else if (data.method === 'game.allowance' || data.method === 'game.end') {
    if (!only(params, data.method === 'game.end' ? ['group', 'meta'] : ['group']))
      throw new Error('Unexpected game request field.');
    if (params.group === undefined ? data.method === 'game.end' : !validGroup(params.group))
      throw new Error(`A group is a label of 1 to ${MAX_GROUP} printable characters.`);
    if (params.meta !== undefined && !validMeta(params.meta)) throw new Error(META);
  } else {
    const fields = {
      'game.casinoBet': ['id', 'stake', 'chance', 'prize', 'group', 'kept'],
      'game.developerBet': ['id', 'stake', 'meta', 'group'],
      'game.payment': ['id', 'amount', 'group', 'kept'],
      'game.receipt': ['id'],
    }[data.method as string]!;
    if (!only(params, fields)) throw new Error('Unexpected game request field.');
    gameOperationKey(params.id);
    for (const field of ['stake', 'amount']) if (fields.includes(field)) gameAmount(params[field]);
    if (params.group !== undefined && !validGroup(params.group))
      throw new Error(`A group is a label of 1 to ${MAX_GROUP} printable characters.`);
    // What stays with the group is the group's: a bet keeps nothing back outside one.
    if (params.kept !== undefined) {
      gameAmount(params.kept, false);
      if (params.group === undefined) throw new Error('Only a bet in a group keeps cash with it.');
    }
    // A casino bet settles now against the bankroll, on the player's own round. A developer bet is its developer's
    // to settle, on its developer's word: its meta is the game's own, which the casino keeps and never reads.
    if (data.method === 'game.casinoBet') validateOdds(params.chance, params.prize);
    if (data.method === 'game.developerBet' && !validMeta(params.meta)) throw new Error(META);
  }
  return { ...data, params };
}

/** The game keeps its host's origin, so the wallet answers only that origin and listens to nothing else
 * in the frame: a frame that navigated elsewhere is no longer the game the player opened. */
export function attachGameBridge({
  iframe,
  origin,
  isCurrent,
  onRequest,
  onError = () => {},
  target = window,
}: {
  iframe: Pick<HTMLIFrameElement, 'contentWindow'>;
  /** The origin of the game's entry page. */
  origin: string;
  isCurrent: () => boolean;
  onRequest: (method: string, params: any) => Promise<unknown>;
  onError?: (message: string) => void;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}) {
  // Request IDs only ever rise within a page, so none is answered twice and nothing has to be remembered. A page
  // begins by greeting the wallet: a greeting whose ID does not rise is a page the frame loaded afresh, which counts from
  // the start and is never sent an answer meant for the page before it. Its greeting is the first the wallet can know of
  // it: the frame's `load` comes after the page has run, and its messages can come before.
  let last = -1,
    waiting = 0,
    turn: Promise<unknown> = Promise.resolve(),
    page = 0;
  const reply = (id: number, payload: Record<string, unknown>) => {
    if (isCurrent() && iframe.contentWindow)
      iframe.contentWindow.postMessage({ hookedin: true, id, ...payload }, origin);
  };
  const fail = (id: number, error: any) =>
    reply(id, {
      error: {
        code: errorCode(error),
        message: error.shortMessage || error.message || 'The wallet could not complete this request.',
      },
    });
  const answer = async (request: { id: number; method: string; params: any }, asked: number) => {
    try {
      const result = await onRequest(request.method, request.params);
      if (asked === page) reply(request.id, { result });
    } catch (error: any) {
      if (asked === page) fail(request.id, error);
      onError(error.shortMessage || error.message || 'The wallet could not complete this request.');
    }
  };
  const listener = (event: MessageEvent) => {
    if (!isCurrent() || event.source !== iframe.contentWindow || event.origin !== origin) return;
    let request: { id: number; method: string; params: any };
    try {
      request = validateRequest(event.data);
    } catch (error: any) {
      if (Number.isSafeInteger(event.data?.id)) fail(event.data.id, error);
      return;
    }
    if (request.id <= last) {
      if (request.method !== 'wallet.hello')
        return fail(request.id, gameError('invalid-request', 'A request ID must be larger than the last.'));
      page++;
      waiting = 0;
    }
    last = request.id;
    const asked = page;
    if (IMMEDIATE.has(request.method)) return answer(request, asked);
    // Whatever signs takes its turn, in the order the game asked.
    if (waiting >= MAX_QUEUE) return fail(request.id, gameError('busy', 'Too many game requests are waiting.'));
    waiting++;
    // A request that waited its turn runs only for the page that asked, while its game is still the one open: the
    // wallet's game session by then may be another game's.
    return (turn = turn.then(async () => {
      if (asked !== page || !isCurrent()) return;
      waiting--;
      await answer(request, asked);
    }));
  };
  target.addEventListener('message', listener);
  return () => {
    page++;
    target.removeEventListener('message', listener);
  };
}
