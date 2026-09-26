import test from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  addCard,
  blackjackState,
  cardProbability,
  compare,
  createBlackjack,
  dealerDistribution,
  divide,
  fraction,
  multiply,
} from '@hookedin/play/sdk/engine';
import type { GameAction, GameNode, Rational } from '@hookedin/play/sdk/engine';
import { loadFundedGame } from '@hookedin/play/sdk/engine';
import { blackjackFunding } from '@hookedin/play/sdk/generated/blackjack-funding';
import { admits, betReturn, RETURN_SCALE } from '@hookedin/play/sdk/admits';
import { blackjackTable, cardHand } from '../src/view.ts';
const ZERO = fraction(0n),
  ONE = fraction(1n),
  STAKE = 2n;
const GRAPH = createBlackjack({ stake: STAKE });
const NODES = new Map(GRAPH.nodes.map(node => [node.id, node]));
const sum = (values: Rational[]) => values.reduce(add, ZERO);
const num = (value: Rational) => Number(value.n) / Number(value.d);
const subtract = (a: Rational, b: Rational) => add(a, fraction(-b.n, b.d));
const probability = (rank: number) => fraction(rank === 10 ? 4n : 1n, 13n);
const ranks = Array.from({ length: 10 }, (_, i) => i + 1);
function decision(id: string) {
  const node = NODES.get(id)!;
  assert.equal(node.kind, 'decision');
  return node as Extract<GameNode, { kind: 'decision' }>;
}
function valueGraph() {
  const values = new Map<string, Rational>(),
    choices = new Map<string, string>();
  function value(id: string): Rational {
    if (values.has(id)) return values.get(id)!;
    const node = NODES.get(id)!;
    let best: Rational | undefined;
    if (node.kind === 'terminal') best = fraction(node.payout);
    else
      for (const a of node.actions) {
        const candidate = a.outcomes.reduce(
          (v, o) => add(v, multiply(o.probability, value(o.next))),
          fraction(-(a.additionalCash ?? 0n)),
        );
        if (!best || compare(candidate, best) > 0) {
          best = candidate;
          choices.set(id, a.id);
        }
      }
    values.set(id, best!);
    return best!;
  }
  return { rtp: divide(value(GRAPH.root), fraction(STAKE)), choices, values };
}
function round() {
  let id = GRAPH.root,
    contributed = STAKE;
  const events: { action: string; label?: string }[] = [];
  return {
    get id() {
      return id;
    },
    get node() {
      return NODES.get(id)!;
    },
    get state() {
      return blackjackState(id)!;
    },
    get contributed() {
      return contributed;
    },
    events,
    act(action: string, face?: number, suit = 0) {
      const a = decision(id).actions.find(a => a.id === action);
      assert(a, `missing ${action} at ${id}`);
      const outcome = face === undefined ? a.outcomes[0]! : a.outcomes.find(o => o.label?.endsWith(`:${face}:${suit}`));
      assert(outcome, `missing face ${face} at ${id}`);
      contributed += a.additionalCash ?? 0n;
      events.push({ action, ...(outcome.label === undefined ? {} : { label: outcome.label }) });
      id = outcome.next;
      return this;
    },
    deal(a: number, b: number, u: number) {
      return this.act('deal', a).act('deal', b).act('deal', u);
    },
  };
}
// This oracle uses all-aces-as-one totals plus an ace count, rather than the
// implementation's best-total/soft representation. Natural is a first-two-card
// event, tested separately before the ordinary dealer recursion starts.
function independentDealer(upcard: any) {
  const memo = new Map();
  function finish(rawTotal: any, aces: any) {
    const key = `${rawTotal}/${aces}`;
    if (memo.has(key)) return memo.get(key);
    const total = rawTotal + (aces > 0 && rawTotal <= 11 ? 10 : 0);
    if (total >= 17) return new Map([[total > 21 ? 'bust' : total, ONE]]);
    const result = new Map();
    for (let rank = 1; rank <= 10; rank += 1) {
      const probability = fraction(rank === 10 ? 4n : 1n, 13n);
      for (const [outcome, chance] of finish(rawTotal + rank, aces + (rank === 1 ? 1 : 0))) {
        result.set(outcome, add(result.get(outcome) ?? ZERO, multiply(probability, chance)));
      }
    }
    memo.set(key, result);
    return result;
  }
  const result = new Map();
  for (let rank = 1; rank <= 10; rank += 1) {
    const probability = fraction(rank === 10 ? 4n : 1n, 13n);
    const natural = (upcard === 1 && rank === 10) || (upcard === 10 && rank === 1);
    const conditional = natural
      ? new Map([['natural', ONE]])
      : finish(upcard + rank, (upcard === 1 ? 1 : 0) + (rank === 1 ? 1 : 0));
    for (const [outcome, chance] of conditional) {
      result.set(outcome, add(result.get(outcome) ?? ZERO, multiply(probability, chance)));
    }
  }
  return result;
}

