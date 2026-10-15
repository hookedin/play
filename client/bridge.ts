import type { GameIdentity } from '../protocol/game-types.ts';
import {
  GAME_ID,
  MAX_GROUP,
  MAX_LABEL,
  MAX_META_BYTES,
  MAX_PAIRS,
  MAX_RESULTS,
  validGroup,
  validHash,
  validMeta,
  validResults,
} from '../protocol/protocol.ts';
import { UINT256_MAX } from '../protocol/risk.ts';
/** Every method a game may call. */
export const METHODS = [
  'wallet.hello',
  'wallet.info',
  'wallet.round',
  'wallet.showBet',
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
/** What a game asks the wallet to sign, which waits its turn. Everything else, its questions and what it tells the
 * wallet, signs nothing and is answered at once. */
export const SIGNS = new Set(['game.casinoBet', 'game.developerBet', 'game.payment']);
/** Requests a game may have waiting for their turn. */
const MAX_QUEUE = 32;
/** The game an operation is for, as a bet or a payment signs it: its ID, which stays the same wherever the game
 * is served. */
export function gameRef(identity: GameIdentity): string {
  if (!['http:', 'https:'].includes(new URL(identity.url).protocol)) throw new Error('Game URLs must use HTTP(S)');
  if (!GAME_ID.test(identity.id)) throw new Error('A game ID is a lowercase UUID');
  return identity.id;
}
/** An amount a game names, in wei: a bigint below 2^256, above zero unless `positive` is false. */
export function gameAmount(value: unknown, positive = true) {
  if (typeof value !== 'bigint') throw new Error('An amount is a bigint of wei');
  if (value > UINT256_MAX || value < (positive ? 1n : 0n)) throw new Error('Amount is outside the supported range');
  return value;
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
/** A step in its one form (protocol.ts `validResults`). */
const STEP =
  `A step holds an amount of wei below 2^96, and 1 to ${MAX_RESULTS} results, each a weight above zero, the cash it ` +
  `leaves below 2^96 and at most a label of 1 to ${MAX_LABEL} printable characters, weighing less than 2^256 together, ` +
  `whose amounts below the step's cash times those above it are at most ${MAX_PAIRS}. A step of one amount keeps its ` +
  'cash.';
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
  } else if (data.method === 'wallet.showBet') {
    if (!only(params, ['id'])) throw new Error('Unexpected game request field.');
    gameOperationKey(params.id);
  } else if (data.method === 'wallet.round') {
    if (!only(params, ['id']) || !validHash(params.id))
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
      'game.casinoBet': ['id', 'cash', 'results', 'group'],
      'game.developerBet': ['id', 'stake', 'meta', 'round', 'group'],
      'game.payment': ['id', 'amount', 'group', 'kept'],
      'game.receipt': ['id'],
    }[data.method as string]!;
    if (!only(params, fields)) throw new Error('Unexpected game request field.');
    gameOperationKey(params.id);
    for (const field of ['stake', 'amount']) if (fields.includes(field)) gameAmount(params[field]);
    if (params.group !== undefined && !validGroup(params.group))
      throw new Error(`A group is a label of 1 to ${MAX_GROUP} printable characters.`);
    // What stays with the group is the group's: a payment leaves nothing behind outside one.
    if (params.kept !== undefined) {
      gameAmount(params.kept, false);
      if (params.group === undefined) throw new Error('Only a payment in a group leaves cash with it.');
    }
    // A casino bet settles now against the bankroll, on the player's own round. A developer bet is its developer's
    // to settle, on its developer's word: its meta is the game's own, which the casino keeps and never reads.
    if (data.method === 'game.casinoBet' && !validResults(params.cash, params.results)) throw new Error(STEP);
    if (data.method === 'game.developerBet' && !validMeta(params.meta)) throw new Error(META);
    if (params.round !== undefined && !validHash(params.round))
      throw new Error("A round is the hash of the developer's secret, as 0x and 64 lowercase hex digits.");
  }
  return { ...data, params };
}

/** The game keeps its host's origin, so the wallet answers only that origin and listens to nothing else
 * in the frame: a frame that navigated elsewhere is no longer the game the player opened. `push` tells the page that
 * greeted the wallet something unasked; a page that has not greeted it yet hears nothing, and asks for what it needs
 * once it has. */
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
    page = 0,
    greeted = -1;
  const post = (message: Record<string, unknown>) => {
    if (isCurrent() && iframe.contentWindow) iframe.contentWindow.postMessage({ hookedin: true, ...message }, origin);
  };
  const reply = (id: number, payload: Record<string, unknown>) => post({ id, ...payload });
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
    if (request.method === 'wallet.hello') greeted = page;
    const asked = page;
    if (!SIGNS.has(request.method)) return answer(request, asked);
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
  return {
    dispose() {
      page++;
      target.removeEventListener('message', listener);
    },
    push(event: string, fields: Record<string, unknown>) {
      if (greeted === page) post({ event, ...fields });
    },
  };
}
