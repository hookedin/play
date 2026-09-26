import { add, compare, divide, fraction, multiply } from './rational.ts';
import type { Rational } from './rational.ts';

export const UINT256_MAX = (1n << 256n) - 1n;
/** A round's outcome is a uniform integer below this. */
export const OUTCOME_SPACE = 1n << 64n;

/** A casino bet: a stake paid to enter, and a prize it pays when the round's outcome is below its chance, counted
 * in outcomes out of 2^64. */
export interface Bet {
  readonly stake: bigint;
  readonly chance: bigint;
  readonly prize: bigint;
}
/** The casino's admission rule, supplied by the caller: would a bankroll of this size take this bet?
 * This library checks every bet it builds against it and never assumes what it is. */
export type Admits = (bankroll: bigint, bet: Bet) => boolean;

/** A labeled successor and the credits required to continue from that state. */
export interface CashOutcome {
  readonly next: string;
  readonly label?: string;
  readonly cash: bigint;
  readonly probability: Rational;
}
/** The successors of a step that need the same cash, and how likely they are together. */
export interface CashClass {
  readonly cash: bigint;
  readonly probability: Rational;
  readonly outcomes: readonly CashOutcome[];
}
/**
 * One way a step can go, drawn by the page before it signs anything, with the probability `weight`. A bet branch is
 * one casino bet between two classes: it keeps the cash of class `lose`, stakes the rest, and pays back up to the
 * cash of class `win` when the round's outcome is below its chance. A branch without a bet lands on its class and
 * moves no money.
 */
export type Branch =
  | { readonly kind: 'bet'; readonly weight: Rational; readonly bet: Bet; readonly win: number; readonly lose: number }
  | { readonly kind: 'none'; readonly weight: Rational; readonly class: number };
export interface TransitionInput {
  readonly admits: Admits;
  readonly bankroll: bigint;
  readonly cash: bigint;
  readonly outcomes: readonly CashOutcome[];
}
/**
 * One step of a game. A step whose successors all need the same cash moves no money: nothing is bet, and what is left
 * over is paid to the bankroll. Any other step is collapsed into branches the page draws from: the one it draws is a
 * single casino bet, or no bet at all, and whichever it is, every successor is reached exactly as often as the
 * rules say.
 */
export type TransitionPlan =
  | {
      readonly kind: 'casino-bet';
      readonly cash: bigint;
      readonly classes: readonly CashClass[];
      readonly branches: readonly Branch[];
      /** How likely the step is to place a bet: every branch but the one that keeps the cash. */
      readonly betMass: Rational;
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
  readonly bankroll: bigint;
  readonly outcomes: readonly CashOutcome[];
  /** Search grid, in the same integer currency units as all cash values. */
  readonly quantum: bigint;
}

const ZERO = fraction(0n);
const ONE = fraction(1n);
/** The margin pricing leaves on the losses: one part in 2^32, room for every bet to round its chance to whole
 * outcomes when its prize is under about 4·10^9 times its stake. */
const MARGIN = fraction((1n << 32n) + 1n, 1n << 32n);

function money(value: bigint, name: string, positive = false): void {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > UINT256_MAX)
    throw new RangeError(`${name} must be ${positive ? 'a positive' : 'a nonnegative'} uint256`);
}

function validate(outcomes: readonly CashOutcome[]): CashOutcome[] {
  if (!Array.isArray(outcomes) || outcomes.length === 0) throw new RangeError('a transition needs an outcome');
  let total = ZERO;
  for (const outcome of outcomes) {
    if (!outcome.next) throw new Error('a successor needs a state');
    money(outcome.cash, 'successor cash');
    if (compare(outcome.probability, ZERO) < 0) throw new RangeError('negative transition probability');
    total = add(total, outcome.probability);
  }
  if (compare(total, ONE) !== 0) throw new RangeError('transition probabilities must sum to one');
  return outcomes.filter(outcome => outcome.probability.n > 0n);
}

