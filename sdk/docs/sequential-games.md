# Sequential games built from casino bets

The [pricing engine](../src/engine/) represents a finite game as a graph of public states, then works backward to assign each state enough **actual player cash** to finance its next transition. The examples are Stake-rules blackjack and a reveal-or-cashout Mines game. The casino core is unchanged: each random transition is one ordinary casino bet, a stake and a prize for every better successor.

The casino enforces each accepted bet's stake, prizes, commission, signed checkpoint and round rules. Games run this optional compiler themselves and request casino bets and payments from the wallet. The wallet checks each bet and its game allocation, without interpreting the graph. The reference preserves full-game probabilities only under its stated execution and bankroll assumptions. Casino withholding can prevent completion.

## Cash continuation values, not expected values

A terminal node's value is its integer gross payout. A nonterminal node's continuation cash is money already available to the player when that state is reached. It must support every action offered at that state. It is not a claim against an unplayed future hand, a conditional expected payout, or newly credited money.

For each action, replace every successor state by its already computed continuation cash, retaining its exact transition probability and state identity. Price that probability/cash table against the planning bankroll floor: the price is the least cash, on the cash grid, whose bet the casino's own admission rule accepts. An action can specify `additionalCash`: existing player money committed by choosing a double, split, or insurance bet. The node's required cash is the maximum of `max(0, action price − additionalCash)` across its actions. Each action is compiled with `node cash + additionalCash` and its original successor cash amounts. The wallet adapter checks that the allocation covers that sum before betting, and records the contribution once when the saved action resolves. This is not casino credit.

Taking the maximum makes all offered choices financeable. It does not mean the player receives a refund equal to the difference between the chosen action's minimum price and the node price. The actual transition starts with the common node cash and ends with the chosen successor's cash. Different actions can therefore have different effective edges. A cash-reducing deterministic or all-downside action requires an explicit payment; the library cannot silently delete account credit.

`compileGame(graph, { admits, bankrollFloor, cashQuantum, initialCash? })` performs this backward calculation. `admits(bankroll, bet)` is the casino's admission rule, handed in by the caller: the library prices against it and never assumes what it is. The sample games pass [the casino's own function](../src/admits.ts), so a price they compute is a price the casino will honour. The optional `initialCash` changes the starting cash budget, subject to supporting the compiled root actions; it does not change terminal payouts. Without it, the root uses its required continuation cash. For blackjack, the `stake` used to define terminal prizes and the computed initial cash needed to finance the sequential implementation are distinct quantities. Report both instead of advertising a conventional fixed-price hand when they differ.

### Why the price exceeds the expected value

For one action with successor cash values v_i and probabilities p_i, current cash c, and bankroll b, the casino's [admission condition](../../docs/economics.md#a-casino-bet-is-one-wager) at zero commission is:

```text
sum_i p_i × (c − v_i) / (b + c − v_i) >= 0        with every b + c − v_i > 0
```

Here `c − v_i` is what the bankroll gains when successor i is reached. A deterministic outcome v needs c = v and no wager. For a nonconstant outcome at finite bankroll, setting c to the expected value makes the sum strictly negative by concavity, so expected value alone does not fund the transition: the difference is the risk premium in continuation cash, and it shrinks as the bankroll grows. `priceTransition` finds the least grid cash that satisfies the casino's exact integer rule by bisection, because more cash is never less safe for the bankroll and staking the whole top prize is always admitted. A single-cash successor uses that exact cash, without rounding. Backward pricing at a fixed conservative bankroll floor is not a theorem that the whole hand is one Kelly-optimal wager.

## One step is one bet

Here is the construction in [transition.ts](../src/engine/transition.ts). Lay the successors along the outcome space `[0, 2^64)` in their stated order, each as wide as its probability. Let `L` be the cheapest successor's cash. With current cash c:

```text
stake    = c − L                          the cash that can be lost
prize_i  = [start_i, end_i) pays v_i − L   for every successor with v_i > L
kept     = L                               never staked, never debited
```

Whatever the round's outcome, the player's cash after the bet is exactly the reached successor's `v_i`: the stake leaves, and the prize holding the outcome comes back. Neighbouring successors that need the same cash share one prize, and a bet holds at most 64 prizes. The cheapest successors are the absence of a prize. A step whose successors all need the same cash moves no money: nothing is bet, and any cash above it is an explicit payment to the bankroll.

