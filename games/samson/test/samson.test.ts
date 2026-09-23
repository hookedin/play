import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGame } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';
import { describeBet } from '@hookedin/play/sdk/admits';
import { betReturn } from '@hookedin/play/sdk/admits';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { RoundClient } from '@hookedin/play/sdk/round';
import {
  BONUS_SPINS,
  MACHINES,
  distribution,
  evaluate,
  nodeOutcome,
  outcomeOf,
  payoutStakes,
  sampleStops,
  slotGraph,
} from '../src/math.ts';
import type { Machine } from '../src/math.ts';

const keyOf = (machine: Machine, stops: number[]) => {
  const result = evaluate(machine, stops);
  return (result.win?.pay ?? 0) * 2 + Number(result.bonus);
};
/** Every stop combination, evaluated one window at a time: the rule the fast counter must reproduce. */
function bruteForce(machine: Machine) {
  const counts = new Map<number, number[][]>();
  const visit = (stops: number[]) => {
    if (stops.length < 5) {
      for (let stop = 0; stop < machine.strips[stops.length].length; stop++) visit([...stops, stop]);
      return;
    }
    const key = keyOf(machine, stops);
    counts.set(key, [...(counts.get(key) ?? []), stops]);
  };
  visit([]);
  return counts;
}
// Short strips with stacks, every wild multiplier and scatters, so all rules interact.
const small: Machine = {
  name: 'bonus',
  strips: ['LLAKHQJL', 'L2AKQJLA', 'LHAK3QLL', 'LAK2QJAL', 'LLAHKQJ'],
};

test('the grouped counter agrees with evaluating every window, outcome by outcome', () => {
  const brute = bruteForce(small),
    { counts, total } = distribution(small);
  assert.equal(total, 8 * 8 * 8 * 8 * 7);
  assert.deepEqual(
    new Map([...counts].sort(([a], [b]) => a - b)),
    new Map([...brute].map(([key, stops]) => [key, stops.length] as const).sort(([a], [b]) => a - b)),
  );
  assert.ok([...counts.keys()].some(key => outcomeOf(key).bonus && outcomeOf(key).pay > 0));
});

test('stops are drawn uniformly from exactly the combinations that pay the settled outcome', () => {
  const brute = bruteForce(small);
  for (const [key, combinations] of brute) {
    // Feeding every index once must return every matching combination once.
    const drawn = combinations.map((_, index) =>
      sampleStops(small, key, upper => {
        assert.equal(upper, BigInt(combinations.length));
        return BigInt(index);
      }).join(),
    );
    assert.deepEqual(new Set(drawn), new Set(combinations.map(stops => stops.join())), `outcome ${key}`);
  }
  assert.throws(() => sampleStops(small, 7 * 2, () => 0n), /cannot produce/);
});

test('the published machines return what the paytable states, exactly', () => {
  const expected = {
    base: { rtp: [490253039n, 509358726n], top: 1152 },
    bonus: { rtp: [3735679n, 3881115n], top: 6912 },
  };
  for (const machine of Object.values(MACHINES)) {
    const { counts, total } = distribution(machine);
    assert.equal(
      [...counts.values()].reduce((sum, ways) => sum + ways, 0),
      total,
    );
    const returned = [...counts].reduce((sum, [key, ways]) => sum + BigInt(ways) * BigInt(payoutStakes(key)), 0n);
    const [n, d] = expected[machine.name].rtp;
    assert.equal(returned * d, n * BigInt(total), `${machine.name} return to player`);
    assert.equal(Math.max(...[...counts.keys()].map(payoutStakes)), expected[machine.name].top);
    // Pricing one wager costs about the cube of the distinct payouts; the rules exist to keep this small.
    assert.ok(new Set([...counts.keys()].map(payoutStakes)).size <= 56, `${machine.name} distinct payouts`);
    console.log(
      `${machine.name}: RTP ${Number((returned * 10n ** 8n) / BigInt(total)) / 1e6}%, ${counts.size} outcomes, top ${expected[machine.name].top}x`,
    );
    for (const key of counts.keys()) {
      for (const pick of [0n, BigInt(counts.get(key)! - 1)])
        assert.equal(
          keyOf(
            machine,
            sampleStops(machine, key, () => pick),
          ),
          key,
          `${machine.name} outcome ${key}`,
        );
      assert.equal(payoutStakes(key), outcomeOf(key).pay + (outcomeOf(key).bonus ? BONUS_SPINS : 0));
    }
    // Wilds stay off the outer reels and honeycombs on reels one, three and five, as the paytable says.
    machine.strips.forEach((strip, reel) => {
      assert.equal(/[W23]/.test(strip), reel >= 1 && reel <= 3, `wilds on reel ${reel + 1}`);
      assert.equal(strip.includes('H'), reel % 2 === 0, `honeycombs on reel ${reel + 1}`);
    });
  }
});

