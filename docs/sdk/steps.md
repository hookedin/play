---
title: Binary steps
description: Reference for @hookedin/play/sdk/steps, which backs a draw a game's players share, such as a roulette spin, with binary casino bets from its developer's bank, and checks where a spin ends.
sidebar:
  order: 5
---

`import { priceSteps, stepBet, stepOutcome } from '@hookedin/play/sdk/steps';` is how a game whose players share one
draw, such as a roulette spin, has the bankroll back all of it with casino bets of one chance and one prize each. The
module is Node-safe. [Developer bets](../games/developer-bets.md) is the guide, and
[roulette](https://github.com/hookedin/game-roulette) the worked example: its server walks every spin with it, and its
page checks every spin with `stepOutcome`.

The draw's `n` outcomes, equally likely, are the leaves of a fixed balanced binary tree. A spin walks from the root to
one leaf, one level per round, and each level is one casino bet of the developer's, from its bank
([`casinoBet`](developer.md#casinobet)), priced backward from what the developer owes on each leaf. The bet backs the
child that needs more cash, so whichever way its round goes, the developer then holds exactly what the rest of the walk
needs, and at the leaf exactly what it owes there. A level whose children need the same cash bets nothing and only
reveals its round ([`reveal`](developer.md#reveal)).

Sign the side each bet backs in its meta: it is then fixed before its round is revealed, and cannot favour anyone. Open
a draw's rounds, [`levels(n)`](#levels) of them, before anybody bets, and commit to them in the ID its players' bets
carry as their group ([developer bets](../games/developer-bets.md#shared-games-binary-steps)); walk level `k` on round
`k`. The leaf then follows from the rounds' outcomes and the sides alone, so anyone can check a spin from what the
casino publishes of its rounds ([`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround)), which a game
page reads through the wallet with [`HookedIn.round`](hookedin.md#round).

```ts
import { levels, next, priceSteps, stepBet, stepsCash } from '@hookedin/play/sdk/steps';

// Before anybody bets: a round for each level of the walk.
const rounds: string[] = [];
for (let level = 0; level < levels(37); level++) rounds.push((await developer.openRound('eth')).id);

// Once the spin's bets are in: what the wheel owes on each of its 37 pockets.
const plan = priceSteps(owed, (await developer.bankroll('eth')) / 2n);
stepsCash(plan); // what the bank needs to start the walk
let node = { lo: 0, hi: 37 };
for (let level = 0; node.hi - node.lo > 1; level++) {
  const round = rounds[level]!,
    bet = stepBet(plan, node),
    revealed = bet
      ? await developer.casinoBet({ round, ...bet, group: spin, meta: { side: bet.side } })
      : await developer.reveal({ round, group: spin, meta: {} });
  node = next(node, bet?.side ?? 'left', BigInt(revealed.outcome!)); // a declined bet reveals its round all the same
}
node.lo; // the pocket
```

## The tree

### `StepNode`

```ts
export interface StepNode {
  lo: number;
  hi: number;
}
```

A node of the tree: the outcomes `[lo, hi)`. The root of a draw of `n` outcomes is `{ lo: 0, hi: n }`, and a leaf holds
one outcome.

### `Side`

```ts
export type Side = 'left' | 'right';
```

One of a node's two children.

### `levels`

```ts
export function levels(n: number): number;
```

The most levels a walk over `n` outcomes takes: how many rounds one spin needs. `levels(37)` is 6, and a spin of 37
pockets walks 5 or 6.

### `children`

```ts
export function children({ lo, hi }: StepNode): [StepNode, StepNode];
```

A node's two children, split at `mid = lo + ⌊(hi − lo) / 2⌋`: the left `[lo, mid)` and the right `[mid, hi)`.
`children({ lo: 0, hi: 37 })` is `[{ lo: 0, hi: 18 }, { lo: 18, hi: 37 }]`. Throws a `RangeError` for a leaf, which has
none, and so do `sideChance`, `next` and `stepBet`, which split the node they are given.

### `sideChance`

```ts
export function sideChance(node: StepNode, side: Side): bigint;
```

The chance that takes a walk to `side` of `node`: that child's share of the node's outcomes, in whole outcomes out of
2^64, rounded down. `sideChance({ lo: 0, hi: 37 }, 'left')` is ⌊2^64 × 18 / 37⌋, `8974091711534376461n`.

### `next`

```ts
export function next(node: StepNode, side: Side, outcome: bigint): StepNode;
```

One level of a walk: the child its round's `outcome` reaches when the level named `side`. An outcome below
`sideChance(node, side)` reaches that side, and any other the other side. A level with no bet names the left. Whichever
side a level names, each child is reached with its share of the node's outcomes to within one outcome in 2^64.

## Pricing

### `StepBet`

```ts
export interface StepBet {
  stake: bigint;
  chance: bigint;
  prize: bigint;
  side: Side;
}
```

One level's casino bet: its `stake` pays `prize` when the round's outcome is below `chance`, and that outcome takes the
walk to `side`, the child that needs more cash.

### `StepPlan`

```ts
export interface StepPlan {
  readonly owed: readonly bigint[];
  readonly bankroll: bigint;
  readonly cash: ReadonlyMap<string, bigint>;
}
```

A priced tree: what is owed on each leaf, the bankroll it was priced against, and the cash each node needs, keyed
`<lo>:<hi>`.

### `priceSteps`

```ts
export function priceSteps(owed: readonly bigint[], bankroll: bigint): StepPlan;
```

The cash every node needs, backward from `owed`, what the developer owes on each of the draw's outcomes. A leaf needs
what is owed on it, and a node whose children need the same cash needs that. Any other node needs the least cash whose
bet between its children the casino's rule, [`admits`](admits.md#admits), takes at `bankroll`: a stake of the node's
cash less the lower child's, paying the difference between the children with the dearer side's chance. More cash is
never less safe for the bankroll, and a stake of the whole difference cannot lose it anything, so the search is a
bisection. Throws a `RangeError` unless `owed` holds at least one amount, every amount is a nonnegative bigint and `bankroll` is a positive one.

The casino decides against its bankroll when each bet arrives, so price against less than it reports: roulette prices
at half.

### `stepsCash`

```ts
export const stepsCash: (plan: StepPlan) => bigint;
```

What a spin needs to start: the root's cash. A walk moves the developer's bank by what is owed on its leaf less this.

### `stepBet`

```ts
export function stepBet(plan: StepPlan, node: StepNode): StepBet | null;
```

The casino bet of one level, `node` being a node of the plan's tree with two outcomes or more. It backs the child that
needs more cash: it stakes the node's cash less the other child's, and its prize is the difference between the two.
Won, the walk holds the backed child's cash; lost, the other's. `null` where both children need the same cash: the level
bets nothing and only reveals its round, and names the left.

## Checking a spin

### `stepOutcome`

```ts
export function stepOutcome(
  n: number,
  steps: readonly { side?: Side; chance?: bigint | string; outcome: bigint | string }[],
): number;
```

The leaf a spin's steps reach from the root of a tree of `n` outcomes. Each step gives its round's `outcome` and, for a
bet, the `side` it named and its `chance`; a level that only revealed its round gives its outcome alone. Chances and
outcomes are bigints or decimal strings. A step's chance, when given, must be its side's share, `sideChance`. Throws an
`Error` when a step names neither side, a chance is not its side's share, or the steps go past a leaf or stop before
one.

```ts
import { stepOutcome } from '@hookedin/play/sdk/steps';

// A spin's rounds in order, each read with HookedIn.round and checked as outcome.md shows.
const pocket = stepOutcome(
  37,
  rounds.map(({ outcome, casinoBet }) =>
    casinoBet.chance === '0' ? { outcome } : { side: casinoBet.meta.side, chance: casinoBet.chance, outcome },
  ),
);
```
