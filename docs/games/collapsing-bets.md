---
title: Pricing and collapsing
description: How the engine prices a game's states backward from its payouts, and how the wallet plays a step's table of many results as one casino bet it draws, with exact odds, and what that gives up.
sidebar:
  order: 5
---

The [engine](../sdk/engine.md) turns a finite game into a sequence of casino bets. It prices every state backward from
the end of the game, and each step is played as at most one casino bet. A step can have many results, such as the
buckets of a Plinko board, the pays of a slot or the cards of a hand: the page offers the wallet the step's table, every
result with its weight and the cash it leaves, and the wallet splits it into bets and draws which to place, so that
placing that bet and letting the casino settle it reaches every result exactly as often as the table says. That is
**collapsing**. The casino enforces each bet it accepts, checks that the table the bet signed can place it, and never
runs the game. [transition.ts](../../sdk/src/engine/transition.ts) is the construction below, which the engine prices
with and the wallet splits with.

## Cash, not expected value

A terminal state's value is its gross payout. Any other state's **cash** is money the player already holds on reaching
it, enough to finance every action offered there: not a claim on an unplayed future, and not casino credit. For each
action, the engine values every successor at its cash, keeping its exact probability, and prices the action against the
planning bankroll ([below](#why-the-price-exceeds-the-expected-value)). An action's `additionalCash` is the player's own
money committed by choosing it, such as a double or a split: a state's cash is the most any of its actions needs less
that action's `additionalCash`, and each action is played from the state's cash plus its own.

Taking the most makes every offered choice financeable and refunds nothing to a cheaper one, so different actions can
carry different edges. A step that lowers the player's cash with nothing to draw is an explicit payment: the engine
never deletes a player's money silently.

## One step is one bet

The engine groups a step's successors by the cash they need into **cash classes**, each with its exact probability. A
step with one class moves no money, or pays what is left over to the bankroll. With current cash `c`, any other step is
collapsed into **branches**. A bet branch is one casino bet between a lower class `j`, at cash `L_j < c`, and a higher
class `i`, at cash `H_i > c`:

```text
stake   a_j = c − L_j      the part of the cash at risk
prize   H_i − L_j          so the player ends on L_j or on H_i
kept    L_j                never staked, never debited
```

The wallet draws each branch with its weight `w` and places only its bet. If that bet wins with probability `q`, its
chance over 2^64, the branch reaches:

```text
the higher class with probability   w × q
the lower class with probability    w × (1 − q)
```

The collapse is correct when, summed over every branch, those equal each class's probability. Preserving every class's
probability preserves the whole distribution of the step's cash, and so its return; preserving only the average would
not. A step of two classes, one on each side of `c`, is one bet that wins with the higher class's probability.

## Every branch must stand alone

The casino sees one bet, never the step, so each bet must pass [admission](../reference/economics.md) by itself against
the planning bankroll `B`. A bet between lower class `j` and higher class `i` gains the bankroll `a_j` when it loses and
costs it `b_i = H_i − c` when it wins. At zero commission the casino admits it when it is a Kelly wager for the
bankroll:

```text
(1 − q) × a_j/(B + a_j)  >=  q × b_i/(B − b_i)
```

A bigger prize needs more edge: that is the constraint that shapes the construction.

## The construction

With `ℓ_j` the probability of lower class `j` and `h_i` that of higher class `i`, let:

```text
C   = Σ_j ℓ_j × a_j/(B + a_j)      what the lower classes are worth to the bankroll
D   = Σ_i h_i × b_i/(B − b_i)      what the higher classes cost it
A_j = (a_j/(B + a_j)) / C
U_i = (b_i/(B − b_i)) / D
```

Every lower class is paired with every higher class. Pair `j/i` is drawn with weight `h_i × ℓ_j × (A_j + U_i)` and wins
with probability `q = A_j / (A_j + U_i)`. Then:

- Class `i` is reached with probability `Σ_j h_i × ℓ_j × A_j = h_i`, and class `j` with `Σ_i h_i × ℓ_j × U_i = ℓ_j`:
  every class exactly as often as the rules say.
- Every pair has `q/(1 − q) = (D/C) × (a_j/(B + a_j)) / (b_i/(B − b_i))`: its odds are the same fraction, `D/C`, of the
  most the casino admits for it. Every pair is admissible exactly when `D <= C`, the Kelly condition for the whole step
  as one wager, so each bet is as sound for the bankroll as the step.

In whole numbers `q = X/(X + Y)`, with `X = a_j × (B − b_i) × D.n × C.d` and `Y = b_i × (B + a_j) × C.n × D.d`, where
`.n` and `.d` are the numerator and denominator of `C` and `D`.

A class at exactly `c` is a branch of its own, drawn with its probability, with no bet: the player keeps `c`. When no
class is above `c`, because the state holds more than this action needs, every other class is paired with the highest
one, the class at `c` if there is one: pair `j` is drawn with weight `ℓ_j × (s + h)/s` and wins with probability
`h/(s + h)`, `h` being the highest class's probability and `s` the others' together. Its prize, `H − L_j`, is at most
its stake, so the bankroll cannot lose it.

## Exact odds on whole outcomes

A chance is whole outcomes, and `q × 2^64` rarely is. With `k = ⌊q × 2^64⌋` and `δ = q × 2^64 − k`, a pair's branch is
two: chance `k` with `1 − δ` of its weight, and chance `k + 1` with `δ` of it. The mean chance is exactly `q × 2^64`, so
every class is still reached exactly as often as the rules say, even when its probability does not divide 2^64, as one
card rank in thirteen does not. A step that would need a chance below one outcome, or of every outcome, has odds finer
than one outcome in 2^64 and is refused.

## Why the price exceeds the expected value

A step's price is the least cash `c` on the cash grid at which the whole step is one Kelly wager for the bankroll at
zero commission:

```text
Σ p × X/(B + X)  >=  0        X = c − (a class's cash): what the bankroll gains when that class is reached
```

with every `B + X > 0`, and the bankroll's losses weighed one part in 2^32 heavier. Without that margin it is exactly
`D <= C`, the condition under which every pair above is admissible; the margin leaves each bet room for the one outcome
more its chance may round to, when its prize is under about 4·10^9 times its stake. A certain outcome `v` needs `c = v`
and no bet. For an uncertain one at a finite bankroll, `c` equal to the expected value makes the sum strictly negative
by concavity, so the expected value alone does not fund the step: the difference is a risk premium, which shrinks as the
bankroll grows.

More cash is never less safe for the bankroll, and the highest class's cash always suffices, so the engine finds the
price by bisection. It then checks every bet the step can place with the casino's own rule,
[`admits`](../sdk/admits.md#admits), at the planning bankroll, and the wallet splits the step again at its quote's
virtual bankroll and checks every bet of that split with the same rule. Pricing backward at a fixed floor does not make
a whole game one Kelly-optimal wager.

## The wallet draws the step

The player chooses an action, and the page sends the step's table to the wallet,
[`game.casinoBet`](../reference/bridge.md#gamecasinobet): its cash, and every result with its whole-number weight, the
cash it leaves and a label. The page draws nothing. The wallet splits the table into branches with the construction
above, at the virtual bankroll of the quote it will sign the bet on, and draws the branch with the seed it signs the
branch's bet with:

```text
r = a number below the branches' total weight, read from the bytes of
    keccak256(abi.encode(keccak256("HOOKEDIN/BRANCH"), seed, i))  for i = 0, 1, 2, …
    as many bytes as total − 1 needs, the first cut to the bits it needs, read big-endian,
    and read again from the next bytes until it is below the total
branch = the first whose running total of weights is above r
```

The casino fixed the round's secret before the wallet picked the seed, so the branch drawn is independent of the
outcome, and the page, which sees neither, cannot choose it. The wallet draws only once the quote covers every bet of
the split, so the bet drawn goes with its seed and the casino must settle it: nothing is declined and drawn again, which
would favour the cheaper branches and change the game's odds. The bet signs the table, and the bankroll it was split at,
in its [details](../reference/signed-messages.md#details-and-memo), and the casino refuses a bet the table cannot place
or a bankroll other than its quote's.

Once the bet settles, the player holds what it kept, with its prize if it won, or the whole cash for a branch without a
bet. The wallet lands the step on one of the results that leave that amount, by their weights, from the same seed under
another tag:

```text
result = the first, among the results that leave that amount, whose running total of weights is above a number
         below their total weight, read as above from keccak256(abi.encode(keccak256("HOOKEDIN/RESULT"), seed, i))
draw   = the next 64-bit number read from the same bytes
```

The round's outcome decides the bet, and so the amount the step leaves, and the wallet's result which of the results
that leave it the step reached, such as which card, so a reload lands on the same state; which of them it reaches costs
the bankroll nothing, since each state's cash already finances what follows it. The receipt carries `result`, the
result's place in the table, and `draw`, which the page shows the result with ([draw the presentation from the
receipt](casino-bets.md#draw-the-presentation-from-the-receipt)). Anyone can work the split, the branch and the result
out again from the table and the seed ([check a bet yourself](../wallet/bets-and-receipts.md#check-a-bet-yourself)).

A step whose results all leave the same cash places no bet, but the wallet still draws which of them it reaches, such as
which card comes when every card leaves the same cash: one branch without a bet, and a result among them all. A payment
is paid first and the draw comes after it, so that nobody stops a step once they know where it leads. Only a step with a
single successor asks the wallet nothing; its `draw` comes from the page's own randomness, saved with the step, and
changes only what the page shows.

`RoundClient` sends each step under one operation ID, saved before anything is sent, and the wallet answers the same ID
with the same draw, so a lost reply or a reload finds the step as it was drawn. A game is free to draw a step's results
in its own page and offer the wallet a table of two, the bet's prize and nothing; the wallet's [**My
games**](../wallet/bets-and-receipts.md#house-edge) then shows its steps with as many house edges as it drew.

## Playing to the end, and stopping

[`evaluatePolicy`](../sdk/engine.md#evaluatepolicy) computes the exact expected payout of a policy that plays the graph
to its end. Its net EV subtracts the starting cash and the expected additional wagers: gross payout over the first stake
alone is not a game's return when doubles and splits exist. A policy is a function of the current state alone, and
reaching every class exactly as often as the rules say preserves each step's distribution for the policy played; it does
not make all policies share one.

At a settled step the player can stop and keep the cash they hold, a [settled
trade-off](../overview/architecture.md#settled-trade-offs); stopping changes the policy, and so the distribution. It
cannot cancel a signed request still pending: recover its result or its verified rejection first.

## A conservative bankroll across a game

Let `D` be the game's greatest number of steps from the root and `M` its greatest cash. A win with prize `g` lowers the
bankroll by `g − s + F`, less than `g = H − L <= M` since the commission `F` is below the stake `s`; a loss, a payment
or a step without a bet does not lower it. So a bankroll of at least `bankrollFloor + D × M` stays above the planning
floor through one play of the game: the plan's `conservativeBankroll`. The argument assumes nothing else lowers the
bankroll between steps, and nothing locks it: the casino serves other bets meanwhile, so a request reserves no future
capacity. Check capacity again at each step, as `prepareAction` does and the wallet does with every split, and stop when
the floor is not there.

## What the engine does not do

The engine is pure reference code: it sends nothing, reads no live bankroll, holds no keys, and cannot hold a modified
page to a policy. Finite acyclic graphs, exact rational probabilities, odds no finer than one outcome in 2^64 and
whole-unit cash bound it.

## What is given up

A casino bet is a fact the player signs: the wallet computes its exact house edge and largest payout, and the round's
outcome alone decides it. A collapsed step keeps that for the bet it places, and the wallet splits the table and draws
which bet that is, so neither the page nor the casino chooses it. What it gives up:

- **The table is the page's.** The bet signs the table the page offered, and each bet's detail shows it: every result,
  what it leaves the player and how likely. Whether those are the game's rules, such as a Plinko board's buckets, is the
  developer's word, which the table shown lets the player hold the rules to. A modified page can offer a worse table,
  never steer the draw; one that draws its results itself before it asks has a different house edge every step, which My
  games shows.
- **Each bet's measured return is its own.** A step bets only what it can lose, and the bets for the largest prizes
  carry more of the step's edge than the rest, so a collapsed game's bets pay back less of what they stake than the game
  does of its stake. Plinko's bets pay back from about 93% to over 99% at a bankroll far above the stake, while each
  board returns exactly 99% of the ball, and less still when the bankroll is small beside a prize: about 22% for the
  rarest bet at the least bankroll that backs the 16-row low board. A step of nothing or one win, as in Dice and Mines,
  is one bet whose return is the step's. In METH, the house edges of the bets drawn come, on average, to the step's.
- **The kept amount was never debited.** When showing a gross result, the player ends with `L` or `H`; do not add `L`
  again.
