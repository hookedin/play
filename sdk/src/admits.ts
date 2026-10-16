/** The casino's admission rule, as the game libraries take it: would this bankroll admit this casino bet? It is
 * the casino's own code, so a price computed with it is a price the casino will honour. Beside it, one bet's
 * return, in millionths of its stake. */
export { admits, assessBet, betReturn, RETURN_SCALE } from '../../protocol/risk.ts';
