# The pricing engine

`@hookedin/play/sdk/engine` is a TypeScript library for finite games with decisions and exact state probabilities. It prices cash continuation values backward through a public-state graph, then executes each chosen action as one native bet (a stake, and a prize for every better successor), an explicit cash payment, or a no-wager transition. Two rule sets ship with it: Stake-rules blackjack with an infinite replacement deck ([blackjack.ts](../src/engine/blackjack.ts)) and reveal-or-cashout Mines ([mines.ts](../src/engine/mines.ts)).

The engine is a layer over the casino's native bet. It adds no contract and reserves no whole hand. The round's verified outcome decides every step, including which card was drawn; the library samples nothing. Each bet must be independently assessed, accepted and settled by the casino.

The derivation is in [sequential games built from native bets](sequential-games.md). This page is the API guide.

## Files

| File                                         | What it holds                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [rational.ts](../src/engine/rational.ts)     | Exact bigint fractions: `fraction`, `add`, `multiply`, `divide`, `compare`                              |
| [model.ts](../src/engine/model.ts)           | The graph types: `GameGraph`, `GameNode`, `GameAction`, `GameOutcome`                                   |
| [transition.ts](../src/engine/transition.ts) | One step as one bet: `priceTransition`, `compileTransition`, `apportion`, the `Admits` type             |
| [engine.ts](../src/engine/engine.ts)         | `compileGame`, `compileGameAsync`, `loadFundedGame`, `prepareAction`, `resolveTransition`, policy tools |
| [blackjack.ts](../src/engine/blackjack.ts)   | `createBlackjack`, `blackjackState`, `dealerDistribution`, `addCard`, `cardProbability`                 |
| [mines.ts](../src/engine/mines.ts)           | `createMines`                                                                                           |

The engine has no dependencies and touches no browser API, so it runs in Node as well as in a game page.

## Run the demos

```sh
git clone https://github.com/hookedin/play
cd play
npm ci
npm run demo:blackjack
npm run demo:mines
```

The demos live in [scripts/demos](../scripts/demos/). They simulate the casino's outcome with Web Crypto and use reference accounting; they do not place wagers. `npm test` includes type checking and the engine tests.

## Graph and pricing

The engine takes the casino's admission rule as a function, `admits(bankroll, bet)`, and prices against it without assuming what it is. Games pass [the casino's own](../src/admits.ts), exported as `admits` from `@hookedin/play/sdk/admits`.

```ts
import { compileGame, createBlackjack } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';

const unit = 1_000_000n;
const graph = createBlackjack({ stake: unit });
const plan = compileGame(graph, {
  admits,
  bankrollFloor: 1_000_000n * unit,
  cashQuantum: 1n,
});

console.log(plan.requiredCash);
console.log(plan.initialCash);
console.log(plan.conservativeBankroll);
```

A `GameGraph` has a root ID and terminal or decision nodes. Terminal payouts are gross bigint cash amounts. Each decision lists actions with exact rational probabilities and successor IDs. The graph must be finite and acyclic; every action's probabilities sum to one.

The compiler prices successors first, prices each action's successor-cash table, and assigns the node the maximum action price minus that action's additional player contribution. It then compiles every action using that common cash balance plus the selected action's contribution. Optional `initialCash` overrides the starting amount only when it supports the root transitions. No choice mints a refund or an expected-value credit.

`requiredCash` is a computed funding requirement, not terminal payout EV. The blackjack terminal prize scale and this starting requirement need not be equal. `cashQuantum` selects the monetary grid. A price is the least grid cash whose bet the admission rule accepts, found by bisection.

For an individual transition, `priceTransition({ admits, bankroll, outcomes, quantum })` returns its required cash, and `compileTransition({ admits, bankroll, cash, outcomes })` builds the step for a specified current balance. Each outcome is `{ next, cash, probability, label? }`. A step is `{ kind: 'bet', bet, retained, successors }`: the bet stakes `cash − retained`, where `retained` is the cheapest successor's cash, and holds a prize `[rangeStart, rangeEnd)` paying `successor cash − retained` for every better successor. Successors lie along the outcome space in their stated order, each as wide as its probability to the nearest outcome in 2^64, and successors needing the same cash keep their own stretch. A step whose successors all need the same cash is a `noop`, or a `payment` of whatever cash exceeds it. A step with more than 64 distinct prizes is refused.

## Runtime and policy

`prepareAction(plan, state, actionId, random?)` takes the chosen action and a runtime state `{ nodeId, cash, bankroll }`. Choose the action before its round's outcome exists. The same action is always the same bet, so there is nothing to protect from a redraw.

`prepareAction` returns a tagged `bet`, `noop` or `payment` result, after asking the admission rule again at the live bankroll. `resolveTransition(prepared, outcome?)` returns `{ state, label, payout, payment }` using reference accounting that ignores commission. The `outcome` of a bet must be the round's verified 64-bit value from native settlement in a live adapter; it names the successor and its label. The resolver is not an oracle or a transaction sender. Explicit payment steps require verified settlement of the corresponding debit before acknowledgement; no-wager steps create no money. Durable restart recovery and exactly-once application belong to the adapter. [`RoundClient`](../src/round.ts) is that adapter for a game page.

