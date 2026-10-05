---
title: Binary steps
description: Reference for @hookedin/play/sdk/steps, which backs a draw a game's players share, such as a roulette spin, with binary casino bets from its game's bank, and checks where a spin ends.
sidebar:
  order: 5
---

`import { priceSteps, stepBet, stepOutcome } from '@hookedin/play/sdk/steps';` walks a draw a game's players share down
a fixed balanced binary tree of its `n` equally likely outcomes, one casino bet of the developer's per level, so the
bankroll backs all of it. The module is Node-safe. [Shared games](../games/developer-bets.md#shared-games-binary-steps)
is the guide, with the whole walk and the rules that keep it fair, and
[roulette](https://github.com/hookedin/game-roulette) the worked example: its server walks every spin with this module,
and its page checks every spin with `stepOutcome`.

## The tree

### `StepNode`

A node of the tree, `{ lo, hi }`: the outcomes `[lo, hi)`. The root of a draw of `n` outcomes is `{ lo: 0, hi: n }`,
and a leaf holds one outcome.

### `Side`

`'left'` or `'right'`: one of a node's two children.

### `levels`

The most levels a walk over `n` outcomes takes: how many rounds one spin needs. `levels(37)` is 6, and a spin of 37
pockets walks 5 or 6.

### `children`

A node's two children, split at `mid = lo + ⌊(hi − lo) / 2⌋`: the left `[lo, mid)` and the right `[mid, hi)`.
`children({ lo: 0, hi: 37 })` is `[{ lo: 0, hi: 18 }, { lo: 18, hi: 37 }]`. Throws a `RangeError` for a leaf, which has
none, and so do `sideChance`, `next` and `stepBet`, which split the node they are given.

### `sideChance`

The chance that takes a walk to a side of a node: that child's share of the node's outcomes, in whole outcomes out of
2^64, rounded down. `sideChance({ lo: 0, hi: 37 }, 'left')` is ⌊2^64 × 18 / 37⌋, `8974091711534376461n`.

### `next`

One level of a walk: the child its round's `outcome` reaches when the level named `side`. An outcome below
`sideChance(node, side)` reaches that side, and any other the other side. A level with no bet names the left.

## Pricing

### `StepPlan`

A priced tree: what is `owed` on each leaf, the `bankroll` it was priced against, and the `cash` each node needs, keyed
`<lo>:<hi>`.

### `priceSteps`

`priceSteps(owed, bankroll)`: the cash every node needs, backward from `owed`, what the developer owes on each of the
draw's outcomes. A leaf needs what is owed on it, and a node whose children need the same cash needs that. Any other
node needs the least cash whose bet between its children the casino's rule, [`admits`](admits.md#admits), takes at
`bankroll`: a stake of the node's cash less the lower child's, paying the difference between the children with the
dearer side's chance. More cash is never less safe for the bankroll, and a stake of the whole difference cannot lose it
anything, so the search is a bisection. The casino admits a game's casino bet against its virtual bankroll when the
bet arrives, so price against the virtual bankroll it reports, half its bankroll, as roulette does. Throws a
`RangeError` unless `owed` holds at least one amount and every amount and `bankroll` is a nonnegative bigint. A bankroll
of nothing admits no bet, so against it every node needs the cash of its dearer child: the game's bank carries the
whole walk, and the casino declines its bets and reveals their rounds.

### `stepsCash`

What a spin needs to start: the root's cash. A walk moves the game's bank by what is owed on its leaf less this.

### `StepBet`

One level's casino bet, `{ stake, chance, prize, side }`: its `stake` pays `prize` when the round's outcome is below
`chance`, and that outcome takes the walk to `side`, the child that needs more cash.

### `stepBet`

The [`StepBet`](#stepbet) of one level of the plan's tree. It backs the child that needs more cash: it stakes the
node's cash less the other child's, and its prize is the difference between the two, so won, the walk holds the backed
child's cash, and lost, the other's. `null` where both children need the same cash: the level bets nothing, only reveals
its round, and names the left.

## Checking a spin

### `stepOutcome`

`stepOutcome(n, steps)`: the leaf a spin's steps reach from the root of a tree of `n` outcomes. Each step gives its
round's `outcome` and, for a bet, the `side` it named and its `chance`; a level that only revealed its round gives its
outcome alone. Chances and outcomes are bigints or decimal strings, and a step's chance, when given, must be its side's
share. Throws an `Error` when a step names neither side, a chance is not its side's share, or the steps go past a leaf
or stop before one.

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
