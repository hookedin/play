---
title: Engine
description: Reference for @hookedin/play/sdk/engine, which prices finite multi-step games exactly and plays each step as at most one casino bet.
sidebar:
  order: 3
---

`import { compileGame } from '@hookedin/play/sdk/engine';` prices games of several steps. The module is Node-safe: it
touches no browser API, so it runs in a game page, a test and a build script alike. A game is a finite acyclic graph of
public states with exact probabilities. The engine gives every state the least cash with which each of its actions is
one wager the planning bankroll takes, and plays a step as at most one casino bet, drawn by the wallet, so that every
successor is reached exactly as often as the rules say. It uses bigint arithmetic and exact fractions throughout.
[`RoundClient`](round.md) plays a priced game through the wallet, and [pricing and collapsing](../games/collapsing-bets.md)
derives the method.

```ts
import { compileGame, evaluatePolicy, optimalExpectedValuePolicy } from '@hookedin/play/sdk/engine';
import { doubleUp } from './rules.ts'; // Double up, from multi-step games: two flips at 1.9 times

const stake = 1_000_000n;
const plan = compileGame(doubleUp({ stake }), {
  bankrollFloor: 1_000_000n * stake,
  cashQuantum: 1n,
  initialCash: stake,
});
plan.requiredCash; // 950001n: the least cash that finances the first flip
plan.conservativeBankroll; // 1000007220000n
evaluatePolicy(plan, optimalExpectedValuePolicy(plan)).netEV; // { n: -50000n, d: 1n }: best play returns 95%
```

