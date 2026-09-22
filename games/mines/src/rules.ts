import { createMines } from '@hookedin/play/sdk/engine';
import type { GameGraph } from '@hookedin/play/sdk/engine';

/** Five tiles, one mine. */
export const TILES = 5;
export const MINES = 1;
/** What one, two and three gems pay, in hundredths of the stake. */
export const CASHOUTS = [120n, 156n, 228n];

/** One round of Mines: reveal a tile, or take the cash-out for the gems already found. */
export function minesGraph(setup: { stake: string }): GameGraph {
  return createMines({
    tiles: TILES,
    mines: MINES,
    cashouts: CASHOUTS.map(n => (BigInt(setup.stake) * n) / 100n),
  });
}
