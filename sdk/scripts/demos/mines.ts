import { compileGame, createMines, evaluatePolicy, fraction, multiply } from '../../src/engine/index.ts';
import type { Policy } from '../../src/engine/index.ts';
import { admits, amount, decimal, traceGame, UNIT } from './trace.ts';

// Each further reveal has its own edge; the cash-out action requires no transfer.
const plan = compileGame(
  createMines({ tiles: 5, mines: 1, cashouts: [(120n * UNIT) / 100n, (156n * UNIT) / 100n, (228n * UNIT) / 100n] }),
  { admits, bankrollFloor: 1_000_000n * UNIT, cashQuantum: 1_000_000_000n, initialCash: UNIT },
);
console.log('Mines reference: 5 tiles, 1 mine; at most 3 safe picks; simulated casino bets.');
console.log(`Required root continuation cash ${amount(plan.requiredCash)}.`);
const policyFor =
  (count: number): Policy =>
  node =>
    node.id === `mines:picks:${count}` ? 'cash-out' : 'reveal';
for (const count of [1, 2, 3]) {
  const ev = evaluatePolicy(plan, policyFor(count));
  console.log(
    `Cash out after ${count} safe picks: RTP ${decimal(multiply(ev.expectedPayout, fraction(100n, UNIT)))}%; expected direct payments ${decimal(ev.expectedPayments)}.`,
  );
}
traceGame(plan, policyFor(3));
