import { fraction } from '@hookedin/play/sdk/engine';
import type { GameGraph } from '@hookedin/play/sdk/engine';

/** The house keeps 1%: a win pays the stake back divided by its chance, times 0.99. */
export const CHANCE_MIN = 1000;
export const CHANCE_MAX = 9000;

/** One roll: win with `chanceBps` in ten-thousandths, or lose the stake. */
export function diceGraph(setup: { stake: string; chanceBps: number }): GameGraph {
  const chance = setup.chanceBps;
  if (!Number.isInteger(chance) || chance < CHANCE_MIN || chance > CHANCE_MAX)
    throw new Error('Chance must be between 10% and 90%');
  return {
    root: 'dice:ready',
    nodes: [
      {
        id: 'dice:ready',
        kind: 'decision',
        actions: [
          {
            id: 'roll',
            outcomes: [
              { next: 'dice:win', probability: fraction(BigInt(chance), 10000n) },
              { next: 'dice:lose', probability: fraction(BigInt(10000 - chance), 10000n) },
            ],
          },
        ],
      },
      { id: 'dice:win', kind: 'terminal', payout: (BigInt(setup.stake) * 9900n) / BigInt(chance) },
      { id: 'dice:lose', kind: 'terminal', payout: 0n },
    ],
  };
}
