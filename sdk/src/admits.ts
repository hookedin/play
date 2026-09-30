/** The casino's admission rule, as the game libraries take it: would this bankroll admit this casino bet? It is
 * the casino's own code, so a price computed with it is a price the casino will honour. Beside it, the return the
 * wallet measures of every bet it signs. */
import { assessBet } from '../../protocol/risk.ts';
export { assessBet, betReturn, RETURN_SCALE } from '../../protocol/risk.ts';
import type { Admits } from './engine/transition.ts';

export const admits: Admits = (bankroll, bet) => {
  try {
    assessBet({ bankroll, bet });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
};
