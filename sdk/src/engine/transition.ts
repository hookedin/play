import { add, compare, fraction } from './rational.ts';
import type { Rational } from './rational.ts';

export const UINT256_MAX = (1n << 256n) - 1n;
/** A round's outcome is a uniform integer below this. */
export const OUTCOME_SPACE = 1n << 64n;
/** The casino's cap on the prizes of one bet. */
export const MAX_PRIZES = 64;

/** Pays `payout` when the round's outcome falls in [rangeStart, rangeEnd). */
export interface Prize {
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
  readonly payout: bigint;
}
/** The casino's native wager: a stake paid to enter, and the prizes it can pay. */
export interface Bet {
  readonly stake: bigint;
  readonly prizes: readonly Prize[];
}
/** The casino's admission rule, supplied by the caller: would a bankroll of this size take this bet?
 * This library prices games against it and never assumes what it is. */
export type Admits = (bankroll: bigint, bet: Bet) => boolean;

/** A labeled successor and the credits required to continue from that state. */
export interface CashOutcome {
  readonly next: string;
  readonly label?: string;
  readonly cash: bigint;
  readonly probability: Rational;
}
/** A successor with the exact stretch of the outcome space that leads to it. */
export interface Successor extends CashOutcome {
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
}
export interface TransitionInput {
  readonly admits: Admits;
  readonly bankroll: bigint;
  readonly cash: bigint;
  readonly outcomes: readonly CashOutcome[];
}
/**
 * One step of a game is one native bet. The round's outcome picks the successor; the player stakes
 * the cash that successor could cost them and each better successor is a prize, so the cash after
 * the bet is exactly the successor's. A step whose successors all need the same cash moves no money:
 * nothing is bet, and what is left over is paid to the bankroll.
 */
export type TransitionPlan =
  | {
      readonly kind: 'bet';
      readonly cash: bigint;
      /** The cash kept whatever happens: the cheapest successor's. */
      readonly retained: bigint;
      readonly bet: Bet;
      readonly successors: readonly Successor[];
      readonly outcomes: readonly CashOutcome[];
    }
  | {
      readonly kind: 'noop' | 'payment';
      readonly cash: bigint;
      readonly successorCash: bigint;
      readonly amount: bigint;
      readonly outcomes: readonly CashOutcome[];
    };
export interface TransitionPriceInput {
  readonly admits: Admits;
  readonly bankroll: bigint;
  readonly outcomes: readonly CashOutcome[];
  /** Search grid, in the same integer currency units as all cash values. */
  readonly quantum: bigint;
}

function money(value: bigint, name: string, positive = false): void {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > UINT256_MAX)
    throw new RangeError(`${name} must be ${positive ? 'a positive' : 'a nonnegative'} uint256`);
}

function validate(outcomes: readonly CashOutcome[]): CashOutcome[] {
  if (!Array.isArray(outcomes) || outcomes.length === 0) throw new RangeError('a transition needs an outcome');
  let total = fraction(0n);
  for (const outcome of outcomes) {
    if (!outcome.next) throw new Error('a successor needs a state');
    money(outcome.cash, 'successor cash');
    if (compare(outcome.probability, fraction(0n)) < 0) throw new RangeError('negative transition probability');
    total = add(total, outcome.probability);
  }
  if (compare(total, fraction(1n)) !== 0) throw new RangeError('transition probabilities must sum to one');
  return outcomes.filter(outcome => outcome.probability.n > 0n);
}

/**
 * Lay the successors along the outcome space in their stated order. Widths are whole outcomes out
 * of 2^64: each successor gets the floor of its share and the few left over go, one each, to the
 * largest remainders. A probability that divides 2^64 is exact; any other is within 2^-64.
 */
