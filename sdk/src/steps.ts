/**
 * Binary steps: how a game whose players share one draw, such as a roulette table, has the bankroll back all of it
 * with casino bets of one chance and one prize each. The table's n outcomes, equally likely, are the leaves of a fixed
 * balanced tree. A spin walks from the root to one leaf, one level per round, and each level is one casino bet of the
 * developer's, priced backward from what the developer owes on each leaf. The bet backs the child that needs more
 * cash, so whichever way its round goes, the developer then holds exactly what the rest of the walk needs, and at the
 * leaf exactly what it owes there.
 *
 * The leaf is a function of the rounds' outcomes and the side each bet named before its round was revealed, so anyone
 * can check a spin with `stepOutcome` from what the casino publishes.
 */
import { OUTCOME_SPACE } from '../../protocol/risk.ts';
import { admits } from './admits.ts';

/** A node of the tree: the outcomes [lo, hi). Its left child is [lo, mid) and its right [mid, hi), with
 * mid = lo + ⌊(hi − lo) / 2⌋. */
export interface StepNode {
  lo: number;
  hi: number;
}
export type Side = 'left' | 'right';
/** One level's casino bet from the developer's bank: its stake pays `prize` when the round's outcome is below
 * `chance`, and that outcome is the one that takes the walk to `side`. */
export interface StepBet {
  stake: bigint;
  chance: bigint;
  prize: bigint;
  side: Side;
}
/** The cash each node of the tree needs, priced against one bankroll. */
export interface StepPlan {
  readonly owed: readonly bigint[];
  readonly bankroll: bigint;
  readonly cash: ReadonlyMap<string, bigint>;
}

const key = ({ lo, hi }: StepNode) => `${lo}:${hi}`;
/** The most levels a walk over `n` outcomes takes: how many rounds one walk needs. */
export function levels(n: number): number {
  return n <= 1 ? 0 : 1 + Math.max(...children({ lo: 0, hi: n }).map(child => levels(child.hi - child.lo)));
}
/** The two children of a node of two outcomes or more. */
export function children({ lo, hi }: StepNode): [StepNode, StepNode] {
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi - lo < 2)
    throw new RangeError('a node splits two outcomes or more');
  const mid = lo + Math.floor((hi - lo) / 2);
  return [
    { lo, hi: mid },
    { lo: mid, hi },
  ];
}
/** The chance that takes the walk to `side` of a node: that child's share of the node's outcomes, in whole outcomes
 * out of 2^64. */
export function sideChance(node: StepNode, side: Side) {
  const [left, right] = children(node),
    child = side === 'left' ? left : right;
  return (OUTCOME_SPACE * BigInt(child.hi - child.lo)) / BigInt(node.hi - node.lo);
}
/** One level of the walk: an outcome below the chance of the side the level named reaches that side, and any other
 * the other side. A level with no bet names the left. */
export function next(node: StepNode, side: Side, outcome: bigint): StepNode {
  const [left, right] = children(node);
  return (side === 'left') === outcome < sideChance(node, side) ? left : right;
}

/**
 * The cash every node needs, backward from `owed`, what the developer owes on each leaf, against `bankroll`: a leaf
 * needs what is owed on it, a node whose children need the same cash needs that, and any other node the least cash
 * whose bet between its children the casino's rule admits. More cash is never less safe for the bankroll, and a stake
 * of the whole difference cannot lose it anything, so the search is a bisection.
 */
export function priceSteps(owed: readonly bigint[], bankroll: bigint): StepPlan {
  if (!owed.length || owed.some(amount => typeof amount !== 'bigint' || amount < 0n))
    throw new RangeError('a walk owes a whole amount on each of at least one outcome');
  if (typeof bankroll !== 'bigint' || bankroll <= 0n)
    throw new RangeError('a walk is priced against a positive bankroll');
  const cash = new Map<string, bigint>();
  const price = (node: StepNode): bigint => {
    let needed: bigint;
    if (node.hi - node.lo === 1) needed = owed[node.lo]!;
    else {
      const [left, right] = children(node).map(price) as [bigint, bigint];
      if (left === right) needed = left;
      else {
        const high = left > right ? left : right,
          low = left > right ? right : left,
          chance = sideChance(node, left > right ? 'left' : 'right');
        let least = low + 1n,
          most = high;
        while (least < most) {
          const middle = (least + most) / 2n;
          if (admits(bankroll, { stake: middle - low, chance, prize: high - low })) most = middle;
          else least = middle + 1n;
        }
        needed = most;
      }
    }
    cash.set(key(node), needed);
    return needed;
  };
  price({ lo: 0, hi: owed.length });
  return Object.freeze({ owed: Object.freeze([...owed]), bankroll, cash });
}
/** What a spin needs to start: the root's cash. */
export const stepsCash = (plan: StepPlan) => plan.cash.get(key({ lo: 0, hi: plan.owed.length }))!;
/** The casino bet of one level, or null where both children need the same cash and the level only reveals its
 * round. */
export function stepBet(plan: StepPlan, node: StepNode): StepBet | null {
  const [left, right] = children(node).map(child => plan.cash.get(key(child))!) as [bigint, bigint];
  if (left === right) return null;
  const low = left > right ? right : left,
    side: Side = left > right ? 'left' : 'right';
  return {
    stake: plan.cash.get(key(node))! - low,
    chance: sideChance(node, side),
    prize: (left > right ? left : right) - low,
    side,
  };
}
/** The leaf a spin's steps reach from the root of a tree of `n` outcomes, each step with the side it named, or none
 * for a reveal, and its round's outcome. A bet's chance must be its side's share. */
export function stepOutcome(
  n: number,
  steps: readonly { side?: Side; chance?: bigint | string; outcome: bigint | string }[],
): number {
  let node: StepNode = { lo: 0, hi: n };
  for (const step of steps) {
    if (node.hi - node.lo <= 1) throw new Error('A spin took more steps than its tree has levels');
    const side = step.side ?? 'left';
    if (side !== 'left' && side !== 'right') throw new Error('A step names the left or the right');
    if (step.chance !== undefined && BigInt(step.chance) !== sideChance(node, side))
      throw new Error("A step's chance is not the share of the side it named");
    node = next(node, side, BigInt(step.outcome));
  }
  if (node.hi - node.lo !== 1) throw new Error('A spin stopped before it reached an outcome');
  return node.lo;
}
