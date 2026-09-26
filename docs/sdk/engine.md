---
title: Engine
description: Reference for @hookedin/play/sdk/engine, which prices finite multi-step games exactly and plays each step as one casino bet, and for the precomputed blackjack table.
sidebar:
  order: 3
---

`import { compileGame, createMines } from '@hookedin/play/sdk/engine';` prices games of several steps. The module is
Node-safe: it has no dependencies and touches no browser API, so it runs in a game page, a test and a build script
alike. A game is a finite acyclic graph of public states with exact probabilities. The engine works backward from the
terminal payouts and gives every state the least cash that finances each of its actions as one casino bet the casino's
admission rule accepts. It uses bigint arithmetic and exact fractions throughout, and draws randomness only for a step
that moves no money. [`RoundClient`](round.md) plays a priced game through the wallet, and
[sequential games](../games/sequential-games.md) derives the method.

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

In a clone of play, `npm run demo:blackjack` and `npm run demo:mines` trace a game on the command line. They simulate
outcomes with Web Crypto and use reference accounting; they place no wagers.

## rational.ts

Exact fractions: game rules state probabilities as fractions, and nothing here rounds one.

### `Rational`

```ts
export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}
```

A fraction `n / d`. The functions below accept any bigint pair and return one in lowest terms with a positive
denominator, frozen.

### `fraction`

```ts
export function fraction(n: bigint, d: bigint = 1n): Rational;
```

The fraction `n / d`, normalized: `fraction(6n, -4n)` is `{ n: -3n, d: 2n }`. Throws a `TypeError` unless both are
bigints, and a `RangeError` for `d` of `0n`.

### `add`

```ts
export function add(a: Rational, b: Rational): Rational;
```

`a + b`.

### `multiply`

```ts
export function multiply(a: Rational, b: Rational): Rational;
```

`a × b`.

### `divide`

```ts
export function divide(a: Rational, b: Rational): Rational;
```

`a ÷ b`. Throws a `RangeError` when `b` is zero.

### `compare`

```ts
export function compare(a: Rational, b: Rational): -1 | 0 | 1;
```

`-1` when `a < b`, `0` when they are equal, `1` when `a > b`.

## model.ts

The graph a game's rules are written as.

### `GameOutcome`

```ts
export interface GameOutcome {
  readonly next: string;
  readonly probability: Rational;
  readonly label?: string;
}
```

One way an action can go: the node it leads to, its exact probability, and a label for presentation, which
`RoundClient` keeps in the round's [events](round.md#roundevent).

### `GameAction`

```ts
export interface GameAction {
  readonly id: string;
  readonly additionalCash?: bigint;
  readonly outcomes: readonly GameOutcome[];
}
```

A choice at a decision node. `additionalCash` is player cash the action commits besides the round's, such as a double
or a split; it defaults to `0n`. The outcomes' probabilities sum to one.

### `GameNode`

```ts
export type GameNode =
  | { readonly id: string; readonly kind: 'terminal'; readonly payout: bigint }
  | { readonly id: string; readonly kind: 'decision'; readonly actions: readonly GameAction[] };
```

A public state. A terminal node pays `payout`, the gross cash the round ends with; a decision node offers its actions.

### `GameGraph`

```ts
export interface GameGraph {
  readonly root: string;
  readonly nodes: readonly GameNode[];
}
```

A finite, acyclic graph of public states, entered at `root`. Node IDs are unique and not empty. An action is chosen
before its outcome is drawn. The [dice](../../games/dice/src/rules.ts) rules are the smallest example: one decision,
two outcomes.

```ts
import { fraction } from '@hookedin/play/sdk/engine';
import type { GameGraph } from '@hookedin/play/sdk/engine';

const coin = (stake: bigint): GameGraph => ({
  root: 'ready',
  nodes: [
    {
      id: 'ready',
      kind: 'decision',
      actions: [
        {
          id: 'flip',
          outcomes: [
            { next: 'won', probability: fraction(1n, 2n) },
            { next: 'lost', probability: fraction(1n, 2n) },
          ],
        },
      ],
    },
    { id: 'won', kind: 'terminal', payout: (stake * 198n) / 100n },
    { id: 'lost', kind: 'terminal', payout: 0n },
  ],
});
```

