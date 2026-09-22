/**
 * Samson's Gold: a five-reel, three-row, 243-ways slot whose whole payout distribution is counted
 * exactly from its reel strips. Pure rules and arithmetic; no DOM, wallet or ambient randomness.
 *
 * A spin settles as one native bet with a prize for each distinct outcome, and a bet holds at most 64
 * prizes. The rules keep that set small: only the best win on the screen pays, every pay is a whole
 * number of stakes of the form 2^a·3^b, and ways and wild multipliers are products of 2s and 3s.
 * No win is smaller than the stake, so a spin never celebrates a net loss.
 */
import { fraction } from '@hookedin/play/sdk/engine';
import type { GameGraph, RandomBelow } from '@hookedin/play/sdk/engine';

/** L lion, P pillars, S shears, T torch, A K Q J; W/2/3 jawbone wilds (×1 ×2 ×3); H honeycomb scatter. */
export const PAYING = 'LPSTAKQJ';
export const WILDS: Readonly<Record<string, number>> = { W: 1, '2': 2, '3': 3 };
export const SCATTER = 'H';
export const ROWS = 3;
/** Pay per way for three, four and five adjacent reels from the left, in whole stakes. */
export const PAYS: Readonly<Record<string, readonly [number, number, number]>> = {
  L: [4, 16, 96],
  P: [2, 8, 24],
  S: [2, 6, 18],
  T: [2, 4, 12],
  A: [1, 3, 9],
  K: [1, 3, 8],
  Q: [1, 2, 6],
  J: [1, 2, 6],
};
/** Three honeycombs award this many bonus spins, prepaid in cash: one stake each, added to the spin's payout. */
export const BONUS_SPINS = 8;

export interface Machine {
  readonly name: 'base' | 'bonus';
  /** One string per reel; a stop shows that position and the two below it, wrapping around. */
  readonly strips: readonly string[];
}
export const MACHINES: Readonly<Record<'base' | 'bonus', Machine>> = {
  base: {
    name: 'base',
    strips: [
      'AKHTQSTSAQJLTHSSSAHTTTHKAPATQHSTATJTTQTQTSAQSSTTASQ',
      'QKJQLPPLKQTSLLKPPJPWAKJAKPSPLLLPQJQPJKLJQKJKJKAQLLQJK',
      'SWPJPAJKSAQJPPPASAJLQKAQASPSJPPPHQKLKPQKPAHSSSHASJQHAKSSTJ',
      'KASPPKAJTTTQTQTJPPJKTQTTKSKLPKJTTJQLLKAQTJTTPPJSTKPWQTKJT',
      'QKQTQPJPPKLLJHQJKPPPLQTQPKTLQTAKQAQKHQJKJTTQTJPPATASSAKJK',
    ],
  },
  bonus: {
    name: 'bonus',
    strips: [
      'AKHTQSTSAQJLTHSSAHTATTHATKATQHSQTATJATTQTTTSAQSSTTATSQ',
      'AJKJQLAPPJLAPKQLLKLJJLL2LLQKJAKKSAPLLJKLLLPQJQAPJJKLQJLQKKJJKJQJKJKAQLLQJK',
      'K3PJPAJKJSAQJPPPAQSAJPQPKAQASPSAKJPJPPHQKKAJPQPKAQHSKSHAQSJQHAKASJSAJ',
      'KKLTSKPPKAJTTTQTQTJPPJKTQTTKPSQPKLPKJTTJQTLKPTLKQTJJTTPPJSTQKTPPT2QTJT',
      'KQPPPLLHQSJPPTPTQTKAKHQJKPTTPPATASAJK',
    ],
  },
};

export interface Win {
  readonly symbol: string;
  /** Adjacent reels from the left carrying the symbol or a wild. */
  readonly length: number;
  readonly ways: number;
  /** Product of the multipliers of every wild in the win. */
  readonly multiplier: number;
  /** Whole stakes: pay per way × ways × multiplier. */
  readonly pay: number;
  /** [reel, row] cells that take part. */
  readonly cells: readonly (readonly [number, number])[];
}
export interface SpinResult {
  readonly window: readonly string[];
  /** The best win on the screen; it alone is paid. */
  readonly win: Win | null;
  readonly bonus: boolean;
  readonly scatterCells: readonly (readonly [number, number])[];
}