// Independent exact calculation: raw totals/all aces as one, conditional dealer
// PMFs, and linear split EV. It does not use the graph or continuation compiler.
function independentRtp() {
  let ev = ZERO;
  for (const upcard of ranks) {
    const distribution = independentDealer(upcard),
      bj = distribution.get('natural') ?? ZERO;
    const clear = subtract(ONE, bj);
    const total = (raw: number, ace: boolean) => raw + (ace && raw <= 11 ? 10 : 0);
    const stand = (raw: number, ace: boolean) => {
      const hand = total(raw, ace);
      if (hand > 21) return fraction(-1n);
      let result = ZERO;
      for (const [dealer, p] of distribution)
        if (dealer !== 'natural')
          result = add(
            result,
            multiply(divide(p, clear), fraction(dealer === 'bust' || hand > dealer ? 1n : hand === dealer ? 0n : -1n)),
          );
      return result;
    };
    const memo = new Map<string, Rational>();
    function play(raw: number, ace: boolean, fresh: boolean): Rational {
      if (total(raw, ace) >= 21) return stand(raw, ace);
      const key = `${raw}/${ace}/${fresh}`;
      if (memo.has(key)) return memo.get(key)!;
      const hit = sum(ranks.map(r => multiply(probability(r), play(raw + r, ace || r === 1, false))));
      const choices = [stand(raw, ace), hit];
      if (fresh)
        choices.push(
          sum(ranks.map(r => multiply(probability(r), multiply(fraction(2n), stand(raw + r, ace || r === 1))))),
        );
      const best = choices.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
      memo.set(key, best);
      return best;
    }
    for (const a of ranks)
      for (const b of ranks) {
        let result;
        if ((a === 1 && b === 10) || (a === 10 && b === 1)) result = multiply(clear, fraction(3n, 2n));
        else {
          let best = play(a + b, a === 1 || b === 1, true);
          if (a === b) {
            const split = multiply(
              fraction(2n),
              sum(ranks.map(r => multiply(probability(r), a === 1 ? stand(a + r, true) : play(a + r, r === 1, true)))),
            );
            if (compare(split, best) > 0) best = split;
          }
          result = subtract(multiply(clear, best), bj);
        }
        ev = add(ev, multiply(multiply(probability(upcard), multiply(probability(a), probability(b))), result));
      }
  }
  return add(ONE, ev);
}

test('Stake completed-hand edge matches an independent exact optimal-play oracle', () => {
  const { rtp, choices } = valueGraph();
  assert.deepEqual(rtp, independentRtp());
  assert.deepEqual(rtp, fraction(7016161098045143337706614398n, 7056410014866816666030739693n));
  assert(Math.abs(100 * (1 - num(rtp)) - 0.57038801227359) < 1e-11);
  for (const node of GRAPH.nodes)
    if (blackjackState(node.id)?.phase === 'insurance') assert.equal(choices.get(node.id), 'decline-insurance');
});

test('all states are reachable, acyclic, normalized and have exact integer monetary terms', () => {
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    assert(!active.has(id));
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    const node = NODES.get(id);
    assert(node);
    if (node.kind === 'decision')
      for (const a of node.actions) {
        assert.deepEqual(sum(a.outcomes.map(o => o.probability)), ONE);
        assert((a.additionalCash ?? 0n) >= 0n);
        for (const o of a.outcomes) {
          assert(compare(o.probability, ZERO) > 0);
          visit(o.next);
        }
      }
    active.delete(id);
  }
  visit(GRAPH.root);
  assert.equal(visited.size, GRAPH.nodes.length);
  for (const stake of [0n, -2n, 1n, 3n]) assert.throws(() => createBlackjack({ stake }), /positive, even/);
});

test('ace arithmetic and the unconditional S17 dealer PMF match a separate recursion', () => {
  assert.deepEqual(addCard(addCard({ total: 0, soft: false }, 1), 1), { total: 12, soft: true });
  assert.deepEqual(addCard({ total: 17, soft: true }, 10), { total: 17, soft: false });
  for (const upcard of ranks)
    assert.deepEqual(
      new Map(dealerDistribution(upcard as any).map(o => [o.result, o.probability])),
      independentDealer(upcard),
    );
  assert.throws(() => addCard({ total: 22, soft: false }, 1), /unbusted/);
});

test('all 52 cards are independent equiprobable draws, and different faces/suits survive merged state IDs', () => {
  const outcomes = decision(GRAPH.root).actions[0]!.outcomes;
  assert.equal(outcomes.length, 52);
  assert.equal(new Set(outcomes.map(o => o.label)).size, 52);
  for (const o of outcomes) assert.deepEqual(o.probability, fraction(1n, 52n));
  assert.equal(
    outcomes.find(o => o.label === 'player:0:10:0')!.next,
    outcomes.find(o => o.label === 'player:0:13:3')!.next,
  );
});

test('double is only on two cards, costs one initial stake and deals exactly one card', () => {
  const r = round().deal(5, 6, 6);
  r.act('double', 10);
  assert.equal(r.contributed, 4n);
  assert.equal(r.state.phase, 'hole');
  assert.deepEqual(r.state.completed, [{ total: 21, multiplier: 2 }]);
  const hit = round().deal(2, 3, 6).act('hit', 4);
  assert.deepEqual(
    decision(hit.id).actions.map(a => a.id),
    ['stand', 'hit'],
  );
});

