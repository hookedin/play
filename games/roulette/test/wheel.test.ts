import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { outcome } from '../../../protocol/protocol.ts';
import type { PublicBet, Referee, Round } from '@hookedin/play/sdk/referee';
import { BETTING_MS, MARGIN_MS, Wheel } from '../server/wheel.ts';
import type { WheelState } from '../server/wheel.ts';
import { pocket } from '../src/table.ts';

const ROUND_MS = 600_000;

/** A casino that does what the referee kit asks, and a clock the test turns. */
function table() {
  let now = 1_000_000,
    count = 0,
    failing: any = null,
    lose = false;
  // The referee's open round: the hash of its secret, named with a deadline when the casino first names it.
  const secret = (n = count) => keccak256('0x' + n.toString(16).padStart(64, '0')),
    id = (n = count) => keccak256(secret(n)),
    deadlines = new Map<string, number>(),
    drawn = new Map<string, { seed: string; secret: string; outcome: string }>(),
    ridden = new Map<string, PublicBet[]>();
  const view = (round: string): Round => ({
    id: round,
    game: '0x' + 'b'.repeat(64),
    referee: '0x' + 'a'.repeat(40),
    asset: 'test',
    deadline: deadlines.get(round)!,
    status: drawn.has(round) ? 'drawn' : 'open',
    seedHash: keccak256(keccak256(round)),
    signature: '0x',
    ...drawn.get(round),
  });
  const open = new Map<string, PublicBet>(),
    calls: string[] = [],
    draws: string[][] = [],
    saves: WheelState[] = [],
    wakes: number[] = [];
  const referee = {
    address: '0x' + 'a'.repeat(40),
    async open() {
      if (!deadlines.has(id())) deadlines.set(id(), now + ROUND_MS);
      return view(id());
    },
    async round(round: string) {
      // A round the casino never named, or lost with its row, is unknown to it.
      if (!deadlines.has(round)) throw Object.assign(new Error('Unknown round'), { status: 404 });
      return view(round);
    },
    async bets() {
      calls.push('bets');
      return structuredClone([...open.values()]);
    },
    async draw(round: string) {
      calls.push('draw');
      if (failing) throw failing;
      if (!drawn.has(round)) {
        const n = [...deadlines.keys()].indexOf(round),
          seed = keccak256(round),
          riding = [...open.values()].filter(bet => bet.round === round);
        draws.push(riding.map(bet => bet.bet));
        ridden.set(round, riding);
        for (const bet of riding) open.delete(bet.bet);
        drawn.set(round, { seed, secret: secret(n), outcome: String(outcome([], seed, secret(n)).value) });
        count++;
      }
      // The casino drew it, and the reply never came back.
      if (lose) throw new Error('reply lost');
      return { round, ...drawn.get(round), bets: ridden.get(round) };
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
    /** A player's wallet places a bet on the round its page named, in its asset: the casino records when. */
    bet(uname = 'p', stake = '100', asset: 'eth' | 'test' = 'test') {
      const bet = '0x' + String(open.size + 1 + count * 100).padStart(64, '0');
      open.set(bet, {
        bet,
        uname,
        stake,
        asset,
        round: asset === 'test' ? id() : keccak256('0x01'),
        status: 'open',
        placedAt: now,
      } as PublicBet);
      return bet;
    },
    advance: (ms: number) => (now += ms),
    fail: (error: any) => (failing = error),
    loseReplies: (value: boolean) => (lose = value),
  };
}

test('an empty table waits; the first bet starts the clock; the spin draws the round every bet rode', async () => {
  const t = table();
  const first = await t.wheel.view();
  assert.deepEqual([first.closesAt, first.players, first.last], [null, 0, null]);
  assert.match(first.round!, /^0x[0-9a-f]{64}$/, 'the table names the round to bet on');
  assert.equal(t.saves.at(-1)!.round, first.round, 'saved before anybody is told of it');
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
  assert.equal(after.last!.round, first.round);
  assert.equal(after.last!.number, pocket(outcome([], after.last!.seed, after.last!.secret).value));
  assert.equal(after.last!.players, 1);
  assert.deepEqual([after.closesAt, after.players], [null, 0], 'and the table is empty again');
  assert.notEqual(after.round, first.round, 'with the next round to bet on');
  assert.deepEqual(t.saves.at(-1)!.last, after.last, 'the spin is saved');
});

test('a round is drawn before its deadline, however late its first chip came', async () => {
  const t = table();
  await t.wheel.view();
  t.advance(ROUND_MS - 10_000);
  t.bet('late');
  const placed = await t.wheel.placed();
  assert.equal(placed.closesAt, 1_000_000 + ROUND_MS - MARGIN_MS);
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
});

test('a draw whose reply was lost is found again by the round the wheel saved, even after a restart', async () => {
  const t = table();
  const opened = await t.wheel.view();
  t.bet('a');
  await t.wheel.placed();
  t.advance(BETTING_MS);
  t.loseReplies(true);
  await assert.rejects(t.wheel.alarm(), /reply lost/);
  t.loseReplies(false);
  // The Durable Object is evicted: a new wheel starts from what the old one saved, and the casino's open round is
  // the next one. The wheel reads the round it saved before it moves on, so the spin is not lost.
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  const view = await woken.view();
  assert.equal(view.last!.round, opened.round);
  assert.notEqual(view.round, opened.round);
  assert.deepEqual(
    t.draws.map(drawn => drawn.length),
    [1],
    'drawn once',
  );
});

test('a wheel whose saved round the casino does not know moves on to the round taking bets', async () => {
  const t = table();
  const woken = new Wheel(t.deps, { last: null, round: '0x' + 'e'.repeat(64) });
  const view = await woken.view();
  assert.equal(view.last, null, 'a round the casino lost has no spin to show');
  assert.equal(t.saves.at(-1)!.round, view.round, 'and the round taking bets is saved');
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
