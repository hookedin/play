import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { outcome } from '../../../protocol/protocol.ts';
import type { Developer, PublicDeveloperBet, Round } from '@hookedin/play/sdk/developer';
import { BETTING_MS, Wheel } from '../server/wheel.ts';
import type { WheelState } from '../server/wheel.ts';
import { bet as layout, pocket } from '../src/table.ts';
import type { Chips } from '../src/table.ts';

/** A casino that does what the developer kit asks, and a clock the test turns. */
function table() {
  let now = 1_000_000,
    count = 0,
    failing: any = null,
    lose = false,
    decline = false;
  // The developer's rounds, each the hash of a secret, and the seed of its casino bet on it.
  const secret = (n: number) => keccak256('0x' + n.toString(16).padStart(64, '0')),
    rounds = new Map<string, { secret: string; casinoBet?: Round['casinoBet'] }>();
  const view = (id: string): Round => {
    const round = rounds.get(id)!,
      seed = keccak256(id);
    return {
      id,
      developer: '0x' + 'a'.repeat(40),
      asset: 'test',
      status: round.casinoBet ? 'revealed' : 'open',
      seedHash: keccak256(seed),
      signature: '0x',
      ...(round.casinoBet
        ? {
            seed,
            secret: round.secret,
            outcome: String(outcome([], seed, round.secret).value),
            casinoBet: round.casinoBet,
          }
        : {}),
    };
  };
  const open = new Map<string, PublicDeveloperBet>(),
    paid = new Map<string, bigint>(),
    calls: string[] = [],
    casinoBets: string[][] = [],
    saves: WheelState[] = [],
    wakes: number[] = [];
  const developer = {
    address: '0x' + 'a'.repeat(40),
    limits: { covers: 256 },
    async openRound() {
      const id = keccak256(secret(++count));
      rounds.set(id, { secret: secret(count) });
      return view(id);
    },
    async round(id: string) {
      // A round the casino never named, or lost with its row, is unknown to it.
      if (!rounds.has(id)) throw Object.assign(new Error('Unknown round'), { status: 404 });
      return view(id);
    },
    async bets() {
      calls.push('bets');
      return { bets: structuredClone([...open.values()]), cursor: '', more: false };
    },
    async casinoBet({ round: id, covers }: { round: string; covers: string[] }) {
      calls.push('casinoBet');
      if (failing) throw failing;
      const round = rounds.get(id)!;
      if (!round.casinoBet) {
        casinoBets.push(covers);
        round.casinoBet = { game: '0x', stake: '0', prizes: [], covers, signature: '0x', accepted: !decline };
      }
      // The casino took it, and the reply never came back.
      if (lose) throw new Error('reply lost');
      return view(id);
    },
    async settle(settlements: { bet: string; player: bigint }[]) {
      for (const { bet, player } of settlements) {
        paid.set(bet, player);
        open.delete(bet);
      }
      return [];
    },
  } as unknown as Developer;
  const deps = {
    developer,
    asset: 'test' as const,
    now: () => now,
    save: (s: WheelState) => void saves.push(structuredClone(s)),
    wake: (at: number) => void wakes.push(at),
  };
  return {
    deps,
    calls,
    casinoBets,
    paid,
    saves,
    wakes,
    wheel: new Wheel(deps),
    /** A player's wallet places a developer bet on the round its page named, in its asset: the casino records when. */
    bet({
      uname = 'p',
      chips = { red: 100n } as Chips,
      asset = 'test' as 'eth' | 'test',
      round = [...rounds.keys()].at(-1)!,
      prizes = layout(chips).prizes,
    } = {}) {
      const hash = '0x' + String(open.size + paid.size + 1).padStart(64, '0');
      open.set(hash, {
        bet: hash,
        uname,
        stake: layout(chips).stake,
        prizes,
        asset,
        round: asset === 'test' ? round : keccak256('0x01'),
        status: 'open',
        placedAt: now,
      } as PublicDeveloperBet);
      return hash;
    },
    /** What chips on a round win once that round is revealed. */
    owed(id: string, chips: Chips = { red: 100n }) {
      const round = view(id);
      return outcome(layout(chips).prizes, round.seed!, round.secret!).payout;
    },
    advance: (ms: number) => (now += ms),
    fail: (error: any) => (failing = error),
    loseReplies: (value: boolean) => (lose = value),
    declining: (value: boolean) => (decline = value),
  };
}

