import test from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  apportion,
  compare,
  compileTransition,
  fraction,
  multiply,
  priceTransition,
  UINT256_MAX,
  OUTCOME_SPACE,
} from '../src/engine/index.ts';
import { admits } from '../src/admits.ts';
import { assessBet, describeBet } from '../../protocol/risk.ts';

const ZERO = fraction(0n);
const labeled = (cash: any, probability: any, next = `cash-${cash}`, label?: string) => ({
  cash,
  probability,
  next,
  ...(label === undefined ? {} : { label }),
});
const width = (s: any): bigint => BigInt(s.rangeEnd) - BigInt(s.rangeStart);

/** A step is one bet: check the bet against the successors it was built from, outcome by outcome. */
function verifyStep(step: any, bankroll: bigint) {
  assert.equal(step.kind, 'casino-bet');
  const { bet, successors, retained, cash } = step;
  // The successors tile the outcome space in their stated order.
  let edge = 0n;
  for (const s of successors) {
    assert.equal(s.rangeStart, edge);
    assert.ok(width(s) > 0n);
    edge = s.rangeEnd;
    // Each successor's share of the space is its probability to within one outcome in 2^64.
    const exact = (s.probability.n * OUTCOME_SPACE) / s.probability.d;
    assert.ok(width(s) === exact || width(s) === exact + 1n, `${s.next} width`);
  }
  assert.equal(edge, OUTCOME_SPACE);
  // The stake is the cash that can be lost, and the cash after the bet is exactly the successor's.
  assert.equal(bet.stake, cash - retained);
  assert.equal(
    retained,
    successors.reduce((low: bigint, s: any) => (s.cash < low ? s.cash : low), successors[0].cash),
  );
  for (const s of successors)
    for (const outcome of [s.rangeStart, s.rangeEnd - 1n]) {
      const paid = bet.prizes.reduce(
        (sum: bigint, p: any) => (outcome >= p.rangeStart && outcome < p.rangeEnd ? sum + p.payout : sum),
        0n,
      );
      assert.equal(cash - bet.stake + paid, s.cash, `${s.next} at ${outcome}`);
    }
  // Prizes never overlap here and never pay nothing.
  for (const [i, prize] of bet.prizes.entries()) {
    assert.ok(prize.payout > 0n);
    if (i) assert.ok(prize.rangeStart >= bet.prizes[i - 1].rangeEnd);
  }
  // The casino's own rule admits it, and the expected cash after the bet is the successors' mean.
  assert.ok(assessBet({ bankroll, bet }).fee >= 0n);
  const mean = successors.reduce((sum: bigint, s: any) => sum + s.cash * width(s), 0n);
  assert.equal(describeBet(bet).expectedPayout + retained * OUTCOME_SPACE, mean);
}

test('a step is one bet whose prizes put the player on exactly the successor cash', () => {
  const outcomes = [
    labeled(0n, fraction(1n, 2n)),
    labeled(90n, fraction(1n, 8n)),
    labeled(150n, fraction(1n, 4n)),
    labeled(400n, fraction(1n, 8n)),
  ];
  const cash = priceTransition({ admits, bankroll: 100000n, outcomes, quantum: 1n });
  const step = compileTransition({ admits, bankroll: 100000n, cash, outcomes });
  verifyStep(step, 100000n);
  assert.equal((step as any).bet.prizes.length, 3, 'the cheapest successor is the absence of a prize');
  // These probabilities divide 2^64, so the step is exact: its expected cash is the rules' own.
  const expected = outcomes.reduce((sum, o) => add(sum, multiply(fraction(o.cash), o.probability)), ZERO);
  assert.deepEqual(fraction(describeBet((step as any).bet).expectedPayout, OUTCOME_SPACE), expected);
  // The price is the least cash the casino's rule admits: one unit less is refused, and it exceeds the mean.
  assert.throws(() => compileTransition({ admits, bankroll: 100000n, cash: cash - 1n, outcomes }), /does not finance/);
  assert.ok(compare(fraction(cash), expected) > 0, 'a finite bankroll prices risk above the expected value');
  // More cash than the price is the same prizes behind a larger stake.
  const rich = compileTransition({ admits, bankroll: 100000n, cash: cash + 50n, outcomes }) as any;
  assert.deepEqual(rich.bet.prizes, (step as any).bet.prizes);
  assert.equal(rich.bet.stake, (step as any).bet.stake + 50n);
});

