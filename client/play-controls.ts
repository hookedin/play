/** Limits cover this account's games and deposits in this browser. Money can always leave. */
export interface PlayLimits {
  deposit: string | null;
  loss: string | null;
  minutes: number | null;
}
export interface PlayControls {
  limits: PlayLimits;
  pending?: { limits: PlayLimits; at: number };
  pausedUntil: number;
  day: string;
  deposited: string;
  lost: string;
  sessionStarted: number;
}
export const DAY = 24 * 60 * 60 * 1000;
const BREAK = 15 * 60 * 1000;
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
function validateLimits(next: PlayLimits) {
  for (const value of [next.deposit, next.loss])
    if (
      value !== null &&
      (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n || BigInt(value) >= 1n << 256n)
    )
      throw new Error('Limits must be positive ETH amounts.');
  if (next.minutes !== null && (!Number.isInteger(next.minutes) || next.minutes < 1 || next.minutes > 1440))
    throw new Error('Session length must be 1–1440 minutes.');
}
export function playControls(saved?: PlayControls, now = Date.now()): PlayControls {
  const value: PlayControls = structuredClone(
    saved ?? {
      limits: { deposit: null, loss: null, minutes: null },
      pausedUntil: 0,
      day: dayOf(now),
      deposited: '0',
      lost: '0',
      sessionStarted: 0,
    },
  );
  validateLimits(value.limits);
  if (
    ![value.pausedUntil, value.sessionStarted, value.pending?.at ?? 0].every(n => Number.isSafeInteger(n) && n >= 0) ||
    ![value.deposited, value.lost].every(n => typeof n === 'string' && /^\d+$/.test(n))
  )
    throw new Error('Invalid saved play controls.');
  if (value.pending) validateLimits(value.pending.limits);
  if (value.day !== dayOf(now)) Object.assign(value, { day: dayOf(now), deposited: '0', lost: '0' });
  if (value.pending && now >= value.pending.at) {
    value.limits = value.pending.limits;
    delete value.pending;
  }
  return value;
}
export function changeLimits(saved: PlayControls, next: PlayLimits, now = Date.now()) {
  validateLimits(next);
  const state = playControls(saved, now),
    immediate = { ...state.limits };
  let relaxation = false;
  for (const field of ['deposit', 'loss', 'minutes'] as const) {
    const old = state.limits[field],
      value = next[field];
    if (old !== null && (value === null || BigInt(value) > BigInt(old))) relaxation = true;
    else Object.assign(immediate, { [field]: value });
  }
  state.limits = immediate;
  if (
    immediate.minutes !== null &&
    state.sessionStarted &&
    now >= state.sessionStarted + immediate.minutes * 60000 &&
    (saved.limits.minutes === null || immediate.minutes < saved.limits.minutes)
  )
    state.sessionStarted = now - immediate.minutes * 60000;
  if (relaxation) state.pending = { limits: next, at: now + DAY };
  else delete state.pending;
  return state;
}
export function depositRemaining(saved: PlayControls, now = Date.now()): bigint | null {
  const state = playControls(saved, now);
  if (state.pausedUntil > now) return 0n;
  if (state.limits.deposit === null) return null;
  const left = BigInt(state.limits.deposit) - BigInt(state.deposited);
  return left > 0n ? left : 0n;
}
export function allowPlay(saved: PlayControls, amount: bigint, now = Date.now()) {
  const state = playControls(saved, now);
  if (state.pausedUntil > now)
    throw new Error(
      `Play is paused until ${new Date(state.pausedUntil).toLocaleString()}. Withdrawals and recovery remain available.`,
    );
  if (state.limits.loss !== null && BigInt(state.lost) + amount > BigInt(state.limits.loss))
    throw new Error('This bet could exceed your daily loss limit. Choose a smaller amount or wait until 00:00 UTC.');
  if (state.limits.minutes !== null) {
    const end = state.sessionStarted + state.limits.minutes * 60000;
    if (state.sessionStarted && now >= end && now < end + BREAK)
      throw new Error(`Your session has ended. Take a break until ${new Date(end + BREAK).toLocaleTimeString()}.`);
    if (!state.sessionStarted || now >= end + BREAK) state.sessionStarted = now;
  }
  return state;
}
/** Record one newly settled operation. Developer bets and payments count their full stake; wins never reduce usage. */
export function recordPlay(saved: PlayControls, receipt: any, now = Date.now()) {
  const state = playControls(saved, now);
  if (receipt.status === 'rejected' || !['signed', 'confirmed'].includes(receipt.status)) return state;
  if (receipt.kind === 'deposit') state.deposited = String(BigInt(state.deposited) + BigInt(receipt.amount));
  if (['casino-bet', 'developer-bet', 'payment'].includes(receipt.kind)) {
    const stake = BigInt(receipt.stake ?? receipt.amount ?? 0),
      payout = receipt.kind === 'casino-bet' ? BigInt(receipt.payout ?? 0) : 0n;
    if (stake > payout) state.lost = String(BigInt(state.lost) + stake - payout);
  }
  return state;
}
