/**
 * Plinko rules: boards of independent 50/50 pegs and their multipliers. Pure arithmetic: a drop is a game of one
 * decision whose outcomes are the buckets, which the SDK collapses into the one casino bet a drop places, and the
 * ball's path inside its bucket is drawn from the settled result. No DOM or wallet.
 */
import { fraction } from '@hookedin/play/sdk/engine';
import type { GameGraph, RandomBelow } from '@hookedin/play/sdk/engine';

export const ROWS = [8, 12, 16] as const;
export const RISKS = ['low', 'medium', 'high'] as const;
export type Rows = (typeof ROWS)[number];
export type Risk = (typeof RISKS)[number];

/**
 * Multipliers in hundredths of the bet, from the outermost bucket to the centre; boards are symmetric.
 * Every table returns exactly 99%: sum(C(rows, j) × multiplier_j) = 99 × 2^rows.
 */
const HALVES: Readonly<Record<Rows, Readonly<Record<Risk, readonly number[]>>>> = {
  8: {
    low: [570, 209, 130, 90, 50],
    medium: [1300, 270, 139, 70, 40],
    high: [2900, 420, 144, 30, 20],
  },
  12: {
    low: [1000, 320, 160, 140, 120, 90, 56],
    medium: [3300, 1100, 360, 210, 110, 60, 31],
    high: [17500, 2300, 800, 200, 70, 22, 19],
  },
  16: {
    low: [1600, 970, 210, 150, 140, 129, 120, 90, 48],
    medium: [11000, 4100, 1000, 440, 270, 149, 110, 50, 32],
    high: [100000, 13000, 2600, 970, 410, 200, 19, 18, 16],
  },
};

/** The multiplier of every bucket, left to right, in hundredths of the bet. */
export const multipliers = (rows: Rows, risk: Risk): number[] =>
  Array.from({ length: rows + 1 }, (_, bucket) => HALVES[rows][risk][Math.min(bucket, rows - bucket)]);

/** Paths into a bucket: the ball goes right exactly `bucket` times in `rows` pegs. */
export function paths(rows: number, bucket: number): bigint {
  let count = 1n;
  for (let i = 0; i < bucket; i++) count = (count * BigInt(rows - i)) / BigInt(i + 1);
  return count;
}
export const payout = (stake: bigint, hundredths: number) => (stake * BigInt(hundredths)) / 100n;

/**
 * One drop as a game: a single decision whose outcomes are the buckets, each exactly as likely as the fair pegs make
 * it, each paying its multiplier of the stake. A stake too small for a multiplier to pay a whole unit is refused, so
 * the board played is the board shown.
 */
export function dropGraph(setup: { stake: string; rows: Rows; risk: Risk }): GameGraph {
  const { rows, risk } = setup,
    stake = BigInt(setup.stake),
    table = multipliers(rows, risk);
  if (table.some(hundredths => payout(stake, hundredths) === 0n))
    throw new Error('This bet is too small for these multipliers. Raise it and drop again.');
  return {
    root: 'board',
    nodes: [
      {
        id: 'board',
        kind: 'decision',
        actions: [
          {
            id: 'drop',
            outcomes: table.map((_, bucket) => ({
              next: `bucket:${bucket}`,
              probability: fraction(paths(rows, bucket), 1n << BigInt(rows)),
            })),
          },
        ],
      },
      ...table.map((hundredths, bucket) => ({
        id: `bucket:${bucket}`,
        kind: 'terminal' as const,
        payout: payout(stake, hundredths),
      })),
    ],
  };
}
/** The bucket a finished drop landed in. */
export const bucketOf = (nodeId: string) => Number(nodeId.slice('bucket:'.length));
/** The ball that lands in `bucket`: one of the bucket's arrangements of right turns, all equally likely, drawn from
 * `random`. */
export function path(rows: Rows, bucket: number, random: RandomBelow): boolean[] {
  let index = random(paths(rows, bucket));
  // Unrank: arrangements that turn left here come first.
  const turns: boolean[] = [];
  for (let row = 0, rights = bucket; row < rows; row++) {
    const left = rows - row - 1 >= rights ? paths(rows - row - 1, rights) : 0n;
    const right = index >= left;
    if (right) {
      index -= left;
      rights--;
    }
    turns.push(right);
  }
  return turns;
}