test('split is once only, permits doubling, and both hands use the same dealer', () => {
  const r = round()
    .deal(8, 8, 6)
    .act('split')
    .act('deal-split', 3)
    .act('double', 10)
    .act('deal-split', 2)
    .act('double', 10);
  assert.equal(r.contributed, 8n);
  assert.equal(r.state.phase, 'hole');
  r.act('reveal', 10).act('dealer-hit', 5);
  assert.deepEqual(r.node, { id: 'blackjack:payout:4', kind: 'terminal', payout: 4n });
  const view = blackjackTable(r.events);
  assert.deepEqual(
    view.hands.map(cardHand).map(h => h.total),
    [21, 20],
  );
  assert.deepEqual(view.doubled, [true, true]);
  assert.equal(cardHand(view.dealer).total, 21);
  const pair = round().deal(8, 8, 6).act('split').act('deal-split', 8);
  assert(!decision(pair.id).actions.some(a => a.id === 'split'));
  assert(decision(round().deal(10, 13, 6).id).actions.some(a => a.id === 'split'));
});

test('split aces get exactly one card, with ordinary 21 paying 1:1', () => {
  const r = round().deal(1, 1, 6).act('split').act('deal-split', 10);
  assert.equal(r.state.phase, 'split-deal');
  r.act('deal-split', 13);
  assert.equal(r.state.phase, 'hole');
  r.act('reveal', 10).act('dealer-hit', 10);
  assert.equal((r.node as any).payout, 8n);
  assert.equal(r.contributed, 4n);
});

test('insurance precedes peek and dealer blackjack ends the entire hand immediately', () => {
  const r = round().deal(8, 8, 1);
  assert.deepEqual(
    decision(r.id).actions.map(a => a.id),
    ['decline-insurance', 'insurance'],
  );
  assert.equal(decision(r.id).actions.find(a => a.id === 'insurance')!.additionalCash, 1n);
  r.act('insurance', 10);
  assert.equal(r.node.kind, 'terminal');
  assert.equal((r.node as any).payout, 3n);
  assert.equal(r.contributed, 3n);
  const natural = round().deal(1, 10, 1).act('insurance', 10);
  assert.equal((natural.node as any).payout, 5n);
  const push = round().deal(1, 10, 10).act('peek', 1);
  assert.equal((push.node as any).payout, 2n);
  const loss = round().deal(8, 8, 10).act('peek', 1);
  assert.equal((loss.node as any).payout, 0n);
});

test('failed insurance costs half a stake and hole cards are conditioned on a successful peek', () => {
  const r = round().deal(10, 10, 1).act('insurance').act('stand');
  assert.equal(r.contributed, 3n);
  const outcomes = decision(r.id).actions[0]!.outcomes;
  assert.equal(outcomes.length, 36);
  for (const o of outcomes) assert.deepEqual(o.probability, fraction(1n, 36n));
  assert(outcomes.every(o => Number(o.label!.split(':')[1]) < 10));
  r.act('reveal', 6);
  assert.equal((r.node as any).payout, 4n); // Dealer S17, player 20.
  const ten = round().deal(10, 10, 10).act('peek').act('stand');
  assert.equal(decision(ten.id).actions[0]!.outcomes.length, 48);
});

test('naturals pay 3:2 and an ordinary 21 pushes against dealer 21', () => {
  const natural = round().deal(1, 13, 6).act('reveal', 10);
  assert.equal((natural.node as any).payout, 5n);
  const ordinary = round().deal(5, 6, 6).act('hit', 10).act('reveal', 10).act('dealer-hit', 5);
  assert.equal((ordinary.node as any).payout, 2n);
  const bust = round().deal(10, 6, 6).act('hit', 10);
  assert.equal((bust.node as any).payout, 0n);
});

/**
 * A hand is played as one bet per step, and a step stakes the cash the hand holds above the class of
 * outcomes it can fall to, so what a single bet pays back is not what the hand pays back: a double
 * can be a bet that seldom pays, and standing charges the retained cash with no prize at all. A
 * player reading the measured return of one step is therefore reading that step, never the hand.
 * This test pins how far apart the two can be.
 */
test('a hand is not one bet: a step can pay back almost nothing', () => {
  const scale = 10n ** 15n / blackjackFunding.initialCash;
  const plan = loadFundedGame(createBlackjack({ stake: 10n ** 15n }), blackjackFunding, scale, admits);
  let worst = RETURN_SCALE,
    payments = 0;
  for (const node of plan.nodes) {
    if (node.kind !== 'decision') continue;
    for (const action of node.actions) {
      const step = action.transition;
      if (step.kind !== 'casino-bet') {
        if (step.amount > 0n) payments++;
        continue;
      }
      for (const branch of step.branches)
        if (branch.kind === 'bet' && betReturn(branch.bet) < worst) worst = betReturn(branch.bet);
    }
  }
  assert.ok(payments > 0, 'standing charges the hand with no prize: a debit that pays nothing back');
  assert.ok(worst < RETURN_SCALE / 2n, `the worst single bet pays back ${worst} millionths, nothing like the hand`);
});