## transition.ts

One step of a game as one casino bet. The round's outcome picks the successor: the player stakes the cash the step
could cost them, and each better successor is a prize, so the cash after the bet is exactly the successor's.

### `UINT256_MAX`

```ts
export const UINT256_MAX = (1n << 256n) - 1n;
```

The largest amount the engine accepts.

### `OUTCOME_SPACE`

```ts
export const OUTCOME_SPACE = 1n << 64n;
```

A round's outcome is a uniform integer below this, 2^64.

### `MAX_PRIZES`

```ts
export const MAX_PRIZES = 64;
```

The most prizes one casino bet holds.

### `Prize`

```ts
export interface Prize {
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
  readonly payout: bigint;
}
```

Pays `payout` when the round's outcome falls in `[rangeStart, rangeEnd)`. The bigint form of the bridge's prize.

### `Bet`

```ts
export interface Bet {
  readonly stake: bigint;
  readonly prizes: readonly Prize[];
}
```

A casino bet: a stake paid to enter, and the prizes it can pay.

### `Admits`

```ts
export type Admits = (bankroll: bigint, bet: Bet) => boolean;
```

The casino's admission rule, which the caller supplies: would a bankroll of this size take this bet? The engine prices
against it and never assumes what it is. Pass the casino's own, [`admits`](admits.md#admits).

### `CashOutcome`

```ts
export interface CashOutcome {
  readonly next: string;
  readonly label?: string;
  readonly cash: bigint;
  readonly probability: Rational;
}
```

A successor state and the cash needed to continue from it.

### `Successor`

```ts
export interface Successor extends CashOutcome {
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
}
```

A successor with the stretch of the outcome space that leads to it.

### `TransitionInput`

```ts
export interface TransitionInput {
  readonly admits: Admits;
  readonly bankroll: bigint;
  readonly cash: bigint;
  readonly outcomes: readonly CashOutcome[];
}
```