Widths are whole outcomes. Each successor receives the floor of `p_i × 2^64` and the few outcomes left over go, one each, to the largest remainders. A probability that divides 2^64 (a fair peg, a coin) is exact; any other (one card rank in thirteen) is within one outcome in 2^64 of its stated value. Pricing uses these actual widths, so the bet that is priced is the bet that is played. `evaluatePolicy` reports the rules' own exact rational probabilities; the played distribution differs from it by less than `2^-64` per successor.

## The round's outcome names the next state

An action specifies exact probabilities for its successor **states**, not only their cash. Every successor keeps its own stretch of the outcome space, including successors that need the same cash, so the casino's verified outcome decides which card was drawn as well as what it paid. Equal monetary values do not make two game states interchangeable: their later actions may differ, and neither the game nor a modified client chooses between them.

The one exception moves no money. When every successor of an action needs the same cash there is no bet to settle, so the library draws the successor from a caller-injected `RandomBelow`. Each state's own cash already finances whatever follows from it, so that draw cannot cost the bankroll anything.

Conditional state-probability preservation at every faithfully completed action preserves path and terminal distributions for the chosen policy. It does not make all policies share the same distribution. `evaluatePolicy` computes an exact terminal payout distribution and expectation for a specified policy completing the graph; it excludes optional cashout outside the graph's own actions. Net EV subtracts both initial cash and expected additional contributions; gross payout divided by the initial bet alone is not blackjack RTP when doubles and splits are available. Its policy callback must be a pure deterministic function of the current public node: the evaluator caches by node, so a stateful or history-dependent callback is not supported unless that history is represented in the graph state. `optimalExpectedValuePolicy` chooses actions for terminal payout expectation minus subsequent player contributions, which is a different calculation from pricing continuation cash.

## Every step uses the casino's risk admission

For actual available bankroll B and total commission F, a step with stake s and prizes of width w_i paying g_i is admitted when every `B + s − g_i − F > 0` and:

```text
sum_k w_k × X_k × prod_{j != k} (B + X_j) >= 0        X_k = s − (payout due in cell k) − F
```

which for a single prize is `(B − W − F)(s − F) × 2^64 >= B × t × (s + W)`. The calculation finds the largest safe integer commission and rounds it down to an even amount for the developer/casino split. A win reduces bankroll by W + F; a loss increases it by s − F. Commission accrues in the service ledger on both outcomes and only on executed bets. It is part of each step's economics, not a fee that can be postponed until the end of a hand. See [Kelly pricing and commission](../../docs/economics.md).

The compiler validates every step at `bankrollFloor`. `prepareAction` checks the supplied runtime bankroll against that floor and asks the admission rule again at the live bankroll before returning the bet. A live adapter submits exactly that stake and those prizes. The casino calculates commission against current capital at admission; it cannot change those signed player terms. Local calculations reserve no capital and make no admission promise.

A rejected step is not a loss or a free card. A verified joint rejection advances the channel above the attempted wager without consuming balance; the declined round is revealed and the next attempt is on a new one. The same action is the same bet, so there is nothing to protect from a redraw: use a new operation ID at the higher sequence for another attempt, or stop the rejected action. The reference round helper keeps the pending action across rejection and reload. A timeout or generic HTTP error leaves the signed request unresolved: recover it or close. No timeout outcome exists.

## A conservative bankroll floor across N transitions

Let D be the graph's maximum number of remaining transitions from the root and M its maximum continuation cash, including any chosen initial cash. Start with available bankroll at least:

```text
bankrollFloor + D × M
```

For a step whose top prize pays g, the bankroll's reduction is g − s + F. Because F < s:

```text
g − s + F < g = H − L <= M
```

A player loss increases bankroll, a cash payment increases it, and a no-wager transition leaves it unchanged. Thus after at most k completed transitions, bankroll is at least its initial amount minus k × M. Through at most D transitions, it remains above the planning floor. The plan exposes this conservative starting requirement; it can be much larger than a practical portfolio budget.

This proof assumes no competing wagers, owner withdrawals, or other external bankroll decreases between steps. The reference does not lock the hand's future capacity, and the existing casino may serve unrelated bets or permit owner withdrawals between executed bets. Without that isolation, check capacity again and pause when the floor is unavailable. An off-chain request reserves no future capacity.

## Actions, entropy, and cashout

