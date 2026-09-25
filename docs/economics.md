# Kelly pricing and commission

All monetary quantities are integer wei. The independent client selects a stake and the prizes it can pay. The casino admits a casino bet against its current unreserved bankroll and sets its commission in the same decision, before its round's secret is read. The wallet and settlement contract verify the exact terms and balance arithmetic; commission is operator accounting and does not add a player debit. The receipt of a casino bet reports its commission for display; the wallet does not independently verify that operator accounting.

A casino bet is a stake paid to enter and up to 64 prizes; every prize whose range holds the round's 64-bit outcome pays. The rule the casino applies is the [condition below](#a-casino-bet-is-one-wager), which covers any number of prizes on one outcome. This section derives it for the simplest casino bet, one prize, where it has a closed form.

| Symbol    | Meaning                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B         | Positive unreserved accounting bankroll, after active player balances, finalized claims, unpaid developer commissions, escrow, developer banks and reservations. |
| S         | Player stake, debited from the player's balance.                                                                                                                 |
| G = S + W | The prize's payout. W is what the player gains net of the stake.                                                                                                 |
| Q = 2^64  | Size of the outcome space.                                                                                                                                       |
| t         | Width of the prize's range in whole outcomes, 1 through Q − 1.                                                                                                   |
| p = t / Q | Actual probability that the prize pays.                                                                                                                          |
| F         | Total commission, accrued on every completed casino bet.                                                                                                         |

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

## A casino bet is one wager

Every prize of a casino bet rides one 64-bit outcome, so for the bankroll the bet is a single wager with several possible cash flows, not a set of independent ones. The prize ranges cut `[0, 2^64)` into cells. In a cell of width `w_k` the bankroll's cash flow is:

```text
X_k = (the stake) − (every payout due in that cell) − F
```

The Kelly condition for accepting the casino bet at full size is `E[X / (B + X)] >= 0` with every `B + X_k > 0`. The implementation checks it exactly, merging cells with equal cash flow:

```text
sum_k  w_k × X_k × prod_{j != k} (B + X_j)  >=  0
```

With one prize there are two cells, `X = S − F` with width `Q − t` and `X = −(W + F)` with width `t`, and the sum reduces term for term to the closed form above. `assessBet` is the only pricing function; tests replay that closed form, an independent integer-root oracle and exhaustive small cases through it. The left side still strictly decreases in `F`, so the same bounded binary search finds the maximum commission. The reservation is the worst cell's cash decrease plus the commission.

