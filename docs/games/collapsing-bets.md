---
title: Pricing and collapsing
description: How the engine prices a game's states backward from its payouts, and plays a step of many outcomes as one casino bet drawn in the page, with exact odds, and what that gives up.
sidebar:
  order: 5
---

The [engine](../sdk/engine.md) turns a finite game into a sequence of casino bets. It prices every state backward from
the end of the game, and plays each step as at most one casino bet. A step can have many outcomes, such as the buckets
of a Plinko board, the pays of a slot or the cards of a hand: the page then draws, with its own randomness, which bet to
place, so that placing that bet and letting the casino settle it reaches every outcome exactly as often as the rules
say. That is **collapsing**. The casino needs nothing more: it enforces each bet it accepts and never sees the game.
[`RoundClient`](../sdk/round.md#roundclient) does all of this for a page, and
[transition.ts](../../sdk/src/engine/transition.ts) is the construction below.

## Cash, not expected value

A terminal state's value is its gross payout. Any other state's **cash** is money the player already holds on reaching
it, enough to finance every action offered there: not a claim on an unplayed future, and not money credited on arrival.
For each action, the engine replaces every successor by its cash, keeping its exact probability and its state, and
prices the action against the planning bankroll ([below](#why-the-price-exceeds-the-expected-value)). An action's
`additionalCash` is the player's own money committed by choosing it, such as a double or a split: a state's cash is the
most any of its actions needs less that action's `additionalCash`, and each action is played from the state's cash plus
its own. None of it is casino credit.

Taking the most makes every offered choice financeable, and refunds nothing to a cheaper one: the step starts from the
state's cash and ends on the chosen successor's, so different actions can carry different edges. A step that lowers
the player's cash with nothing to draw is an explicit payment; the engine never deletes a player's money silently.

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

The page draws each branch with its weight `w` and places only its bet. If that bet wins with probability `q`, its
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

A bigger prize needs more edge. That is the constraint that shapes the construction.

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

A class at exactly `c` is a branch of its own, drawn with its probability, with no bet: the player keeps `c`, which is
that class's cash. When no class is above `c`, because the state holds more than this action needs, every other class
is paired with the highest one, the class at `c` if there is one: pair `j` is drawn with weight `ℓ_j × (s + h)/s` and
wins with probability `h/(s + h)`, `h` being the highest class's probability and `s` the others' together. Its prize,
`H − L_j`, is at most its stake, so the bankroll cannot lose it.

## Exact odds on whole outcomes

A chance is whole outcomes, and `q × 2^64` rarely is. With `k = ⌊q × 2^64⌋` and `δ = q × 2^64 − k`, a pair's branch
is two: chance `k` with `1 − δ` of its weight, and chance `k + 1` with `δ` of it. The mean chance is exactly
`q × 2^64`, so every class is still reached exactly as often as the rules say, even when its probability does not
divide 2^64, as one card rank in thirteen does not. A step that would need a chance below one outcome, or of every
outcome, has odds finer than one outcome in 2^64 and is refused.

## Why the price exceeds the expected value

A step's price is the least cash `c` on the cash grid at which the whole step is one Kelly wager for the bankroll at
zero commission:

```text
Σ p × X/(B + X)  >=  0        X = c − (a class's cash): what the bankroll gains when that class is reached
```

with every `B + X > 0`, and the bankroll's losses weighed one part in 2^32 heavier. Without that margin it is exactly
`D <= C`, the condition under which every pair above is admissible; the margin leaves each bet room for the one outcome
more its chance may round to, when its prize is under about 4·10^9 times its stake. A certain outcome `v` needs
`c = v` and no bet. For an uncertain one at a finite bankroll, `c` equal to the expected value makes the sum strictly
negative by concavity, so the expected value alone does not fund the step: the difference is a risk premium, and it
shrinks as the bankroll grows.

More cash is never less safe for the bankroll, and the highest class's cash always suffices, so the engine finds the
price by bisection. It then checks every bet the step can place with the casino's own rule,
[`admits`](../sdk/admits.md#admits), at the planning bankroll, and [`prepareAction`](../sdk/engine.md#prepareaction)
checks the bet it draws again at the live bankroll. Pricing backward at a fixed floor does not make a whole game one
Kelly-optimal wager.

## Draw once

The player chooses an action first. The page then draws the branch with its own randomness, a `RandomBelow` uniform
over what it is asked for, before the wallet picks the round's seed, so the draw is independent of the outcome. The
round's outcome, fixed by the seed the wallet signs and the secret of the round the casino named beforehand, then
decides the bet. The engine has no randomness of its own.

Draw a step's branch once, save it with its operation ID before the wallet signs, and offer the same bet again after a
verified rejection. Redrawing until a cheaper branch is admitted, or dropping the rare expensive ones, silently changes
the game's odds. `RoundClient` keeps the drawn step until it settles: across a reload, and under a fresh operation ID
after a rejection. Keep declined, cancelled and withheld attempts apart from outcomes in any claim about returns.

## What the player sees

The round's outcome decides the bet, and so the class. Which state of the class, when several need its cash, is drawn
from the outcome with [`seededRandom`](../sdk/engine.md#seededrandom), a deterministic generator, so the verified
outcome names the card as well as what it paid, and a reload lands on the same state. Equal cash does not make two
states interchangeable, since their later actions can differ, but each state's cash already finances what follows it,
so which of them a step reaches costs the bankroll nothing. The same generator then draws `state.settlement.draw`, what
the page shows the result with, such as the ball's path or the reel stops
([draw the presentation from the outcome](casino-bets.md#draw-the-presentation-from-the-outcome)). A branch without a
bet has no outcome: its state and its `draw` come from the page's own randomness, saved with the step.

## Playing to the end, and stopping

[`evaluatePolicy`](../sdk/engine.md#evaluatepolicy) computes the exact payout distribution of a policy that plays the
graph to its end. Its net EV subtracts the starting cash and the expected additional wagers: gross payout over the first
stake alone is not a game's return when doubles and splits exist. A policy is a function of the current state alone,
and reaching every class exactly as often as the rules say preserves each step's distribution for the policy played; it
does not make all policies share one.

At a settled step the player can stop and keep the cash they hold, a
[settled trade-off](../overview/architecture.md#settled-trade-offs); stopping changes the policy, and so the
distribution. It cannot cancel a signed request still pending: recover its result or its verified rejection first.

## A conservative bankroll across a game

Let `D` be the game's greatest number of steps from the root and `M` its greatest cash. A win with prize `g` lowers the
bankroll by `g − s + F`, less than `g = H − L <= M` since the commission `F` is below the stake `s`; a loss, a payment or
a step without a bet does not lower it. So a bankroll of at least `bankrollFloor + D × M` stays above the planning floor
through one play of the game: the plan's `conservativeBankroll`. The argument assumes nothing else lowers the bankroll
between steps, and nothing locks it: the casino serves other bets meanwhile, so a request reserves no future capacity.
Check capacity again at each step, as `prepareAction` does, and stop when the floor is not there.

## What the engine does not do

The engine is pure reference code. It sends nothing, reads no live bankroll, holds no keys, and cannot hold a modified
page to a policy. An adapter signs and saves each step's bet, retries identical requests and verifies the signed
result; `RoundClient` is that adapter for a page. Finite acyclic graphs, exact rational probabilities, odds no finer
than one outcome in 2^64 and whole-unit cash bound it.

## What is given up

A casino bet is a fact the player signs: the wallet computes its exact return and largest payout, and the round's
outcome alone decides it. A collapsed step keeps that for the bet it places, and gives up the rest:

- **The wallet sees one bet, not the step.** It verifies that bet completely (its odds, its outcome and its payout) and
  knows nothing of the distribution it was drawn from. Which bet the page draws, or whether it draws none, is the
  developer's word.
- **A modified page can choose its branch outright.** Every branch is admissible alone, so it cannot harm the bankroll,
  only misrepresent the game to its player.
- **Each bet's measured return is its own.** A step bets only what it can lose, and the bets for the largest prizes
  carry more of the step's edge than the rest, so a collapsed game's bets pay back less of what they stake than the game
  does of its stake. At a bankroll far above the stake, Plinko's bets pay back from about 93% to over 99%, while each
  board returns exactly 99% of the ball; Samson's lowest is the whole stake against the jackpot, at 95.1%. When
  the bankroll is small beside a prize, the bet for it must carry more edge still for the bankroll to take it: at the
  least bankroll that backs Plinko's 16-row low board, its rarest bet pays back about 22%. A step whose outcomes are
  nothing or one win, as in Dice and Mines, is one bet whose return is the step's.
- **The kept amount was never debited.** When showing a gross result, the player ends with `L` or `H`; do not add `L`
  again.
