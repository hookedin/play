---
title: Engine
description: Reference for @hookedin/play/sdk/engine, which prices finite multi-step games exactly and plays each step as at most one casino bet.
sidebar:
  order: 3
---

`import { compileGame, createMines } from '@hookedin/play/sdk/engine';` prices games of several steps. The module is
Node-safe: it touches no browser API, so it runs in a game page, a test and a build script alike. A game is a finite
acyclic graph of public states with exact probabilities. The engine gives every state the least cash with which each of
its actions is one wager the planning bankroll takes, and plays a step as at most one casino bet, drawn by the page, so
that every successor is reached exactly as often as the rules say. It uses bigint arithmetic and exact fractions
throughout. [`RoundClient`](round.md) plays a priced game through the wallet, and
[pricing and collapsing](../games/collapsing-bets.md) derives the method.

```ts
import { compileGame, createMines, evaluatePolicy, optimalExpectedValuePolicy } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';

const stake = 1_000_000n;
const graph = createMines({ tiles: 5, mines: 1, cashouts: [120n, 156n, 228n].map(n => (stake * n) / 100n) });
const plan = compileGame(graph, { admits, bankrollFloor: 1_000_000n * stake, cashQuantum: 1n, initialCash: stake });
plan.requiredCash; // 960001n: the least cash that finances the first reveal
plan.conservativeBankroll; // 1000009120000n
evaluatePolicy(plan, optimalExpectedValuePolicy(plan)).netEV; // { n: -40000n, d: 1n }: best play returns 96%
```

## Exact fractions

Game rules state probabilities as fractions, and nothing here rounds one. Every function returns a fraction in lowest
terms with a positive denominator, frozen.

### `Rational`

A fraction `{ n, d }` of bigints.

### `fraction`

`fraction(n, d = 1n)`, normalized: `fraction(6n, -4n)` is `{ n: -3n, d: 2n }`. Throws a `TypeError` unless both are
bigints, and a `RangeError` for `d` of `0n`.

### `add`

`a + b`.

### `multiply`

`a × b`.

### `divide`

`a ÷ b`. Throws a `RangeError` when `b` is zero.

### `compare`

`-1` when `a < b`, `0` when they are equal, `1` when `a > b`.

## The graph

The graph a game's rules are written as ([describe the game as a graph](../games/multi-step-games.md#describe-the-game-as-a-graph)).

### `GameGraph`

A finite, acyclic graph of public states, `{ root, nodes }`, entered at `root`. Node IDs are unique and not empty. An
action is chosen before its outcome is drawn. The [dice](../../games/dice/src/rules.ts) rules are the smallest example:
one decision, two outcomes.

### `GameNode`

A public state: `{ id, kind: 'terminal', payout }`, paying `payout`, the gross cash the round ends with, or
`{ id, kind: 'decision', actions }`.

### `GameAction`

A choice at a decision node: `{ id, additionalCash?, outcomes }`. `additionalCash` is player cash the action commits
besides the round's, such as a double or a split, `0n` by default. The outcomes' probabilities sum to one.

### `GameOutcome`

One way an action can go: `{ next, probability, label? }`, the node it leads to, its exact probability, and a label for
presentation, which `RoundClient` keeps in the round's [events](round.md#roundevent).

### `OUTCOME_SPACE`

2^64: a round's outcome is a uniform integer below it, and a bet's chance counts outcomes out of it.

## Pricing

### `compileGame`

