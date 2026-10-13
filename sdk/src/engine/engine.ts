import { add, compare, fraction, multiply, wholeWeights } from './rational.ts';
import type { Rational } from './rational.ts';
import type { GameGraph, GameNode } from './model.ts';
import { cashClasses, compileTransition, priceTransition } from './transition.ts';
import { uint256 } from '../../../protocol/risk.ts';
import type { Admits, CashOutcome, TransitionPlan } from './transition.ts';

/** A uniform integer in [0, limit), such as `seededRandom` draws what the page shows a result with. */
export type RandomBelow = (limit: bigint) => bigint;

const ZERO = fraction(0n);
const ONE = fraction(1n);
const indexes = new WeakMap<GamePlan, ReadonlyMap<string, PricedNode>>();

interface PricedAction {
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
interface CompileOptions {
  /** The casino's admission rule. Every bet a step can place is checked against it at the planning bankroll. */
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
  uint256(scale, 'funding scale', true);
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
  uint256(options.bankrollFloor, 'bankrollFloor', true);
  uint256(options.cashQuantum, 'cashQuantum', true);
  if (options.initialCash !== undefined) uint256(options.initialCash, 'initialCash');
  const input = new Map<string, GameNode>();
  for (const node of graph.nodes) {
    if (!node.id || input.has(node.id)) throw new Error('game node ids must be nonempty and unique');
    input.set(node.id, node);
  }
  const visiting = new Set<string>();
  const priced = new Map<string, PricedNode>();
  if (typeof options.admits !== 'function') throw new TypeError('the casino admission rule is required');
  // Many public card states need the same cash with the same probabilities. Reuse their exact price.
  const prices = new Map<string, bigint>();
  const cashKey = (outcomes: readonly CashOutcome[]): string =>
    cashClasses(outcomes)
      .map(c => `${c.cash}:${c.probability.n}/${c.probability.d}`)
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
      uint256(source.payout, 'terminal payout');
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
        uint256(additionalCash, 'additional action cash');
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
          uint256(required, 'precomputed action cash');
        } else {
          key = cashKey(outcomes);
          let needed = prices.get(key);
          if (needed === undefined) {
            needed = priceTransition({ bankroll: options.bankrollFloor, outcomes, quantum: options.cashQuantum });
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
            // Built when first read: compiling needs only the prices, and a game plays few of its steps.
            let cached: TransitionPlan | undefined;
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
  uint256(conservativeBankroll, 'conservativeBankroll', true);
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
interface PolicyEvaluation {
  readonly distribution: readonly { readonly payout: bigint; readonly probability: Rational }[];
  readonly expectedPayout: Rational;
  readonly expectedAdditionalCash: Rational;
  readonly netEV: Rational;
  readonly expectedCasinoBets: Rational;
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
    if (action.transition.kind === 'casino-bet') bets = action.transition.betMass;
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
    expectedCasinoBets: result.bets,
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

interface RuntimeState {
  readonly nodeId: string;
  readonly cash: bigint;
  readonly bankroll: bigint;
}
/** A step as the wallet takes it: the action chosen, before anything is drawn, and its successors, each with a
 * whole-number weight in the proportions of its probability. A step whose successors need several amounts of cash is a
 * `casino-bet`: its table, which the wallet splits into casino bets, holds `cash`. One whose successors all need the
 * same cash moves no money, a `noop`, or pays the bankroll `amount`, what they do not need, a `payment`: either way they
 * need `cash`, and the wallet draws which of them it reaches when they are several. */
interface PreparedTransition {
  readonly before: RuntimeState;
  readonly actionId: string;
  readonly additionalCash: bigint;
  readonly kind: 'casino-bet' | 'noop' | 'payment';
  readonly cash: bigint;
  readonly amount: bigint;
  readonly outcomes: readonly CashOutcome[];
  readonly weights: readonly bigint[];
}
const preparedTransitions = new WeakSet<object>();

/** Choose an action FIRST: the step it takes, for the wallet to draw. The engine draws nothing: the wallet splits a
 * `casino-bet` into casino bets its quote covers, draws one, and lands on a successor with the seed of the bet it signs,
 * and draws which successor a step without a bet reaches when it has several. */
export function prepareAction(plan: GamePlan, state: RuntimeState, actionId: string): PreparedTransition {
  const node = getNode(plan, state.nodeId);
  if (node.kind !== 'decision') throw new Error('terminal state has no action');
  if (state.cash !== node.cash) throw new Error('state does not have its funded continuation balance');
  uint256(state.bankroll, 'live bankroll', true);
  if (state.bankroll < plan.bankrollFloor)
    throw new RangeError('available bankroll fell below the planning floor; stop before betting');
  const action = node.actions.find(value => value.id === actionId);
  if (!action) throw new Error(`illegal action: ${actionId}`);
  const step = action.transition,
    bet = step.kind === 'casino-bet';
  if (!bet) uint256(state.bankroll + step.amount, 'bankroll after payment', true);
  const prepared = Object.freeze({
    before: Object.freeze({ ...state }),
    actionId,
    additionalCash: action.additionalCash,
    kind: step.kind,
    cash: bet ? step.cash : step.successorCash,
    amount: bet ? 0n : step.amount,
    outcomes: step.outcomes,
    weights: Object.freeze(wholeWeights(step.outcomes.map(outcome => outcome.probability))),
  });
  preparedTransitions.add(prepared);
  return prepared;
}

interface Resolution {
  readonly state: RuntimeState;
  readonly label?: string | undefined;
}
/** Apply a prepared step as the wallet landed it: on `result`, the successor it reached, as its place in the step's
 * `outcomes`; a step with one successor takes none. Pure reference accounting, NOT a transaction or proof of casino
 * settlement/payment: the bankroll takes what the step held and its successor does not need. The bankroll it reports
 * ignores the casino's commission, which only ever lowers it further. */
export function resolveTransition(prepared: PreparedTransition, result?: bigint): Resolution {
  if (!preparedTransitions.has(prepared)) throw new TypeError('use a transition returned by prepareAction');
  const several = prepared.outcomes.length > 1;
  if (!several) {
    if (result !== undefined) throw new TypeError('a step with one successor draws nothing');
  } else if (typeof result !== 'bigint' || result < 0n || result >= BigInt(prepared.outcomes.length))
    throw new TypeError("the wallet's result is required");
  const next = prepared.outcomes[Number(result ?? 0n)]!,
    { before } = prepared,
    held = before.cash + prepared.additionalCash;
  return Object.freeze({
    state: Object.freeze({ nodeId: next.next, cash: next.cash, bankroll: before.bankroll + held - next.cash }),
    label: next.label,
  });
}

/** A RandomBelow drawn from a 64-bit seed, such as the value the wallet draws after a step's result: the SplitMix64
 * stream from the seed, rejection-sampled, so the same seed always draws the same values. For showing a result, never
 * for drawing one. */
export function seededRandom(seed: bigint): RandomBelow {
  let state = BigInt.asUintN(64, seed);
  const next = () => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
    let z = BigInt.asUintN(64, (state ^ (state >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  };
  return rngFromBytes(bytes => {
    for (let offset = 0; offset < bytes.length; offset += 8) {
      let word = next();
      for (let i = offset; i < Math.min(offset + 8, bytes.length); i++, word >>= 8n) bytes[i] = Number(word & 0xffn);
    }
  });
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