test('an empty table waits; the first bet starts the clock; the spin covers every layout with one casino bet', async () => {
  const t = table();
  const first = await t.wheel.view();
  assert.deepEqual([first.closesAt, first.players, first.last], [null, 0, null]);
  assert.match(first.round!, /^0x[0-9a-f]{64}$/, 'the table names the round to bet on');
  assert.equal(t.saves.at(-1)!.round, first.round, 'saved before anybody is told of it');
  t.advance(60_000);
  assert.equal((await t.wheel.view()).closesAt, null, 'nobody is in, so nothing spins');
  assert.ok(!t.calls.includes('casinoBet'));
  // A page says its wallet placed a bet; the wheel believes the casino, not the page.
  const placedAt = t.deps.now();
  const a = t.bet({ uname: 'a', chips: { red: 250n } }),
    b = t.bet({ uname: 'a', chips: { '17': 50n } });
  t.bet({ uname: 'b', asset: 'eth' });
  const placed = await t.wheel.placed();
  assert.deepEqual([placed.players, placed.staked], [1, '300'], 'only the bets on its own round, in its own asset');
  assert.equal(placed.closesAt, placedAt + BETTING_MS, 'twenty seconds after the first bet, by the casino');
  assert.equal(t.wakes.at(-1), placed.closesAt, 'and on time whether or not anybody asks');
  t.advance(BETTING_MS - 1);
  assert.equal((await t.wheel.view()).last, null);
  t.advance(1);
  await t.wheel.alarm();
  assert.deepEqual(t.casinoBets, [[a, b]], 'one casino bet for the whole table');
  assert.deepEqual(
    [t.paid.get(a), t.paid.get(b)],
    [t.owed(first.round!, { red: 250n }), t.owed(first.round!, { '17': 50n })],
    'each is paid what its chips win where the ball landed',
  );
  const after = await t.wheel.view();
  assert.equal(after.last!.round, first.round);
  assert.equal(after.last!.number, pocket(outcome([], after.last!.seed, after.last!.secret).value));
  assert.equal(after.last!.players, 1);
  assert.deepEqual([after.closesAt, after.players], [null, 0], 'and the table is empty again');
  assert.notEqual(after.round, first.round, 'with a new round to bet on');
  assert.deepEqual(t.saves.at(-1)!.last, after.last, 'the spin is saved');
});

test('a bet that is not a roulette layout is not covered, and gets its stake back', async () => {
  const t = table();
  const { round } = await t.wheel.view();
  const fair = t.bet(),
    // Every pocket pays: more than chips of its stake can win, whatever the prizes claim.
    greedy = t.bet({ prizes: [{ rangeStart: '0', rangeEnd: String(1n << 64n), payout: '101' }] });
  await t.wheel.placed();
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  assert.deepEqual(t.casinoBets, [[fair]]);
  assert.deepEqual([t.paid.get(fair), t.paid.get(greedy)], [t.owed(round!), 100n]);
});

test('a bet that comes after its spin, or on a spin the bankroll declines, gets its stake back', async () => {
  const t = table();
  const { round } = await t.wheel.view();
  t.bet();
  await t.wheel.placed();
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  // Signed while the round was open, it reached the casino after the spin.
  const late = t.bet({ round: round! });
  t.advance(1000);
  await t.wheel.view();
  assert.equal(t.paid.get(late), 100n);
  // The bankroll will not take the table's casino bet: the round is revealed, and every stake comes back.
  t.declining(true);
  const declined = t.bet();
  await t.wheel.placed();
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  assert.equal(t.paid.get(declined), 100n);
});

test('the casino is asked about bets at most once a second, however many pages are watching', async () => {
  const t = table();
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'bets').length, 1);
  t.advance(1000);
  for (let i = 0; i < 20; i++) await t.wheel.view();
  assert.equal(t.calls.filter(call => call === 'bets').length, 2);
});

test('a failed spin is tried again, and places the same casino bet', async () => {
  const t = table();
  await t.wheel.view();
  for (const uname of ['a', 'b', 'c', 'd']) t.bet({ uname });
  await t.wheel.placed();
  t.advance(BETTING_MS);
  t.fail(new Error('casino unavailable'));
  await assert.rejects(t.wheel.alarm(), /casino unavailable/);
  assert.ok(t.wakes.at(-1)! > t.deps.now(), 'it asks to be woken again');
  t.fail(null);
  await t.wheel.alarm();
  assert.deepEqual(
    t.casinoBets.map(covers => covers.length),
    [4],
    'every bet on the round rode the one spin',
  );
});

test('a casino bet whose reply was lost is found on the round the wheel saved, even after a restart', async () => {
  const t = table();
  const opened = await t.wheel.view();
  const a = t.bet({ uname: 'a' });
  await t.wheel.placed();
  t.advance(BETTING_MS);
  t.loseReplies(true);
  await assert.rejects(t.wheel.alarm(), /reply lost/);
  t.loseReplies(false);
  // The Durable Object is evicted: a new wheel starts from what the old one saved. The round it saved is revealed,
  // so it shows where the ball landed, pays the bet on it and moves on to a new round.
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  const view = await woken.view();
  assert.equal(view.last!.round, opened.round);
  assert.notEqual(view.round, opened.round);
  assert.equal(t.paid.get(a), t.owed(opened.round!));
  assert.deepEqual(
    t.casinoBets.map(covers => covers.length),
    [1],
    'placed once',
  );
});

test('a wheel whose saved round the casino does not know moves on to a new round', async () => {
  const t = table();
  const woken = new Wheel(t.deps, { last: null, round: '0x' + 'e'.repeat(64) });
  const view = await woken.view();
  assert.equal(view.last, null, 'a round the casino lost has no spin to show');
  assert.equal(t.saves.at(-1)!.round, view.round, 'and the new round is saved');
});

test('a wheel woken from storage carries on with the last spin it made', async () => {
  const t = table();
  await t.wheel.view();
  t.bet();
  await t.wheel.placed();
  t.advance(BETTING_MS);
  await t.wheel.alarm();
  const woken = new Wheel(t.deps, structuredClone(t.saves.at(-1)!));
  assert.deepEqual((await woken.view()).last, (await t.wheel.view()).last);
});