`compileGame(graph, { admits, bankrollFloor, cashQuantum, initialCash? })` prices every legal action before any outcome
exists, with no network or wallet access, and returns a [`GamePlan`](#gameplan). `admits` is the casino's rule,
[`admits`](admits.md#admits), which every bet a step can place is checked against at `bankrollFloor`; every step is
priced as the least cash on a grid of `cashQuantum` at which it is one wager `bankrollFloor` takes. `initialCash`, when
given, is the cash the round starts with, such as the stake, and must cover the root's price; a terminal root's must
equal its payout. A decision node's price is the most any of its actions needs less that action's `additionalCash`.

Throws an `Error` for a cyclic graph, a missing or duplicate node, a decision node without actions, an action without
outcomes, or a duplicate or empty action ID; a `TypeError` without `admits`; and a `RangeError` for a negative
probability, probabilities that do not sum to one, an amount outside uint256, or an `initialCash` below the root's
price. A step is built the first time its `transition` is read, and throws then when a bet it can place is not admitted.

### `GamePlan`

A priced graph.

| Field                                            | Meaning                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `admits`, `root`, `bankrollFloor`, `cashQuantum` | As the plan was compiled                                                                                                                    |
| `requiredCash`                                   | The cash the root needs: its price                                                                                                          |
| `initialCash`                                    | The cash the round starts with: `initialCash` when it was given, otherwise `requiredCash`                                                   |
| `maximumCash`                                    | The most cash any state holds                                                                                                               |
| `maximumDepth`                                   | The root's depth                                                                                                                            |
| `conservativeBankroll`                           | `bankrollFloor + maximumDepth × maximumCash`: a bankroll that stays above the floor through one play of the game, if nothing else lowers it |
| `nodes`                                          | Every [`PricedNode`](#pricednode)                                                                                                           |

### `PricedNode`

A node with its `cash`, a terminal node's payout or a decision node's price, and its `depth`, the most steps of positive
probability from it to the end. A decision node's `actions` each carry `requiredCash`, the node cash they need besides
their own `additionalCash`, and `transition`, the [step](#transitionplan) they play.

### `TransitionPlan`

A step as it is played. A `casino-bet` step holds its cash `classes`, cheapest first, the `branches` it collapses into,
and `betMass`, how likely it is to place a bet. A step whose successors all need the same cash moves no money on
chance: it is a `noop` when its `cash` equals that `successorCash`, or a `payment` of `amount`, the cash left over, to
the bankroll. `outcomes` lists every successor of positive probability.

### `getNode`

A priced node of a plan by ID. Throws a `TypeError` for a plan that did not come from this engine, and an `Error` for an
unknown node.

### `FundingTable`

Prices computed at build time: a plan's `bankrollFloor`, `cashQuantum`, `initialCash` and `conservativeBankroll`, and
`actions`, each decision node's actions' `requiredCash` in the graph's action order, keyed by node ID. They price a
game; they are not settlement authority. Blackjack's
[src/funding.ts](https://github.com/hookedin/game-blackjack/blob/main/src/funding.ts) is one: every action of its 14,055
decision nodes at a 1,000,000-wei stake, with a planning floor of 256 stakes and a one-wei grid.

### `loadFundedGame`

`loadFundedGame(graph, table, scale, admits)`: a plan from a funding table, every amount multiplied by `scale`, a
positive integer, for the graph built for a stake of `table.initialCash × scale`. It keeps every runtime check. Throws
`Funding table is missing actions at <node>` or `Funding table does not match the game` when the table was not made for
this graph, and a `RangeError` when `scale` is not a positive uint256.

```ts
import { loadFundedGame } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';
import { createBlackjack } from './rules.ts'; // blackjack's rules and table, in its own repository
import { blackjackFunding } from './funding.ts';

const plan = loadFundedGame(createBlackjack({ stake: 3_000_000n }), blackjackFunding, 3n, admits);
plan.conservativeBankroll; // 2016000000n: 672 stakes
```

## Policies

### `Policy`

Which action to take at a decision node. It must depend on the node alone.

### `evaluatePolicy`

`evaluatePolicy(plan, policy)` plays `policy` exactly to a terminal node, with no stopping outside the graph's own
actions, and returns `distribution`, each terminal payout and its probability in ascending payout order;
`expectedPayout`; `expectedAdditionalCash`; `netEV`, the expected payout less `initialCash` and the expected additional
cash; and `expectedCasinoBets` and `expectedPayments`. A game's return on its initial stake is `1 + netEV / initialCash`.
Throws an `Error` when the policy names an action a node does not offer.

```ts
import type { Policy } from '@hookedin/play/sdk/engine';

// The mines plan from the top of this page, cashing out after two safe picks.
const cashOutAfterTwo: Policy = node => (node.id === 'mines:picks:2' ? 'cash-out' : 'reveal');
evaluatePolicy(plan, cashOutAfterTwo).expectedPayout; // { n: 936000n, d: 1n }: 93.6% of a 1,000,000 stake
```

### `optimalExpectedValuePolicy`

The policy with the highest expected payout less additional cash, at every node of the plan, including nodes it never
reaches. Pricing is separate from it: every legal policy is financed.

## Playing a step

`RoundClient` plays each step with these; a game's test can walk a plan with them, as blackjack's proves its edge.

### `RandomBelow`

A uniform integer in `[0, limit)`: the page's own randomness, which draws each step's branch, and the successor of a
step without a bet when several need its cash.

### `prepareAction`

`prepareAction(plan, { nodeId, cash, bankroll }, actionId, random?)` takes an action before its round's outcome exists.
A step with branches draws one with `random`: a bet branch is a `casino-bet` carrying exactly what the wallet signs,
`bet`, which it checks again at the live `bankroll`, and the classes the step reaches when the round's outcome is below
the bet's chance, `win`, or otherwise, `lose`; the branch without a bet is a `noop` to a successor of its class. A step
that moves no money is a `noop` or a `payment`, with its successor chosen. Save what it returns before the wallet signs
anything, and never draw again for the same step: a redraw would change the game's odds. Throws an `Error` for a
terminal node, a `cash` other than the node's, or an action the node does not offer; a `RangeError` when the live
bankroll is below the plan's floor or does not admit the bet; and a `TypeError` when the step needs `random` and has
none.

### `resolveTransition`

`resolveTransition(prepared, outcome?)` applies a prepared step. A casino bet needs the round's verified 64-bit
`outcome`: below the bet's chance the step reaches `win`, otherwise `lose`, and the outcome draws the state within the
class. A step without a bet takes no outcome. It returns the `state` reached, its `label`, the bet's `payout` and the
step's `payment`; the bankroll it reports ignores the casino's commission, which only lowers it further. It proves no
settlement and sends nothing. Throws a `TypeError` for a step `prepareAction` did not return, a bet without a valid
outcome, or a step without a bet given one.

```ts
import { prepareAction, resolveTransition, seededRandom } from '@hookedin/play/sdk/engine';

// seededRandom draws the same branch every time: fit for a test, never for a live step.
const step = prepareAction(
  plan,
  { nodeId: plan.root, cash: plan.initialCash, bankroll: 10n ** 18n },
  'reveal',
  seededRandom(1n),
);
if (step.kind === 'casino-bet') resolveTransition(step, 0n).state; // where a winning outcome leads
```

### `seededRandom`

A `RandomBelow` drawn from a 64-bit seed, such as a round's verified outcome: the SplitMix64 stream from the seed's low
64 bits, rejection-sampled, so the same seed always draws the same values. It is for showing a result, never for
drawing one: Plinko draws its ball's path with `seededRandom(BigInt(state.settlement.draw))`
([`RoundState`](round.md#roundstate)), so a reload shows the same path into the same bucket.

## Mines

### `createMines`

`createMines({ tiles, mines, cashouts })` is reveal-or-cash-out Mines: `tiles` unrevealed tiles, `mines` of them
mines, and `cashouts[k - 1]` the gross cash after `k` safe picks. The root is `mines:picks:0`. At `mines:picks:<k>` the
player may `reveal`, which hits a mine with probability `mines / (tiles - k)` and leads to `mines:loss`, paying nothing,
or else to `mines:picks:<k + 1>`; and, from the first safe pick, `cash-out`, which leads to `mines:payout:<k>`, paying
`cashouts[k - 1]`. After the last cash-out value only `cash-out` is left. Throws a `RangeError` unless
`0 < mines < tiles` in whole numbers and `cashouts` holds 1 to `tiles - mines` positive bigints. The house's
[mines](../../games/mines/) plays 25 tiles and 1 to 24 mines.
