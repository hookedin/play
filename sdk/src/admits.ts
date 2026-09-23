/** The casino's admission rule, as the game libraries take it: would this bankroll admit this bet? It is the
 * casino's own code, so a price computed with it is a price the casino will honour. Beside it, what the wallet
 * measures of every bet it signs: the most it can pay, what it is expected to pay, and its return. */
import { assessRound } from '../../protocol/risk.ts';
export { betReturn, describeBet, returnParts, RETURN_SCALE } from '../../protocol/risk.ts';
import type { Admits } from './engine/index.ts';

export const admits: Admits = (bankroll, bet) => {
  try {
    assessRound({ bankroll, bets: [bet] });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
};
