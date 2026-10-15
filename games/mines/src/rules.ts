import { compileGame, fraction } from '@hookedin/play/sdk/engine';
import type { GameAction, GameGraph, GameNode, Rational } from '@hookedin/play/sdk/engine';
import { pricing } from '@hookedin/play/sdk/round';

/** Five by five. */
export const TILES = 25;

/** Reveal-or-cash-out Mines over symmetric unrevealed tiles: `cashouts[k - 1]` is the gross cash after `k` safe
 * picks. */
export function createMines({
  tiles,
  mines,
  cashouts,
}: {
  readonly tiles: number;
  readonly mines: number;
  readonly cashouts: readonly bigint[];
}): GameGraph {
  if (!Number.isSafeInteger(tiles) || !Number.isSafeInteger(mines) || mines < 1 || mines >= tiles) {
    throw new RangeError('mines requires integer 0 < mines < tiles');
  }
  if (
    cashouts.length === 0 ||
    cashouts.length > tiles - mines ||
    cashouts.some(value => typeof value !== 'bigint' || value <= 0n)
  ) {
    throw new RangeError('provide one positive cashout per allowed safe pick');
  }
  const nodes: GameNode[] = [{ id: 'mines:loss', kind: 'terminal', payout: 0n }];
  for (let picked = 0; picked <= cashouts.length; picked += 1) {
    const actions: GameAction[] = [];
    if (picked > 0) {
      const payout = cashouts[picked - 1];
      if (payout === undefined) throw new Error('missing mines payout');
      const next = `mines:payout:${picked}`;
      nodes.push(Object.freeze({ id: next, kind: 'terminal', payout }));
      actions.push(
        Object.freeze({
          id: 'cash-out',
          outcomes: Object.freeze([Object.freeze({ next, probability: fraction(1n) })]),
        }),
      );
    }
    if (picked < cashouts.length) {
      actions.push(
        Object.freeze({
          id: 'reveal',
          outcomes: Object.freeze([
            Object.freeze({
              next: 'mines:loss',
              probability: fraction(BigInt(mines), BigInt(tiles - picked)),
              label: 'Mine',
            }),
            Object.freeze({
              next: `mines:picks:${picked + 1}`,
              probability: fraction(BigInt(tiles - mines - picked), BigInt(tiles - picked)),
              label: 'Safe',
            }),
          ]),
        }),
      );
    }
    nodes.push(Object.freeze({ id: `mines:picks:${picked}`, kind: 'decision', actions: Object.freeze(actions) }));
  }
  return Object.freeze({ root: 'mines:picks:0', nodes: Object.freeze(nodes) });
}

/** The ways to choose `k` of `n`. */
function choose(n: number, k: number) {
  let ways = 1n;
  for (let i = 0; i < k; i++) ways = (ways * BigInt(n - i)) / BigInt(i + 1);
  return ways;
}

/** What `picks` safe picks among `mines` mines multiply the stake by: 99% of the fair
 * C(25, picks) / C(25 − mines, picks). */
export const multiplier = (mines: number, picks: number): Rational => ({
  n: 99n * choose(TILES, picks),
  d: 100n * choose(TILES - mines, picks),
});

/** What cashing out after `picks` safe picks pays, rounded down to the wei. */
export function payout(stake: bigint, mines: number, picks: number) {
  const { n, d } = multiplier(mines, picks);
  return (stake * n) / d;
}

/** One round: `mines` of the 25 tiles are mines, and the player may cash out after any of up to `picks` safe picks. */
export function minesGraph({ stake, mines, picks }: { stake: bigint; mines: number; picks: number }): GameGraph {
  return createMines({
    tiles: TILES,
    mines,
    cashouts: Array.from({ length: picks }, (_, k) => payout(stake, mines, k + 1)),
  });
}

/** The most safe picks the casino backs at this stake, priced as `RoundClient` prices a round (`pricing`). Zero when
 * it backs none. */
export function coveredPicks(stake: bigint, mines: number, bankroll: bigint) {
  const backed = (picks: number) => {
    try {
      return (
        bankroll >= compileGame(minesGraph({ stake, mines, picks }), pricing(stake, bankroll)).conservativeBankroll
      );
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  };
  // A longer ladder only ever needs more: the answer is where backing stops.
  let low = 0,
    high = TILES - mines;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (backed(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}