const column = (strip: string, stop: number) =>
  Array.from({ length: ROWS }, (_, row) => strip[(stop + row) % strip.length]).join('');

/** The visible 5×3 window and what it pays: the presentation's view, and the reference rule for the counter. */
export function evaluate(machine: Machine, stops: readonly number[]): SpinResult {
  const window = machine.strips.map((strip, reel) => column(strip, stops[reel]));
  let win: Win | null = null;
  for (const symbol of PAYING) {
    let ways = 1,
      multiplier = 1,
      length = 0;
    const cells: [number, number][] = [];
    for (const [reel, shown] of window.entries()) {
      let matches = 0;
      for (const [row, cell] of [...shown].entries())
        if (cell === symbol || cell in WILDS) {
          matches++;
          multiplier *= WILDS[cell] ?? 1;
          cells.push([reel, row]);
        }
      if (!matches) break;
      ways *= matches;
      length++;
    }
    const pay = length >= 3 ? PAYS[symbol][length - 3] * ways * multiplier : 0;
    if (pay > (win?.pay ?? 0)) win = { symbol, length, ways, multiplier, pay, cells };
  }
  const scatterCells = window.flatMap((shown, reel) =>
    [...shown].flatMap((cell, row) => (cell === SCATTER ? [[reel, row] as const] : [])),
  );
  return { window, win, bonus: scatterCells.length >= 3, scatterCells };
}

/** An outcome is the best pay and whether the bonus triggered; equal outcomes are the same money. */
const outcomeKey = (pay: number, bonus: boolean) => pay * 2 + Number(bonus);
export const outcomeOf = (key: number) => ({ pay: Math.floor(key / 2), bonus: key % 2 === 1 });
/** Gross payout in whole stakes. */
export const payoutStakes = (key: number) => outcomeOf(key).pay + (outcomeOf(key).bonus ? BONUS_SPINS : 0);

interface Prefix {
  /** Paying symbols still alive after three reels, with the product of their ways and multipliers so far. */
  readonly alive: readonly (readonly [number, number])[];
  readonly scatters: number;
  /** Every first-three-reel stop combination that produces this state. */
  readonly stops: number[];
}
interface Counted {
  readonly prefixes: readonly Prefix[];
  readonly factors: readonly (readonly Uint8Array[])[];
  readonly scatter: readonly Uint8Array[];
  readonly counts: ReadonlyMap<number, number>;
  readonly total: number;
}
const counted = new WeakMap<Machine, Counted>();

/**
 * Count every stop combination exactly. A win depends on the first three reels only through the
 * running product of each symbol still alive, so those states are grouped before reels four and five.
 */
function count(machine: Machine): Counted {
  const known = counted.get(machine);
  if (known) return known;
  const factors = machine.strips.map(strip =>
    Array.from({ length: strip.length }, (_, stop) => {
      const shown = [...column(strip, stop)];
      if (shown.filter(cell => cell in WILDS || cell === SCATTER).length > 1)
        throw new Error('A reel window may show at most one wild or scatter');
      const multiplier = shown.reduce((product, cell) => product * (WILDS[cell] ?? 1), 1);
      return Uint8Array.from(
        PAYING,
        symbol => shown.filter(cell => cell === symbol || cell in WILDS).length * multiplier,
      );
    }),
  );
  const scatter = machine.strips.map(strip =>
    Uint8Array.from({ length: strip.length }, (_, stop) => Number(column(strip, stop).includes(SCATTER))),
  );
  const [l1, l2, l3, l4, l5] = machine.strips.map(strip => strip.length);
  const states = new Map<string, Prefix>();
  for (let a = 0; a < l1; a++)
    for (let b = 0; b < l2; b++)
      for (let c = 0; c < l3; c++) {
        const alive: [number, number][] = [];
        for (let s = 0; s < PAYING.length; s++) {
          const product = factors[0][a][s] * factors[1][b][s] * factors[2][c][s];
          if (product) alive.push([s, product]);
        }
        const scatters = scatter[0][a] + scatter[1][b] + scatter[2][c];
        const key = `${scatters}|${alive}`;
        let state = states.get(key);
        if (!state) states.set(key, (state = { alive, scatters, stops: [] }));
        state.stops.push((a * l2 + b) * l3 + c);
      }
  const prefixes = [...states.values()];
  const counts = new Map<number, number>();
  for (const prefix of prefixes)
    for (let d = 0; d < l4; d++)
      for (let e = 0; e < l5; e++) {
        const key = suffixKey(prefix, factors[3][d], factors[4][e], scatter[3][d] + scatter[4][e]);
        counts.set(key, (counts.get(key) ?? 0) + prefix.stops.length);
      }
  const result = { prefixes, factors, scatter, counts, total: l1 * l2 * l3 * l4 * l5 };
  counted.set(machine, result);
  return result;
}
function suffixKey(prefix: Prefix, fourth: Uint8Array, fifth: Uint8Array, scatters: number) {
  let best = 0;
  for (const [s, product] of prefix.alive) {
    const pays = PAYS[PAYING[s]];
    const pay = !fourth[s]
      ? pays[0] * product
      : !fifth[s]
        ? pays[1] * product * fourth[s]
        : pays[2] * product * fourth[s] * fifth[s];
    if (pay > best) best = pay;
  }
  return outcomeKey(best, prefix.scatters + scatters >= 3);
}

