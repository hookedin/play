/**
 * Plinko rules: boards of independent 50/50 pegs and their prize tables. Pure arithmetic: a drop is one
 * casino bet whose prizes are the buckets, and the ball's whole path is read from the round's outcome.
 * No DOM, wallet or randomness of its own.
 */
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

const WORD_BITS = 64n;
/** Where a bucket sits in the outcome space. A path is one of 2^rows equally likely stretches of
 * 2^(64 - rows) outcomes, and a bucket holds its C(rows, bucket) paths side by side, so every width
 * is exact: the board played is the board of fair pegs, to the last outcome. */
function bucketStart(rows: number, bucket: number): bigint {
  let before = 0n;
  for (let b = 0; b < bucket; b++) before += paths(rows, b);
  return before << (WORD_BITS - BigInt(rows));
}
/** One drop as a casino bet: the stake, and a prize for every bucket that pays. */
export function dropBet(rows: Rows, risk: Risk, stake: bigint) {
  return {
    stake,
    prizes: multipliers(rows, risk).flatMap((hundredths, bucket) => {
      const prize = payout(stake, hundredths);
      return prize > 0n
        ? [{ rangeStart: bucketStart(rows, bucket), rangeEnd: bucketStart(rows, bucket + 1), payout: prize }]
        : [];
    }),
  };
}
/**
 * The ball a round's outcome drops. The outcome names one of the 2^rows paths: its bucket, and which
 * of the bucket's arrangements of right turns it is. Ball and money are the same fact.
 */
export function landing(rows: Rows, outcome: bigint): { bucket: number; turns: boolean[] } {
  const path = outcome >> (WORD_BITS - BigInt(rows));
  let bucket = 0,
    index = path;
  while (index >= paths(rows, bucket)) index -= paths(rows, bucket++);
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
  return { bucket, turns };
}
