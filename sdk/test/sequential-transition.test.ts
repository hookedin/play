import test from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  cashClasses,
  compare,
  compileTransition,
  fraction,
  landing,
  multiply,
  priceTransition,
  seededRandom,
  tableAdmits,
  UINT256_MAX,
  OUTCOME_SPACE,
} from '../src/engine/index.ts';
import type { Rational } from '../src/engine/index.ts';
import { admits } from '../src/admits.ts';
import { assessBet } from '../../protocol/risk.ts';

const ZERO = fraction(0n);
const ONE = fraction(1n);
const labeled = (cash: any, probability: any, next = `cash-${cash}`, label?: string) => ({
  cash,
  probability,
  next,
  ...(label === undefined ? {} : { label }),
});
const minus = (a: Rational, b: Rational) => add(a, fraction(-b.n, b.d));

/** A collapsed step, checked against the successors it was built from: every class is reached exactly as often as
 * its probability says, every bet keeps the cash of the class it can fall to and pays up to the class it can reach,
 * and the casino's own rule admits every bet. */
function verifyStep(step: any, bankroll: bigint) {
  assert.equal(step.kind, 'casino-bet');
  const reached = step.classes.map(() => ZERO);
  let total = ZERO;
  for (const branch of step.branches) {
    total = add(total, branch.weight);
    if (branch.kind === 'none') {
      assert.equal(step.classes[branch.class].cash, step.cash, 'only the cash already held is kept without a bet');
      reached[branch.class] = add(reached[branch.class], branch.weight);
      continue;
    }
    const { bet, win, lose } = branch,
      q = fraction(bet.chance, OUTCOME_SPACE);
    assert.equal(bet.stake, step.cash - step.classes[lose].cash, 'what can be lost is staked, the rest kept');
    assert.equal(bet.prize, step.classes[win].cash - step.classes[lose].cash, 'a win lands on the higher class');
    assert.ok(bet.chance > 0n && bet.chance < OUTCOME_SPACE);
    assert.ok(assessBet({ bankroll, bet }).fee >= 0n, 'the casino admits every bet');
    reached[win] = add(reached[win], multiply(branch.weight, q));
    reached[lose] = add(reached[lose], multiply(branch.weight, minus(ONE, q)));
  }
  assert.deepEqual(total, ONE, 'the branches are every way the step can go');
  for (const [i, c] of step.classes.entries()) assert.deepEqual(reached[i], c.probability, `class ${c.cash}`);
}
/** The whole step as one wager, E[X / (B + X)] >= 0, checked independently of the engine. */
function kelly(bankroll: bigint, cash: bigint, outcomes: any[]) {
  let sum = ZERO;
  for (const { cash: needed, probability } of outcomes) {
    const gain = cash - needed;
    if (bankroll + gain <= 0n) return false;
    sum = add(sum, multiply(probability, fraction(gain, bankroll + gain)));
  }
  return compare(sum, ZERO) >= 0;
}

test('a step collapses into binary bets that reach every successor exactly as often as the rules say', () => {
  const outcomes = [
    labeled(0n, fraction(1n, 2n)),
    labeled(90n, fraction(1n, 8n)),
    labeled(150n, fraction(1n, 4n)),
    labeled(400n, fraction(1n, 8n)),
  ];
  const cash = priceTransition({ bankroll: 100000n, outcomes, quantum: 1n });
  const step = compileTransition({ admits, bankroll: 100000n, cash, outcomes }) as any;
  verifyStep(step, 100000n);
  // Two classes below the cash, two above: every lower class paired with every higher one.
  assert.equal(step.classes.length, 4);
  assert.ok(step.branches.every((b: any) => b.kind === 'bet'));
  // The price is the least cash at which the step is one Kelly wager with room to round, and it exceeds the mean.
  const expected = outcomes.reduce((sum, o) => add(sum, multiply(fraction(o.cash), o.probability)), ZERO);
  assert.ok(kelly(100000n, cash, outcomes) && !tableAdmits(100000n, cash - 1n, cashClasses(outcomes)));
  assert.ok(compare(fraction(cash), expected) > 0, 'a finite bankroll prices risk above the expected value');
  // More cash than the price stakes more in every bet, and reaches the same classes as often.
  verifyStep(compileTransition({ admits, bankroll: 100000n, cash: cash + 50n, outcomes }), 100000n);
});