/** Exact number of stop combinations for every outcome, and the total. */
export function distribution(machine: Machine): { counts: ReadonlyMap<number, number>; total: number } {
  const { counts, total } = count(machine);
  return { counts, total };
}

/**
 * Pick reel stops uniformly from exactly those combinations that produce the settled outcome. The
 * joint distribution of reels and money is then the same as spinning the physical strips. The game
 * feeds it the position of the round's outcome inside the prize it hit, so the reels shown are a
 * function of the verified outcome, not of anything the page drew.
 */
export function sampleStops(machine: Machine, key: number, random: RandomBelow): number[] {
  const { prefixes, factors, scatter, counts } = count(machine);
  const matching = counts.get(key);
  if (!matching) throw new Error('This machine cannot produce that outcome');
  let index = Number(random(BigInt(matching)));
  const [, l2, l3, l4, l5] = machine.strips.map(strip => strip.length);
  for (const prefix of prefixes)
    for (let d = 0; d < l4; d++)
      for (let e = 0; e < l5; e++) {
        if (suffixKey(prefix, factors[3][d], factors[4][e], scatter[3][d] + scatter[4][e]) !== key) continue;
        if (index < prefix.stops.length) {
          const first = prefix.stops[index];
          return [Math.floor(first / (l2 * l3)), Math.floor(first / l3) % l2, first % l3, d, e];
        }
        index -= prefix.stops.length;
      }
  throw new Error('Outcome counts are inconsistent');
}

const PREFIX = 'samson:';
export const outcomeNode = (machine: Machine, key: number) => `${PREFIX}${machine.name}:${key}`;
/** The machine and outcome key of a terminal node, or null for any other node. */
export function nodeOutcome(nodeId: string): { machine: Machine; key: number } | null {
  const [, name, key] = nodeId.startsWith(PREFIX) ? nodeId.split(':') : [];
  return (name === 'base' || name === 'bonus') && /^\d+$/.test(key)
    ? { machine: MACHINES[name], key: Number(key) }
    : null;
}
/** One spin is one decision; every distinct outcome is a terminal with its exact probability. */
export function slotGraph(setup: { stake: string; mode?: string }): GameGraph {
  const machine = setup.mode === 'bonus' ? MACHINES.bonus : MACHINES.base;
  const stake = BigInt(setup.stake);
  if (stake <= 0n) throw new Error('Your stake must be greater than zero.');
  const { counts, total } = count(machine);
  const root = `${PREFIX}${machine.name}:ready`;
  return {
    root,
    nodes: [
      {
        id: root,
        kind: 'decision',
        actions: [
          {
            id: 'spin',
            outcomes: [...counts].map(([key, ways]) => ({
              next: outcomeNode(machine, key),
              probability: fraction(BigInt(ways), BigInt(total)),
            })),
          },
        ],
      },
      ...[...counts.keys()].map(key => ({
        id: outcomeNode(machine, key),
        kind: 'terminal' as const,
        payout: stake * BigInt(payoutStakes(key)),
      })),
    ],
  };
}