Choose an action using only the current public state **before** its round's outcome exists. The step is then fully determined: its bet, and the successor each stretch of outcomes leads to. Persist the pending action and its operation ID in a live integration. Policy evaluation assumes the policy obeys this information boundary.

The only entropy in a step is the round's: the seed the wallet signs and the secret of the round the casino named beforehand determine the 64-bit outcome, which names the successor and its card. The local resolver accepts that externally supplied verified outcome; drawing one with a test RNG is only a simulation, not a server settlement proof. The library's one other use of randomness, an injected `RandomBelow` for steps that move no money, must be uniform over the requested interval; `rngFromBytes` adapts a secure byte source with rejection sampling. There is no ambient library RNG.

At a settled game boundary, the player can stop and retain the current actual continuation cash: a [settled trade-off](../../architecture.md#settled-trade-offs). Retaining that signed continuation balance needs no favorable future game outcome. Withdrawing ETH still requires channel closure, and the winnings portion depends on casino liquidity. Stopping changes the chosen policy and therefore the terminal distribution compared with playing to the original terminal nodes. Stopping cannot cancel a still-valid signed request. Recover the exact result or verified joint rejection, or resolve it through channel closure, before abandoning its pending action. A clock or HTTP error cannot establish cancellation. The blackjack rules omit surrender; stopping a client-managed sequence between settled bets is a separate consequence of actual-cash funding, not conventional blackjack surrender.

## Blackjack rules and completed-hand edge

The game implements the rules shown in [Stake Originals Blackjack → Game Info → Rules](https://stake.com/casino/games/blackjack), checked on 2026-09-17. The live panel explicitly allows doubling after a split; older forum posts describing no doubling after splits are obsolete. Stake's [card-generation documentation](https://stake.com/provably-fair/game-events) specifies independent draws with unlimited decks.

| Rule         | Behavior                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| Cards        | Every card face and suit is an independent 1/52 draw, with replacement.                               |
| Dealer       | Stands on all 17s; checks for a natural before ordinary player decisions.                             |
| Initial deal | Two player cards and one visible dealer card. Insurance is offered against an Ace before the check.   |
| Double       | Any first two cards, including a split hand; add S and draw exactly one card.                         |
| Split        | One initial equal-value pair into two hands; add S; no re-splitting. Both hands share one dealer.     |
| Split aces   | One additional card per ace, then stand. Split 21 pays as ordinary 21.                                |
| Insurance    | Optional S/2 against an Ace, returns 3S/2 gross on dealer blackjack and zero otherwise.               |
| Payouts      | Loss/bust 0, push original hand bet, win twice hand bet gross, natural 5S/2 gross. Two naturals push. |
| Surrender    | Unavailable. Wallet stopping outside the game is excluded from completed-hand calculations.           |

`stake` must be a positive even bigint. The initial round cash is exactly S; each selected extra bet contributes its stated amount from the allocation. Final wallet change is `terminal payout − S − all additional wagers`. Commissions are house-side accounting, not additional player debits. Insufficient capacity or an unrepresentable plan rejects the stake rather than changing probabilities or payouts.

The optimal completed-hand net return per initial stake is exactly:

```text
−40248916821673328324125295 / 7056410014866816666030739693
```

That is **0.5703880122736% house edge**, or **99.4296119877264% RTP** on an initial-bet basis, matching Stake's published rounded 0.57% / 99.43%. This is not a claim that every strategy has that edge, or that the edge is exactly 57/10,000. Insurance is declined under optimal play. The independent oracle in [games/blackjack/test/blackjack-rules.test.ts](../../games/blackjack/test/blackjack-rules.test.ts) calculates raw-total/ace-count dealer probabilities and stand/hit/double/split EV without using the game graph, continuation pricing, or commission code.

The graph merges equivalent economic states, retaining actual card faces and suits in outcome labels. Every card keeps its own stretch of the outcome space, so the verified outcome names the card; only that card is appended to the visible history. Dealer blackjack is checked as a public chance event. After a negative check, the later hole-card draw excludes the complementary rank. With replacement, this gives the same public card and payout distribution as an initially hidden hole card, without exposing future information to player decisions. Dealer cards are revealed and drawn explicitly after the player's hands finish. All-bust rounds finish immediately.

With S = 1 ETH, a 1,000,000 ETH planning floor and a 10^9-wei cash quantum, there are 14,065 states, maximum depth 52, maximum cash 8 ETH, and required root cash 0.994297434 ETH. The game starts at the nominal 1 ETH, preserving its advertised payouts and edge. Extra wagers explain why maximum total stake and expected gross return exceed S.

The browser normally loads the committed [funding table](../src/generated/blackjack-funding.ts). `npm run generate:blackjack` generates it from this same rules graph and exact compiler at a 1,000,000-wei stake, a 256-stake planning floor and a one-wei quantum. It stores only each action's required cash, not another copy of the rules or every possible wager. `loadFundedGame` scales these amounts by an exact integer, constructs steps as they are used, and retains the existing runtime risk checks. All probabilities and terminal payouts remain unchanged. The generated root requires 0.999452 stakes; the player still contributes exactly one stake. Pricing each step as one prize table against the casino's exact rule gives the least cash at all 28,229 actions.

The table supports stakes divisible by 1,000,000 wei (0.000000000001 ETH) when the starting bankroll covers 672 stakes: the 256-stake floor plus the existing 52 × 8-stake conservative allowance. Exact integer scaling preserves the Kelly ratios; actual commissions are calculated by the service at admission rather than scaled. Tests regenerate the artifact byte for byte and verify that every blackjack action is one admitted bet whose ranges name each successor at its stated odds. Rebuild the table when changing rules or pricing. `npm run generate:blackjack -- --check` checks it without writing.

Other stake increments and lower starting capital use `compileGameAsync`, which yields between batches of states. A subsequent round can reuse its plan while the live bankroll covers the conservative starting requirement. The game stores its own checkpoint, contribution totals and resolved cards at its origin; no blackjack authority, contract rule, or whole-hand collateral has been added.

## Mines: another N-move graph

`createMines({ tiles, mines, cashouts })` models symmetric unrevealed tiles by the number of safe picks already made. After j safe picks, the next reveal succeeds with probability `(tiles − mines − j)/(tiles − j)` and hits a mine with probability `mines/(tiles − j)`. Revealed safe tiles are removed; no hidden full board is exposed to the action policy. The player may cash out after any supported safe pick.

The example uses five tiles, one mine, and at most three safe picks, with gross cashouts `[1.20, 1.56, 2.28]` for initial cash 1. Its fixed-stop policies give:

| Cash out after   | Survival probability  | Gross cashout | RTP from initial cash 1 |
| ---------------- | --------------------- | ------------- | ----------------------- |
| One safe pick    | 4/5                   | 1.20          | 0.96                    |
| Two safe picks   | (4/5)(3/4) = 3/5      | 1.56          | 0.936                   |
| Three safe picks | (4/5)(3/4)(2/3) = 2/5 | 2.28          | 0.912                   |

Each further reveal has its own positive edge: conditional expected cash falls from 1 to 0.96, from 1.20 to 1.17, and from 1.56 to 1.52. At the example's bankroll floor, each safe state is already funded at its cashout value and the explicit `cash-out` action is a no-wager transition to that same cash. The example has no payment branches. In contrast, a constant full-game RTP ladder gives later zero-edge reveals, which fail finite-bankroll Kelly admission when funded only at their advertised cashout values.

## Implementation boundary

The game compiler and runtime are pure reference code. They do not submit transactions, read live bankroll, store player keys, validate chain finality, or enforce a client policy against a modified caller. A native adapter must sign and persist each step's bet, retry identical requests, and verify signed off-chain result evidence using the channel protocol. The game-side [src/round.ts](../src/round.ts) adapter saves its opaque state and pending step at the game's own origin and places the bet through the wallet bridge. The wallet persists the signed request in IndexedDB and verifies settlement; the game's spending limit lives only in the open tab's memory. Plan/prepared-object ownership checks in the reference library remain process-local; other adapters must supply their own durable recovery and settlement journal.

Payment branches are explicit payments to the bankroll in the abstract accounting. The wallet's `payBankroll(amount)` signs a deterministic off-chain debit and verifies the casino's resulting checkpoint before advancing. This kind-2 payment changes the signed balance and service accounting without an ETH transfer or commission. `fundBankroll` is only needed to add ETH to the shared on-chain pool.

Finite acyclic state graphs, exact rational probabilities, integer cash, 64 prizes per step, and resource use bound this implementation. A step with more distinct prizes than one bet holds can be [collapsed client-side](collapsing-bets.md), at the cost that doc describes; nothing here does so. The contract remains safe only by validating each accepted wager independently; an untrusted frontend can misrepresent the wider game, but not a single step of it: the wallet signs each step's whole prize table.