export function apportion(outcomes: readonly CashOutcome[]): Successor[] {
  const live = validate(outcomes),
    shares = live.map(({ probability: p }, index) => ({
      index,
      width: (p.n * OUTCOME_SPACE) / p.d,
      remainder: (p.n * OUTCOME_SPACE) % p.d,
      d: p.d,
    }));
  let spare = OUTCOME_SPACE - shares.reduce((sum, share) => sum + share.width, 0n);
  for (const share of [...shares].sort((a, b) => {
    const order = b.remainder * a.d - a.remainder * b.d;
    return order > 0n ? 1 : order < 0n ? -1 : a.index - b.index;
  })) {
    if (spare === 0n) break;
    share.width += 1n;
    spare -= 1n;
  }
  let edge = 0n;
  return live.map((outcome, index) => {
    const width = shares[index]!.width;
    if (width === 0n) throw new RangeError('a successor is rarer than one outcome in 2^64');
    const successor = Object.freeze({ ...outcome, rangeStart: edge, rangeEnd: edge + width });
    edge += width;
    return successor;
  });
}

/** The prizes of a step do not depend on the cash brought to it: only the stake does. */
function table(successors: readonly Successor[]): { retained: bigint; prizes: Prize[] } {
  const retained = successors.reduce((low, s) => (s.cash < low ? s.cash : low), successors[0]!.cash),
    prizes: Prize[] = [];
  for (const { cash, rangeStart, rangeEnd } of successors) {
    if (cash === retained) continue;
    const last = prizes.at(-1);
    // Neighbouring successors that need the same cash are one prize.
    if (last && last.rangeEnd === rangeStart && last.payout === cash - retained)
      prizes[prizes.length - 1] = { ...last, rangeEnd };
    else prizes.push({ rangeStart, rangeEnd, payout: cash - retained });
  }
  if (prizes.length > MAX_PRIZES) throw new RangeError(`a step has at most ${MAX_PRIZES} distinct prizes`);
  return { retained, prizes };
}

/** The exact bet for one step taken with `cash`, or the payment when nothing is left to chance. */
export function compileTransition({ admits, bankroll, cash, outcomes }: TransitionInput): TransitionPlan {
  money(bankroll, 'bankroll', true);
  money(cash, 'cash');
  const successors = apportion(outcomes),
    live = Object.freeze(successors.map(({ rangeStart, rangeEnd, ...outcome }) => Object.freeze(outcome))),
    { retained, prizes } = table(successors);
  if (!prizes.length) {
    if (cash < retained) throw new RangeError('cash does not cover the successor state');
    return Object.freeze({
      kind: cash === retained ? 'noop' : 'payment',
      cash,
      successorCash: retained,
      amount: cash - retained,
      outcomes: live,
    });
  }
  if (cash <= retained) throw new RangeError('cash does not cover the step');
  const bet = Object.freeze({ stake: cash - retained, prizes: Object.freeze(prizes.map(p => Object.freeze(p))) });
  if (!admits(bankroll, bet)) throw new RangeError('cash does not finance this step at the planning bankroll');
  return Object.freeze({ kind: 'bet', cash, retained, bet, successors: Object.freeze(successors), outcomes: live });
}

/** The least cash on the grid whose bet the planning bankroll admits. A larger stake is never less
 * safe for the bankroll, so the search is a bisection, and the largest successor always suffices. */
export function priceTransition({ admits, bankroll, outcomes, quantum }: TransitionPriceInput): bigint {
  money(bankroll, 'bankroll', true);
  money(quantum, 'quantum', true);
  const { retained, prizes } = table(apportion(outcomes));
  // A step that moves no money costs exactly its successor's cash, without rounding.
  if (!prizes.length) return retained;
  const top = retained + prizes.reduce((most, prize) => (prize.payout > most ? prize.payout : most), 0n),
    fits = (cash: bigint) => admits(bankroll, { stake: cash - retained, prizes });
  let low = retained / quantum + 1n,
    high = (top + quantum - 1n) / quantum;
  if (!fits(high * quantum)) throw new RangeError('the planning bankroll cannot cover this step');
  while (low < high) {
    const middle = (low + high) / 2n;
    if (fits(middle * quantum)) high = middle;
    else low = middle + 1n;
  }
  return high * quantum;
}
