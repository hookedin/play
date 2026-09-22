import { add, compare, divide, fraction, multiply } from './rational.ts';
import type { Rational } from './rational.ts';
import type { GameGraph, GameNode } from './model.ts';
import { apportion, compileTransition, priceTransition, UINT256_MAX, OUTCOME_SPACE } from './transition.ts';
import type { Admits, Bet, CashOutcome, Successor, TransitionPlan } from './transition.ts';

/** A uniform integer in [0, limit). Only a step that moves no money ever draws from it. */
export type RandomBelow = (limit: bigint) => bigint;

const ZERO = fraction(0n);
const ONE = fraction(1n);
const indexes = new WeakMap<GamePlan, ReadonlyMap<string, PricedNode>>();

export interface PricedAction {
  readonly id: string;
  readonly additionalCash: bigint;
  readonly requiredCash: bigint;
  readonly transition: TransitionPlan;
}
export type PricedNode =
  | { readonly id: string; readonly kind: 'terminal'; readonly cash: bigint; readonly depth: 0 }
  | {
      readonly id: string;
      readonly kind: 'decision';
      readonly cash: bigint;
      readonly depth: number;
      readonly actions: readonly PricedAction[];
    };
export interface GamePlan {
  readonly admits: Admits;
  readonly root: string;
  readonly bankrollFloor: bigint;
  readonly cashQuantum: bigint;
  readonly requiredCash: bigint;
  readonly initialCash: bigint;
  readonly maximumCash: bigint;
  readonly maximumDepth: number;
  /** Sufficient starting capital for one isolated play: the floor plus the most every step could pay. */
  readonly conservativeBankroll: bigint;
  readonly nodes: readonly PricedNode[];
}
export interface CompileOptions {
  /** The casino's admission rule. Every step is priced as the least cash whose bet it admits. */
  readonly admits: Admits;
  readonly bankrollFloor: bigint;
  readonly cashQuantum: bigint;
  readonly initialCash?: bigint;
}
/** Build-generated action prices, in graph action order. Not settlement authority. */
export interface FundingTable {
  readonly bankrollFloor: bigint;
  readonly cashQuantum: bigint;
  readonly initialCash: bigint;
  readonly conservativeBankroll: bigint;
  readonly actions: Readonly<Record<string, readonly bigint[]>>;
}

function money(value: bigint, name: string, positive = false): void {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > UINT256_MAX) {
    throw new RangeError(`${name} must be ${positive ? 'a positive' : 'a nonnegative'} uint256`);
  }
}

/** Price every legal action before any randomness is consumed. No network or wallet access. */
export function compileGame(graph: GameGraph, options: CompileOptions): GamePlan {
  const work = compileSteps(graph, options);
  for (;;) {
    const step = work.next();
    if (step.done) return step.value;
  }
}

/** Load exact integer-scaled funding; construct only transitions actually used. */
export function loadFundedGame(graph: GameGraph, table: FundingTable, scale: bigint, admits: Admits): GamePlan {
  money(scale, 'funding scale', true);
  const work = compileSteps(
    graph,
    {
      admits,
      bankrollFloor: table.bankrollFloor * scale,
      cashQuantum: table.cashQuantum * scale,
      initialCash: table.initialCash * scale,
    },
    table,
    scale,
  );
  for (;;) {
    const step = work.next();
    if (step.done) {
      if (step.value.conservativeBankroll !== table.conservativeBankroll * scale)
        throw new Error('Funding table does not match the game');
      return step.value;
    }
  }
}

