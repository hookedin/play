import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { outcome } from '@hookedin/play/protocol/protocol.ts';
import type { PublicBet, Referee } from '@hookedin/play/sdk/referee';
import { BETTING_MS, Wheel } from '../server/wheel.ts';
import type { WheelState } from '../server/wheel.ts';
import { pocket } from '../src/table.ts';

/** A casino that does what the referee kit asks, and a clock the test turns. */
function table() {
  let now = 1_000_000,
    count = 0,
    failing: any = null;
  // The referee's open round: the hash of its secret.
  const secret = () => keccak256('0x' + count.toString(16).padStart(64, '0')),
    round = () => keccak256(secret());
  const open = new Map<string, PublicBet>(),
    calls: string[] = [],
    draws: string[][] = [],
    saves: WheelState[] = [],
    wakes: number[] = [];
  const referee = {
    address: '0x' + 'a'.repeat(40),
    async open() {
      return { id: round(), seedHash: keccak256(keccak256(round())), signature: '0x' };
    },
    async bets() {
      calls.push('bets');
      return structuredClone([...open.values()]);
    },
    async draw() {
      calls.push('draw');
      if (failing) throw failing;
      const id = round(),
        seed = keccak256(id),
        drawn = [...open.values()].filter(bet => bet.round === id);
      draws.push(drawn.map(bet => bet.bet));
      for (const bet of drawn) open.delete(bet.bet);
      const revealed = secret();
      count++;
      return { round: id, seed, secret: revealed, outcome: outcome([], seed, revealed).value, bets: drawn };
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
    draws,
    saves,
    wakes,
    wheel: new Wheel(deps),
    /** A player's wallet places a bet on the round open in its asset: the casino records when it took it. */
    bet(uname = 'p', stake = '100', asset: 'eth' | 'test' = 'test') {
      const bet = '0x' + String(open.size + 1 + count * 100).padStart(64, '0');
      open.set(bet, {
        bet,
        uname,
        stake,
        asset,
        round: asset === 'test' ? round() : keccak256('0x01'),
        status: 'open',
        placedAt: now,
      } as PublicBet);
      return bet;
    },
    advance: (ms: number) => (now += ms),
    fail: (error: any) => (failing = error),
  };
}

test('an empty table waits; the first bet starts the clock; the spin draws the round every bet rode', async () => {
  const t = table();
  const first = await t.wheel.view();
  assert.deepEqual([first.closesAt, first.players, first.last], [null, 0, null]);
  t.advance(60_000);
  assert.equal((await t.wheel.view()).closesAt, null, 'nobody is in, so nothing spins');
  assert.ok(!t.calls.includes('draw'));
  // A page says its wallet placed a bet; the wheel believes the casino, not the page.
  const placedAt = t.deps.now();
  t.bet('a', '250');
  t.bet('a', '50');
  t.bet('b', '100', 'eth');
  const placed = await t.wheel.placed();
  assert.deepEqual([placed.players, placed.staked], [1, '300'], 'only the bets on its own round, in its own asset');
  assert.equal(placed.closesAt, placedAt + BETTING_MS, 'twenty seconds after the first bet, by the casino');
  assert.equal(t.wakes.at(-1), placed.closesAt, 'and on time whether or not anybody asks');
  t.advance(BETTING_MS - 1);
  assert.equal((await t.wheel.view()).last, null);
  t.advance(1);
  await t.wheel.alarm();
  assert.equal(t.draws.length, 1);
  assert.equal(t.draws[0]!.length, 2, 'one draw for the whole table');
  const after = await t.wheel.view();
  assert.equal(after.last!.number, pocket(outcome([], after.last!.seed, after.last!.secret).value));
  assert.equal(after.last!.players, 1);
  assert.deepEqual([after.closesAt, after.players], [null, 0], 'and the table is empty again');
  assert.deepEqual(t.saves.at(-1)!.last, after.last, 'the spin is saved');
});

test('the casino is asked about bets at most once a second, however many pages are watching', async () => {
  const t = table();
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'bets').length, 1);
  t.advance(1000);
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'bets').length, 2);
});

test('a failed spin is tried again, and draws the same round', async () => {
  const t = table();
  for (const uname of ['a', 'b', 'c', 'd']) t.bet(uname);
  await t.wheel.placed();
  t.advance(BETTING_MS);
  t.fail(new Error('casino unavailable'));
  await assert.rejects(t.wheel.alarm(), /casino unavailable/);
  assert.ok(t.wakes.at(-1)! > t.deps.now(), 'it asks to be woken again');
  t.fail(null);
  await t.wheel.alarm();
  assert.deepEqual(
    t.draws.map(drawn => drawn.length),
    [4],
    'every bet on the round rode the one spin',
  );
  assert.equal((await t.wheel.view()).last!.players, 4);
});

test('a wheel woken from storage carries on with the last spin it made', async () => {
  const t = table();
  t.bet();
  await t.wheel.placed();
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  assert.deepEqual((await woken.view()).last, (await t.wheel.view()).last);
});
