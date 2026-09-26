import { gameAmount, gameOperationKey } from './game-account.ts';
import { LIMITS, MAX_GROUP, MAX_META_BYTES, validMeta } from '../protocol/protocol.ts';
import { MAX_BALANCE } from '../protocol/risk.ts';
/** Every method a game may call; `wallet.hello` reports this list, so a game can tell what a wallet offers. */
export const METHODS = [
  'wallet.hello',
  'wallet.info',
  'wallet.round',
  'game.receipt',
  'game.casinoBet',
  'game.developerBet',
  'game.payment',
  'game.requestFunds',
];
const methods = new Set(METHODS);
/** Questions the wallet answers at once. Everything else signs or asks the player, and waits its turn. */
const IMMEDIATE = new Set(['wallet.hello', 'wallet.info', 'wallet.round', 'game.receipt']);
/** Requests a game may have waiting for their turn. */
const MAX_QUEUE = 32;
/** An error a game can act on: `code` is stable, the message is for people. */
export const gameError = (code: string, message: string) => Object.assign(new Error(message), { code });
const invalid = (message: string) => gameError('invalid-request', message);
/** What a developer bet's meta must be, as the protocol checks it before anything is signed. */
export const META = `A developer bet's meta is a JSON object of up to ${MAX_META_BYTES} bytes, whose numbers are whole.`;
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
  if (gameAmount(prize) >= MAX_BALANCE) throw new Error('A prize is below 2^128.');
  if (gameAmount(chance) >= BigInt(LIMITS.outcomeSpace))
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
  if (data.method === 'wallet.hello' || data.method === 'wallet.info') {
    if (Object.keys(params).length) throw new Error('This method takes no parameters.');
  } else if (data.method === 'wallet.round') {
    if (!only(params, ['id']) || typeof params.id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(params.id))
      throw new Error('A round is named by its 32-byte hash, as 0x and 64 hex digits.');
  } else if (data.method === 'game.requestFunds') {
    // The wallet's modal decides, and every word in it is the wallet's: a game suggests an amount.
    if (!only(params, ['amount'])) throw new Error('Unexpected game request field.');
    if (params.amount !== undefined) gameAmount(params.amount);
  } else {
    const fields = {
      'game.casinoBet': ['id', 'stake', 'chance', 'prize', 'group'],
      'game.developerBet': ['id', 'stake', 'meta', 'group'],
      'game.payment': ['id', 'amount', 'group'],
      'game.receipt': ['id'],
    }[data.method as string]!;
    if (!only(params, fields)) throw new Error('Unexpected game request field.');
    gameOperationKey(params.id);
    for (const field of ['stake', 'amount']) if (fields.includes(field)) gameAmount(params[field]);
    if (
      params.group !== undefined &&
      (typeof params.group !== 'string' || !params.group.length || params.group.length > MAX_GROUP)
    )
      throw new Error(`A group is a label of 1 to ${MAX_GROUP} characters.`);
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
  onActivity = () => {},
  target = window,
}: {
  iframe: Pick<HTMLIFrameElement, 'contentWindow'>;
  /** The origin of the game's entry page. */
  origin: string;
  isCurrent: () => boolean;
  onRequest: (method: string, params: any) => Promise<unknown>;
  onError?: (message: string) => void;
  onActivity?: (type: 'request' | 'response' | 'error', data: any) => void;
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
  const activity = (type: 'request' | 'response' | 'error', data: unknown) => {
    // Diagnostics must never interrupt validation or settlement.
    try {
      onActivity(type, data);
    } catch {}
  };
  const reply = (id: number, payload: Record<string, unknown>) => {
    if (isCurrent() && iframe.contentWindow) {
      const message = { hookedin: true, id, ...payload };
      iframe.contentWindow.postMessage(message, origin);
      activity('error' in payload ? 'error' : 'response', message);
    }
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
    activity('request', event.data);
    let request: { id: number; method: string; params: any };
    try {
      request = validateRequest(event.data);
    } catch (error: any) {
      if (Number.isSafeInteger(event.data?.id)) fail(event.data.id, error);
      else activity('error', { error: error.message });
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
    // Whatever signs or asks the player takes its turn, in the order the game asked.
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