/** The same exact compiler, yielding periodically so an iframe stays responsive. */
export async function compileGameAsync(graph: GameGraph, options: CompileOptions): Promise<GamePlan> {
  const work = compileSteps(graph, options);
  for (let count = 0; ; count++) {
    const step = work.next();
    if (step.done) return step.value;
    if (count % 32 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

function* compileSteps(
  graph: GameGraph,
  options: CompileOptions,
  table?: FundingTable,
  scale = 1n,
): Generator<void, GamePlan> {
  money(options.bankrollFloor, 'bankrollFloor', true);
  money(options.cashQuantum, 'cashQuantum', true);
  if (options.initialCash !== undefined) money(options.initialCash, 'initialCash');
  const input = new Map<string, GameNode>();
  for (const node of graph.nodes) {
    if (!node.id || input.has(node.id)) throw new Error('game node ids must be nonempty and unique');
    input.set(node.id, node);
  }
  const visiting = new Set<string>();
  const priced = new Map<string, PricedNode>();
  if (typeof options.admits !== 'function') throw new TypeError('the casino admission rule is required');
  // Many public card states lay the same cash along the outcome space. Reuse their exact price.
  const prices = new Map<string, bigint>();
  const cashKey = (outcomes: readonly CashOutcome[]): string =>
    apportion(outcomes)
      .map(s => `${s.cash}:${s.rangeEnd - s.rangeStart}`)
      .join(';');
  const transition = (cash: bigint, outcomes: readonly CashOutcome[]): TransitionPlan =>
    compileTransition({ admits: options.admits, bankroll: options.bankrollFloor, cash, outcomes });
  let requiredCash = 0n;
  function* visit(id: string): Generator<void, PricedNode> {
    const cached = priced.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error(`game must be acyclic: ${id}`);
    const source = input.get(id);
    if (!source) throw new Error(`missing game node: ${id}`);
    visiting.add(id);
    let node: PricedNode;
    if (source.kind === 'terminal') {
      money(source.payout, 'terminal payout');
      if (id === graph.root && options.initialCash !== undefined && options.initialCash !== source.payout) {
        throw new Error('a terminal root must already have its exact payout');
      }
      node = Object.freeze({ id, kind: 'terminal', cash: source.payout, depth: 0 });
      if (id === graph.root) requiredCash = source.payout;
    } else {
      if (source.kind !== 'decision' || source.actions.length === 0) throw new Error(`node ${id} needs an action`);
      const actionIds = new Set<string>();
      let depth = 0;
      let cash = 0n;
      const actions: {
        id: string;
        outcomes: CashOutcome[];
        requiredCash: bigint;
        additionalCash: bigint;
        key: string;
      }[] = [];
      const savedPrices = table?.actions[id];
      if (table && (!savedPrices || savedPrices.length !== source.actions.length))
        throw new Error(`Funding table is missing actions at ${id}`);
      for (const action of source.actions) {
        if (!action.id || actionIds.has(action.id)) throw new Error(`duplicate or empty action at ${id}`);
        actionIds.add(action.id);
        const additionalCash = action.additionalCash ?? 0n;
        money(additionalCash, 'additional action cash');
        if (action.outcomes.length === 0) throw new Error(`empty action at ${id}`);
        const outcomes: CashOutcome[] = [];
        for (const outcome of action.outcomes) {
          const probability = fraction(outcome.probability.n, outcome.probability.d);
          if (compare(probability, ZERO) < 0) throw new RangeError('negative transition probability');
          const child = yield* visit(outcome.next);
          if (probability.n > 0n) depth = Math.max(depth, child.depth + 1);
          outcomes.push(
            Object.freeze({
              next: child.id,
              cash: child.cash,
              probability,
              ...(outcome.label === undefined ? {} : { label: outcome.label }),
            }),
          );
        }
        let key = '',
          required: bigint;
        if (savedPrices) {
          required = savedPrices[actions.length]! * scale;
          money(required, 'precomputed action cash');
        } else {
          key = cashKey(outcomes);
          let needed = prices.get(key);
          if (needed === undefined) {
            needed = priceTransition({
              admits: options.admits,
              bankroll: options.bankrollFloor,
              outcomes,
              quantum: options.cashQuantum,
            });
            prices.set(key, needed);
          }
          required = needed > additionalCash ? needed - additionalCash : 0n;
        }
        cash = cash > required ? cash : required;
        actions.push({ id: action.id, outcomes, requiredCash: required, additionalCash, key });
      }
      if (id === graph.root) {
        requiredCash = cash;
        if (options.initialCash !== undefined) {
          if (options.initialCash < cash)
            throw new RangeError(`initialCash ${options.initialCash} is below required ${cash}`);
          cash = options.initialCash;
        }
      }
      node = Object.freeze({
        id,
        kind: 'decision',
        cash,
        depth,
        actions: Object.freeze(
          actions.map(action => {
            let cached = table ? undefined : transition(cash + action.additionalCash, action.outcomes);
            return Object.freeze({
              id: action.id,
              requiredCash: action.requiredCash,
              additionalCash: action.additionalCash,
              get transition() {
                return (cached ??= transition(cash + action.additionalCash, action.outcomes));
              },
            });
          }),
        ),
      });
    }
    visiting.delete(id);
    priced.set(id, node);
    yield;
    return node;
  }
  const root = yield* visit(graph.root);
  let maximumCash = 0n;
  for (const node of priced.values()) maximumCash = maximumCash > node.cash ? maximumCash : node.cash;
  const conservativeBankroll = options.bankrollFloor + BigInt(root.depth) * maximumCash;
  money(conservativeBankroll, 'conservativeBankroll', true);
  const plan: GamePlan = Object.freeze({
    admits: options.admits,
    root: root.id,
    bankrollFloor: options.bankrollFloor,
    cashQuantum: options.cashQuantum,
    initialCash: root.cash,
    requiredCash,
    maximumCash,
    maximumDepth: root.depth,
    conservativeBankroll,
    nodes: Object.freeze([...priced.values()]),
  });
  indexes.set(plan, priced);
  return plan;
}

export function getNode(plan: GamePlan, id: string): PricedNode {
  const map = indexes.get(plan);
  if (!map) throw new TypeError('use a plan returned by compileGame');
  const node = map.get(id);
  if (!node) throw new Error(`unknown node: ${id}`);
  return node;
}

export type Policy = (node: Extract<PricedNode, { kind: 'decision' }>) => string;
export interface PolicyEvaluation {
  readonly distribution: readonly { readonly payout: bigint; readonly probability: Rational }[];
  readonly expectedPayout: Rational;
  readonly expectedAdditionalCash: Rational;
  readonly netEV: Rational;
  readonly expectedAtomicBets: Rational;
  readonly expectedPayments: Rational;
}

/** Exact PMF propagation; this evaluates faithful completion, excluding optional early cash-out. */
export function evaluatePolicy(plan: GamePlan, policy: Policy): PolicyEvaluation {
  const cache = new Map<
    string,
    { pmf: Map<bigint, Rational>; bets: Rational; payments: Rational; additional: Rational }
  >();
  function evaluate(id: string): {
    pmf: Map<bigint, Rational>;
    bets: Rational;
    payments: Rational;
    additional: Rational;
  } {
    const cached = cache.get(id);
    if (cached) return cached;
    const node = getNode(plan, id);
    if (node.kind === 'terminal')
      return { pmf: new Map([[node.cash, ONE]]), bets: ZERO, payments: ZERO, additional: ZERO };
    const actionId = policy(node);
    const action = node.actions.find(value => value.id === actionId);
    if (!action) throw new Error(`invalid policy action ${actionId} at ${id}`);
    const pmf = new Map<bigint, Rational>();
    let bets = ZERO;
    let payments = ZERO;
    let additional = fraction(action.additionalCash);
    if (action.transition.kind === 'bet') bets = ONE;
    if (action.transition.kind === 'payment') payments = ONE;
    for (const outcome of action.transition.outcomes) {
      const child = evaluate(outcome.next);
      for (const [payout, probability] of child.pmf) {
        pmf.set(payout, add(pmf.get(payout) ?? ZERO, multiply(outcome.probability, probability)));
      }
      bets = add(bets, multiply(outcome.probability, child.bets));
      payments = add(payments, multiply(outcome.probability, child.payments));
      additional = add(additional, multiply(outcome.probability, child.additional));
    }
    const result = { pmf, bets, payments, additional };
    cache.set(id, result);
    return result;
  }
  const result = evaluate(plan.root);
  const distribution = [...result.pmf]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([payout, probability]) => Object.freeze({ payout, probability }));
  const expectedPayout = distribution.reduce(
    (value, outcome) => add(value, multiply(fraction(outcome.payout), outcome.probability)),
    ZERO,
  );
  return Object.freeze({
    distribution: Object.freeze(distribution),
    expectedPayout,
    expectedAdditionalCash: result.additional,
    netEV: add(add(expectedPayout, fraction(-plan.initialCash)), fraction(-result.additional.n, result.additional.d)),
    expectedAtomicBets: result.bets,
    expectedPayments: result.payments,
  });
}

/** Maximizes net EV, subtracting additional wagers. Funding covers ALL legal policies. */
export function optimalExpectedValuePolicy(plan: GamePlan): Policy {
  const choices = new Map<string, string>();
  const values = new Map<string, Rational>();
  function visit(id: string): Rational {
    const previous = values.get(id);
    if (previous) return previous;
    const node = getNode(plan, id);
    if (node.kind === 'terminal') return fraction(node.cash);
    let best = ZERO;
    let chosen: string | undefined;
    for (const action of node.actions) {
      const ev = action.transition.outcomes.reduce(
        (value, outcome) => add(value, multiply(outcome.probability, visit(outcome.next))),
        fraction(-action.additionalCash),
      );
      if (chosen === undefined || compare(ev, best) > 0) {
        chosen = action.id;
        best = ev;
      }
    }
    if (chosen === undefined) throw new Error('no policy action');
    choices.set(id, chosen);
    values.set(id, best);
    return best;
  }
  // Visit all states, including those unreachable under the selected root policy.
  for (const node of plan.nodes) visit(node.id);
  return node => {
    const choice = choices.get(node.id);
    if (choice === undefined) throw new Error(`policy does not cover ${node.id}`);
    return choice;
  };
}

function draw(random: RandomBelow, limit: bigint): bigint {
  const value = random(limit);
  if (typeof value !== 'bigint' || value < 0n || value >= limit)
    throw new RangeError('RNG result outside requested range');
  return value;
}
/** Exact sequential categorical draw; avoids a global LCM of weight denominators. */
export function selectWeighted<T>(items: readonly T[], weight: (item: T) => Rational, random: RandomBelow): T {
  if (typeof random !== 'function') throw new TypeError('an injected RNG is required');
  const positive = items.filter(item => weight(item).n > 0n);
  let remaining = positive.reduce((total, item) => add(total, weight(item)), ZERO);
  if (remaining.n <= 0n) throw new RangeError('empty probability distribution');
  for (let index = 0; index < positive.length; index += 1) {
    const item = positive[index];
    if (item === undefined) throw new Error('missing weighted item');
    if (index === positive.length - 1) return item;
    const conditional = divide(weight(item), remaining);
    if (draw(random, conditional.d) < conditional.n) return item;
    remaining = add(remaining, fraction(-weight(item).n, weight(item).d));
  }
  throw new Error('empty weighted distribution');
}

export interface RuntimeState {
  readonly nodeId: string;
  readonly cash: bigint;
  readonly bankroll: bigint;
}
interface PreparedBase {
  readonly before: RuntimeState;
  readonly actionId: string;
  readonly additionalCash: bigint;
}
export type PreparedTransition =
  | (PreparedBase & {
      readonly kind: 'bet';
      /** Exactly what the wallet signs: the stake and the prizes it can pay. */
      readonly bet: Bet;
      /** The cash kept whatever the outcome. */
      readonly retained: bigint;
      /** Where each stretch of the outcome space leads: the round's outcome names the next state. */
      readonly successors: readonly Successor[];
    })
  | (PreparedBase & {
      readonly kind: 'noop' | 'payment';
      readonly next: string;
      readonly label?: string | undefined;
      readonly cash: bigint;
      readonly amount: bigint;
    });
const preparedTransitions = new WeakSet<object>();

/** Choose an action FIRST. The bet it returns is the whole step: nothing is sampled, so there is
 * no ticket to protect. Only a step that moves no money and still has several successors draws
 * from `random`, and no cash rides on that draw. */
export function prepareAction(
  plan: GamePlan,
  state: RuntimeState,
  actionId: string,
  random?: RandomBelow,
): PreparedTransition {
  const node = getNode(plan, state.nodeId);
  if (node.kind !== 'decision') throw new Error('terminal state has no action');
  if (state.cash !== node.cash) throw new Error('state does not have its funded continuation balance');
  money(state.bankroll, 'live bankroll', true);
  if (state.bankroll < plan.bankrollFloor)
    throw new RangeError('available bankroll fell below the planning floor; stop before betting');
  const action = node.actions.find(value => value.id === actionId);
  if (!action) throw new Error(`illegal action: ${actionId}`);
  const step = action.transition,
    before = Object.freeze({ ...state });
  let prepared: PreparedTransition;
  if (step.kind === 'bet') {
    if (!plan.admits(state.bankroll, step.bet)) throw new RangeError('the live bankroll does not admit this step');
    prepared = Object.freeze({
      kind: 'bet',
      before,
      actionId,
      additionalCash: action.additionalCash,
      bet: step.bet,
      retained: step.retained,
      successors: step.successors,
    });
  } else {
    money(state.bankroll + step.amount, 'bankroll after payment', true);
    if (step.outcomes.length > 1 && typeof random !== 'function')
      throw new TypeError('this step chooses among equal-cash states: an injected RNG is required');
    const next =
      step.outcomes.length > 1 ? selectWeighted(step.outcomes, o => o.probability, random!) : step.outcomes[0]!;
    prepared = Object.freeze({
      kind: step.kind,
      before,
      actionId,
      additionalCash: action.additionalCash,
      next: next.next,
      label: next.label,
      cash: step.successorCash,
      amount: step.amount,
    });
  }
  preparedTransitions.add(prepared);
  return prepared;
}

export interface Resolution {
  readonly state: RuntimeState;
  readonly label?: string | undefined;
  /** What the bet's prizes paid, or zero. */
  readonly payout: bigint;
  readonly payment: bigint;
}
/** Pure reference accounting, NOT a transaction or proof of casino settlement/payment. The bankroll
 * it reports ignores the casino's commission, which only ever lowers it further. */
export function resolveTransition(prepared: PreparedTransition, outcome?: bigint): Resolution {
  if (!preparedTransitions.has(prepared)) throw new TypeError('use a transition returned by prepareAction');
  if (prepared.kind === 'bet') {
    if (typeof outcome !== 'bigint' || outcome < 0n || outcome >= OUTCOME_SPACE)
      throw new TypeError("the round's verified 64-bit outcome is required for a bet");
    const next = prepared.successors.find(s => outcome >= s.rangeStart && outcome < s.rangeEnd);
    if (!next) throw new Error('outcome has no successor');
    const payout = next.cash - prepared.retained;
    return Object.freeze({
      state: Object.freeze({
        nodeId: next.next,
        cash: next.cash,
        bankroll: prepared.before.bankroll + prepared.bet.stake - payout,
      }),
      label: next.label,
      payout,
      payment: 0n,
    });
  }
  if (outcome !== undefined) throw new TypeError('a step without a bet has no outcome');
  return Object.freeze({
    state: Object.freeze({
      nodeId: prepared.next,
      cash: prepared.cash,
      bankroll: prepared.before.bankroll + prepared.amount,
    }),
    label: prepared.label,
    payout: 0n,
    payment: prepared.amount,
  });
}

/** Demonstration only: production gets this outcome from the verified round. */
export function simulateServerResult(prepared: PreparedTransition, random: RandomBelow): bigint {
  if (prepared.kind !== 'bet') throw new Error('not a bet');
  if (typeof random !== 'function') throw new TypeError('an independent server RNG is required');
  return draw(random, OUTCOME_SPACE);
}

/** Adapt a secure byte source (crypto.getRandomValues) into an unbiased RandomBelow by rejection sampling. */
export function rngFromBytes(fill: (bytes: Uint8Array<ArrayBuffer>) => void): RandomBelow {
  if (typeof fill !== 'function') throw new TypeError('fill must be a function');
  return (limit: bigint): bigint => {
    if (typeof limit !== 'bigint' || limit < 1n) throw new RangeError('random limit must be a positive bigint');
    if (limit === 1n) return 0n;
    const bits = (limit - 1n).toString(2).length;
    const bytes = new Uint8Array(Math.ceil(bits / 8));
    const leadingMask = 0xff >>> (bytes.length * 8 - bits);
    for (;;) {
      for (let offset = 0; offset < bytes.length; offset += 65_536)
        fill(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)));
      bytes[0] = bytes[0]! & leadingMask;
      let value = 0n;
      for (const byte of bytes) value = (value << 8n) | BigInt(byte);
      if (value < limit) return value;
    }
  };
}