test('cash kept in every outcome is never staked: only what can be lost is at risk', () => {
  // A push returns the stake and the worst case keeps 40: the bet is 60 to win up to 160 more.
  const outcomes = [labeled(40n, fraction(1n, 2n)), labeled(100n, fraction(1n, 4n)), labeled(200n, fraction(1n, 4n))];
  const step = compileTransition({ admits, bankroll: 10n ** 9n, cash: 100n, outcomes }) as any;
  verifyStep(step, 10n ** 9n);
  assert.equal(step.retained, 40n);
  assert.deepEqual(step.bet, {
    stake: 60n,
    prizes: [
      { rangeStart: OUTCOME_SPACE / 2n, rangeEnd: (OUTCOME_SPACE * 3n) / 4n, payout: 60n },
      { rangeStart: (OUTCOME_SPACE * 3n) / 4n, rangeEnd: OUTCOME_SPACE, payout: 160n },
    ],
  });
});

test("equal-cash successors keep their own stretch of the outcome space: the round's outcome names the state", () => {
  const outcomes = [
    labeled(0n, fraction(1n, 4n), 'bust', 'king'),
    labeled(300n, fraction(1n, 4n), 'seventeen', 'seven of hearts'),
    labeled(300n, fraction(1n, 4n), 'soft-seventeen', 'six of spades'),
    labeled(0n, fraction(1n, 4n), 'bust-again', 'queen'),
  ];
  const step = compileTransition({ admits, bankroll: 10n ** 9n, cash: 200n, outcomes }) as any;
  verifyStep(step, 10n ** 9n);
  assert.equal(step.bet.prizes.length, 1, 'neighbours that need the same cash are one prize');
  assert.deepEqual(
    step.successors.map((s: any) => [s.next, s.label, s.rangeStart / (OUTCOME_SPACE / 4n)]),
    [
      ['bust', 'king', 0n],
      ['seventeen', 'seven of hearts', 1n],
      ['soft-seventeen', 'six of spades', 2n],
      ['bust-again', 'queen', 3n],
    ],
  );
  assert.deepEqual(step.outcomes, outcomes);
});

test('probabilities that do not divide 2^64 are laid out to the nearest outcome, largest remainders first', () => {
  const thirteenths = Array.from({ length: 13 }, (_, i) => labeled(BigInt(i), fraction(1n, 13n), `rank-${i}`));
  const laid = apportion(thirteenths);
  assert.equal(laid.at(-1)!.rangeEnd, OUTCOME_SPACE);
  const widths = laid.map(width),
    floor = OUTCOME_SPACE / 13n;
  assert.deepEqual(new Set(widths), new Set([floor, floor + 1n]));
  assert.equal(
    BigInt(widths.filter(w => w === floor + 1n).length),
    OUTCOME_SPACE % 13n,
    'exactly the leftover outcomes',
  );
  assert.deepEqual(widths.slice(0, Number(OUTCOME_SPACE % 13n)), Array(Number(OUTCOME_SPACE % 13n)).fill(floor + 1n));
  // Unequal remainders: the largest remainder takes the spare outcome.
  const uneven = apportion([labeled(1n, fraction(1n, 3n), 'a'), labeled(2n, fraction(2n, 3n), 'b')]);
  assert.deepEqual(uneven.map(width), [OUTCOME_SPACE / 3n, (OUTCOME_SPACE * 2n) / 3n + 1n]);
  // A zero-probability successor takes no space; one rarer than a single outcome cannot be played.
  assert.equal(apportion([labeled(1n, ZERO, 'never'), labeled(2n, fraction(1n), 'always')]).length, 1);
  assert.throws(
    () =>
      apportion([
        labeled(1n, fraction(1n, OUTCOME_SPACE * 4n), 'rare'),
        labeled(2n, fraction(OUTCOME_SPACE * 4n - 1n, OUTCOME_SPACE * 4n)),
      ]),
    /rarer than one outcome/,
  );
});