[Double up](../games/multi-step-games.md#describe-the-game-as-a-graph) is the graph the examples on this page price.

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
presentation, 1 to 64 printable characters, which `RoundClient` sends with the step's table for the wallet to show, and
keeps in the round's [events](round.md#roundevent).

### `OUTCOME_SPACE`

2^64: a round's outcome is a uniform integer below it, and a bet's chance counts outcomes out of it.

## Pricing

### `compileGame`

`compileGame(graph, { bankrollFloor, cashQuantum, initialCash? })` prices every legal action before any outcome exists,
with no network or wallet access, and returns a [`GamePlan`](#gameplan). Every step is priced as the least cash on a
grid of `cashQuantum` at which it is one wager `bankrollFloor` takes, and every bet it can place is checked against the
casino's own rule, [`admits`](admits.md#admits), at `bankrollFloor`. `initialCash`, when given, is the cash the round
starts with, such as the stake, and must cover the root's price; a terminal root's must equal its payout. A decision
node's price is the most any of its actions needs less that action's `additionalCash`. [`pricing`](round.md#pricing)
gives the options `RoundClient` prices a round with.

Throws an `Error` for a cyclic graph, a missing or duplicate node, a decision node without actions, an action without
outcomes, or a duplicate or empty action ID; and a `RangeError` for a negative probability, probabilities that do not
sum to one, an amount outside uint256, or an `initialCash` below the root's price. A step is built the first time its `transition` is read, and throws then when a bet it can place is not admitted.

### `GamePlan`

A priced graph.

| Field                                  | Meaning                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`, `bankrollFloor`, `cashQuantum` | As the plan was compiled                                                                                                                    |
| `requiredCash`                         | The cash the root needs: its price                                                                                                          |
| `initialCash`                          | The cash the round starts with: `initialCash` when it was given, otherwise `requiredCash`                                                   |
| `maximumCash`                          | The most cash any state holds                                                                                                               |
| `maximumDepth`                         | The root's depth                                                                                                                            |
| `conservativeBankroll`                 | `bankrollFloor + maximumDepth × maximumCash`: a bankroll that stays above the floor through one play of the game, if nothing else lowers it |
| `nodes`                                | Every [`PricedNode`](#pricednode)                                                                                                           |

### `PricedNode`

A node with its `cash`, a terminal node's payout or a decision node's price, and its `depth`, the most steps of positive
probability from it to the end. A decision node's `actions` each carry `requiredCash`, the node cash they need besides
their own `additionalCash`, and `transition`, the [step](#transitionplan) they play.

### `TransitionPlan`

A step as it is played. A `casino-bet` step holds its cash `classes`, cheapest first, and the `branches` it collapses
into at the planning bankroll. A step whose successors all need the same cash moves no money on chance: it is a `noop`
when its `cash` equals that `successorCash`, or a `payment` of `amount`, the cash left over, to the bankroll.
`outcomes` lists every successor of positive probability.

### `getNode`

A priced node of a plan by ID. Throws a `TypeError` for a plan that did not come from this engine, and an `Error` for an
unknown node.

### `FundingTable`

Prices computed at build time: a plan's `bankrollFloor`, `cashQuantum`, `initialCash` and `conservativeBankroll`, and
`actions`, each decision node's actions' `requiredCash` in the graph's action order, keyed by node ID. They price a
game; they are not settlement authority. Blackjack's `src/funding.ts`, which its
[scripts/funding.ts](https://github.com/hookedin/game-blackjack/blob/main/scripts/funding.ts) writes at every build, is
one: every action of its 14,055 decision nodes at a 1,000,000-wei stake, with a planning floor of 256 stakes and a
one-wei grid.

### `loadFundedGame`

`loadFundedGame(graph, table, scale)`: a plan from a funding table, every amount multiplied by `scale`, a positive
integer, for the graph built for a stake of `table.initialCash × scale`. It keeps every runtime check. Throws
`Funding table is missing actions at <node>` or `Funding table does not match the game` when the table was not made for
this graph, and a `RangeError` when `scale` is not a positive uint256.

```ts
import { loadFundedGame } from '@hookedin/play/sdk/engine';
import { createBlackjack } from './rules.ts'; // blackjack's rules and table, in its own repository
import { blackjackFunding } from './funding.ts';

const plan = loadFundedGame(createBlackjack({ stake: 3_000_000n }), blackjackFunding, 3n);
plan.conservativeBankroll; // 2016000000n: 672 stakes
```

## Policies

### `Policy`

Which action to take at a decision node. It must depend on the node alone.

### `evaluatePolicy`

`evaluatePolicy(plan, policy)` plays `policy` exactly to a terminal node, with no stopping outside the graph's own
actions, and returns `expectedPayout`; `expectedAdditionalCash`; and `netEV`, the expected payout less `initialCash`
and the expected additional cash. A game's return on its initial stake is `1 + netEV / initialCash`. Throws an `Error`
when the policy names an action a node does not offer.

```ts
import type { Policy } from '@hookedin/play/sdk/engine';

// The plan from the top of this page, flipping again after a win.
const flipAgain: Policy = () => 'flip';
evaluatePolicy(plan, flipAgain).expectedPayout; // { n: 902500n, d: 1n }: 90.25% of a 1,000,000 stake
```

### `optimalExpectedValuePolicy`

The policy with the highest expected payout less additional cash, at every node of the plan, including nodes it never
reaches. Pricing is separate from it: every legal policy is financed.

## Playing a step

`RoundClient` plays each step with these; a game's test can walk a plan with them, as blackjack's proves its edge.

### `RandomBelow`

A uniform integer in `[0, limit)`, such as [`seededRandom`](#seededrandom) draws: what the page shows a result with.

### `prepareAction`

`prepareAction(plan, { nodeId, cash, bankroll }, actionId)` takes an action before anything is drawn: the step it starts,
for the wallet to draw. It returns `before`, the state it starts from, `actionId`, `additionalCash`, `kind`, `cash`,
`amount`, `outcomes`, every successor of positive probability in the game's own order, each with the cash it needs and
its label, and `weights`, whole numbers in the proportions of their probabilities: the step's table. A step whose
successors need several amounts is a `casino-bet` that holds `cash`, which the wallet splits into casino bets at its
quote's bankroll. A step whose successors all need one amount moves no money, a `noop`, or pays the bankroll what they
do not need, a `payment` of `amount`; either way they need `cash`. The engine draws nothing: the wallet splits the
table, draws a bet and lands on a successor, or draws which successor a step without a bet reaches when it has several
([the wallet draws the step](../games/collapsing-bets.md#the-wallet-draws-the-step)). Throws an `Error` for a terminal
node, a `cash` other than the node's, or an action the node does not offer, and a `RangeError` when the live bankroll is
below the plan's floor.

### `resolveTransition`

`resolveTransition(prepared, result?)` applies a prepared step as the wallet landed it: `result` is the successor it
reached, as its place in the step's `outcomes`, the receipt's `result`; a step with one successor takes none. It
returns the `state` reached, with the cash that successor needs, and its `label`. The bankroll it reports takes what
the step held less what the successor needs, and ignores the casino's commission, which only lowers it further. It
proves no settlement and sends nothing. Throws a `TypeError` for a step `prepareAction` did not return, or a result
missing, out of range or given to a step with one successor.

```ts
import { prepareAction, resolveTransition } from '@hookedin/play/sdk/engine';

const step = prepareAction(plan, { nodeId: plan.root, cash: plan.initialCash, bankroll: 10n ** 18n }, 'flip');
resolveTransition(step, 0n).state; // where the flip leads when the wallet lands on its first outcome, heads: `won`
```

### `seededRandom`

A `RandomBelow` drawn from a 64-bit seed, such as the `draw` the wallet makes after a step's result: the SplitMix64
stream from the seed's low 64 bits, rejection-sampled, so the same seed always draws the same values. It is for showing a result, never for
drawing one: Plinko draws its ball's path with `seededRandom(state.settlement.draw)`
([`RoundState`](round.md#roundstate)), so a reload shows the same path into the same bucket.
