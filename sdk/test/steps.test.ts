import test from 'node:test';
import assert from 'node:assert/strict';
import { children, levels, priceSteps, sideChance, stepBet, stepOutcome, stepsCash } from '../src/steps.ts';
import type { Side, StepNode, StepPlan } from '../src/steps.ts';
import { add, compare, fraction, multiply } from '../src/engine/index.ts';
import type { Rational } from '../src/engine/index.ts';
import { admits } from '../src/admits.ts';
import { OUTCOME_SPACE } from '../../protocol/risk.ts';

const Q = OUTCOME_SPACE;
const ONE = fraction(1n);
/** A repeatable pseudo-random owed amount per leaf, some leaves owing nothing. */
function owedOn(n: number, seed: number, most: bigint) {
  let state = seed;
  return Array.from({ length: n }, () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state % 3 === 0 ? 0n : (BigInt(state) * most) / 2n ** 31n;
  });
}
/** The nodes from the root to `leaf`, and the side of each that leads there. */
function route(n: number, leaf: number) {
  const levels: { node: StepNode; side: Side }[] = [];
  for (let node: StepNode = { lo: 0, hi: n }; node.hi - node.lo > 1;) {
    const [left, right] = children(node),
      side: Side = leaf < left.hi ? 'left' : 'right';
    levels.push({ node, side });
    node = side === 'left' ? left : right;
  }
  return levels;
}
/** What the step of `node` does to a walk heading to `side`: the step's bet, or a reveal, and an outcome of its round
 * that takes the walk there. */
function play(plan: StepPlan, node: StepNode, side: Side) {
  const bet = stepBet(plan, node),
    named = bet?.side ?? 'left',
    chance = sideChance(node, named);
  return { bet, named, chance, outcome: side === named ? chance - 1n : chance };
}

test('a walk ends holding exactly what is owed on its leaf, and the casino takes every bet on the way', () => {
  const bankroll = 10n ** 21n;
  for (const [n, owed] of [
    [37, owedOn(37, 1, 36n * 10n ** 18n)],
    [37, owedOn(37, 2, 10n ** 15n)],
    [37, Array.from({ length: 37 }, (_, i) => (i === 17 ? 36n * 10n ** 18n : 0n))],
    [2, [0n, 10n ** 18n]],
    [5, [3n, 1n, 4n, 1n, 5n]],
  ] as [number, bigint[]][]) {
    const plan = priceSteps(owed, bankroll);
    for (let leaf = 0; leaf < n; leaf++) {
      let cash = stepsCash(plan);
      for (const { node, side } of route(n, leaf)) {
        const { bet, named } = play(plan, node, side);
        if (!bet) continue;
        assert.ok(admits(bankroll, bet), 'the bankroll takes the bet');
        assert.ok(bet.stake <= cash, 'a step stakes only what the walk holds');
        cash += (side === named ? bet.prize : 0n) - bet.stake;
      }
      assert.equal(cash, owed[leaf], `leaf ${leaf} of ${n}`);
    }
  }
});

test('a walk takes at most as many rounds as the tree has levels', () => {
  assert.deepEqual([1, 2, 3, 5, 37, 64, 65].map(levels), [0, 1, 2, 3, 6, 6, 7]);
  for (const n of [2, 3, 5, 37])
    assert.equal(Math.max(...Array.from({ length: n }, (_, leaf) => route(n, leaf).length)), levels(n));
});

test('a walk that owes the same on every leaf only reveals its rounds', () => {
  const plan = priceSteps(Array(37).fill(5n), 10n ** 18n);
  assert.equal(stepsCash(plan), 5n);
  for (let leaf = 0; leaf < 37; leaf++) for (const { node } of route(37, leaf)) assert.equal(stepBet(plan, node), null);
  assert.deepEqual(priceSteps([7n], 10n ** 18n).owed, [7n]);
  assert.equal(stepsCash(priceSteps([7n], 10n ** 18n)), 7n);
});

test('the least cash a node needs is the least its bet between its children is admitted with', () => {
  const bankroll = 10n ** 20n,
    plan = priceSteps(owedOn(37, 3, 36n * 10n ** 18n), bankroll);
  for (let leaf = 0; leaf < 37; leaf++)
    for (const { node } of route(37, leaf)) {
      const bet = stepBet(plan, node);
      if (!bet) continue;
      assert.ok(!admits(bankroll, { ...bet, stake: bet.stake - 1n }), 'a wei less is refused');
    }
});

test('each pocket of a 37-pocket wheel is reached with its share of the outcomes, whichever sides the bets name', () => {
  for (const owed of [owedOn(37, 4, 10n ** 18n), Array(37).fill(0n)]) {
    const plan = priceSteps(owed, 10n ** 21n);
    let total = fraction(0n);
    for (let leaf = 0; leaf < 37; leaf++) {
      let reached: Rational = ONE;
      const steps = [];
      for (const { node, side } of route(37, leaf)) {
        const { bet, named, chance, outcome } = play(plan, node, side);
        reached = multiply(reached, fraction(side === named ? chance : Q - chance, Q));
        steps.push(bet ? { side: named, chance, outcome } : { outcome });
      }
      assert.equal(stepOutcome(37, steps), leaf, 'the verifier walks to the same pocket');
      // Each level rounds its chance down to a whole outcome, so a pocket is off its 1/37 by under one outcome in 2^64
      // per level.
      const off = add(reached, fraction(-1n, 37n));
      assert.ok(compare(off.n < 0n ? fraction(-off.n, off.d) : off, fraction(6n, Q)) < 0, `pocket ${leaf}`);
      total = add(total, reached);
    }
    assert.deepEqual(total, ONE);
  }
});

test('a verifier refuses steps that do not walk to one pocket', () => {
  const node = { lo: 0, hi: 37 },
    chance = sideChance(node, 'left');
  assert.throws(() => stepOutcome(37, [{ side: 'left', chance: chance + 1n, outcome: 0n }]), /share of the side/);
  assert.throws(() => stepOutcome(37, [{ side: 'up' as Side, outcome: 0n }]), /left or the right/);
  assert.throws(() => stepOutcome(37, [{ outcome: 0n }]), /stopped before/);
  assert.throws(() => stepOutcome(2, [{ outcome: 0n }, { outcome: 0n }]), /more steps/);
  assert.equal(stepOutcome(2, [{ outcome: sideChance({ lo: 0, hi: 2 }, 'left') }]), 1);
  assert.equal(stepOutcome(2, [{ side: 'right', chance: String(Q / 2n), outcome: '0' }]), 1);
  assert.throws(() => priceSteps([], 1n), /at least one outcome/);
  assert.throws(() => priceSteps([1n, -1n], 1n), /whole amount/);
  assert.throws(() => priceSteps([1n, 2n], 0n), /positive bankroll/);
  assert.throws(() => stepBet(priceSteps([1n, 2n], 10n ** 18n), { lo: 1, hi: 2 }), /two outcomes or more/);
});
