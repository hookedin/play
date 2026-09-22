# Kelly pricing and commission

All monetary quantities are integer wei. The independent client selects a stake and the prizes it can pay. The casino admits the bet against its current unreserved bankroll and sets commission at the close, against the bankroll there is then. The wallet and settlement contract verify the exact terms and balance arithmetic; commission is operator accounting and does not add a player debit. The receipt reports commission for display; the wallet does not independently verify that operator accounting.

A bet is a stake paid to enter and up to 64 prizes; every prize whose range holds the round's 64-bit outcome pays. The rule the casino applies is the [round condition below](#a-round-is-one-wager), which covers any number of prizes and any number of bets on one outcome. This section derives it for the simplest bet, one prize, where it has a closed form.

| Symbol    | Meaning                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B         | Positive unreserved accounting bankroll, after active player liabilities, finalized claims, unpaid developer commissions, escrow, and in-flight reservations. |
| S         | Player stake, debited from the player's balance.                                                                                                              |
| G = S + W | The prize's payout. W is what the player gains net of the stake.                                                                                              |
| Q = 2^64  | Size of the outcome space.                                                                                                                                    |
| t         | Width of the prize's range in whole outcomes, 1 through Q − 1.                                                                                                |
| p = t / Q | Actual probability that the prize pays.                                                                                                                       |
| F         | Total commission, accrued on every completed signed bet.                                                                                                      |

The actual player-facing house edge is `e = 1 − pG/S`. Ranges are whole outcomes, so the probability played is exactly `t/Q`: a game chooses `t`, and nothing is rounded afterwards.

## The bankroll's residual wager

Pricing conservatively treats the full commission as removed: the bankroll gains `S − F` if the prize does not pay and loses `W + F` if it does. The casino retains its half of the fee in actual bankroll equity, but risk admission uses these conservative cash flows.

For a wager with these two outcomes, the house's Kelly-optimal fraction is:

```text
f* = (1 − p) − p(W + F)/(S − F)
```

The fraction actually at risk is `(W + F)/B`. Requiring that fraction to be no greater than `f*` gives:

```text
(B − W − F)(S − F) >= B p (S + W)
```

The exact integer equivalent is:

```text
(B − W − F)(S − F) Q >= B t (S + W)
```

with `F < S` and `W + F < B`. With `F = 0`, this reduces to:

```text
W / B <= 1 − p(S + W)/S = e
```

Thus a net prize of 1% of the available bankroll requires at least a 1% house edge. A wager with less edge is rejected. A positive-probability bet cannot risk the entire bankroll: the Kelly condition itself excludes that endpoint. There is no additional fixed percentage or monetary prize cap; uint256 amounts and the finite outcome space impose the usual numeric limits.

## A round is one wager