test('cash kept in every outcome is never staked, and the class at the cash already held needs no bet', () => {
  // A push keeps the cash; the worst case keeps 40: a bet stakes 60 to win up to 160 more.
  const outcomes = [labeled(40n, fraction(1n, 2n)), labeled(100n, fraction(1n, 4n)), labeled(200n, fraction(1n, 4n))];
  const step = compileTransition({ admits, bankroll: 10n ** 9n, cash: 100n, outcomes }) as any;
  verifyStep(step, 10n ** 9n);
  assert.deepEqual(
    step.branches.map((b: any) => (b.kind === 'none' ? ['none', b.weight] : [b.bet.stake, b.bet.prize])),
    [['none', fraction(1n, 4n)], ...step.branches.filter((b: any) => b.kind === 'bet').map(() => [60n, 160n])],
  );
  assert.deepEqual(step.betMass, fraction(3n, 4n), 'a bet is placed three times in four');
});

test('a step with nothing above its cash pairs every other class with the highest, and cannot cost the bankroll', () => {
  const outcomes = [labeled(10n, fraction(1n, 3n)), labeled(20n, fraction(1n, 3n)), labeled(50n, fraction(1n, 3n))];
  for (const cash of [50n, 80n]) {
    const step = compileTransition({ admits, bankroll: 1000n, cash, outcomes }) as any;
    verifyStep(step, 1000n);
    for (const branch of step.branches)
      assert.ok(branch.bet.prize <= branch.bet.stake, 'a win never pays more than the stake');
  }
});

test("successors that need the same cash share a class, and a settled bet's outcome picks among them", () => {
  const outcomes = [
    labeled(0n, fraction(1n, 4n), 'bust', 'king'),
    labeled(300n, fraction(1n, 4n), 'seventeen', 'seven of hearts'),
    labeled(300n, fraction(1n, 4n), 'soft-seventeen', 'six of spades'),
    labeled(0n, fraction(1n, 4n), 'bust-again', 'queen'),
  ];
  const step = compileTransition({ admits, bankroll: 10n ** 9n, cash: 200n, outcomes }) as any;
  verifyStep(step, 10n ** 9n);
  assert.deepEqual(
    step.classes.map((c: any) => [c.cash, c.outcomes.map((o: any) => o.next)]),
    [
      [0n, ['bust', 'bust-again']],
      [300n, ['seventeen', 'soft-seventeen']],
    ],
  );
  // The same outcome always lands on the same state, each state of a class is reachable, and what the page shows it
  // with is drawn apart from which state it is.
  const win = step.classes[1],
    seen = new Map<string, number>(),
    shown = new Map<string, Set<bigint>>();
  for (let outcome = 0n; outcome < 2000n; outcome++) {
    const { next, draw } = landing(win, outcome * 0x9e3779b97f4a7c15n);
    assert.deepEqual(landing(win, outcome * 0x9e3779b97f4a7c15n), { next, draw });
    seen.set(next.next, (seen.get(next.next) ?? 0) + 1);
    shown.set(next.next, (shown.get(next.next) ?? new Set()).add(seededRandom(draw)(8n)));
  }
  assert.deepEqual([...seen.keys()].sort(), ['seventeen', 'soft-seventeen']);
  for (const count of seen.values()) assert.ok(count > 850 && count < 1150, 'about as often as its probability');
  for (const values of shown.values()) assert.equal(values.size, 8, 'every view of every state');
});

test('a step that moves no money bets nothing: what is left over is an explicit payment', () => {
  const same = [labeled(70n, fraction(1n, 2n), 'left'), labeled(70n, fraction(1n, 2n), 'right')];
  assert.equal(priceTransition({ bankroll: 1000n, outcomes: same, quantum: 7n }), 70n, 'exactly, off the grid');
  const noop = compileTransition({ admits, bankroll: 1000n, cash: 70n, outcomes: same }) as any;
  assert.deepEqual([noop.kind, noop.amount, noop.successorCash], ['noop', 0n, 70n]);
  const payment = compileTransition({ admits, bankroll: 1000n, cash: 100n, outcomes: same }) as any;
  assert.deepEqual([payment.kind, payment.amount, payment.successorCash], ['payment', 30n, 70n]);
  assert.throws(() => compileTransition({ admits, bankroll: 1000n, cash: 69n, outcomes: same }), /does not cover/);
});

