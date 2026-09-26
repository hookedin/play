---
title: Collapsing bets
description: How the SDK plays a step with more than two outcomes as one casino bet, drawn in the page.
sidebar:
  order: 6
---

A casino bet has two outcomes: it pays its prize when the round's outcome is below its chance, and nothing otherwise
([casino bets](casino-bets.md)). A step of a game can have many: the buckets of a Plinko board, the pays of a slot, the
cards of a hand. The SDK plays such a step with one casino bet all the same, by **collapsing** it: the page draws, with
its own randomness, which bet to place, so that placing that bet and letting the casino settle it reaches every outcome
exactly as often as the rules say. [`RoundClient`](../sdk/round.md#roundclient) does this for every step it plays;
[`collapse`](../sdk/engine.md#collapse), in [transition.ts](../../sdk/src/engine/transition.ts), is the construction
below.

## The idea

The engine groups a step's successors by the cash they need into **cash classes**
([`cashClasses`](../sdk/engine.md#cashclasses)), each with its exact probability. A step with one class moves no money,
or pays what is left over to the bankroll. With current cash `c`, any other step is collapsed into **branches**. A bet
branch is one casino bet between a lower class `j`, at cash `L_j < c`, and a higher class `i`, at cash `H_i > c`:

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
not.

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
`q × 2^64`, so every class is still reached exactly as often as the rules say. A step that would need a chance below
one outcome, or of every outcome, has odds finer than one outcome in 2^64 and is refused.

## Pricing

The engine prices every state backward from the end of the game
([sequential games](sequential-games.md#cash-continuation-values-not-expected-values)). A step's price is the least
cash `c` on the cash grid at which [`tableAdmits`](../sdk/engine.md#tableadmits) holds: the Kelly condition for the
whole step as one wager for the bankroll,

```text
Σ p × X/(B + X)  >=  0        X = c − (a class's cash): what the bankroll gains when that class is reached
```

with the bankroll's losses weighed one part in 2^32 heavier. Without that margin it is exactly `D <= C`, the condition
under which every pair above is admissible; the margin leaves each bet room for the one outcome more its chance may
round to, when its prize is under about 4·10^9 times its stake. More cash is never less safe for the bankroll, and the
highest class's cash always suffices, so [`priceTransition`](../sdk/engine.md#pricetransition) finds the price by
bisection. [`compileTransition`](../sdk/engine.md#compiletransition) then checks every bet the step can place with the
casino's own rule, [`admits`](../sdk/admits.md#admits), at the planning bankroll, and
[`prepareAction`](../sdk/engine.md#prepareaction) checks the bet it draws again at the live bankroll.

## Never redraw

The page draws the branch with its own randomness, uniformly over the exact weights, before the wallet picks the
round's seed, so the draw is independent of the outcome. Draw it once, save it before the wallet signs, and offer the
same bet again after a verified rejection. Redrawing until a cheaper branch is admitted, or dropping the rare expensive
ones, silently changes the game's odds. `RoundClient` saves the drawn step with its operation ID before the wallet
signs anything, and keeps it until it settles: across a reload, and under a fresh operation ID after a rejection. Keep
declined, cancelled and withheld attempts apart from outcomes in any claim about returns.

## What the player sees

The round's outcome decides the bet, and so the class. Which state of the class, when several need its cash, is
[`landing(class, outcome)`](../sdk/engine.md#landing): drawn from the outcome with
[`seededRandom`](../sdk/engine.md#seededrandom), a deterministic generator, so the verified outcome names the card and a
reload lands on the same one. What the page shows, such as the ball's path or the reel stops, is drawn the same way
from `state.settlement.draw`
([draw the presentation from the outcome](casino-bets.md#draw-the-presentation-from-the-outcome)). A branch without a
bet has no outcome: its state and its `draw` come from the page's own randomness, saved with the step.

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
  board returns exactly 99% of the ball; Samson's Gold's lowest is the whole stake against the jackpot, at 95.1%. When
  the bankroll is small beside a prize, the bet for it must carry more edge still for the bankroll to take it: at
  the least bankroll that backs Plinko's 16-row low board, its rarest bet pays back about 22%. A step whose outcomes are
  nothing or one win, as in Dice and Mines, is one bet whose return is the step's.
- **The kept amount was never debited.** When showing a gross result, the player ends with `L` or `H`; do not add `L`
  again.