Every bet in a [round](protocol.md#rounds) rides one 64-bit outcome, so for the bankroll the round is a single wager with several possible cash flows, not a set of independent bets. A bet with several prizes is the same thing on a smaller scale. The prize ranges of every bet cut `[0, 2^64)` into cells. In a cell of width `w_k` the bankroll's cash flow is:

```text
X_k = (every stake in the round) − (every payout due in that cell) − F
```

The Kelly condition for accepting the whole round at full size is `E[X / (B + X)] >= 0` with every `B + X_k > 0`. The implementation checks it exactly, merging cells with equal cash flow:

```text
sum_k  w_k × X_k × prod_{j != k} (B + X_j)  >=  0
```

With one stake and one prize there are two cells, `X = S − F` with width `Q − t` and `X = −(W + F)` with width `t`, and the sum reduces term for term to the closed form above. `assessRound` is the only pricing function; tests replay that closed form, an independent integer-root oracle and exhaustive small cases through it. The left side still strictly decreases in `F`, so the same bounded binary search finds the round's maximum commission. Each bet carries its stake's share of that total, rounded down to an even number of wei and split equally between its signed developer and the casino. The reservation is the worst cell's cash decrease plus the commission.

Correlation cuts both ways. Prizes on the **same** range stack: two players on red are one double-sized wager, so a table shares the capacity a lone player would have had (`sum of same-side net wins / B <= edge`) instead of multiplying it. Prizes on **disjoint** ranges hedge: what red wins, black loses, and the table earns capacity no set of independent bets could. It makes no difference who holds them: one player with a chip on red and a chip on black is priced exactly like two players holding one each, and overlapping chips priced as they stand equal the same chips flattened to one payout per pocket. `vectors/bets.json` records one red, two reds, a red with a black, and one player's overlapping chips, at the same bankroll. A hosted round fills one seat at a time, and each seat is assessed together with every seat already in it: the round is admitted again as a whole with the newcomer, who is declined alone if it does not fit. So it matters who arrives first. A third red may be declined where a black is welcome, and the same red fits once the black is seated. A seat that was admitted stays admitted. The round reserves its worst cell from the first seat until it closes. Commission is decided once, at the close, over the seats the round ended with and against the capital there is then; it is operator accounting and never a reason to decline a seat already taken. A round holds at most 256 seats and 128 distinct cells, which bounds the exact-integer products; a roulette table stays within the wheel's 37 pockets however many players sit down.

This derivation uses the expected logarithmic growth criterion described in [Edward Thorp's treatment of Kelly betting](https://web.williams.edu/Mathematics/sjmiller/public_html/341/handouts/Thorpe_KellyCriterion2007.pdf). The fee inequality above is derived for this protocol's specific cash flows.

## Extracting and splitting the excess

The service finds the maximum integer `F` satisfying the inequality by bounded binary search. The left side strictly decreases over the allowed fee interval. Each bet takes its stake's share of `F`, rounded down to an even number of wei, so that:

```text
developer commission = bet fee / 2
casino commission    = bet fee / 2
```

Each bet's rounding leaves under two wei in the bankroll. Probability rounding can likewise leave a slightly more favorable residual bet. JavaScript BigInt preserves the exact intermediate products.

This defines excess profit as the amount that can be removed while leaving the bankroll a Kelly-compliant residual wager. Subtracting the two advertised edge percentages alone is not generally correct: doing so ignores how an outcome-independent commission changes the bankroll's exposure.

For illustration, express amounts to six decimal places:

| Available bankroll | Stake | Net win | Target edge | Total commission | Each account |
| ------------------ | ----- | ------- | ----------- | ---------------- | ------------ |
| 10,000             | 100   | 100     | 1%          | 0                | 0            |
| 10,000             | 100   | 100     | 2%          | 1.000100         | 0.500050     |
| 10,000             | 1,000 | 100     | 2%          | 9.182046         | 4.591023     |

These are the integer examples in [the vectors](../vectors/bets.json), using six-decimal illustrative units. The contract itself uses native ETH in wei. In the second example, conservative pricing uses `−101.000100` for a player win and `+98.999900` for a loss. Actual bankroll equity changes by `−100.500050` or `+99.499950`, respectively, because the casino retains its half of the fee. Expected revenue is not a guaranteed per-bet profit.

Commission is credited on executed wins and losses. Unexecuted requests receive no commission and no debit. The casino can selectively refuse requests after learning the outcome; there is no withholding penalty. Probability-based economic calculations assume it does not do so.

## Available capital and concurrency

Signed results change the player balance and casino accounting off-chain. Casino fees are retained in bankroll equity: losses add S-F/2 and wins subtract W+F/2 to reported betting bankroll. Admission uses the conservative full-fee inequality and reserves W+F. Each bet's even share of F accrues equally to its developer and casino earnings, once per completed bet. The service decides admission from current capital excluding other in-flight reservations and reserves the round's worst case before it reads the round's secret; a wager it has admitted settles. A bet on a channel's own round carries the commission its admission priced; a hosted round's commission is priced at its close, and only that gives way if capital has moved by then. It never changes the player's signed stake, net win or probability. Insufficient capacity produces a joint higher-sequence rejection checkpoint with unchanged balance and no commission. A seat declined in a hosted round leaves that round open for the seats it already has; a channel's own round is declined with its bet, revealed at once and settling nothing. Reservations are per round; they do not fund a whole future hand or stop an owner from withdrawing on-chain.

At a consistent confirmed block, reported bankroll is:

    max(0, pool cash - active signed player balances - finalized unpaid claims - accrued unpaid developer commissions - in-flight worst-case reservations - escrow)

Escrow is every payout awarded but not yet collected: money that has left the bankroll for a player who has not signed for it yet.

The casino keeps one set of these books per asset; ETH and test coins never add up. Test coins have no chain: their pool cash is ten million test coins plus every coin the faucet has minted, and a claim credits the channel the same amount, so the test bankroll is unchanged by it.

Anyone may add to this capital. An [investment](protocol.md#the-bankroll-fund) is a transfer from a channel into the bankroll that mints shares at `equity / totalShares`, where equity is the reported bankroll before in-flight reservations; a redemption burns them at the same price and owes the player their worth, which counts as escrow until collected. Both leave the price of every other share unchanged, so holders gain and lose only what the bankroll does: losses add to equity and wins and developer commission take from it, pro rata. Investors widen what the Kelly rule admits exactly as the owner's own funding does, and the owner's funding and withdrawals buy and sell house shares at the going price. A redemption never takes money an in-flight round has reserved.

An open channel's full original deposit remains protected on-chain even after signed losses. On valid closure, protection becomes min(original deposit, final balance); the remainder of a loss is released. Finalized unpaid claims replace the active liability. Claim payments reduce both cash and claim liabilities. Confirmed funding and withdrawals change cash. The service reconciles each category without counting a channel and its replacement claim twice.

A developer [collects](protocol.md#developer-earnings) commission into a channel of their own: the payable falls and the developer's signed balance rises by the same amount, so the bankroll does not move and no ETH does either. Casino-earned commission is a cumulative reporting counter, not a second payable. Owner withdrawals reduce observed pool cash and thus bankroll equity; no separate house-commission release can be double-counted.

A deterministic game payment is a different operation: kind 2 reduces the player's signed channel balance by its amount and increases accounting bankroll by the same amount. It settles on no round, accrues no commission, and moves no ETH. The original deposit stays protected on-chain until closure. A game no-op changes neither the checkpoint nor this accounting.

Unallocated winnings cash excludes protected principal and already-reserved winnings. Owner withdrawals exclude all finalized unpaid winnings. Finalization order determines FIFO allocation; protected principal remains isolated. A failed recipient retains its allocation without blocking later funded claims. The casino's public cash balance is not evidence of full coverage of private signed balances. Kelly admission against reported bankroll does not enforce casino solvency or reserve capital for a whole game.