/** The successors that can happen, grouped by the cash they need, cheapest first. */
export function cashClasses(outcomes: readonly CashOutcome[]): CashClass[] {
  const classes = new Map<bigint, { probability: Rational; outcomes: CashOutcome[] }>();
  for (const outcome of validate(outcomes)) {
    const found = classes.get(outcome.cash);
    if (found) {
      found.probability = add(found.probability, outcome.probability);
      found.outcomes.push(outcome);
    } else classes.set(outcome.cash, { probability: outcome.probability, outcomes: [outcome] });
  }
  return [...classes]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([cash, { probability, outcomes }]) =>
      Object.freeze({ cash, probability, outcomes: Object.freeze(outcomes) }),
    );
}

/**
 * The whole step as one wager for the bankroll, at `cash`: the Kelly condition E[X / (B + X)] >= 0 over its classes,
 * where the bankroll gains X = cash − (a class's cash). It holds exactly when the step collapses into binary casino
 * bets the bankroll takes, and pricing asks for it with the losses weighed one part in 2^32 heavier, so that every
 * bet has room to round its chance to whole outcomes.
 */
export function tableAdmits(bankroll: bigint, cash: bigint, classes: readonly CashClass[]): boolean {
  // Σ p·X / (B + X), each loss weighed by the margin, summed over one common denominator without reducing it.
  let numerator = 0n,
    denominator = 1n;
  for (const { cash: needed, probability } of classes) {
    const gain = cash - needed;
    if (gain === 0n) continue;
    if (bankroll + gain <= 0n) return false;
    const n = probability.n * gain * (gain > 0n ? MARGIN.d : MARGIN.n),
      d = probability.d * (bankroll + gain) * MARGIN.d;
    numerator = numerator * d + n * denominator;
    denominator *= d;
  }
  return numerator >= 0n;
}

/** A bet that wins with probability `wins / total`, as whole outcomes out of 2^64: the chance rounded down, and one
 * outcome more for the share of the branch's weight that makes the mean exact. */
function rounded(
  weight: Rational,
  wins: bigint,
  total: bigint,
  bet: (chance: bigint) => Bet,
  win: number,
  lose: number,
) {
  const chance = (wins * OUTCOME_SPACE) / total,
    over = wins * OUTCOME_SPACE - chance * total;
  if (chance < 1n || chance + (over > 0n ? 1n : 0n) >= OUTCOME_SPACE)
    throw new RangeError('a step has odds finer than one outcome in 2^64');
  const branch = (share: Rational, chance: bigint): Branch =>
    Object.freeze({ kind: 'bet' as const, weight: multiply(weight, share), bet: bet(chance), win, lose });
  return over === 0n
    ? [branch(ONE, chance)]
    : [branch(fraction(total - over, total), chance), branch(fraction(over, total), chance + 1n)];
}

/**
 * Collapse a step into branches. With current cash c and bankroll B, a class below c, of probability ℓ, gains the
 * bankroll a = c − L when it is reached, and a class above c, of probability h, costs it b = H − c. Weigh each lower
 * class by A = (a / (B + a)) / C and each higher class by U = (b / (B − b)) / D, where C = Σ ℓ·a / (B + a) and
 * D = Σ h·b / (B − b). Pair every lower class j with every higher class i: the pair is drawn with weight
 * h_i·ℓ_j·(A_j + U_i), and its bet stakes a_j, keeps L_j and pays H_i − L_j with probability A_j / (A_j + U_i), which
 * in whole numbers is X / (X + Y) with X = a·(B − b)·D.n·C.d and Y = b·(B + a)·C.n·D.d. Each class is then reached
 * exactly as often as its probability says, and each bet is as sound for the bankroll as the whole step, which
 * `tableAdmits` guarantees. A class at c is reached with no bet. A step with no class above c pairs every other class
 * with the highest one, a bet the bankroll cannot lose.
 */
