import { compileGame, createMines } from '@hookedin/play/sdk/engine';
import type { GameGraph, Rational } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';

/** Five by five. */
export const TILES = 25;

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
export function minesGraph({ stake, mines, picks }: { stake: string; mines: number; picks: number }): GameGraph {
  return createMines({
    tiles: TILES,
    mines,
    cashouts: Array.from({ length: picks }, (_, k) => payout(BigInt(stake), mines, k + 1)),
  });
}

/** The most safe picks the casino backs at this stake, priced as `RoundClient` prices a round: against half the
 * bankroll, on a grid of a billionth of the stake. Zero when it backs none. */
export function coveredPicks(stake: bigint, mines: number, bankroll: bigint) {
  const backed = (picks: number) => {
    try {
      const plan = compileGame(minesGraph({ stake: String(stake), mines, picks }), {
        admits,
        bankrollFloor: bankroll / 2n,
        cashQuantum: stake / 10n ** 9n || 1n,
        initialCash: stake,
      });
      return bankroll >= plan.conservativeBankroll;
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
