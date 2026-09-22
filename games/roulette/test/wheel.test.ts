import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { roundOutcome } from '@hookedin/play/sdk/host';
import type { RoundHost } from '@hookedin/play/sdk/host';
import { BETTING_MS, Wheel } from '../server/wheel.ts';
import type { WheelState } from '../server/wheel.ts';
import { pocket } from '../src/table.ts';

/** A casino that does what the host kit asks, and a clock the test turns. */
function table() {
  let now = 1_000_000,
    count = 0;
  const secrets = new Map<string, string>(),
    open = new Map<string, { stake: string }[]>(),
    calls: string[] = [],
    saves: WheelState[] = [],
    wakes: number[] = [];
  const create = () => {
    const secret = keccak256('0x' + (++count).toString(16).padStart(64, '0')),
      id = keccak256(secret);
    secrets.set(id, secret);
    return id;
  };
  let failing: any = null;
  const host = {
    address: '0x' + 'a'.repeat(40),
    // The betting windows this casino takes: the host reads them from it, so the wheel asks for one it accepts.
    window: { min: 1000, max: 60000 },
    async round(asset?: string, window?: number) {
      assert.equal(asset, 'test', 'the wheel asks for rounds in its own asset');
      // Nobody's bet is held longer than the table's own betting time, plus room to close.
      assert.ok(window! >= BETTING_MS && window! <= host.window.max, 'and for the betting time it needs');
      calls.push('open');
      const id = create();
      open.set(id, []);
      const seed = keccak256(id);
      return { round: { id, seedHash: keccak256(seed) }, seed };
    },
    async seats(id: string) {
      calls.push('seats');
      return open.has(id) ? ({ status: 'open', seats: open.get(id)! } as any) : null;
    },
    async close(id: string, seed: string) {
      calls.push('close');
      if (failing) throw failing;
      assert.equal(seed, keccak256(id), 'the wheel closes a round with the seed it drew for it');
      open.delete(id);
      return { secret: secrets.get(id)! } as any;
    },
  } as unknown as RoundHost;
  const deps = {
    host,
    asset: 'test' as const,
    now: () => now,
    save: (s: WheelState) => void saves.push(structuredClone(s)),
    wake: (at: number) => void wakes.push(at),
  };
  return {
    deps,
    calls,
    saves,
    wakes,
    wheel: new Wheel(deps),
    sit: (id: string, stake = '100') => open.get(id)!.push({ stake }),
    leave: (id: string) => open.get(id)!.pop(),
    forget: (id: string) => open.delete(id),
    advance: (ms: number) => (now += ms),
    fail: (error: any) => (failing = error),
    secret: (id: string) => secrets.get(id)!,
  };
}

test('an empty table waits; the first seat starts the clock; the spin is what the secret and seed say', async () => {
  const t = table();
  const first = await t.wheel.view();
  assert.ok(first.round);
  assert.deepEqual([first.closesAt, first.players, first.last], [null, 0, null]);
  assert.deepEqual(t.saves[0].round, first.round, 'the round is saved before anybody is shown it');
  assert.deepEqual(Object.keys(first.round!), ['id', 'seedHash'], 'and nobody is shown its seed');
  assert.ok(!JSON.stringify(first).includes(t.saves[0].seed!));
  t.advance(60_000);
  assert.equal((await t.wheel.view()).closesAt, null, 'nobody is seated, so nothing spins');
  // A page says its wallet joined; the wheel believes the casino, not the page.
  assert.equal((await t.wheel.seated()).closesAt, null);
  t.sit(first.round!.id, '250');
  const seated = await t.wheel.seated();
  assert.deepEqual([seated.players, seated.staked], [1, '250']);
  assert.equal(seated.closesAt, seated.now + BETTING_MS);
  assert.equal(t.wakes.at(-1), seated.closesAt, 'the wheel spins on time whether or not anybody asks');
  t.advance(BETTING_MS - 1);
  assert.equal((await t.wheel.view()).last, null);
  t.advance(1);
  await t.wheel.alarm();
  const after = await t.wheel.view();
  assert.equal(after.last!.round, first.round!.id);
  assert.equal(after.last!.seed, keccak256(first.round!.id), 'the seed is out once the round is closed');
  assert.equal(after.last!.number, pocket(roundOutcome(after.last!.seed, t.secret(first.round!.id))));
  assert.equal(after.last!.players, 1);
  // The next round is the one the casino named at the close, opened without asking for another.
  assert.notEqual(after.round!.id, first.round!.id);
  assert.equal(after.closesAt, null);
  assert.deepEqual(
    t.calls.filter(call => call !== 'seats'),
    ['open', 'close', 'open'],
  );
});

test('the clock stops when the last player takes their bet back', async () => {
  const t = table(),
    round = (await t.wheel.view()).round!;
  t.sit(round.id);
  assert.notEqual((await t.wheel.seated()).closesAt, null);
  t.leave(round.id);
  // Even at the very moment the round would close, the wheel looks again before it spins for nobody.
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  const after = await t.wheel.view();
  assert.deepEqual([after.closesAt, after.last, after.round!.id], [null, null, round.id]);
  assert.ok(!t.calls.includes('close'));
});

test('the casino is asked about seats at most once a second, however many pages are watching', async () => {
  const t = table();
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'seats').length, 0, 'a round just opened has nobody in it');
  t.advance(1000);
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'seats').length, 1);
});

test('an empty round is replaced before the casino gives up on it, and a failed close is tried again', async () => {
  const t = table();
  const first = (await t.wheel.view()).round!;
  t.advance(8 * 60_000 + 1);
  const second = (await t.wheel.view()).round!;
  assert.notEqual(second.id, first.id);
  t.sit(second.id);
  await t.wheel.seated();
  t.advance(BETTING_MS);
  t.fail(new Error('casino unavailable'));
  await assert.rejects(t.wheel.alarm(), /casino unavailable/);
  assert.equal(t.wheel.state.round!.id, second.id, 'the round is still to be closed');
  assert.ok(t.wakes.at(-1)! > t.deps.now());
  t.fail(null);
  await t.wheel.alarm();
  assert.equal(t.wheel.state.last!.round, second.id);
  // A round the casino no longer has open settles nobody: the wheel moves on without a number for it.
  const third = (await t.wheel.view()).round!;
  t.sit(third.id);
  await t.wheel.seated();
  t.advance(BETTING_MS);
  t.fail(Object.assign(new Error('Round is not open'), { code: 'round-not-open' }));
  await t.wheel.alarm();
  t.fail(null);
  assert.equal(t.wheel.state.last!.round, second.id);
  assert.notEqual((await t.wheel.view()).round!.id, third.id);
});

test('a round the casino no longer knows is replaced at the next look', async () => {
  const t = table(),
    first = (await t.wheel.view()).round!;
  t.forget(first.id);
  t.advance(1000);
  const next = await t.wheel.view();
  assert.notEqual(next.round!.id, first.id);
  assert.deepEqual([next.closesAt, next.last], [null, null]);
});

test('a wheel woken from storage carries on with the round it had', async () => {
  const t = table(),
    first = (await t.wheel.view()).round!;
  t.sit(first.id);
  await t.wheel.seated();
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  t.advance(BETTING_MS);
  await woken.alarm();
  assert.equal(woken.state.last!.round, first.id);
});