test('a step that moves no money bets nothing: what is left over is an explicit payment', () => {
  const same = [labeled(70n, fraction(1n, 2n), 'left'), labeled(70n, fraction(1n, 2n), 'right')];
  assert.equal(priceTransition({ admits, bankroll: 1000n, outcomes: same, quantum: 7n }), 70n, 'exactly, off the grid');
  const noop = compileTransition({ admits, bankroll: 1000n, cash: 70n, outcomes: same }) as any;
  assert.deepEqual([noop.kind, noop.amount, noop.successorCash], ['noop', 0n, 70n]);
  const payment = compileTransition({ admits, bankroll: 1000n, cash: 100n, outcomes: same }) as any;
  assert.deepEqual([payment.kind, payment.amount, payment.successorCash], ['payment', 30n, 70n]);
  assert.throws(() => compileTransition({ admits, bankroll: 1000n, cash: 69n, outcomes: same }), /does not cover/);
});

test('the price follows the casino rule it is given, respects the cash grid and falls as the bankroll grows', () => {
  const outcomes = [labeled(0n, fraction(9n, 10n)), labeled(5000n, fraction(1n, 10n))];
  let previous = UINT256_MAX;
  for (const bankroll of [6000n, 20000n, 10n ** 6n, 10n ** 12n]) {
    const price = priceTransition({ admits, bankroll, outcomes, quantum: 1n });
    assert.ok(price >= 500n, 'never below the expected value');
    assert.ok(price <= previous, 'a larger bankroll prices the same risk lower');
    previous = price;
    // Exactly at the boundary of the rule: the price is admitted, one less is not.
    assert.ok(
      admits(bankroll, {
        stake: price,
        prizes: [{ rangeStart: (OUTCOME_SPACE * 9n) / 10n + 1n, rangeEnd: OUTCOME_SPACE, payout: 5000n }],
      }),
    );
    const gridded = priceTransition({ admits, bankroll, outcomes, quantum: 64n });
    assert.equal(gridded % 64n, 0n);
    assert.ok(gridded >= price && gridded < price + 64n);
  }
  assert.ok(previous < 510n, 'and approaches the expected value');
  // Another casino, another price: the library only ever asks the rule.
  const asked: bigint[] = [];
  const strict = (bankroll: bigint, bet: any) => (asked.push(bet.stake), bet.stake >= 4000n);
  assert.equal(priceTransition({ admits: strict, bankroll: 1n, outcomes, quantum: 1n }), 4000n);
  assert.ok(asked.length < 20, 'by bisection');
});

test('small generated distributions are priced, built and verified exactly, never by Monte Carlo tolerance', () => {
  let steps = 0;
  for (let seed = 1n; seed <= 60n; seed++) {
    const parts = [1n + (seed % 5n), 1n + ((seed * 7n) % 6n), 1n + ((seed * 11n) % 4n), 1n + ((seed * 13n) % 7n)],
      total = parts.reduce((a, b) => a + b, 0n),
      outcomes = parts.map((n, i) => labeled((BigInt(i) * seed * 37n) % 500n, fraction(n, total), `s${i}`));
    const bankroll = 5000n + seed * 1000n,
      cash = priceTransition({ admits, bankroll, outcomes, quantum: 1n }),
      step = compileTransition({ admits, bankroll, cash, outcomes });
    if (step.kind !== 'casino-bet') continue;
    verifyStep(step, bankroll);
    steps++;
  }
  assert.ok(steps > 50);
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
  assert.throws(() => compileTransition({ admits, bankroll: 1000n, cash: 2n, outcomes: ok }), /does not finance/);
  assert.throws(() => priceTransition({ admits, bankroll: 1000n, outcomes: ok, quantum: 0n }), /quantum/);
  // Staking the whole prize is always safe for the bankroll, so the casino's own rule always has a
  // price; a rule that admits nothing has none.
  const huge = [labeled(0n, fraction(1n, 2n)), labeled(5000n, fraction(1n, 2n))];
  assert.ok(priceTransition({ admits, bankroll: 1000n, outcomes: huge, quantum: 1n }) <= 5000n);
  assert.throws(
    () => priceTransition({ admits: () => false, bankroll: 1000n, outcomes: huge, quantum: 1n }),
    /cannot cover/,
  );
  // A bet holds at most 64 prizes; a step with more distinct, separated prizes cannot be one bet.
  const many = Array.from({ length: 130 }, (_, i) => labeled(i % 2 ? BigInt(i) : 0n, fraction(1n, 130n), `s${i}`));
  assert.throws(() => priceTransition({ admits, bankroll: 10n ** 9n, outcomes: many, quantum: 1n }), /at most 64/);
});