Correlation cuts both ways. Prizes on the **same** range stack: two chips on red are one double-sized wager, so they share the capacity one chip would have had (`sum of same-side net wins / B <= edge`) instead of multiplying it. Prizes on **disjoint** ranges hedge: what red wins, black loses, and the pair earns capacity no two independent bets could. It makes no difference whose chips they are: a developer's casino bet that covers one player on red and another on black is priced exactly like one player with a chip on each, and overlapping chips priced as they stand equal the same chips flattened to one payout per pocket. `vectors/bets.json` records a lone red and one player's overlapping chips, at the same bankroll. That is how a table of [developer bets](protocol.md#developer-bets) gets the bankroll behind it: its developer places one casino bet that adds up the prizes of the bets it covers, and the bankroll prices the table as a whole. A casino bet holds at most 64 prizes, so at most 128 distinct cells, which bounds the exact-integer products; a roulette table's prizes fit the wheel's 37 pockets however many players sit down.

This derivation uses the expected logarithmic growth criterion described in [Edward Thorp's treatment of Kelly betting](https://web.williams.edu/Mathematics/sjmiller/public_html/341/handouts/Thorpe_KellyCriterion2007.pdf). The fee inequality above is derived for this protocol's specific cash flows.

## Extracting and splitting the excess

The service finds the maximum integer `F` satisfying the inequality by bounded binary search. The left side strictly decreases over the allowed fee interval. `F` is rounded down to an even number of wei, so that:

```text
developer commission = F / 2
casino commission    = F / 2
```

The developer is the account that publishes the game; a game nobody publishes has none, and all of its commission is the casino's. The rounding leaves under two wei in the bankroll. Probability rounding can likewise leave a slightly more favorable residual bet. JavaScript BigInt preserves the exact intermediate products.

This defines excess profit as the amount that can be removed while leaving the bankroll a Kelly-compliant residual wager. Charging only that excess is [a settled trade-off](../architecture.md#settled-trade-offs). A casino bet is admitted when the condition holds with `F = 0`, and the left side falls as `F` grows, so a fee fixed first would turn away bets the bankroll could take; setting `F` afterwards admits every one of them and charges only the surplus. Subtracting the two advertised edge percentages alone is not generally correct: doing so ignores how an outcome-independent commission changes the bankroll's exposure.

For illustration, express amounts to six decimal places:

| Available bankroll | Stake | Net win | Target edge | Total commission | Each account |
| ------------------ | ----- | ------- | ----------- | ---------------- | ------------ |
| 10,000             | 100   | 100     | 1%          | 0                | 0            |
| 10,000             | 100   | 100     | 2%          | 1.000100         | 0.500050     |
| 10,000             | 1,000 | 100     | 2%          | 9.182046         | 4.591023     |

These are the integer examples in [the vectors](../vectors/bets.json), using six-decimal illustrative units. The contract itself uses native ETH in wei. In the second example, conservative pricing uses `−101.000100` for a player win and `+98.999900` for a loss. Actual bankroll equity changes by `−100.500050` or `+99.499950`, respectively, because the casino retains its half of the fee. Expected revenue is not a guaranteed per-bet profit.

Commission is credited on executed wins and losses. Unexecuted requests receive no commission and no debit. The casino can selectively refuse requests after learning the outcome; there is no withholding penalty. Probability-based economic calculations assume it does not do so.

## Developer bets

A [developer bet](protocol.md#developer-bets) is not the bankroll's: its stake goes into its game developer's bank at the casino, and what it is paid comes out of that bank, so the casino neither admits developer bets by Kelly nor prices their commission. Nothing in the bank is reserved. Whether the developer can pay is [outside HookedIn](../architecture.md#settled-trade-offs): a batch of settlements their bank cannot pay is refused, and the bets stay open. The casino's part is what the developer's signed settlement gives it, which the casino keeps in its earnings; its policy asks a developer for about half of what each developer bet is expected to earn them, as a casino bet's commission splits in two, and nothing enforces it. A developer who wants the bankroll behind its developer bets places its own casino bet on their round, which the bankroll admits and prices like any other: the developer pays its commission, and earns half of it back, as for any casino bet of its game.

## Available capital and concurrency

Signed results change the player balance and casino accounting off-chain. Casino fees are retained in bankroll equity: losses add S-F/2 and wins subtract W+F/2 to reported betting bankroll. Admission uses the conservative full-fee inequality and reserves W+F. Each casino bet's even F accrues equally to its game's developer and casino earnings, once per completed casino bet. The service decides admission from current capital excluding other casino bets' reservations and reserves the bet's worst case before it reads its round's secret; a casino bet it has admitted settles, and carries the commission its admission priced. Commission never changes the player's signed stake, net win or probability. Insufficient capacity produces a joint higher-sequence rejection checkpoint with unchanged balance and no commission, and the round is revealed at once, settling nothing; a developer's casino bet that does not fit is declined the same way and reveals its round. Reservations are per casino bet and last only while it is decided; they do not fund a whole future hand or stop an owner from withdrawing on-chain.

At a consistent confirmed block, reported bankroll is:

    max(0, pool cash - active signed player balances - finalized unpaid claims - accrued unpaid developer commissions - reservations - escrow - developer banks)

Reservations are the worst cases of the casino bets being decided. Escrow is every payout awarded but not yet collected: money that has left the bankroll for a player who has not signed for it yet. Developer banks are the developers' own money, the stakes of their developer bets among it.

The casino keeps one set of these books per asset; ETH and test coins never add up. Test coins have no chain: their pool cash is ten million test coins plus every coin the faucet has minted, and a claim credits the channel the same amount, so the test bankroll is unchanged by it.

Anyone may add to this capital. An [investment](protocol.md#the-bankroll-fund) is a debit from a channel into the bankroll that mints shares at `equity / totalShares`, where equity is the reported bankroll before reservations; a redemption burns them at the same price and owes the player their worth, which counts as escrow until collected. Both leave the price of every other share unchanged, so holders gain and lose only what the bankroll does: losses add to equity and wins and developer commission take from it, pro rata. Investors widen what the Kelly rule admits exactly as the owner's own funding does, and the owner's funding and withdrawals buy and sell house shares at the going price. A redemption never takes money a casino bet has reserved.

An open channel's full original deposit remains protected on-chain even after signed losses. On valid closure, protection becomes min(original deposit, final balance); the remainder of a loss is released. Finalized unpaid claims replace the active liability. Claim payments reduce both cash and claim liabilities. Confirmed funding and withdrawals change cash. The service reconciles each category without counting a channel and its replacement claim twice.

A developer [collects](protocol.md#developer-earnings) commission into a channel of their own: the payable falls and the developer's signed balance rises by the same amount, so the bankroll does not move and no ETH does either. Casino-earned commission is a cumulative reporting counter, not a second payable. Owner withdrawals reduce observed pool cash and thus bankroll equity; no separate house-commission release can be double-counted.

A deterministic game payment is a different operation: a debit that reduces the player's signed channel balance by its amount and increases accounting bankroll by the same amount. It settles on no round, accrues no commission, and moves no ETH. The original deposit stays protected on-chain until closure. A game no-op changes neither the checkpoint nor this accounting.

Unallocated winnings cash excludes protected principal and already-reserved winnings. Owner withdrawals exclude all finalized unpaid winnings. Finalization order determines FIFO allocation; protected principal remains isolated. A failed recipient retains its allocation without blocking later funded claims. The casino's public cash balance is not evidence of full coverage of private signed balances. Kelly admission against reported bankroll does not enforce casino solvency or reserve capital for a whole game.
