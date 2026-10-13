import test from 'node:test';
import assert from 'node:assert/strict';
import {
  divide,
  fraction,
  compileGame,
  createMines,
  evaluatePolicy,
  getNode,
  optimalExpectedValuePolicy,
  prepareAction,
  resolveTransition,
} from '../src/engine/index.ts';
import { compileGameAsync } from '../src/engine/engine.ts';
import { splitStep } from '../src/engine/transition.ts';
import { drawStep } from '../../protocol/protocol.ts';
import { admits } from '../src/admits.ts';
import { coin } from './coin.ts';

const UNIT = 10n ** 18n;
const ZERO = fraction(0n);
const ONE = fraction(1n);
const options = { admits, bankrollFloor: 1_000_000n * UNIT, cashQuantum: 10n ** 9n, initialCash: UNIT };
/** A coin toss that pays 1.9 times: one step, one casino bet. */
const toss = coin({ action: 'toss', payout: () => 19n * UNIT })({ stake: 0n });
const plan = compileGame(toss, { ...options, initialCash: 10n * UNIT });

test('state labels with equal funding retain distinct subsequent choices', () => {
  const game = {
    root: 'root',
    nodes: [
      {
        id: 'root',
        kind: 'decision',
        actions: [
          {
            id: 'draw',
            outcomes: [
              { next: 'left', probability: fraction(1n, 3n) },
              { next: 'right', probability: fraction(2n, 3n) },
            ],
          },
        ],
      },
      { id: 'left', kind: 'decision', actions: [{ id: 'left-only', outcomes: [{ next: 'done', probability: ONE }] }] },
      {
        id: 'right',
        kind: 'decision',
        actions: [{ id: 'right-only', outcomes: [{ next: 'done', probability: ONE }] }],
      },
      { id: 'done', kind: 'terminal', payout: UNIT },
    ],
  };
  const equal = compileGame(game as any, options);
  const state = { nodeId: equal.root, cash: UNIT, bankroll: equal.conservativeBankroll };
  const step = prepareAction(equal, state, 'draw');
  assert.equal(step.kind, 'noop');
  // No money rides on that choice, and the wallet's draw makes it: each state as likely as its weight says.
  assert.deepEqual(step.weights, [1n, 2n]);
  assert.deepEqual(
    [0n, 1n].map(result => resolveTransition(step, result).state.nodeId),
    ['left', 'right'],
  );
  assert.throws(() => resolveTransition(step), /result is required/);
});

test('a step is a table of its successors, whole-number weights in the proportions of their chances, and is immutable', () => {
  const state = { nodeId: plan.root, cash: plan.initialCash, bankroll: plan.conservativeBankroll };
  assert.throws(() => prepareAction(plan, state, 'double'), /illegal action/);
  assert.throws(() => prepareAction(plan, { ...state, cash: state.cash - 1n }, 'toss'), /funded/);
  assert.throws(() => prepareAction(plan, { ...state, bankroll: plan.bankrollFloor - 1n }, 'toss'), /planning floor/);
  const step = prepareAction(plan, state, 'toss');
  assert(Object.isFrozen(step) && Object.isFrozen(step.before) && Object.isFrozen(step.weights));
  assert.equal(step.kind, 'casino-bet');
  assert.equal(step.cash, plan.initialCash);
  assert.deepEqual(step.weights, [1n, 1n]);
  // The same action is the same step, whatever the bankroll it is played at.
  assert.deepEqual(prepareAction(plan, { ...state, bankroll: 2n * state.bankroll }, 'toss'), {
    ...step,
    before: { ...state, bankroll: 2n * state.bankroll },
  });
  assert.throws(() => resolveTransition(step), /result is required/);
  assert.throws(() => resolveTransition(step, 2n), /result is required/);
  assert.throws(() => resolveTransition({ ...step }, 0n), /returned by prepareAction/);
});

test('a step lands on the successor the wallet drew, and the bankroll takes what it held and that one does not need', () => {
  const state = { nodeId: plan.root, cash: plan.initialCash, bankroll: 2n * plan.conservativeBankroll },
    step = prepareAction(plan, state, 'toss');
  step.outcomes.forEach((outcome, i) => {
    const result = resolveTransition(step, BigInt(i));
    assert.equal(result.state.nodeId, outcome.next);
    assert.equal(result.state.cash, outcome.cash);
    assert.equal(result.state.cash, getNode(plan, result.state.nodeId).cash);
    assert.equal(result.state.cash + result.state.bankroll, state.cash + state.bankroll, 'commission aside');
    assert(result.state.bankroll >= plan.bankrollFloor);
  });
  // The wallet splits the table into bets the live bankroll admits, and its seed draws one by its weight, the same seed
  // always the same one.
  const branches = splitStep({
      admits,
      bankroll: state.bankroll,
      cash: step.cash,
      results: step.outcomes.map((outcome, i) => ({ weight: step.weights[i]!, cash: outcome.cash })),
    }),
    seed = '0x' + '11'.repeat(32),
    weights = branches.map(branch => branch.weight);
  assert.ok(branches.every(branch => 'stake' in branch && admits(state.bankroll, branch)));
  assert.equal(drawStep(seed, weights), drawStep(seed, weights));
});