test('the price respects the cash grid and falls toward the expected value as the bankroll grows', () => {
  const outcomes = [labeled(0n, fraction(9n, 10n)), labeled(5000n, fraction(1n, 10n))];
  let previous = UINT256_MAX;
  for (const bankroll of [6000n, 20000n, 10n ** 6n, 10n ** 12n]) {
    const price = priceTransition({ bankroll, outcomes, quantum: 1n });
    assert.ok(price >= 500n, 'never below the expected value');
    assert.ok(price <= previous, 'a larger bankroll prices the same risk lower');
    previous = price;
    verifyStep(compileTransition({ admits, bankroll, cash: price, outcomes }), bankroll);
    const gridded = priceTransition({ bankroll, outcomes, quantum: 64n });
    assert.equal(gridded % 64n, 0n);
    assert.ok(gridded >= price && gridded < price + 64n);
  }
  assert.ok(previous < 510n, 'and approaches the expected value');
});

test('generated tables, with partial losses and rare jackpots, are priced, collapsed and verified exactly', () => {
  let steps = 0,
    seed = 12345n;
  const random = (limit: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    return seed % limit;
  };
  for (let trial = 0; trial < 120; trial++) {
    // Every third table has a jackpot about a hundred thousand times rarer than its other outcomes.
    const n = 2 + Number(random(9n)),
      rare = trial % 3 === 0,
      parts = Array.from({ length: n }, (_, i) =>
        rare && i === 1 ? 1n : (1n + random(1000n)) * (rare ? 100000n : 1n),
      ),
      total = parts.reduce((a, b) => a + b, 0n),
      outcomes = parts.map((part, i) =>
        labeled(i === 1 ? 1000n * (1n + random(10000n)) : random(4000n), fraction(part, total), `s${i}`),
      );
    const bankroll = 10n ** 9n * (1n + random(1000n)),
      cash = priceTransition({ bankroll, outcomes, quantum: 1n });
    assert.ok(kelly(bankroll, cash, outcomes), 'a priced step is a Kelly wager as a whole');
    const step = compileTransition({ admits, bankroll, cash, outcomes });
    if (step.kind !== 'casino-bet') continue;
    verifyStep(step, bankroll);
    steps++;
  }
  assert.ok(steps > 80);
});

test('invalid, underfunded and unplayable steps fail explicitly', () => {
  const ok = [labeled(0n, fraction(1n, 2n)), labeled(10n, fraction(1n, 2n))];
  assert.throws(() => compileTransition({ admits, bankroll: 1000n, cash: 5n, outcomes: [] }), /needs an outcome/);
  assert.throws(
    () => compileTransition({ admits, bankroll: 1000n, cash: 5n, outcomes: [labeled(0n, fraction(1n, 3n))] }),
    /sum to one/,
  );
  assert.throws(
    () =>
      compileTransition({
        admits,
        bankroll: 1000n,
        cash: 5n,
        outcomes: [labeled(0n, fraction(-1n, 2n)), labeled(1n, fraction(3n, 2n))],
      }),
    /negative/,
  );
  assert.throws(() => compileTransition({ admits, bankroll: 0n, cash: 5n, outcomes: ok }), /bankroll/);
  assert.throws(
    () => compileTransition({ admits, bankroll: 1000n, cash: 0n, outcomes: ok }),
    /does not cover the step/,
  );
  assert.throws(() => compileTransition({ admits: () => false, bankroll: 1000n, cash: 6n, outcomes: ok }), /finance/);
  assert.throws(() => priceTransition({ bankroll: 1000n, outcomes: ok, quantum: 0n }), /quantum/);
  // Staking the whole top prize cannot cost the bankroll anything, so every step has a price.
  const huge = [labeled(0n, fraction(1n, 2n)), labeled(5000n, fraction(1n, 2n))];
  assert.ok(priceTransition({ bankroll: 1000n, outcomes: huge, quantum: 1n }) <= 5000n);
  // A successor rarer than one outcome in 2^64 cannot be reached by a bet's chance.
  const rare = [
    labeled(0n, fraction(OUTCOME_SPACE * 4n - 1n, OUTCOME_SPACE * 4n)),
    labeled(10n, fraction(1n, OUTCOME_SPACE * 4n), 'rare'),
  ];
  assert.throws(() => compileTransition({ admits, bankroll: 10n ** 30n, cash: 1n, outcomes: rare }), /finer than one/);
  assert.equal(seededRandom(7n)(1000n), seededRandom(7n)(1000n), 'a seed draws the same value every time');
});
