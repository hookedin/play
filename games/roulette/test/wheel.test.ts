import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { roundOutcome } from '@hookedin/play/sdk/referee';
import type { PotStatus, Referee } from '@hookedin/play/sdk/referee';
import { BETTING_MS, CLOSE_MS, Wheel } from '../server/wheel.ts';
import type { WheelState } from '../server/wheel.ts';
import { pocket } from '../src/table.ts';

/** A casino that does what the referee kit asks, and a clock the test turns. */
function table() {
  let now = 1_000_000,
    count = 0;
  const secrets = new Map<string, string>(),
    pots = new Map<string, PotStatus & { window: number }>(),
    calls: string[] = [],
    saves: WheelState[] = [],
    wakes: number[] = [];
  let failing: any = null;
  const referee = {
    address: '0x' + 'a'.repeat(40),
    // The betting windows this casino takes: the referee reads them from it, so the wheel asks for one it accepts.
    window: { min: 1000, max: 60000 },
    async open({ bank, asset, window }: any) {
      assert.deepEqual([bank, asset], ['house', 'test'], 'the wheel opens house pots in its own asset');
      assert.equal(window, BETTING_MS + CLOSE_MS, 'for the betting time it needs and room to spin');
      calls.push('open');
      const secret = keccak256('0x' + (++count).toString(16).padStart(64, '0')),
        id = keccak256(secret),
        seed = keccak256(id);
      secrets.set(id, secret);
      const pot = { id, status: 'open', seedHash: keccak256(seed), closesAt: null, entries: [], window } as any;
      pots.set(id, pot);
      return { pot, seed };
    },
    async pot(id: string) {
      calls.push('pot');
      return structuredClone(pots.get(id)) ?? null;
    },
    async resolve(id: string, { seed }: any) {
      calls.push('resolve');
      if (failing) throw failing;
      assert.equal(seed, keccak256(id), 'the wheel resolves a pot with the seed it drew for it');
      return Object.assign(pots.get(id)!, { status: 'resolved', seed, secret: secrets.get(id) });
    },
    async void(id: string) {
      calls.push('void');
      pots.get(id)!.status = 'void';
    },
  } as unknown as Referee;
  const deps = {
    referee,
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
    /** A player enters: the casino starts the pot's window at its first entry. */
    enter(id: string, uname = 'p', stake = '100') {
      const pot = pots.get(id)!;
      if (!pot.entries.length) pot.closesAt = now + pot.window;
      pot.entries.push({ uname, alias: null, stake });
    },
    forget: (id: string) => pots.delete(id),
    advance: (ms: number) => (now += ms),
    fail: (error: any) => (failing = error),
    secret: (id: string) => secrets.get(id)!,
  };
}

test('an empty table waits; the first entry starts the clock; the spin is what the secret and seed say', async () => {
  const t = table();
  const first = await t.wheel.view();
  assert.ok(first.pot);
  assert.deepEqual([first.closesAt, first.players, first.last], [null, 0, null]);
  assert.equal(t.saves[0]!.pot, first.pot, 'the pot is saved before anybody is shown it');
  assert.ok(!JSON.stringify(first).includes(t.saves[0]!.seed!), 'and nobody is shown its seed');
  t.advance(60_000);
  assert.equal((await t.wheel.view()).closesAt, null, 'nobody is in, so nothing spins');
  // A page says its wallet entered; the wheel believes the casino, not the page.
  assert.equal((await t.wheel.entered()).closesAt, null);
  t.enter(first.pot!, 'a', '250');
  t.enter(first.pot!, 'a', '50');
  const entered = await t.wheel.entered();
  assert.deepEqual([entered.players, entered.staked], [1, '300']);
  assert.equal(entered.closesAt, entered.now + BETTING_MS, 'the wheel spins well inside the window the casino holds');
  assert.equal(t.wakes.at(-1), entered.closesAt, 'and on time whether or not anybody asks');
  t.advance(BETTING_MS - 1);
  assert.equal((await t.wheel.view()).last, null);
  t.advance(1);
  await t.wheel.alarm();
  const after = await t.wheel.view();
  assert.equal(after.last!.pot, first.pot);
  assert.equal(after.last!.seed, keccak256(first.pot!), 'the seed is out once the pot is resolved');
  assert.equal(after.last!.number, pocket(roundOutcome(after.last!.seed, t.secret(first.pot!))));
  assert.equal(after.last!.players, 1);
  assert.notEqual(after.pot, first.pot, 'and the next pot is open');
  assert.equal(after.closesAt, null);
  assert.deepEqual(
    t.calls.filter(call => call !== 'pot'),
    ['open', 'resolve', 'open'],
  );
});

test('the casino is asked about entries at most once a second, however many pages are watching', async () => {
  const t = table();
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'pot').length, 0, 'a pot just opened has nobody in it');
  t.advance(1000);
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'pot').length, 1);
});

test('an empty pot is called off before the casino gives up on it, and a failed spin is tried again', async () => {
  const t = table();
  const first = (await t.wheel.view()).pot!;
  t.advance(8 * 60_000 + 1);
  const second = (await t.wheel.view()).pot!;
  assert.notEqual(second, first);
  assert.ok(t.calls.includes('void'));
  t.enter(second);
  await t.wheel.entered();
  t.advance(BETTING_MS);
  t.fail(new Error('casino unavailable'));
  await assert.rejects(t.wheel.alarm(), /casino unavailable/);
  assert.equal(t.wheel.state.pot, second, 'the pot is still to be resolved');
  assert.ok(t.wakes.at(-1)! > t.deps.now());
  t.fail(null);
  await t.wheel.alarm();
  assert.equal(t.wheel.state.last!.pot, second);
  // A pot the casino voided pays nobody here: the wheel moves on without a number for it.
  const third = (await t.wheel.view()).pot!;
  t.enter(third);
  await t.wheel.entered();
  t.advance(BETTING_MS);
  t.fail(Object.assign(new Error('The pot is past its deadline'), { code: 'pot-void' }));
  await t.wheel.alarm();
  t.fail(null);
  assert.equal(t.wheel.state.last!.pot, second);
  assert.notEqual((await t.wheel.view()).pot, third);
});

test('a pot the casino no longer knows is replaced at the next look', async () => {
  const t = table(),
    first = (await t.wheel.view()).pot!;
  t.forget(first);
  t.advance(1000);
  const next = await t.wheel.view();
  assert.notEqual(next.pot, first);
  assert.deepEqual([next.closesAt, next.last], [null, null]);
});

test('a wheel woken from storage carries on with the pot it had', async () => {
  const t = table(),
    first = (await t.wheel.view()).pot!;
  t.enter(first);
  await t.wheel.entered();
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  t.advance(BETTING_MS);
  await woken.alarm();
  assert.equal(woken.state.last!.pot, first);
});
