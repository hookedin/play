import test from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  divide,
  fraction,
  OUTCOME_SPACE,
  compileGame,
  compileGameAsync,
  createBlackjack,
  createMines,
  evaluatePolicy,
  getNode,
  optimalExpectedValuePolicy,
  prepareAction,
  resolveTransition,
  simulateServerResult,
} from '../src/engine/index.ts';
import { admits } from '../src/admits.ts';
import { assessRound } from '../../protocol/risk.ts';
import { blackjackFunding } from '../src/generated/blackjack-funding.ts';

const UNIT = 10n ** 18n;
const ZERO = fraction(0n);
const ONE = fraction(1n);
const options = { admits, bankrollFloor: 1_000_000n * UNIT, cashQuantum: 10n ** 9n, initialCash: UNIT };
const graph = createBlackjack({ stake: UNIT });
// The suite's one full blackjack compile: the generator's rules at the table's scale.
const scale = UNIT / blackjackFunding.initialCash;
const plan = compileGame(graph, {
  admits,
  bankrollFloor: blackjackFunding.bankrollFloor * scale,
  cashQuantum: blackjackFunding.cashQuantum * scale,
  initialCash: UNIT,
});

test('the committed blackjack funding table is what the current rules and compiler produce', () => {
  const decisions = plan.nodes.filter(node => node.kind === 'decision');
  assert.deepEqual(Object.keys(blackjackFunding.actions), decisions.map(node => node.id).sort());
  for (const node of decisions)
    assert.deepEqual(
      node.actions.map(action => action.requiredCash),
      blackjackFunding.actions[node.id].map(cash => cash * scale),
      node.id,
    );
  assert.equal(plan.initialCash, blackjackFunding.initialCash * scale);
  assert.equal(plan.conservativeBankroll, blackjackFunding.conservativeBankroll * scale);
});

test('every blackjack action is one admitted bet whose ranges name each successor state at its stated odds', () => {
  let bets = 0,
    most = 0;
  for (const source of graph.nodes) {
    if (source.kind !== 'decision') continue;
    const priced = getNode(plan, source.id);
    assert.equal(priced.kind, 'decision');
    for (const action of source.actions) {
      const pricedAction: any = (priced as any).actions.find((value: any) => value.id === action.id);
      const step: import('../src/engine/index.ts').TransitionPlan = pricedAction.transition;
      assert.deepEqual(
        step.outcomes.map(o => [o.next, o.label, o.probability]),
        action.outcomes.filter(o => o.probability.n > 0n).map(o => [o.next, o.label, o.probability]),
        'every original successor and card label survives, in order',
      );
      if (step.kind !== 'bet') continue;
      let edge = 0n;
      for (const s of step.successors) {
        // A card's share of the outcome space is its probability to within one outcome in 2^64.
        const exact = (s.probability.n * OUTCOME_SPACE) / s.probability.d,
          width = s.rangeEnd - s.rangeStart;
        assert.ok(s.rangeStart === edge && (width === exact || width === exact + 1n));
        edge = s.rangeEnd;
        assert.equal(s.cash, getNode(plan, s.next).cash);
      }
      assert.equal(edge, OUTCOME_SPACE);
      assert.equal(step.bet.stake, priced.cash + pricedAction.additionalCash - step.retained);
      // The casino's own rule admits the step at the planning floor, and no step can cost the
      // bankroll more than the conservative starting bound allows for.
      const risk = assessRound({ bankroll: plan.bankrollFloor, bets: [step.bet] });
      assert.ok(risk.liability - risk.totalFee < plan.maximumCash);
      most = Math.max(most, step.bet.prizes.length);
      bets++;
    }
  }
  assert.ok(bets > 1000);
  assert.ok(most <= 64, `at most ${most} prizes in one step`);
});

test('backward funding covers all choices while exact terminal EV depends on the player policy', () => {
  assert.equal(plan.nodes.length, 14065);
  assert.equal(plan.maximumDepth, 52);
  assert.equal(plan.maximumCash, 8n * UNIT);
  assert.equal(plan.requiredCash, 999452000000000000n);
  const best = evaluatePolicy(plan, optimalExpectedValuePolicy(plan));
  assert.deepEqual(
    divide(best.netEV, fraction(UNIT)),
    fraction(-40248916821673328324125295n, 7056410014866816666030739693n),
  );
  assert(best.expectedAdditionalCash.n > 0n);
  assert.deepEqual(
    best.distribution.reduce((total, item) => add(total, item.probability), ZERO),
    ONE,
  );
  assert(best.expectedAtomicBets.n > 4n * best.expectedAtomicBets.d);
  assert.throws(() => evaluatePolicy(plan, () => 'split'), /invalid policy action/);
});

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
  const left = prepareAction(equal, state, 'draw', () => 0n);
  const right = prepareAction(equal, state, 'draw', limit => limit - 1n);
  assert.equal(left.kind, 'noop');
  assert.equal(right.kind, 'noop');
  assert.equal(resolveTransition(left).state.nodeId, 'left');
  assert.equal(resolveTransition(right).state.nodeId, 'right');
  // No money rides on that choice, which is the only one the library ever draws for itself.
  assert.throws(() => prepareAction(equal, state, 'draw'), /injected RNG is required/);
});