test('Mines uses the same engine and preserves stopping-policy payouts without payments', () => {
  const game = createMines({
    tiles: 5,
    mines: 1,
    cashouts: [(120n * UNIT) / 100n, (156n * UNIT) / 100n, (228n * UNIT) / 100n],
  });
  const mines = compileGame(game, options);
  for (const [picks, expected] of [
    [1, fraction(96n, 100n)],
    [2, fraction(936n, 1000n)],
    [3, fraction(912n, 1000n)],
  ]) {
    const ev = evaluatePolicy(mines, node => (node.id === `mines:picks:${picks}` ? 'cash-out' : 'reveal'));
    assert.deepEqual(divide(ev.expectedPayout, fraction(UNIT)), expected);
    assert.deepEqual(ev.expectedPayments, ZERO);
  }
});

test('a deterministic payment is explicit and conservative accounting transfers it to bankroll', () => {
  const graph = {
    root: 'start',
    nodes: [
      { id: 'start', kind: 'decision', actions: [{ id: 'pay', outcomes: [{ next: 'end', probability: ONE }] }] },
      { id: 'end', kind: 'terminal', payout: UNIT / 2n },
    ],
  };
  const paymentPlan = compileGame(graph as any, options);
  const state = { nodeId: 'start', cash: UNIT, bankroll: paymentPlan.conservativeBankroll };
  const ticket = prepareAction(paymentPlan, state, 'pay');
  assert.equal(ticket.kind, 'payment');
  assert.equal(ticket.amount, UNIT / 2n);
  const result = resolveTransition(ticket);
  assert.equal(result.state.bankroll, state.bankroll + UNIT / 2n);
  assert.equal(result.state.cash + result.state.bankroll, state.cash + state.bankroll);
  assert.throws(() => resolveTransition(ticket, 0n), /one successor draws nothing/);
});

test('malformed, cyclic, and underfunded game graphs fail before any execution', () => {
  const node = {
    id: 'root',
    kind: 'decision',
    actions: [{ id: 'again', outcomes: [{ next: 'root', probability: ONE }] }],
  };
  assert.throws(() => compileGame({ root: 'root', nodes: [node] as any }, options), /acyclic/);
  assert.throws(() => compileGame({ root: 'root', nodes: [] }, options), /missing/);
  assert.throws(() => compileGame({ root: 'root', nodes: [node, node] as any }, options), /unique/);
  assert.throws(
    () => compileGame(createMines({ tiles: 5, mines: 1, cashouts: [2n * UNIT] }), options),
    /below required/,
  );
  assert.throws(() => getNode({ ...plan }, plan.root), /returned by compileGame/);
  assert.throws(() => compileGame(toss, { ...options, admits: undefined as any }), /admission rule is required/);
  assert(Object.isFrozen(plan) && Object.isFrozen(plan.nodes));
});

test('additional wagers are included in net policy value and async pricing is identical', async () => {
  const game = {
    root: 'choice',
    nodes: [
      {
        id: 'choice',
        kind: 'decision' as const,
        actions: [
          { id: 'stand', outcomes: [{ next: 'push', probability: ONE }] },
          { id: 'double', additionalCash: UNIT, outcomes: [{ next: 'more-gross', probability: ONE }] },
        ],
      },
      { id: 'push', kind: 'terminal' as const, payout: UNIT },
      { id: 'more-gross', kind: 'terminal' as const, payout: (3n * UNIT) / 2n },
    ],
  };
  const sync = compileGame(game, options),
    asyncPlan = await compileGameAsync(game, options);
  assert.deepEqual(asyncPlan, sync);
  assert.equal(optimalExpectedValuePolicy(sync)(getNode(sync, sync.root) as any), 'stand');
  const doubled = evaluatePolicy(sync, () => 'double');
  assert.deepEqual(doubled.expectedAdditionalCash, fraction(UNIT));
  assert.deepEqual(doubled.netEV, fraction(-UNIT / 2n));
  const ticket = prepareAction(sync, { nodeId: sync.root, cash: UNIT, bankroll: sync.conservativeBankroll }, 'double');
  const after = resolveTransition(ticket);
  assert.equal(ticket.additionalCash, UNIT);
  assert.equal(after.state.cash + after.state.bankroll, UNIT * 2n + sync.conservativeBankroll);
  const invalid = structuredClone(game);
  invalid.nodes[0]!.actions![1]!.additionalCash = -1n;
  assert.throws(() => compileGame(invalid, options), /additional action cash/);
});
