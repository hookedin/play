import {
  add,
  blackjackState,
  compileGame,
  createBlackjack,
  divide,
  evaluatePolicy,
  fraction,
  multiply,
  optimalExpectedValuePolicy,
} from '../../src/engine/index.ts';
import { admits, amount, decimal, traceGame, UNIT } from './trace.ts';

const plan = compileGame(createBlackjack({ stake: UNIT }), {
  admits,
  bankrollFloor: 1_000_000n * UNIT,
  cashQuantum: 1_000_000_000n,
  initialCash: UNIT,
});
const policy = optimalExpectedValuePolicy(plan);
const evaluation = evaluatePolicy(plan, policy);

console.log(
  'Blackjack reference: Stake Originals rules; every step is one simulated casino bet; no wallet transactions.',
);
console.log('Replacement deck; dealer stands on soft 17; dealer blackjack check; natural pays 3:2.');
console.log('Double any two, including splits; split once; one card to split aces; insurance; no surrender.');
console.log(`\n${plan.nodes.length} public states; maximum ${plan.maximumDepth} transitions.`);
console.log(`Nominal stake ${amount(UNIT)}; required root continuation cash ${amount(plan.requiredCash)}.`);
console.log(
  `Planning bankroll floor ${amount(plan.bankrollFloor)}; isolated-play starting bound ${amount(plan.conservativeBankroll)}.`,
);
console.log(
  `Optimal completed-hand RTP per initial stake ${decimal(multiply(add(fraction(1n), divide(evaluation.netEV, fraction(UNIT))), fraction(100n)))}%.`,
);
console.log(`Expected bets per completed hand: ${decimal(evaluation.expectedCasinoBets)}.`);
console.log(`Expected direct payments per completed hand: ${decimal(evaluation.expectedPayments)}.`);
console.log('\nExample decision funding (action prices use the same planning bankroll):');
for (const node of plan.nodes) {
  const hand = blackjackState(node.id);
  if (
    node.kind !== 'decision' ||
    hand === undefined ||
    hand.phase !== 'player' ||
    hand.soft ||
    !(
      (hand.total === 20 && hand.dealerUpcard === 6) ||
      (hand.total === 16 && hand.dealerUpcard === 10) ||
      (hand.total === 11 && hand.dealerUpcard === 6)
    )
  )
    continue;
  console.log(`  Hard ${hand.total} vs ${hand.dealerUpcard}: funded cash ${amount(node.cash)}; policy ${policy(node)}`);
  for (const action of node.actions) {
    console.log(
      `    ${action.id}: required ${amount(action.requiredCash)}; ${action.transition.kind === 'casino-bet' ? `${action.transition.branches.length} branches over ${action.transition.classes.length} cash classes` : action.transition.kind}`,
    );
  }
}
console.log('\nExact terminal payout distribution:');
for (const outcome of evaluation.distribution) {
  console.log(
    `  ${amount(outcome.payout)}: ${outcome.probability.n}/${outcome.probability.d} (${decimal(multiply(outcome.probability, fraction(100n)))}%)`,
  );
}
console.log('\nOne simulated hand using the EV-optimal policy:');
traceGame(plan, policy);
