/** The casino's admission rule, as the game libraries take it: would this bankroll admit this bet?
 * It is the casino's own code, so a price computed with it is a price the casino will honour. */
import { assessRound } from '@hookedin/play/protocol/risk.ts';
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
