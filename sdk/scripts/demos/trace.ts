import {
  fraction,
  getNode,
  prepareAction,
  resolveTransition,
  rngFromBytes,
  simulateServerResult,
} from '../../src/engine/index.ts';
import type { GamePlan, Policy, Rational, RuntimeState } from '../../src/engine/index.ts';

export { admits } from '../../src/admits.ts';
export const UNIT = 10n ** 18n;

export function decimal(value: Rational, places = 9): string {
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  const scale = 10n ** BigInt(places);
  const digits = ((n * scale) / value.d).toString().padStart(places + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
export const amount = (value: bigint): string => decimal(fraction(value, UNIT));

/** One simulated play. The only randomness is the round outcome the casino would reveal. */
export function traceGame(plan: GamePlan, policy: Policy): void {
  const random = rngFromBytes(bytes => {
    crypto.getRandomValues(bytes);
  });
  let state: RuntimeState = { nodeId: plan.root, cash: plan.initialCash, bankroll: plan.conservativeBankroll };
  let contributions = 0n;
  let payments = 0n;
  const startingTotal = state.cash + state.bankroll;
  let moves = 0;
  while (getNode(plan, state.nodeId).kind !== 'terminal') {
    const node = getNode(plan, state.nodeId);
    if (node.kind !== 'decision') throw new Error('missing decision');
    const actionId = policy(node); // Chosen BEFORE the round's outcome exists.
    const step = prepareAction(plan, state, actionId, random);
    contributions += step.additionalCash;
    console.log(`\n${state.nodeId}\n  ${actionId}; funded balance ${amount(state.cash)}`);
    if (step.kind === 'casino-bet') {
      const outcome = simulateServerResult(step, random),
        result = resolveTransition(step, outcome);
      console.log(
        `  stake ${amount(step.bet.stake)}; ${amount(step.bet.prize)} on ${step.bet.chance} of 18446744073709551616 outcomes; ${amount(step.lose.cash)} kept aside`,
      );
      console.log(
        `  outcome ${outcome} of 18446744073709551616 pays ${amount(result.payout)}${result.label ? `: ${result.label}` : ''}`,
      );
      state = result.state;
    } else {
      console.log(`  ${step.kind}${step.kind === 'payment' ? ` ${amount(step.amount)} to the bankroll` : ''}`);
      const result = resolveTransition(step);
      payments += result.payment;
      state = result.state;
    }
    if (state.bankroll < plan.bankrollFloor) throw new Error('bankroll floor violated');
    if (state.cash + state.bankroll !== startingTotal + contributions) throw new Error('money conservation failed');
    if (++moves > plan.maximumDepth) throw new Error('graph depth exceeded');
  }
  console.log(
    `\nFinal payout ${amount(state.cash)}; net result ${amount(state.cash - plan.initialCash - contributions)}; direct payments ${amount(payments)}`,
  );
  console.log(
    'Exact money conservation and the bankroll floor held throughout this simulated play (commission aside).',
  );
}
