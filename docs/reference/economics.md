---
title: Economics
description: How the casino admits a casino bet by the Kelly criterion, sets and splits its commission, and counts the bankroll it admits against.
sidebar:
  order: 6
---

All amounts are integers in wei, or test units of 10^-18. A player's wallet chooses a stake and the prizes it can pay.
The casino admits the casino bet against its current unreserved bankroll and sets its commission in the same decision,
before it reads the round's secret. The wallet and the contract check the exact terms and the balance arithmetic.
Commission is the casino's accounting: it is never a debit from the player, the signed operation does not carry it, and
the wallet shows it on the receipt without verifying it.

A casino bet is a stake paid to enter and up to 64 prizes, and every prize whose range holds the round's 64-bit outcome
pays. The casino's rule is the [condition for one wager](#a-casino-bet-is-one-wager), which covers any number of prizes
on one outcome. It is derived first for one prize, where it has a closed form.

| Symbol    | Meaning                                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B         | The unreserved accounting bankroll, positive: pool cash after active player balances, finalized claims, unpaid developer commissions, escrow, developer banks and reservations ([available capital](#available-capital-and-concurrency)) |
| S         | The stake, debited from the player's balance                                                                                                                                                                                             |
| G = S + W | The prize's payout; W is what the player gains beyond the stake                                                                                                                                                                          |
| Q = 2^64  | The size of the outcome space                                                                                                                                                                                                            |
| t         | The width of the prize's range in whole outcomes, 1 to Q − 1                                                                                                                                                                             |
| p = t / Q | The probability that the prize pays                                                                                                                                                                                                      |
| F         | The total commission, accrued on every completed casino bet                                                                                                                                                                              |

The house edge the player faces is `e = 1 − pG/S`. Ranges are whole outcomes, so the probability is exactly `t/Q`: a
game chooses `t`, and nothing is rounded afterwards.

## The bankroll's residual wager

Pricing treats the whole commission as removed: the bankroll gains `S − F` when the prize does not pay and loses
`W + F` when it does. The casino keeps its half of the commission in the bankroll's equity, but admission uses these
conservative cash flows.

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

A net prize of 1% of the available bankroll needs at least a 1% house edge, and a bet with less edge is declined. A
bet that can pay never risks the entire bankroll: the Kelly condition itself excludes that endpoint. There is no other
percentage or prize cap; the 2^128 bound on amounts and the finite outcome space are the only other bounds.

## A casino bet is one wager

Every prize of a casino bet rides one 64-bit outcome, so for the bankroll the bet is one wager with several possible
cash flows, not a set of independent wagers. The prize ranges cut `[0, 2^64)` into cells. In a cell of width `w_k` the
bankroll's cash flow is:

```text
X_k = (the stake) − (every payout due in that cell) − F
```

The casino admits the bet at full size when `E[X / (B + X)] ≥ 0` with every `B + X_k > 0`.
[risk.ts](../../protocol/risk.ts) checks it exactly, merging cells with equal cash flow:

```text
sum_k  w_k × X_k × prod_{j ≠ k} (B + X_j)  ≥  0
```

With one prize there are two cells, `X = S − F` of width `Q − t` and `X = −(W + F)` of width `t`, and the sum reduces
term for term to the closed form above. `assessBet` is the only pricing function; its tests replay the closed form, an
independent integer-root oracle and exhaustive small cases through it. The left side strictly decreases in `F`, so a
bounded binary search finds the largest commission. The reservation is the worst cell's cash decrease plus the
commission.

Correlation cuts both ways. Prizes on the **same** range stack: two chips on red are one wager of twice the size, and
share the capacity one chip would have had (`sum of same-side net wins / B ≤ edge`) instead of multiplying it. Prizes
on **disjoint** ranges hedge: what red wins, black loses, and the pair earns capacity no two independent bets could.
Whose chips they are makes no difference: a developer's casino bet that backs one player on red and another on black
is priced exactly like one player with a chip on each, and overlapping chips priced as they stand equal the same chips
flattened to one payout per pocket. [The vectors](../../vectors/protocol.json) record a lone red and one player's
overlapping chips at the same bankroll. That is how a table of [developer bets](../games/developer-bets.md) gets the
bankroll behind it: its developer places one casino bet that adds up the prizes of the bets it backs, and the bankroll
prices the table as a whole. A casino bet holds at most 64 prizes, so at most 128 distinct cells, which bounds the
exact integer products; a roulette table's prizes fit the wheel's 37 pockets however many players sit down.

The criterion is the expected logarithmic growth of
[Edward Thorp's treatment of Kelly betting](https://web.williams.edu/Mathematics/sjmiller/public_html/341/handouts/Thorpe_KellyCriterion2007.pdf);
the fee inequality is derived for this protocol's cash flows.

## Extracting and splitting the excess

The casino takes the largest integer `F` that satisfies the condition, found by binary search in at most 256 steps,
and rounds it down to an even number of wei:

```text
developer commission = F / 2
casino commission    = F / 2
```

The developer is the account that publishes the game. A game nobody publishes has none, and all of its commission is
the casino's. The rounding leaves under two wei in the bankroll, and probability rounding can leave a slightly more
favourable residual bet. Every intermediate product is an exact integer.

This defines excess profit as what can be removed while leaving the bankroll a Kelly-compliant residual wager. Charging
only that excess is [a settled trade-off](../overview/architecture.md#settled-trade-offs). A casino bet is admitted
when the condition holds with `F = 0`, and the left side falls as `F` grows, so a fee fixed first would turn away bets
the bankroll could take; setting `F` afterwards admits every one of them and charges only the surplus. Subtracting two
advertised edge percentages is not generally correct: it ignores how an outcome-independent commission changes the
bankroll's exposure.

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

Commission accrues on executed casino bets, won or lost. A declined request pays no commission and moves no money. A
casino could decline bets by their outcome and no penalty would apply; each declined bet's revealed secret shows its
outcome on the player's receipt. The probabilities here assume the casino does not do so.

## Developer bets

A [developer bet](../games/developer-bets.md) is not the bankroll's: its stake goes into its game developer's bank at
the casino, and what it is paid comes out of that bank. The casino neither admits developer bets by Kelly nor prices
their commission, and nothing in a bank is reserved. Whether the developer can pay is
[outside HookedIn](../overview/architecture.md#settled-trade-offs): a batch of settlements the bank cannot pay is
refused, and the bets stay open. The casino's part is what the developer's signed settlement gives it, which the casino
keeps in its earnings. Its policy asks a developer for about half of what each developer bet is expected to earn them,
as a casino bet's commission splits in two; nothing enforces it. A developer who wants the bankroll behind its
developer bets places its own casino bet on one of its rounds, which the bankroll admits and prices like any other: the
developer pays that bet's commission and earns half of it back, as for any casino bet of its game.

## Available capital and concurrency

Signed results change player balances and the casino's accounting off-chain. The casino keeps its half of every
commission in the bankroll's equity: a player's loss adds `S − F/2` to the reported bankroll and a win takes
`W + F/2`, the developer's half being owed to the developer (a game nobody publishes leaves all of `F` in the
bankroll). Admission uses the conservative full-fee condition and reserves `W + F`. The casino decides admission from
current capital less the other casino bets' reservations, and reserves the bet's worst case before it reads the round's
secret; a casino bet it admits settles, with the commission its admission priced. Commission never changes the
player's signed stake, net win or probability. A casino bet without capacity gets a jointly signed rejection
checkpoint, with its balance unchanged and no commission, and its round is revealed at once, settling nothing; a
developer's casino bet that does not fit is declined the same way and reveals its round. Reservations are per casino
bet and last only while it is decided: they do not fund a whole future hand, and they do not stop the owner from
withdrawing on-chain.

At a consistent confirmed block, the reported bankroll is:

```text
max(0, pool cash − active signed player balances − finalized unpaid claims − accrued unpaid developer commissions − reservations − escrow − developer banks)
```

Reservations are the worst cases of the casino bets being decided. Escrow is every payout awarded and not yet
collected: money that has left the bankroll for a player who has not yet signed for it. Developer banks are the
developers' own money, the stakes of their developer bets among it. [`GET /api/status`](../casino-api/public.md#get-apistatus)
reports every term.

The casino keeps one set of these books per asset; ETH and test coins never add up. Test coins have no chain: their
pool cash is ten million test coins plus every coin the faucet has minted, and a faucet claim credits a channel the
same amount, so the test bankroll does not move.

Anyone with an ETH channel may add to this capital. An [investment](../wallet/bankroll-fund.md) is a debit from a
channel into the bankroll that mints shares at `equity / totalShares`, where equity is the reported bankroll before
reservations; a redemption burns them at the same price and owes the player their worth, which counts as escrow until
collected. Both leave every other share's price unchanged, so holders gain and lose only what the bankroll does:
losses add to equity, and wins and developer commission take from it, pro rata. Investors widen what the Kelly rule
admits exactly as the owner's funding does, and the owner's funding and withdrawals buy and sell house shares at the
going price. A redemption never takes money a casino bet has reserved.

An open channel's full original deposit stays protected on-chain even after signed losses. On closure the protection
becomes `min(original deposit, final balance)`, and the rest of a loss is released. A finalized unpaid claim takes the
place of the channel's active liability. Claim payments reduce both cash and claim liabilities, and confirmed funding and
withdrawals change cash. The casino reconciles each category without counting a channel and its claim twice.

A developer [collects](../games/earnings.md) commission into a channel of their own: the payable falls and the
developer's signed balance rises by the same amount, so neither the bankroll nor any ETH moves. The casino's own earned
commission is a cumulative counter, not a second payable. Owner withdrawals reduce observed pool cash and so the
bankroll's equity, and no separate release of house commission can be counted twice.

A game's payment is a debit that lowers the player's signed balance by its amount and raises the accounting bankroll
by the same amount. It settles on no round, accrues no commission and moves no ETH; the original deposit stays
protected on-chain until closure.

Unallocated winnings cash excludes protected principal and winnings already reserved, and owner withdrawals exclude
every finalized unpaid winning. Finalization order sets the order of [allocation](contract.md#the-winnings-queue), and
protected principal stays apart. A recipient that refuses payment keeps its allocation without blocking later funded
claims. The casino's public cash balance does not show that private signed balances are covered: Kelly admission
against the reported bankroll neither enforces the casino's solvency nor reserves capital for a whole game.