What [`compileTransition`](#compiletransition) takes: the rule, the bankroll to plan against, the cash brought to the
step and its successors.

### `TransitionPlan`

```ts
export type TransitionPlan =
  | {
      readonly kind: 'casino-bet';
      readonly cash: bigint;
      readonly retained: bigint;
      readonly bet: Bet;
      readonly successors: readonly Successor[];
      readonly outcomes: readonly CashOutcome[];
    }
  | {
      readonly kind: 'noop' | 'payment';
      readonly cash: bigint;
      readonly successorCash: bigint;
      readonly amount: bigint;
      readonly outcomes: readonly CashOutcome[];
    };
```

A step as it is played. A `casino-bet` keeps `retained`, the cheapest successor's cash, whatever happens, and stakes the
rest of `cash` on `bet`. A step whose successors all need the same cash, `successorCash`, moves no money on chance: it
is a `noop` when `cash` equals it, or a `payment` of `amount`, the cash left over, to the bankroll.

### `TransitionPriceInput`

```ts
export interface TransitionPriceInput {
  readonly admits: Admits;
  readonly bankroll: bigint;
  readonly outcomes: readonly CashOutcome[];
  readonly quantum: bigint;
}
```

What [`priceTransition`](#pricetransition) takes. `quantum` is the grid prices are searched on, in the same units as
every cash value.

### `apportion`

```ts
export function apportion(outcomes: readonly CashOutcome[]): Successor[];
```

Lays the successors along `[0, 2^64)` in their stated order. Each is as wide as its probability, in whole outcomes: the
floor of its share, with the few outcomes left over going one each to the largest remainders. A probability that divides
2^64 is exact; any other is within 2^-64. Successors of zero probability are dropped. Throws a `RangeError` when there
are no outcomes, a probability is negative, the probabilities do not sum to one, a successor is rarer than one outcome
in 2^64, or a cash value is not a uint256, and an `Error` for an outcome with no `next`.

```ts
import { apportion, fraction } from '@hookedin/play/sdk/engine';

apportion([
  { next: 'win', cash: 2000n, probability: fraction(99n, 200n) },
  { next: 'lose', cash: 0n, probability: fraction(101n, 200n) },
]); // win: [0, 9131138316486228050); lose: [9131138316486228050, 2^64)
```

### `compileTransition`

```ts
export function compileTransition({ admits, bankroll, cash, outcomes }: TransitionInput): TransitionPlan;
```

The exact step for `cash`. Every successor other than the cheapest is a prize paying its cash less `retained`, over its
stretch of the outcome space; neighbouring successors that need the same cash make one prize. The bet stakes
`cash - retained`. Without prizes the step is a `noop` or a `payment`. Throws a `RangeError` when `cash` does not cover
the step, the step has more than 64 distinct prizes, the bet is not admitted at `bankroll`, or `bankroll` is not a
positive uint256.

### `priceTransition`

```ts
export function priceTransition({ admits, bankroll, outcomes, quantum }: TransitionPriceInput): bigint;
```

The least cash on the `quantum` grid whose bet `admits` accepts at `bankroll`. A larger stake is never less safe for the
bankroll, so the search is a bisection. A step that moves no money costs exactly its successors' cash. Throws a
`RangeError` when even the dearest successor's cash is not admitted.

```ts
import { fraction, priceTransition } from '@hookedin/play/sdk/engine';
import { admits } from '@hookedin/play/sdk/admits';

priceTransition({
  admits,
  bankroll: 10n ** 12n,
  quantum: 1n,
  outcomes: [
    { next: 'win', cash: 2000n, probability: fraction(99n, 200n) },
    { next: 'lose', cash: 0n, probability: fraction(101n, 200n) },
  ],
}); // 991n: at 990n the bet would pay back the whole stake on average, and leave the casino no edge
```

## engine.ts

Pricing a whole graph, and playing it one step at a time.

### `RandomBelow`

```ts
export type RandomBelow = (limit: bigint) => bigint;
```

A uniform integer in `[0, limit)`. Only a step that moves no money and has several successors draws from it.

### `PricedAction`

```ts
export interface PricedAction {
  readonly id: string;
  readonly additionalCash: bigint;
  readonly requiredCash: bigint;
  readonly transition: TransitionPlan;
}
```

An action of a priced node. `requiredCash` is the node cash it needs besides its own `additionalCash`. `transition` is
the step it plays from the node's cash plus `additionalCash`; a plan from `loadFundedGame` builds it the first time it is
read.

### `PricedNode`

```ts
export type PricedNode =
  | { readonly id: string; readonly kind: 'terminal'; readonly cash: bigint; readonly depth: 0 }
  | {
      readonly id: string;
      readonly kind: 'decision';
      readonly cash: bigint;
      readonly depth: number;
      readonly actions: readonly PricedAction[];
    };
```

A node with its cash: a terminal node's payout, or a decision node's price, the most its actions require; the root's
cash is `initialCash` when one was given. `depth` is the most steps of positive probability from the node to the end.

### `GamePlan`

```ts
export interface GamePlan {
  readonly admits: Admits;
  readonly root: string;
  readonly bankrollFloor: bigint;
  readonly cashQuantum: bigint;
  readonly requiredCash: bigint;
  readonly initialCash: bigint;
  readonly maximumCash: bigint;
  readonly maximumDepth: number;
  readonly conservativeBankroll: bigint;
  readonly nodes: readonly PricedNode[];
}
```

A priced graph.

| Field                                            | Meaning                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `admits`, `root`, `bankrollFloor`, `cashQuantum` | As the plan was compiled                                                                                                                    |
| `requiredCash`                                   | The cash the root needs: its price                                                                                                          |
| `initialCash`                                    | The cash the round starts with: `initialCash` when it was given, otherwise `requiredCash`                                                   |
| `maximumCash`                                    | The most cash any state holds                                                                                                               |
| `maximumDepth`                                   | The root's depth                                                                                                                            |
| `conservativeBankroll`                           | `bankrollFloor + maximumDepth × maximumCash`: a bankroll that stays above the floor through one play of the game, if nothing else lowers it |
| `nodes`                                          | Every priced node                                                                                                                           |

### `CompileOptions`

```ts
export interface CompileOptions {
  readonly admits: Admits;
  readonly bankrollFloor: bigint;
  readonly cashQuantum: bigint;
  readonly initialCash?: bigint;
}
```

`admits` is the casino's rule; every step is priced as the least cash whose bet it admits at `bankrollFloor`, on a grid
of `cashQuantum`. `initialCash`, when given, is the cash the round starts with, such as the stake, and must cover the
root's price.

### `FundingTable`

```ts
export interface FundingTable {
  readonly bankrollFloor: bigint;
  readonly cashQuantum: bigint;
  readonly initialCash: bigint;
  readonly conservativeBankroll: bigint;
  readonly actions: Readonly<Record<string, readonly bigint[]>>;
}
```

Prices computed at build time: the plan's parameters, and each decision node's actions' `requiredCash`, in the graph's
action order, keyed by node ID. They price a game; they are not settlement authority.
[`blackjackFunding`](#blackjackfunding) is one.

### `compileGame`

```ts
export function compileGame(graph: GameGraph, options: CompileOptions): GamePlan;
```

Prices every legal action before any outcome exists, with no network or wallet access. A decision node's price is the
most any of its actions needs less that action's `additionalCash`. Throws an `Error` for a cyclic graph, a missing or
duplicate node, a decision node without actions, an action without outcomes, or a duplicate or empty action ID; a
`TypeError` without `admits`; and a `RangeError` for a negative probability, an amount outside uint256, a step with more
than 64 distinct prizes or one the planning bankroll cannot cover, or an `initialCash` below the root's price. A
terminal root's `initialCash` must equal its payout.

### `loadFundedGame`

```ts
export function loadFundedGame(graph: GameGraph, table: FundingTable, scale: bigint, admits: Admits): GamePlan;
```

A plan from a funding table, every amount multiplied by `scale`, a positive integer: the graph must be the one built for
a stake of `table.initialCash × scale`. It builds each step the first time it is played and keeps every runtime check.
Throws `Funding table is missing actions at <node>` or `Funding table does not match the game` when the table was not
made for this graph, and a `RangeError` when `scale` is not a positive uint256.

```ts
import { createBlackjack, loadFundedGame } from '@hookedin/play/sdk/engine';
import { blackjackFunding } from '@hookedin/play/sdk/generated/blackjack-funding';
import { admits } from '@hookedin/play/sdk/admits';

const plan = loadFundedGame(createBlackjack({ stake: 3_000_000n }), blackjackFunding, 3n, admits);
plan.conservativeBankroll; // 2016000000n: 672 stakes
```

### `compileGameAsync`

```ts
export async function compileGameAsync(graph: GameGraph, options: CompileOptions): Promise<GamePlan>;
```

`compileGame`, yielding to the event loop every 32 nodes so a page stays responsive.

### `getNode`

```ts
export function getNode(plan: GamePlan, id: string): PricedNode;
```

A priced node by ID. Throws a `TypeError` for a plan that did not come from this engine, and an `Error` for an unknown
node.

### `Policy`

```ts
export type Policy = (node: Extract<PricedNode, { kind: 'decision' }>) => string;
```

Which action to take at a decision node. It must depend on the node alone.

### `PolicyEvaluation`

```ts
export interface PolicyEvaluation {
  readonly distribution: readonly { readonly payout: bigint; readonly probability: Rational }[];
  readonly expectedPayout: Rational;
  readonly expectedAdditionalCash: Rational;
  readonly netEV: Rational;
  readonly expectedCasinoBets: Rational;
  readonly expectedPayments: Rational;
}
```

The exact result of playing a policy to the end: each terminal payout and its probability, in ascending payout order;
the expected payout; the expected additional cash; `netEV`, the expected payout less `initialCash` and the expected
additional cash; and the expected number of casino bets and of payments.

### `evaluatePolicy`

```ts
export function evaluatePolicy(plan: GamePlan, policy: Policy): PolicyEvaluation;
```

Evaluates `policy` exactly over the plan. It assumes play to a terminal node, with no stopping outside the graph's own
actions. Throws an `Error` when the policy names an action a node does not offer. A game's return on its initial stake
is `1 + netEV / initialCash`.

```ts
import type { Policy } from '@hookedin/play/sdk/engine';

// The mines plan from the top of this page, cashing out after two safe picks.
const cashOutAfterTwo: Policy = node => (node.id === 'mines:picks:2' ? 'cash-out' : 'reveal');
evaluatePolicy(plan, cashOutAfterTwo).expectedPayout; // { n: 936000n, d: 1n }: 93.6% of a 1,000,000 stake
```

### `optimalExpectedValuePolicy`

```ts
export function optimalExpectedValuePolicy(plan: GamePlan): Policy;
```

The policy with the highest expected payout less additional cash, at every node of the plan, including nodes the policy
never reaches. Pricing is separate from it: every legal policy is financed.

### `selectWeighted`

```ts
export function selectWeighted<T>(items: readonly T[], weight: (item: T) => Rational, random: RandomBelow): T;
```

Draws one item with probability proportional to its exact weight, skipping items of zero weight. Throws a `TypeError`
without `random`, and a `RangeError` when every weight is zero or `random` answers outside its range.

### `RuntimeState`

```ts
export interface RuntimeState {
  readonly nodeId: string;
  readonly cash: bigint;
  readonly bankroll: bigint;
}
```

Where a game stands while it is played: its node, its cash, and the casino's bankroll as last reported.

### `PreparedTransition`

```ts
export type PreparedTransition =
  | (PreparedBase & {
      readonly kind: 'casino-bet';
      readonly bet: Bet;
      readonly retained: bigint;
      readonly successors: readonly Successor[];
    })
  | (PreparedBase & {
      readonly kind: 'noop' | 'payment';
      readonly next: string;
      readonly label?: string | undefined;
      readonly cash: bigint;
      readonly amount: bigint;
    });
```

A step ready to play. Both kinds carry `before`, the `RuntimeState` it was prepared from, `actionId` and
`additionalCash`. A `casino-bet` carries exactly what the wallet signs, `bet`, and where each stretch of the outcome
space leads, `successors`. A `noop` or `payment` has already chosen its successor, `next`, and pays `amount` to the
bankroll.

### `prepareAction`

```ts
export function prepareAction(
  plan: GamePlan,
  state: RuntimeState,
  actionId: string,
  random?: RandomBelow,
): PreparedTransition;
```

Takes an action before its round's outcome exists. The same action is always the same bet, so there is nothing to
protect from a redraw. It checks the step again at the live bankroll. Only a step that moves no money and has several
successors draws its successor from `random`, and no cash rides on that draw. Throws an `Error` for a terminal node, a
`state.cash` other than the node's cash, or an action the node does not offer; a `RangeError` when the live bankroll is
below the plan's floor or does not admit the bet; and a `TypeError` when the step needs `random` and has none.

```ts
import { prepareAction, resolveTransition, rngFromBytes, simulateServerResult } from '@hookedin/play/sdk/engine';

const random = rngFromBytes(bytes => crypto.getRandomValues(bytes));
const step = prepareAction(plan, { nodeId: plan.root, cash: plan.initialCash, bankroll: 10n ** 18n }, 'reveal', random);
if (step.kind === 'casino-bet') {
  // A game signs step.bet and resolves it with the verified receipt's outcome; a demonstration simulates one.
  const { state, payout } = resolveTransition(step, simulateServerResult(step, random));
}
```

### `Resolution`

```ts
export interface Resolution {
  readonly state: RuntimeState;
  readonly label?: string | undefined;
  readonly payout: bigint;
  readonly payment: bigint;
}
```

The state a step leads to, its outcome's label, what the bet's prizes paid (or `0n`), and what the step paid the
bankroll (or `0n`).

### `resolveTransition`

```ts
export function resolveTransition(prepared: PreparedTransition, outcome?: bigint): Resolution;
```

Applies a step. A casino bet needs the round's verified 64-bit `outcome`, which names its successor; a step without a
bet takes none. The bankroll it reports is reference accounting: it ignores the casino's commission, which only lowers
it further. It proves no settlement and sends nothing. Throws a `TypeError` for a step `prepareAction` did not return,
a bet without a valid outcome, or a step without a bet given one.

### `simulateServerResult`

```ts
export function simulateServerResult(prepared: PreparedTransition, random: RandomBelow): bigint;
```

A uniform outcome below 2^64 for a prepared casino bet, for demonstrations and tests. A live game takes its outcome from
the verified receipt. Throws an `Error` for a step that is not a bet.

### `rngFromBytes`

```ts
export function rngFromBytes(fill: (bytes: Uint8Array<ArrayBuffer>) => void): RandomBelow;
```

A `RandomBelow` from a secure byte source such as `crypto.getRandomValues`, unbiased by rejection sampling. Throws a
`TypeError` when `fill` is not a function; the function it returns throws a `RangeError` for a limit below `1n`.

## blackjack.ts

Blackjack as a graph: infinite deck, dealer stands on soft 17, dealer peeks for blackjack, 3:2 naturals, double on any
first two cards including after a split, one split, one card to each split ace, no surrender, and insurance at half the
stake paying 2:1. Both split hands settle against one dealer. [Sequential games](../games/sequential-games.md) states
the rules' sources and the exact edge of optimal play.

### `CardRank`

```ts
export type CardRank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
```

A card's value: `1` is an ace, and `10` stands for ten, jack, queen and king.

### `BlackjackHand`

```ts
export interface BlackjackHand {
  readonly total: number;
  readonly soft: boolean;
}
```

A hand's best total, with at most one ace counted as eleven, and whether one is.

### `BlackjackResult`

```ts
export interface BlackjackResult {
  readonly total: number;
  readonly multiplier: 1 | 2;
}
```

A finished hand: `total` is its standing total, with 16 for every total below 17, 22 for a bust and 23 for a natural;
`multiplier` is 2 after a double.

### `BlackjackState`

```ts
export interface BlackjackState extends BlackjackHand {
  readonly phase: 'first' | 'second' | 'upcard' | 'insurance' | 'peek' | 'player' | 'split-deal' | 'hole' | 'dealer';
  readonly dealerUpcard: CardRank | 0;
  readonly pair: CardRank | 0;
  readonly firstTwo: boolean;
  readonly split: boolean;
  readonly pendingSplit: CardRank | 0;
  readonly completed: readonly BlackjackResult[];
  readonly multiplier: 1 | 2;
}
```

The public state a node ID encodes. `phase` is what comes next: the player's first and second cards, the dealer's
upcard, the insurance offer (an ace up), the peek (a ten up), the player's decision, a split hand's second card, the
dealer's hole card or the dealer's draws. `total` and `soft` are the player's hand, or the dealer's in the `hole` and
`dealer` phases. `dealerUpcard` is `0` before the upcard and in the `dealer` phase; `pair` is the rank the player may
split, or `0`; `firstTwo` means the hand holds its first two cards, so it may double; `split` marks a split hand and
`pendingSplit` the rank of the split hand still to play; `completed` holds the finished hands.

### `DealerResult`

```ts
export type DealerResult = 'natural' | 'bust' | 17 | 18 | 19 | 20 | 21;
```

How the dealer's hand ends.

### `DealerOutcome`

```ts
export interface DealerOutcome {
  readonly result: DealerResult;
  readonly probability: Rational;
}
```

One way the dealer's hand ends, and its exact probability.

### `cardProbability`

```ts
export function cardProbability(rank: CardRank): Rational;
```

The chance of drawing `rank` from the infinite deck: 1/13, or 4/13 for `10`. Throws a `RangeError` for a rank outside
1 to 10.

### `addCard`

```ts
export function addCard(hand: BlackjackHand, rank: CardRank): BlackjackHand;
```

The hand with one more card. `addCard({ total: 11, soft: true }, 10)` is `{ total: 21, soft: true }`, and
`addCard({ total: 16, soft: false }, 1)` is `{ total: 17, soft: false }`. Throws a `RangeError` for an invalid rank, or
a hand that is bust or not a valid best total.

### `dealerDistribution`

```ts
export function dealerDistribution(upcard: CardRank): readonly DealerOutcome[];
```

The exact distribution of the dealer's final hand from an upcard, standing on soft 17, with the two-card natural apart
from a later 21. It is unconditional: the game's graph checks for a dealer blackjack before the player acts and deals the
hole card on that condition.

### `blackjackState`

```ts
export function blackjackState(id: string): BlackjackState | undefined;
```

The public state a blackjack decision node's ID encodes, or `undefined` for any other ID, such as a payout node's.

### `createBlackjack`

```ts
export function createBlackjack({ stake }: { readonly stake: bigint }): GameGraph;
```

The graph of one hand for `stake`, a positive even bigint so that a natural's 3:2 is exact; a `RangeError` otherwise. It
has 14,065 nodes at any stake.

| Action              | Phase                                                                                       | `additionalCash` |
| ------------------- | ------------------------------------------------------------------------------------------- | ---------------- |
| `deal`              | `first`, `second`, `upcard`: each of the player's first two cards, then the dealer's upcard | –                |
| `decline-insurance` | `insurance`: an ace up                                                                      | –                |
| `insurance`         | `insurance`                                                                                 | half the stake   |
| `peek`              | `peek`: a ten up                                                                            | –                |
| `stand`, `hit`      | `player`                                                                                    | –                |
| `double`            | `player`, on a hand's first two cards                                                       | the stake        |
| `split`             | `player`, on a pair, once                                                                   | the stake        |
| `deal-split`        | `split-deal`: a split hand's second card                                                    | –                |
| `reveal`            | `hole`: the dealer's hole card                                                              | –                |
| `dealer-hit`        | `dealer`                                                                                    | –                |

Decision node IDs start `blackjack:v1:`, and [`blackjackState`](#blackjackstate) reads them. A terminal node
`blackjack:payout:<n>` pays `n` half-stakes. Every drawn card keeps its face and suit in its outcome's label:
`player:<hand>:<face>:<suit>` or `dealer:<face>:<suit>`, with faces 1 to 13 and suits 0 to 3; the peek's outcomes are
`no-blackjack` and `dealer-blackjack:<face>:<suit>`.

## mines.ts

### `createMines`

```ts
export function createMines({
  tiles,
  mines,
  cashouts,
}: {
  readonly tiles: number;
  readonly mines: number;
  readonly cashouts: readonly bigint[];
}): GameGraph;
```

Reveal-or-cash-out Mines: `tiles` unrevealed tiles, `mines` of them mines, and `cashouts[k - 1]` the gross cash after
`k` safe picks. The root is `mines:picks:0`. At `mines:picks:<k>` the player may `reveal`, which hits a mine with
probability `mines / (tiles - k)` and leads to `mines:loss`, paying nothing, or else to `mines:picks:<k + 1>`; and, from
the first safe pick, `cash-out`, which leads to `mines:payout:<k>`, paying `cashouts[k - 1]`. After the last cash-out
value only `cash-out` is left. Throws a `RangeError` unless `0 < mines < tiles` in whole numbers and `cashouts` holds 1
to `tiles - mines` positive bigints.

The house's [mines](../../games/mines/) pays 1.20, 1.56 and 2.28 times the stake on five tiles with one mine: cashing
out after one, two or three safe picks returns exactly 96%, 93.6% and 91.2%.

## blackjack-funding

`import { blackjackFunding } from '@hookedin/play/sdk/generated/blackjack-funding';` is the precomputed price table for
[`createBlackjack`](#createblackjack). It is Node-safe data, about 1 MB.

### `blackjackFunding`

```ts
export const blackjackFunding: FundingTable;
```

The required cash of every action of the blackjack graph's 14,055 decision nodes, compiled at a 1,000,000-wei stake with
a planning floor of 256 stakes and a one-wei grid. Its `initialCash` is `1000000n`, its `bankrollFloor` `256000000n` and
its `conservativeBankroll` `672000000n`, 672 stakes. [`loadFundedGame`](#loadfundedgame) scales it exactly to any stake
divisible by 1,000,000 wei, and `RoundClient` does so when the bankroll covers 672 stakes; other stakes and smaller
bankrolls are priced in the page. In play, `npm run generate:blackjack` regenerates it, and `npm test` fails when it
does not match the rules and the compiler.
