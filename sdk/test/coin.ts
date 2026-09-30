import { fraction } from '../src/engine/index.ts';
import type { GameGraph } from '../src/engine/index.ts';

/** A coin toss as a game's rules: one action, `roll` unless named, that reaches `win`, paying `payout` of the stake,
 * or `loss`, paying nothing, each half the time. */
export const coin =
  ({
    action = 'roll',
    payout,
    additionalCash,
    labels,
  }: {
    action?: string;
    payout: (stake: bigint) => bigint;
    additionalCash?: bigint;
    labels?: [string, string];
  }) =>
  (setup: { stake: string }): GameGraph => ({
    root: 'start',
    nodes: [
      {
        id: 'start',
        kind: 'decision',
        actions: [
          {
            id: action,
            ...(additionalCash === undefined ? {} : { additionalCash }),
            outcomes: [
              { next: 'win', probability: fraction(1n, 2n), ...(labels ? { label: labels[0] } : {}) },
              { next: 'loss', probability: fraction(1n, 2n), ...(labels ? { label: labels[1] } : {}) },
            ],
          },
        ],
      },
      { id: 'win', kind: 'terminal', payout: payout(BigInt(setup.stake)) },
      { id: 'loss', kind: 'terminal', payout: 0n },
    ],
  });
