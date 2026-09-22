import { fraction } from './rational.ts';
import type { GameAction, GameGraph, GameNode } from './model.ts';

/** Symmetric unrevealed tiles; cashouts[k-1] is the gross return after k safe picks. */
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
            Object.freeze({ next: 'mines:loss', probability: fraction(BigInt(mines), BigInt(tiles - picked)) }),
            Object.freeze({
              next: `mines:picks:${picked + 1}`,
              probability: fraction(BigInt(tiles - mines - picked), BigInt(tiles - picked)),
            }),
          ]),
        }),
      );
    }
    nodes.push(Object.freeze({ id: `mines:picks:${picked}`, kind: 'decision', actions: Object.freeze(actions) }));
  }
  return Object.freeze({ root: 'mines:picks:0', nodes: Object.freeze(nodes) });
}
