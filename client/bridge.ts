import { gameAmount, gameOperationKey } from './game-account.ts';
import { MAX_GROUP } from '../protocol/protocol.ts';
/** Every method a game may call; `wallet.hello` reports this list, so a game can tell what a wallet offers. */
export const METHODS = [
  'wallet.hello',
  'wallet.info',
  'game.receipt',
  'game.bet',
  'game.place',
  'game.payment',
  'game.requestFunds',
];
const methods = new Set(METHODS);
/** Questions the wallet answers at once. Everything else signs or asks the player, and waits its turn. */
const IMMEDIATE = new Set(['wallet.hello', 'wallet.info', 'game.receipt']);
/** Requests a game may have waiting for their turn. */
const MAX_QUEUE = 32;
/** An error a game can act on: `code` is stable, the message is for people. */
export const gameError = (code: string, message: string) => Object.assign(new Error(message), { code });
const invalid = (message: string) => gameError('invalid-request', message);
/** A code is the wallet's own or the casino's; anything else, such as a library's, is a plain failure. */
const errorCode = (error: any) =>
  typeof error?.code === 'string' && /^[a-z][a-z-]{0,39}$/.test(error.code) ? error.code : 'failed';
const object = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
/** The stake is paid to enter; every prize whose range holds the outcome pays. Prizes may overlap. */
function validatePrizes(prizes: unknown) {
  if (!Array.isArray(prizes) || !prizes.length || prizes.length > 64) throw new Error('A bet holds 1 to 64 prizes.');
  for (const prize of prizes) {
    if (!object(prize) || !only(prize, ['rangeStart', 'rangeEnd', 'payout']))
      throw new Error('A prize is {rangeStart, rangeEnd, payout}.');
    gameAmount(prize.payout);
    if (gameAmount(prize.rangeStart, false) >= gameAmount(prize.rangeEnd) || BigInt(prize.rangeEnd) > 1n << 64n)
      throw new Error('A prize range lies within [0, 2^64).');
  }
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
  } else if (data.method === 'game.requestFunds') {
    // The wallet's modal decides, and every word in it is the wallet's: a game suggests an amount.
    if (!only(params, ['amount'])) throw new Error('Unexpected game request field.');
    if (params.amount !== undefined) gameAmount(params.amount);
  } else {
    const fields = {
      'game.bet': ['id', 'stake', 'prizes', 'group'],
      'game.place': ['id', 'stake', 'prizes', 'round', 'terms', 'deadline', 'group'],
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
    // A bet settles now on the player's own round. A placed bet settles later: drawn on the round of its
    // referee's it names, or split by its referee by the deadline it names.
    if (data.method === 'game.bet') validatePrizes(params.prizes);
    if (data.method === 'game.place') {
      if (params.terms === undefined) {
        validatePrizes(params.prizes);
        if (typeof params.round !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(params.round))
          throw new Error('A placed bet with prizes names the round it rides.');
        if (params.deadline !== undefined) throw new Error("A placed bet with prizes has its round's deadline.");
      } else if (
        !object(params.terms) ||
        params.prizes !== undefined ||
        params.round !== undefined ||
        !Number.isSafeInteger(params.deadline)
      )
        throw new Error('A placed bet with terms has a deadline in unix milliseconds, and no prizes or round.');
    }
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
  iframe: Pick<HTMLIFrameElement, 'contentWindow'> &
    Partial<Pick<HTMLIFrameElement, 'addEventListener' | 'removeEventListener'>>;
  /** The origin of the game's entry page. */
  origin: string;
  isCurrent: () => boolean;
  onRequest: (method: string, params: any) => Promise<unknown>;
  onError?: (message: string) => void;
  onActivity?: (type: 'request' | 'response' | 'error', data: any) => void;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}) {
  // Request IDs only ever rise, so none is answered twice and nothing has to be remembered. A page
  // the frame loads afresh counts from the start, and is never sent an answer meant for the page before it.
  let last = -1,
    waiting = 0,
    turn: Promise<unknown> = Promise.resolve(),
    page = 0;
  const loaded = () => {
    page++;
    last = -1;
    waiting = 0;
  };
  iframe.addEventListener?.('load', loaded);
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
    if (request.id <= last)
      return fail(request.id, gameError('invalid-request', 'A request ID must be larger than the last.'));
    last = request.id;
    const asked = page;
    if (IMMEDIATE.has(request.method)) return answer(request, asked);
    // Whatever signs or asks the player takes its turn, in the order the game asked.
    if (waiting >= MAX_QUEUE) return fail(request.id, gameError('busy', 'Too many game requests are waiting.'));
    waiting++;
    return (turn = turn.then(async () => {
      if (asked !== page) return;
      waiting--;
      await answer(request, asked);
    }));
  };
  target.addEventListener('message', listener);
  return () => {
    target.removeEventListener('message', listener);
    iframe.removeEventListener?.('load', loaded);
  };
}