export function collapse(bankroll: bigint, cash: bigint, classes: readonly CashClass[]): Branch[] {
  const branches: Branch[] = [],
    lows = classes.flatMap((c, i) => (c.cash < cash ? [i] : [])),
    highs = classes.flatMap((c, i) => (c.cash > cash ? [i] : [])),
    equal = classes.findIndex(c => c.cash === cash);
  if (!highs.length) {
    const win = equal >= 0 ? equal : lows.at(-1)!,
      others = lows.filter(j => j !== win),
      spread = others.reduce((sum, j) => add(sum, classes[j]!.probability), ZERO),
      top = classes[win]!;
    for (const j of others) {
      const low = classes[j]!,
        weight = multiply(low.probability, divide(add(spread, top.probability), spread)),
        q = divide(top.probability, add(spread, top.probability));
      branches.push(
        ...rounded(
          weight,
          q.n,
          q.d,
          chance => ({ stake: cash - low.cash, chance, prize: top.cash - low.cash }),
          win,
          j,
        ),
      );
    }
    return branches;
  }
  if (!lows.length) throw new RangeError('cash does not finance this step');
  if (equal >= 0) branches.push(Object.freeze({ kind: 'none', weight: classes[equal]!.probability, class: equal }));
  const B = bankroll,
    a = (j: number) => cash - classes[j]!.cash,
    b = (i: number) => classes[i]!.cash - cash,
    C = lows.reduce((sum, j) => add(sum, multiply(classes[j]!.probability, fraction(a(j), B + a(j)))), ZERO),
    D = highs.reduce((sum, i) => add(sum, multiply(classes[i]!.probability, fraction(b(i), B - b(i)))), ZERO);
  for (const j of lows)
    for (const i of highs) {
      const X = a(j) * (B - b(i)) * D.n * C.d,
        Y = b(i) * (B + a(j)) * C.n * D.d,
        weight = multiply(
          multiply(classes[i]!.probability, classes[j]!.probability),
          fraction(X + Y, (B + a(j)) * (B - b(i)) * C.n * D.n),
        );
      branches.push(
        ...rounded(
          weight,
          X,
          X + Y,
          chance => ({ stake: a(j), chance, prize: classes[i]!.cash - classes[j]!.cash }),
          i,
          j,
        ),
      );
    }
  return branches;
}

/** The branches for one step taken with `cash`, each bet checked with the casino's rule at the planning bankroll, or
 * the payment when nothing is left to chance. */
export function compileTransition({ admits, bankroll, cash, outcomes }: TransitionInput): TransitionPlan {
  money(bankroll, 'bankroll', true);
  money(cash, 'cash');
  const classes = cashClasses(outcomes),
    live = Object.freeze(classes.flatMap(c => c.outcomes));
  if (classes.length === 1) {
    const needed = classes[0]!.cash;
    if (cash < needed) throw new RangeError('cash does not cover the successor state');
    return Object.freeze({
      kind: cash === needed ? 'noop' : 'payment',
      cash,
      successorCash: needed,
      amount: cash - needed,
      outcomes: live,
    });
  }
  if (cash <= classes[0]!.cash) throw new RangeError('cash does not cover the step');
  const branches = collapse(bankroll, cash, classes);
  for (const branch of branches)
    if (branch.kind === 'bet' && !admits(bankroll, branch.bet))
      throw new RangeError('cash does not finance this step at the planning bankroll');
  const kept = branches.find(branch => branch.kind === 'none');
  return Object.freeze({
    kind: 'casino-bet',
    cash,
    classes: Object.freeze(classes),
    branches: Object.freeze(branches),
    betMass: kept ? add(ONE, fraction(-kept.weight.n, kept.weight.d)) : ONE,
    outcomes: live,
  });
}

/** The least cash on the grid at which the whole step is one wager the planning bankroll admits, with the margin that
 * leaves every bet room to round. More cash is never less safe for the bankroll, so the search is a bisection, and
 * the largest successor's cash always suffices: the bankroll loses on no class. */
export function priceTransition({ bankroll, outcomes, quantum }: TransitionPriceInput): bigint {
  money(bankroll, 'bankroll', true);
  money(quantum, 'quantum', true);
  const classes = cashClasses(outcomes);
  // A step that moves no money costs exactly its successor's cash, without rounding.
  if (classes.length === 1) return classes[0]!.cash;
  const fits = (cash: bigint) => tableAdmits(bankroll, cash, classes);
  let low = classes[0]!.cash / quantum + 1n,
    high = (classes.at(-1)!.cash + quantum - 1n) / quantum;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (fits(middle * quantum)) high = middle;
    else low = middle + 1n;
  }
  return high * quantum;
}
