import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, allowPlay, changeLimits, depositRemaining, playControls, recordPlay } from '../client/play-controls.ts';

const now = Date.UTC(2026, 8, 29, 12);
const limits = { deposit: '1000', loss: '100', minutes: 30 };

test('limits tighten immediately while increases and removals wait a full day', () => {
  const initial = changeLimits(playControls(undefined, now), limits, now);
  assert.deepEqual(initial.limits, limits);
  const changed = changeLimits(initial, { deposit: '500', loss: null, minutes: 60 }, now);
  assert.deepEqual(changed.limits, { deposit: '500', loss: '100', minutes: 30 });
  assert.deepEqual(playControls(changed, now + DAY - 1).limits, changed.limits);
  assert.deepEqual(playControls(changed, now + DAY).limits, { deposit: '500', loss: null, minutes: 60 });
  const reduced = changeLimits(changed, { deposit: '400', loss: '50', minutes: 10 }, now + 1);
  assert.equal(reduced.pending, undefined);
  assert.deepEqual(playControls(reduced, now + DAY).limits, reduced.limits);
});

test('a session spans reloads and requires a 15-minute break before further play', () => {
  const initial = changeLimits(playControls(undefined, now), limits, now);
  const playing = allowPlay(initial, 1n, now);
  const reloaded = playControls(JSON.parse(JSON.stringify(playing)), now + 29 * 60000);
  assert.equal(allowPlay(reloaded, 1n, now + 29 * 60000).sessionStarted, now);
  assert.throws(() => allowPlay(reloaded, 1n, now + 30 * 60000), /Take a break/);
  assert.throws(() => allowPlay(reloaded, 1n, now + 45 * 60000 - 1), /Take a break/);
  assert.equal(allowPlay(reloaded, 1n, now + 45 * 60000).sessionStarted, now + 45 * 60000);
  const reduced = changeLimits(playing, { ...limits, minutes: 1 }, now + 20 * 60000);
  assert.throws(() => allowPlay(reduced, 1n, now + 20 * 60000), /Take a break/);
});

test('the daily loss limit checks the full stake and wins or rejected bets cannot raise what is left of it', () => {
  let state = changeLimits(playControls(undefined, now), limits, now);
  state = recordPlay(state, { kind: 'casino-bet', status: 'signed', stake: '80', payout: '30' }, now);
  assert.equal(state.lost, '50');
  assert.throws(() => allowPlay(state, 51n, now), /daily loss limit/);
  allowPlay(state, 50n, now);
  state = recordPlay(state, { kind: 'casino-bet', status: 'signed', stake: '10', payout: '100' }, now);
  state = recordPlay(state, { kind: 'casino-bet', status: 'rejected', stake: '50', payout: '0' }, now);
  state = recordPlay(state, { kind: 'developer-bet', status: 'signed', stake: '20' }, now);
  state = recordPlay(state, { kind: 'developer-bet-payout', status: 'signed', amount: '100' }, now);
  assert.equal(state.lost, '70');
  assert.equal(playControls(state, now + DAY).lost, '0');
});

test('the daily deposit limit counts confirmed own deposits and pauses block all new commitments', () => {
  let state = changeLimits(playControls(undefined, now), limits, now);
  state = recordPlay(state, { kind: 'deposit', status: 'confirmed', amount: '600' }, now);
  state = recordPlay(state, { kind: 'deposit', status: 'reverted', amount: '400' }, now);
  state = recordPlay(state, { kind: 'taken-in', status: 'signed', amount: '500' }, now);
  assert.equal(depositRemaining(state, now), 400n);
  state.pausedUntil = now + DAY;
  assert.equal(depositRemaining(state, now), 0n);
  assert.throws(() => allowPlay(state, 1n, now), /Play is paused/);
  assert.equal(depositRemaining(state, now + DAY), 1000n);
});

test('invalid limits and counters are rejected rather than disabling limits', () => {
  for (const value of ['0', '-1', '1.5', 'invalid', String(1n << 256n)])
    assert.throws(() => changeLimits(playControls(undefined, now), { ...limits, loss: value }, now), /positive/);
  for (const minutes of [0, 1.5, 1441, Infinity])
    assert.throws(() => changeLimits(playControls(undefined, now), { ...limits, minutes }, now), /Session length/);
  assert.throws(() => playControls({ ...playControls(undefined, now), lost: '-1' }, now), /Invalid saved/);
});