test('a spin prices as one wager at the stake, even against a modest bankroll', () => {
  const stake = 10n ** 12n;
  for (const mode of ['base', 'bonus']) {
    const started = performance.now();
    const plan = compileGame(slotGraph({ stake: String(stake), mode }), {
      admits,
      bankrollFloor: 25000n * stake,
      cashQuantum: stake / 1000000000n,
      initialCash: stake,
    });
    assert.ok(plan.requiredCash <= stake, `${mode} needs ${plan.requiredCash}`);
    assert.equal(plan.maximumDepth, 1);
    // The spin is one bet the player signs whole: a prize per paying outcome, and its exact return.
    const [{ transition: step }] = (plan.nodes.find(n => n.id === plan.root) as any).actions;
    assert.equal(step.kind, 'bet');
    assert.equal(step.bet.stake, stake);
    assert.ok(step.bet.prizes.length <= 64 && step.bet.prizes.length >= 30, `${step.bet.prizes.length} prizes`);
    const { counts, total } = distribution(mode === 'bonus' ? MACHINES.bonus : MACHINES.base),
      fromReels = [...counts].reduce((sum, [key, ways]) => sum + BigInt(ways) * BigInt(payoutStakes(key)), 0n),
      signed = describeBet(step.bet).expectedPayout;
    // Reel odds do not divide 2^64; each outcome is off by less than one part in 2^64 of the space.
    const gap = signed * BigInt(total) - fromReels * stake * (1n << 64n);
    assert.ok(
      (gap < 0n ? -gap : gap) < BigInt(total) * BigInt(counts.size) * 6912n * stake,
      'the signed prize table is what the reels pay',
    );
    console.log(
      `${mode}: priced in ${Math.round(performance.now() - started)} ms, needs ${plan.requiredCash} of ${stake}`,
    );
  }
  assert.throws(() => slotGraph({ stake: '0' }), /greater than zero/);
});

test('spins settle through the atomic bridge in both modes and survive a reload', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('samson'));
  await w.setGameLimit('100000');
  const map = new Map<string, string>();
  const store = {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
    remove: (k: string) => void map.delete(k),
  };
  const bridge = {
    balance: async () => w.gameLimit(),
    // Exactly what the wallet answers with, so a game's view of the player is the real one.
    call: async (method: string, params: any = {}) =>
      method === 'wallet.hello'
        ? w.gameHello()
        : method === 'wallet.info'
          ? { ...w.gameInfo(), bankroll: '1000000000000' }
          : method === 'game.receipt'
            ? w.gameReceipt(params.id)
            : method === 'game.bet'
              ? w.gameBet(params)
              : w.gamePayment(params),
  };
  let round = new RoundClient(bridge, slotGraph, undefined, { store, name: 'samson' });
  const ids = new Set<string>();
  let expected = await w.balance();
  for (let spin = 0; spin < 12; spin++) {
    const mode = spin % 3 === 2 ? 'bonus' : 'base';
    let state = await round.start({ stake: '1000', mode });
    if (spin === 5) round = new RoundClient(bridge, slotGraph, undefined, { store, name: 'samson' });
    state = await round.action('spin');
    assert.equal(state.terminal, true);
    const outcome = nodeOutcome(state.nodeId)!;
    assert.equal(outcome.machine.name, mode);
    assert.equal(BigInt(state.cash), 1000n * BigInt(payoutStakes(outcome.key)));
    expected += BigInt(state.cash) - 1000n;
    assert.equal(await w.balance(), expected);
    ids.add(state.id);
    assert.equal((await round.restore())!.id, state.id, 'a reload sees the same round, so it is applied once');
  }
  assert.equal(ids.size, 12, 'every round has its own id');
  assert.equal(nodeOutcome('samson:base:ready'), null);
  assert.equal(nodeOutcome('dice:win'), null);
});

const GRAPHS = (stake: bigint) => ['base', 'bonus'].map(mode => slotGraph({ stake: String(stake), mode }));

/** Every step this game can ever place, at every stake it takes: the floor holds for each one, so it
 * is checked against all of them and not against a sample. */
/** The least any one bet of this game pays back, in millionths of its stake. The game publishes no
 * such figure — a promise nobody can verify is worth nothing, because no game bounds how often it
 * wagers what it holds — but its own table is held to it here, and every player sees the measured
 * return of each bet they actually signed. */
const FLOOR = 962400n;

test('every step pays back at least the floor this game is built to', () => {
  for (const stake of [1000n, 10n ** 6n, 10n ** 9n, 12345678901n, 10n ** 12n, 10n ** 15n, 10n ** 18n])
    for (const graph of GRAPHS(stake)) {
      const plan = compileGame(graph, {
        admits,
        bankrollFloor: 10n ** 9n * stake,
        cashQuantum: stake / 10n ** 9n || 1n,
        initialCash: stake,
      });
      for (const node of plan.nodes) {
        if (node.kind !== 'decision') continue;
        for (const action of node.actions) {
          const step = action.transition;
          // Every step is a bet that pays something back: this game never charges for nothing.
          assert.ok(step.kind === 'bet' || step.amount === 0n, `${node.id}/${action.id} charges for nothing`);
          if (step.kind !== 'bet') continue;
          assert.ok(
            betReturn(step.bet) >= FLOOR,
            `${node.id}/${action.id} at ${stake} wei pays back less than this game's floor`,
          );
        }
      }
    }
});
