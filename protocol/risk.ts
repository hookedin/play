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

/** One round holds a bounded table: the exact-integer admission cost grows with its distinct outcomes. */
export const MAX_ROUND_BETS = 256;
export const MAX_PRIZES = 64;
export const MAX_ROUND_CELLS = 128;
/** A bet pays `payout` when its round's 64-bit outcome falls in [rangeStart, rangeEnd). */
export interface Prize {
  rangeStart: bigint;
  rangeEnd: bigint;
  payout: bigint;
}
/** The stake is paid to enter; every prize whose range holds the outcome pays. Prizes may overlap. */
export interface BetTerms {
  stake: bigint;
  prizes: readonly Prize[];
}

function checkTerms({ stake, prizes }: BetTerms) {
  uint256(stake, 'stake', true);
  if (!Array.isArray(prizes) || !prizes.length || prizes.length > MAX_PRIZES)
    throw new RangeError(`a bet holds 1 to ${MAX_PRIZES} prizes`);
  for (const prize of prizes) {
    uint256(prize.rangeStart, 'rangeStart');
    uint256(prize.rangeEnd, 'rangeEnd', true);
    uint256(prize.payout, 'payout', true);
    if (prize.rangeStart >= prize.rangeEnd || prize.rangeEnd > OUTCOME_SPACE)
      throw new RangeError('a prize range must lie within [0, 2^64)');
  }
}
/** Sweep the outcome space once: each cell is a stretch of outcomes that pays the same total. */
function cells(bets: readonly BetTerms[]) {
  const steps = new Map<bigint, bigint>([
    [0n, 0n],
    [OUTCOME_SPACE, 0n],
  ]);
  for (const bet of bets)
    for (const { rangeStart, rangeEnd, payout } of bet.prizes) {
      steps.set(rangeStart, (steps.get(rangeStart) || 0n) + payout);
      steps.set(rangeEnd, (steps.get(rangeEnd) || 0n) - payout);
    }
  const edges = [...steps.keys()].sort((a, b) => (a < b ? -1 : 1)),
    widths = new Map<bigint, bigint>();
  let paid = 0n;
  for (let i = 0; i + 1 < edges.length; i++) {
    paid += steps.get(edges[i])!;
    widths.set(paid, (widths.get(paid) || 0n) + edges[i + 1] - edges[i]);
  }
  return [...widths].map(([payout, width]) => ({ payout, width }));
}
/** What a player is signing, exactly: the most the bet can pay and its expected payout out of 2^64. */
export function describeBet(bet: BetTerms) {
  checkTerms(bet);
  const table = cells([bet]);
  return {
    maxPayout: table.reduce((most, cell) => (cell.payout > most ? cell.payout : most), 0n),
    // expectedPayout / (stake * 2^64) is the return to player.
    expectedPayout: table.reduce((sum, cell) => sum + cell.payout * cell.width, 0n),
  };
}

/** A return is measured in millionths of the stake: a percentage with four decimals, so 98.5% is
 * 985000. It is what one signed bet was expected to pay back, measured from the bet itself. */
export const RETURN_SCALE = 1_000_000n;
/** A bet's return in millionths of its stake, rounded to the nearest. Prize ranges are whole
 * outcomes, so a table's width truncates by a few parts in 2^64; rounding to the grid the figure is
 * shown on keeps that from moving the last digit. */
export const returnParts = (stake: bigint, expectedPayout: bigint) => {
  const unit = uint256(stake, 'stake', true) * OUTCOME_SPACE;
  return (uint256(expectedPayout, 'expectedPayout') * RETURN_SCALE + unit / 2n) / unit;
};
/** The return of one bet, straight from its terms. */
export const betReturn = (bet: BetTerms) => returnParts(bet.stake, describeBet(bet).expectedPayout);

/**
 * Every bet in a round rides one 64-bit outcome, so the round is a single wager for the bankroll.
 * The prize ranges cut [0, 2^64) into cells; in a cell of width w the bankroll's cash flow is
 * X = (every stake) - (every payout due there) - F.
 * The Kelly condition for taking the whole round is E[X / (B + X)] >= 0 with every B + X > 0,
 * checked exactly as sum_k w_k X_k prod_{j != k} (B + X_j) >= 0. For one stake S with one prize
 * S + W of width t this is (B-W-F)(S-F)Q >= B*t*(S+W). Prizes that cannot fall together hedge
 * each other; prizes that fall together stack.
 * Bigint intermediate products deliberately exceed uint256; final amounts do not.
 */
export function assessRound({ bankroll, bets }: { bankroll: bigint; bets: readonly BetTerms[] }) {
  uint256(bankroll, 'bankroll', true);
  if (!Array.isArray(bets) || !bets.length || bets.length > MAX_ROUND_BETS)
    throw new RangeError(`a round holds 1 to ${MAX_ROUND_BETS} bets`);
  bets.forEach(checkTerms);
  const totalStake = bets.reduce((sum, bet) => sum + bet.stake, 0n),
    table = cells(bets).map(cell => ({ flow: totalStake - cell.payout, width: cell.width }));
  if (table.length > MAX_ROUND_CELLS) throw new RangeError(`a round has at most ${MAX_ROUND_CELLS} distinct outcomes`);
  const worst = table.reduce((low, cell) => (cell.flow < low ? cell.flow : low), table[0].flow);
  if (bankroll + worst <= 0n) throw new RangeError('the net payout must be less than the available bankroll');
  const isSafe = (fee: bigint) => {
    const after = table.map(cell => bankroll + cell.flow - fee),
      suffix = [1n];
    for (let k = after.length - 1; k > 0; k--) suffix.unshift(suffix[0] * after[k]);
    let prefix = 1n,
      sum = 0n;
    for (let k = 0; k < table.length; k++) {
      sum += table[k].width * (table[k].flow - fee) * prefix * suffix[k];
      prefix *= after[k];
    }
    return sum >= 0n;
  };
  if (!isSafe(0n)) throw new RangeError('bet exceeds the bankroll Kelly limit');

  // The left side strictly decreases throughout this interval. At most 256 steps.
  let low = 0n;
  let high = totalStake - 1n < bankroll + worst - 1n ? totalStake - 1n : bankroll + worst - 1n;
  while (low < high) {
    const middle = low + (high - low + 1n) / 2n;
    if (isSafe(middle)) low = middle;
    else high = middle - 1n;
  }

  // Each bet carries its stake's share of the fee, rounded down to an even number of wei and split equally.
  const maxFee = low,
    fees = bets.map(bet => {
      const share = (maxFee * bet.stake) / totalStake;
      return share - (share % 2n);
    }),
    totalFee = fees.reduce((sum, fee) => sum + fee, 0n);
  // The worst cell is the largest cash decrease the bankroll can suffer from this round.
  const liability = uint256((worst < 0n ? -worst : 0n) + totalFee, 'liability');
  uint256(bankroll + totalStake - totalFee, 'bankroll after player loss', true);
  return Object.freeze({ bankroll, maxFee, totalFee, fees: Object.freeze(fees), liability });
}
