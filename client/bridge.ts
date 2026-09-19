import { gameAmount, gameOperationKey } from './game-account.ts';
const methods = new Set([
  'wallet.info',
  'game.receipt',
  'game.bet',
  'game.cancel',
  'game.stake',
  'game.match',
  'game.payment',
  'game.transfer',
  'game.requestFunds',
]);
const object = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
/** The stake is paid to enter; every prize whose range holds the outcome pays. Prizes may overlap. */
function validatePrizes(prizes: unknown) {
  if (!Array.isArray(prizes) || prizes.length > 64) throw new Error('A bet holds 1 to 64 prizes.');
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
  if (!object(data) || !only(data, ['hookedin', 'id', 'method', 'params']) || data.hookedin !== true)
    throw new Error('Invalid HookedIn request.');
  if (!(
    (typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 80) ||
    (Number.isSafeInteger(data.id) && data.id >= 0)
  ))
    throw new Error('Invalid request ID.');
  if (!methods.has(data.method)) throw new Error('This wallet method is not available to games.');
  if (!object(data.params ?? {})) throw new Error('Request parameters must be an object.');
  if (!withinSize(data, 70000)) throw new Error('Game request is too large.');
  const params = data.params ?? {};
  if (data.method === 'wallet.info') {
    if (Object.keys(params).length) throw new Error('This method takes no parameters.');
  } else if (data.method === 'game.requestFunds') {
    // The wallet's modal decides; the game only suggests an amount and says why.
    if (!only(params, ['amount', 'reason'])) throw new Error('Unexpected game request field.');
    if (params.amount !== undefined) gameAmount(params.amount);
    if (params.reason !== undefined && (typeof params.reason !== 'string' || params.reason.length > 140))
      throw new Error('A funding reason is a string of at most 140 characters.');
  } else if (data.method === 'game.match') {
    if (!only(params, ['matchId']) || !/^0x[0-9a-fA-F]{64}$/.test(params.matchId)) throw new Error('Invalid match ID.');
  } else if (data.method === 'game.stake') {
    // The wallet recomputes the match ID from these terms and signs it into the stake.
    const match = params.match;
    if (!only(params, ['id', 'match'])) throw new Error('Unexpected game request field.');
    gameOperationKey(params.id);
    if (
      !object(match) ||
      !only(match, ['oracle', 'developer', 'expiresAt', 'nonce', 'roundHead', 'prizes', 'seats']) ||
      ![match.oracle, match.developer].every(v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) ||
      ![match.nonce, match.roundHead].every(v => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)) ||
      !Array.isArray(match.seats) ||
      !match.seats.length
    )
      throw new Error('Invalid match.');
    gameAmount(match.expiresAt);
    // With prizes, the stakes are one bet settled as the match opens, and what it pays is the pot.
    validatePrizes(match.prizes);
    for (const seat of match.seats) {
      if (
        !object(seat) ||
        !only(seat, ['channelId', 'stake', 'shares']) ||
        typeof seat.channelId !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(seat.channelId) ||
        !Array.isArray(seat.shares) ||
        !seat.shares.length
      )
        throw new Error('Invalid match seat.');
      gameAmount(seat.stake);
      // Each outcome's share of the pot, in millionths.
      for (const share of seat.shares) gameAmount(share, false);
    }
  } else {
    const fields =
      data.method === 'game.bet'
        ? ['stake']
        : ['game.payment', 'game.transfer'].includes(data.method)
          ? ['amount']
          : [];
    if (!only(params, ['id', ...fields, ...(data.method === 'game.bet' ? ['prizes', 'round'] : [])]))
      throw new Error('Unexpected game request field.');
    gameOperationKey(params.id);
    for (const field of fields) gameAmount(params[field]);
    if (data.method === 'game.bet') {
      if (!Array.isArray(params.prizes) || !params.prizes.length) throw new Error('A bet holds 1 to 64 prizes.');
      validatePrizes(params.prizes);
      // A shared round: its owner's head and seed. The wallet signs the bet; the owner submits it.
      const round = params.round;
      if (
        round !== undefined &&
        (!object(round) ||
          !only(round, ['owner', 'epoch', 'index', 'roundHead', 'seed']) ||
          typeof round.owner !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(round.owner) ||
          ![round.roundHead, round.seed].every(v => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)) ||
          ![round.epoch, round.index].every(v => Number.isSafeInteger(v) && v >= 0))
      )
        throw new Error('Invalid round.');
    }
  }
  return { ...data, params };
}

/** An opaque iframe origin is `null`; source identity is the security boundary. */
export function attachGameBridge({
  iframe,
  isCurrent,
  onRequest,
  onError = () => {},
  onActivity = () => {},
  target = window,
}: {
  iframe: Pick<HTMLIFrameElement, 'contentWindow'>;
  isCurrent: () => boolean;
  onRequest: (method: string, params: any) => Promise<unknown>;
  onError?: (message: string) => void;
  onActivity?: (type: 'request' | 'response' | 'error', data: any) => void;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}) {
  const seen = new Set();
  let busy = false;
  const activity = (type: 'request' | 'response' | 'error', data: unknown) => {
    // Diagnostics must never interrupt validation or settlement.
    try {
      onActivity(type, data);
    } catch {}
  };
  const reply = (id: string | number, payload: Record<string, unknown>) => {
    if (isCurrent() && iframe.contentWindow) {
      const message = { hookedin: true, id, ...payload };
      iframe.contentWindow.postMessage(message, '*');
      activity('error' in payload ? 'error' : 'response', message);
    }
  };
  const listener = async (event: MessageEvent) => {
    if (!isCurrent() || event.source !== iframe.contentWindow) return;
    activity('request', event.data);
    let request;
    try {
      request = validateRequest(event.data);
    } catch (error: any) {
      if (typeof event.data?.id === 'string' || Number.isSafeInteger(event.data?.id))
        reply(event.data.id, { error: error.message });
      else activity('error', { error: error.message });
      return;
    }
    if (seen.has(request.id)) return reply(request.id, { error: 'A request ID can only be used once.' });
    if (seen.size >= 2500) return reply(request.id, { error: 'Reload this game to start a fresh bridge session.' });
    seen.add(request.id);
    if (busy) return reply(request.id, { error: 'Another game request is still in progress.' });
    busy = true;
    try {
      const result = await onRequest(request.method, request.params);
      reply(request.id, { result });
    } catch (error: any) {
      const message = error.shortMessage || error.message || 'The wallet could not complete this request.';
      reply(request.id, { error: message });
      onError(message);
    } finally {
      busy = false;
    }
  };
  target.addEventListener('message', listener);
  return () => target.removeEventListener('message', listener);
}