test('a step needs no randomness of its own, fails before it is built, and is immutable', () => {
  const state = { nodeId: plan.root, cash: plan.initialCash, bankroll: plan.conservativeBankroll };
  assert.throws(() => prepareAction(plan, state, 'double'), /illegal action/);
  assert.throws(() => prepareAction(plan, { ...state, cash: state.cash - 1n }, 'deal'), /funded/);
  assert.throws(() => prepareAction(plan, { ...state, bankroll: plan.bankrollFloor - 1n }, 'deal'), /planning floor/);
  const step = prepareAction(plan, state, 'deal');
  assert(Object.isFrozen(step) && Object.isFrozen(step.before));
  assert.equal(step.kind, 'bet');
  // The same action is always the same bet: there is no ticket to protect or to redraw.
  assert.deepEqual(prepareAction(plan, state, 'deal'), step);
  assert.throws(() => resolveTransition(step), /64-bit outcome/);
  assert.throws(() => resolveTransition(step, OUTCOME_SPACE), /64-bit outcome/);
  assert.throws(() => resolveTransition({ ...step }, 0n), /returned by prepareAction/);
  assert.throws(() => simulateServerResult(step, () => -1n), /RNG result/);
  // A live bankroll the casino's rule would refuse stops the step before anything is signed.
  const coin = {
    root: 'flip',
    nodes: [
      {
        id: 'flip',
        kind: 'decision' as const,
        actions: [
          {
            id: 'toss',
            outcomes: [
              { next: 'heads', probability: fraction(1n, 2n) },
              { next: 'tails', probability: fraction(1n, 2n) },
            ],
          },
        ],
      },
      { id: 'heads', kind: 'terminal' as const, payout: 19n * UNIT },
      { id: 'tails', kind: 'terminal' as const, payout: 0n },
    ],
  };
  const live = 7n * options.bankrollFloor,
    refusing = compileGame(coin, {
      ...options,
      initialCash: 10n * UNIT,
      admits: (b, bet) => b !== live && admits(b, bet),
    });
  const ready = { nodeId: 'flip', cash: refusing.initialCash, bankroll: refusing.conservativeBankroll };
  assert.equal(prepareAction(refusing, ready, 'toss').kind, 'bet');
  assert.throws(() => prepareAction(refusing, { ...ready, bankroll: live }, 'toss'), /does not admit/);
});

test('every outcome lands on a funded state and moves exactly its prize between player and bankroll', () => {
  const state = { nodeId: plan.root, cash: plan.initialCash, bankroll: 2n * plan.conservativeBankroll };
  const step = prepareAction(plan, state, 'deal');
  assert.equal(step.kind, 'bet');
  if (step.kind !== 'bet') return;
  for (const s of step.successors)
    for (const outcome of [s.rangeStart, s.rangeEnd - 1n]) {
      const result = resolveTransition(step, outcome);
      assert.deepEqual([result.state.nodeId, result.label], [s.next, s.label]);
      assert.equal(result.state.cash, getNode(plan, s.next).cash);
      assert.equal(result.payout, s.cash - step.retained);
      assert.equal(result.state.cash + result.state.bankroll, state.cash + state.bankroll, 'commission aside');
      assert(result.state.bankroll >= plan.bankrollFloor);
    }
});

test('the extreme outcomes of every round complete funded blackjack paths', () => {
  const policies = [
    optimalExpectedValuePolicy(plan),
    (node: any) => node.actions.find((a: any) => a.id === 'hit')?.id ?? node.actions[0].id,
  ];
  for (const policy of policies)
    for (const outcome of [0n, OUTCOME_SPACE / 3n, OUTCOME_SPACE - 1n]) {
      let state = { nodeId: plan.root, cash: plan.initialCash, bankroll: plan.conservativeBankroll };
      let contributions = 0n;
      let steps = 0;
      const total = state.cash + state.bankroll;
      while (getNode(plan, state.nodeId).kind !== 'terminal') {
        const node = getNode(plan, state.nodeId);
        const step = prepareAction(plan, state, policy(node as any), () => 0n);
        const result = resolveTransition(step, step.kind === 'bet' ? outcome : undefined);
        contributions += step.additionalCash;
        state = result.state;
        assert.equal(state.cash, getNode(plan, state.nodeId).cash);
        assert.equal(state.cash + state.bankroll, total + contributions);
        assert(state.bankroll >= plan.bankrollFloor);
        assert(++steps <= plan.maximumDepth);
      }
      assert(plan.nodes.some(n => n.kind === 'terminal' && n.cash === state.cash));
    }
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
  const ticket = prepareAction(paymentPlan, state, 'pay', () => 0n);
  assert.equal(ticket.kind, 'payment');
  assert.equal(ticket.amount, UNIT / 2n);
  const result = resolveTransition(ticket);
  assert.equal(result.payment, UNIT / 2n);
  assert.equal(result.state.cash + result.state.bankroll, state.cash + state.bankroll);
  assert.equal(result.payout, 0n);
  assert.throws(() => resolveTransition(ticket, 0n), /has no outcome/);
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
  assert.throws(() => compileGame(graph, { ...options, admits: undefined as any }), /admission rule is required/);
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
  const ticket = prepareAction(
    sync,
    { nodeId: sync.root, cash: UNIT, bankroll: sync.conservativeBankroll },
    'double',
    () => 0n,
  );
  const after = resolveTransition(ticket);
  assert.equal(ticket.additionalCash, UNIT);
  assert.equal(after.state.cash + after.state.bankroll, UNIT * 2n + sync.conservativeBankroll);
  const invalid = structuredClone(game);
  invalid.nodes[0]!.actions![1]!.additionalCash = -1n;
  assert.throws(() => compileGame(invalid, options), /additional action cash/);
});
