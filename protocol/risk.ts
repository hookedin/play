export const UINT256_MAX = (1n << 256n) - 1n;
/** Deposits and signed balances stay below 2^128 wei so aggregate claims cannot overflow. */
export const MAX_BALANCE = 1n << 128n;
/** A round's outcome is a uniform integer below this. */
export const OUTCOME_SPACE = 1n << 64n;

export function uint256(value: unknown, name = 'value', positive = false) {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > UINT256_MAX) {
    throw new RangeError(`${name} must be ${positive ? 'a positive' : 'an'} uint256 bigint`);
  }
  return value;
}

/** A casino bet: the stake is paid to enter, and the bet pays `prize` when its round's 64-bit outcome is below
 * `chance`, its probability counted in outcomes out of 2^64. */
export interface BetTerms {
  stake: bigint;
  chance: bigint;
  prize: bigint;
}

function checkTerms({ stake, chance, prize }: BetTerms) {
  uint256(stake, 'stake', true);
  uint256(prize, 'prize', true);
  if (typeof chance !== 'bigint' || chance <= 0n || chance >= OUTCOME_SPACE)
    throw new RangeError('chance must lie in [1, 2^64)');
}
/** What a player is signing, exactly: the most the bet can pay and its expected payout out of 2^64. */
export function describeBet(bet: BetTerms) {
  checkTerms(bet);
  // expectedPayout / (stake * 2^64) is the return to player.
  return { maxPayout: bet.prize, expectedPayout: bet.prize * bet.chance };
}

/** A return is measured in millionths of the stake: a percentage with four decimals, so 98.5% is
 * 985000. It is what one signed bet was expected to pay back, measured from the bet itself. */
export const RETURN_SCALE = 1_000_000n;
/** A bet's return in millionths of its stake, rounded to the nearest. A chance is whole outcomes, so a bet's
 * odds can be a few parts in 2^64 off a round figure; rounding to the grid the figure is shown on keeps that
 * from moving the last digit. */
export const returnParts = (stake: bigint, expectedPayout: bigint) => {
  const unit = uint256(stake, 'stake', true) * OUTCOME_SPACE;
  return (uint256(expectedPayout, 'expectedPayout') * RETURN_SCALE + unit / 2n) / unit;
};
/** The return of one bet, straight from its terms. */
export const betReturn = (bet: BetTerms) => returnParts(bet.stake, describeBet(bet).expectedPayout);

/** The largest integer whose square is at most `n`. */
export function isqrt(n: bigint) {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (let y = (x + n / x) >> 1n; y < x; y = (x + n / x) >> 1n) x = y;
  return x;
}

/**
 * A casino bet is one wager with two outcomes. With available bankroll B, stake S, net win W = prize − S and total
 * commission F, the bankroll gains S − F when the bet loses and loses W + F when it wins. The Kelly condition for
 * taking it, E[X / (B + X)] >= 0 with every B + X > 0, is exactly (B − W − F)(S − F)·2^64 >= B·chance·(S + W). Its
 * left side falls as F grows, so the largest commission that keeps it is the smaller root of that quadratic in F,
 * taken with an integer square root and checked exactly. Bigint intermediate products deliberately exceed uint256;
 * final amounts do not.
 */
export function assessBet({ bankroll, bet }: { bankroll: bigint; bet: BetTerms }) {
  uint256(bankroll, 'bankroll', true);
  checkTerms(bet);
  const { stake: S, chance: t, prize } = bet,
    Q = OUTCOME_SPACE,
    B = bankroll,
    W = prize - S;
  if (B - W <= 0n) throw new RangeError('the net payout must be less than the available bankroll');
  const isSafe = (F: bigint) => (B - W - F) * (S - F) * Q >= B * t * prize;
  if (!isSafe(0n)) throw new RangeError('bet exceeds the bankroll Kelly limit');
  let maxFee = (Q * (B - W + S) - isqrt(Q * Q * (B - W - S) ** 2n + 4n * Q * B * t * prize)) / (2n * Q);
  // The integer root rounds down, which can leave the fee one above the real root.
  if (!isSafe(maxFee)) maxFee -= 1n;
  // The fee is rounded down to an even number of wei, to be split equally.
  const fee = maxFee - (maxFee % 2n);
  // What the bankroll can lose on this bet: the net win when it pays more than its stake, and the commission.
  const liability = uint256((W > 0n ? W : 0n) + fee, 'liability');
  uint256(B + S - fee, 'bankroll after player loss', true);
  return Object.freeze({ bankroll, maxFee, fee, liability });
}
