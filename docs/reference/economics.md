---
title: Economics
description: How the casino admits a casino bet by the Kelly criterion, sets and splits its commission, and counts the bankroll it admits against.
sidebar:
  order: 4
---

All amounts are integers in wei. A player's wallet chooses a stake, a chance and a prize. The casino admits the casino
bet against its current unreserved bankroll and sets its commission in the same decision, before it reads the round's
secret. The wallet and the contract check the exact terms and the balance arithmetic. Commission is the casino's
accounting: it is never a debit from the player, the signed operation does not carry it, and the wallet shows it on the
receipt without verifying it.

A casino bet is a stake paid to enter and a prize it pays when the round's 64-bit outcome is below its chance. For the
bankroll it is one wager with two outcomes, and the casino's rule, the Kelly condition for that wager, has a closed
form.

| Symbol    | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| B         | The unreserved bankroll, positive ([available capital](#available-capital-and-concurrency))   |
| S         | The stake, debited from the player's balance                                                  |
| G = S + W | The prize; W is what a win gains beyond the stake, negative when the prize is below the stake |
| Q = 2^64  | The size of the outcome space                                                                 |
| t         | The chance: how many outcomes win, 1 to Q − 1                                                 |
| p = t / Q | The probability that the bet wins                                                             |
| F         | The total commission, accrued on every completed casino bet, won or lost                      |

The house edge the player faces is `e = 1 − pG/S`. The chance is whole outcomes, so the probability is exactly `t/Q`:
a game chooses `t`, and nothing is rounded afterwards.

## The bankroll's residual wager

Pricing treats the whole commission as removed: the bankroll gains `S − F` when the bet loses and loses `W + F` when it
wins. The casino keeps its half of the commission in the bankroll's equity, but admission uses these conservative cash
flows.

For a wager with these two outcomes, the house's Kelly-optimal fraction is:

```text
f* = (1 − p) − p(W + F)/(S − F)
```

The fraction at risk is `(W + F)/B`. Requiring it to be at most `f*` gives:

```text
(B − W − F)(S − F) ≥ B p (S + W)
```

and in exact integers:

```text
(B − W − F)(S − F) Q ≥ B t (S + W)
```

with `F < S` and `W + F < B`. With `F = 0` it reduces to:

```text
W / B ≤ 1 − p(S + W)/S = e
```

A net win of 1% of the available bankroll needs at least a 1% house edge, and a bet with less edge is declined. A bet
that can pay never risks the entire bankroll: the Kelly condition itself excludes that endpoint. There is no other
percentage or prize cap; the 2^128 bound on amounts and the finite outcome space are the only other bounds.

## A casino bet is one wager

A casino bet has two outcomes, so the condition above is the whole of the casino's rule: it is exactly
`E[X / (B + X)] ≥ 0`, with `X` the bankroll's cash flow and every `B + X > 0`. `assessBet` in
[risk.ts](../../protocol/risk.ts) checks it in exact integers; its tests replay it against exhaustive small cases and an
independent integer-root oracle. The casino reserves the bet's liability, `max(W, 0) + F`: what the bankroll can lose
on it.

A game with more outcomes than two plays them as casino bets of two outcomes each, each admitted by itself: a
single-player game [collapses](../games/collapsing-bets.md) each step into one, and a shared draw is backed in
[binary steps](../games/developer-bets.md#shared-games-binary-steps).

The criterion is the expected logarithmic growth of
[Edward Thorp's treatment of Kelly betting](https://web.williams.edu/Mathematics/sjmiller/public_html/341/handouts/Thorpe_KellyCriterion2007.pdf);
the fee inequality is derived for this protocol's cash flows.

## Extracting and splitting the excess

The casino takes the largest integer `F` that satisfies the condition. Its left side falls as `F` grows, so that is the
smaller root of the quadratic in `F`, rounded down:

```text
F = ⌊(Q(B − W + S) − isqrt(Q²(B − W − S)² + 4QBtG)) / 2Q⌋
```

`isqrt` is the integer square root, which can leave `F` one above the root: the casino checks the condition exactly,
and takes one less when it fails. It rounds `F` down to an even number of wei and splits it equally:

```text
developer commission = F / 2
casino commission    = F / 2
```

The developer is the account that publishes the game. A game nobody publishes has none, and all of its commission is
the casino's. The rounding leaves under two wei in the bankroll. Every intermediate product is an exact integer.

This defines excess profit as what can be removed while leaving the bankroll a Kelly-compliant residual wager, which is
[a settled trade-off](../overview/architecture.md#settled-trade-offs). Subtracting two advertised edge percentages is not
generally correct: it ignores how an outcome-independent commission changes the bankroll's exposure.

The integer examples in [the vectors](../../vectors/protocol.json) (`cases`), in six-decimal illustrative units:

| Available bankroll | Stake | Net win | Edge | Total commission | Each account |
| ------------------ | ----- | ------- | ---- | ---------------- | ------------ |
| 10,000             | 100   | 100     | 1%   | 0                | 0            |
| 10,000             | 100   | 100     | 2%   | 1.000100         | 0.500050     |
| 10,000             | 1,000 | 100     | 2%   | 9.182046         | 4.591023     |
| 10,000             | 100   | 9,000   | 90%  | 0                | 0            |

The first and the last lie on the Kelly boundary: the net win's share of the bankroll equals the edge. In the second,
conservative pricing uses `−101.000100` for a player win and `+98.999900` for a loss, while the bankroll's equity
changes by `−100.500050` or `+99.499950`, because the casino keeps its half of the commission. Expected revenue is not a
profit on every bet.

A [developer bet](../games/developer-bets.md) is not the bankroll's: the casino neither admits it by Kelly nor prices
its commission, and nothing in a developer's bank is reserved. The casino's part of it is what the developer's
settlement gives it ([the casino's share](../games/developer-bets.md#the-casinos-share)).

## Available capital and concurrency

The casino keeps its half of every commission in the bankroll's equity: a player's loss adds `S − F/2` to the bankroll
and a win takes `W + F/2`, the developer's half being owed to the developer (a game nobody publishes leaves all of `F`
in the bankroll). Admission uses the conservative full-fee condition and reserves `max(W, 0) + F` against current
capital less the other casino bets' reservations, before it reads the round's secret, so a casino bet it admits settles
with the commission its admission priced. One without capacity gets a signed rejection, with no commission, and its
round revealed; a developer's casino bet that does not fit is declined the same way. Reservations last only while a bet
is decided: they do not fund a whole future hand, and they do not stop the owner from withdrawing on-chain.

At a consistent confirmed block, in the books that [`GET /api/status`](../casino-api/public.md#get-apistatus) reports
and defines, the bankroll is:

```text
bankroll = max(0, cash − activeLiabilities − claimLiabilities − commissions − reserved − escrow − banks − withdrawals)
```

`equity`, what [bankroll fund](../wallet/bankroll-fund.md) shares are a claim on, is the same without `reserved` or the
floor at 0. Investors widen what the Kelly rule admits exactly as the owner's funding does. Kelly admission against the
reported bankroll neither enforces the casino's solvency nor reserves capital for a whole game.