`evaluatePolicy(plan, policy)` obtains an exact terminal payout distribution, expectation, net EV after initial cash and additional contributions, and expected counts of bets and payments. It assumes completion to graph terminals and excludes optional stopping outside graph actions. The policy must be a pure deterministic function of the public node; stateful callbacks are incompatible with its per-node cache. `optimalExpectedValuePolicy(plan)` supplies a policy chosen for net payout expectation after additional contributions. These are separate from the backward Kelly funding calculation. `getNode(plan, id)` exposes a compiled public state for a consumer.

The only randomness the library ever draws is for a step that moves no money yet has several successors: pass a `RandomBelow` (a uniform integer below a bigint limit; `rngFromBytes` adapts a secure byte source). No cash rides on that draw. There is no global `Math.random` or hidden server RNG, and a simulated outcome is not proof of a settled wager.

## Bankroll and cashout

Every step is checked at the planning floor, and again at the supplied runtime bankroll when it is prepared. A live adapter signs exactly the step's stake and prizes; the casino calculates commission against current capacity. A verified higher-sequence rejection permits a new attempt with the same bet; a timeout requires recovering the exact pending request. The plan's `conservativeBankroll` is `bankrollFloor + BigInt(maximumDepth) × maximumCash`. It keeps the planning floor available through the graph only if there are no outside bets, withdrawals or other bankroll decreases.

Each settled state contains player cash in the reference accounting. In the live wallet this is a signed channel balance: stopping retains it, while ETH withdrawal requires channel closure and sufficient liquidity for winnings. Stopping changes the play policy and does not cancel a still-valid signed request. Neither the library nor an off-chain request guarantees future game capacity.

The abstract runtime can represent cash-reducing payment steps. In a game page a payment step is the bridge's `game.payment`: the wallet signs a kind-2 channel operation and verifies the casino's resulting checkpoint before the game advances. This reduces the player's signed balance and increases the casino's accounting bankroll without an on-chain transaction or commission. The pure engine performs no settlement itself.

## Blackjack rules

Blackjack follows the current Stake Originals rules: infinite replacement deck, S17, dealer blackjack check, 3:2 naturals, double any first two cards including split hands, one split maximum, one card to split aces, and optional half-stake insurance paying 2:1. There is no surrender. Both split hands share one dealer. Every face and suit remains in the resolved card history.

`createBlackjack({ stake })` requires a positive even bigint. Set `initialCash: stake` for conventional pricing. Extra bets contribute existing player cash through `GameAction.additionalCash`. `evaluatePolicy` reports `expectedAdditionalCash` and subtracts it in `netEV`; `optimalExpectedValuePolicy` maximizes net return after these costs. Calculate initial-bet RTP as `1 + netEV / stake`, not gross payout divided by stake.

The independently verified optimal completed-hand edge is **0.5703880122736%**, rounding to Stake's advertised 0.57%. Initial-bet RTP is **99.4296119877264%**. Commissions do not change the player's terminal payouts. Mid-hand stopping is outside this calculation. The independent check is [the blackjack game's rules test](../../games/blackjack/test/blackjack-rules.test.ts).

A game page loads the committed [funding table](../src/generated/blackjack-funding.ts), generated with `npm run generate:blackjack`. `loadFundedGame(graph, table, scale, admits)` reuses build-time action prices at an exact positive integer scale and lazily constructs the transitions used during play. It retains all runtime risk and settlement checks. The table uses a 1,000,000-wei unit and a 256-stake planning floor; its conservative starting requirement is 672 stakes. Other stake increments and lower capital use the ordinary compiler. `npm test` checks that the committed table is what the current rules and compiler produce, and verifies the loaded transitions; regenerate it alongside any rule or pricing change.

With initial stake 1 ETH, floor 1,000,000 ETH and quantum 10^9 wei, the graph has 14,065 states, maximum depth 52 and required root cash 0.994297434 ETH. See [rules, sources and exact edge](sequential-games.md#blackjack-rules-and-completed-hand-edge).

`blackjackState(nodeId)` exposes public economic state only. Outcome labels preserve individual cards even when next-state IDs coincide. `dealerDistribution(upcard)` remains the unconditional exact S17 reference distribution, including naturals. The playable graph checks for blackjack first and conditions the later hole card accordingly.

## Mines example

`createMines({ tiles: 5, mines: 1, cashouts })` uses the same compiler for repeated reveal/cash-out choices. The example's gross cashouts after one, two or three safe picks are 1.20, 1.56 and 2.28 times its initial cash. Fixed-stop RTPs are exactly 96%, 93.6% and 91.2%; later reveals each retain a positive conditional edge. Cash-out is an equal-cash no-wager transition, and the example needs no direct payments. See [the source](../src/engine/mines.ts), [the demo](../scripts/demos/mines.ts) and [games/mines](../../games/mines/), the playable page.

## Further reading

- [Sequential games built from native bets](sequential-games.md): the derivation, the bankroll floor, and the blackjack rules and edge.
- [Collapsing a table too large for one bet](collapsing-bets.md).
- [Kelly pricing and commission](../../docs/economics.md): the admission rule the engine prices against.
