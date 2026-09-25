import {
  compileGame,
  createBlackjack,
  createMines,
  evaluatePolicy,
  fraction,
  getNode,
  optimalExpectedValuePolicy,
  prepareAction,
  resolveTransition,
  rngFromBytes,
} from '../src/engine/index.ts';
import type { Admits, GameGraph, RuntimeState } from '../src/engine/index.ts';

const unit = 10n ** 18n;
// The library takes the casino's admission rule as a function and never assumes what it is.
const admits: Admits = (bankroll, bet) => bet.prizes.every(prize => prize.payout < bankroll);
const graph: GameGraph = createBlackjack({ stake: unit });
const plan = compileGame(graph, {
  admits,
  bankrollFloor: 1_000_000n * unit,
  cashQuantum: 10n ** 9n,
  initialCash: unit,
});
const state: RuntimeState = { nodeId: plan.root, cash: plan.initialCash, bankroll: plan.conservativeBankroll };
const node = getNode(plan, state.nodeId);
const policy = optimalExpectedValuePolicy(plan);
const rng = rngFromBytes(bytes => {
  crypto.getRandomValues(bytes);
});
if (node.kind === 'decision') {
  const step = prepareAction(plan, state, policy(node), rng);
  resolveTransition(step, step.kind === 'casino-bet' ? 0n : undefined);
}
evaluatePolicy(plan, policy);
createMines({ tiles: 5, mines: 1, cashouts: [unit] });
fraction(1n, 13n);
