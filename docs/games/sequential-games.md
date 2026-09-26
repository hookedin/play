---
title: Sequential games
description: How a finite game with decisions becomes a sequence of casino bets, with blackjack's rules and exact edge.
sidebar:
  order: 5
---

The [pricing engine](../../sdk/src/engine/) represents a finite game as a graph of public states and works backward to
give each state enough **actual player cash** to finance its next step. The casino needs nothing more: each random step
is one ordinary casino bet, a stake, a chance and a prize, which the page draws from the bets the step can place.
Stake-rules blackjack and a reveal-or-cash-out Mines game are the worked examples;
[multi-step games](multi-step-games.md) shows how a page plays one.

The casino enforces each accepted bet's stake, chance, prize, commission, signed checkpoint and round. A game runs the
compiler itself and asks the wallet for casino bets and payments; the wallet checks each bet against the game's spending
limit without interpreting the graph. Whole-game probabilities hold only under the execution and bankroll assumptions
below, and the casino can decline a step, which ends the game there.

## Cash continuation values, not expected values

A terminal node's value is its whole gross payout. A nonterminal node's continuation cash is money the player already
holds on reaching that state, enough to support every action offered there. It is not a claim on an unplayed future
hand, a conditional expected payout, or money credited on arrival.

For each action, replace every successor by its continuation cash, keeping its exact probability and state identity.
Price the action against the planning bankroll floor: the price is the least cash on the cash grid at which the step,
as one wager, is Kelly-sound for the bankroll ([below](#why-the-price-exceeds-the-expected-value)); at that cash every
bet the step can place is one the casino admits. An action can carry `additionalCash`: the player's own money
committed by choosing a double, a split or insurance. A node's required cash is the maximum over its actions of
`max(0, action price − additionalCash)`. Each action is compiled with `node cash + additionalCash` and its successors'
cash. `RoundClient` checks that the spending limit covers that sum before betting, and records the contribution once
when the step resolves. None of it is casino credit.

Taking the maximum makes every offered choice financeable. It does not refund the difference between the chosen
action's price and the node's: the step starts from the node's cash and ends on the chosen successor's, so different
actions can carry different edges. A step that lowers the player's cash with nothing to draw is an explicit payment;
the library never deletes a player's money silently.

`compileGame(graph, { admits, bankrollFloor, cashQuantum, initialCash? })` performs the backward calculation.
`admits(bankroll, bet)` is the casino's admission rule, handed in by the caller: the library checks every bet it builds
against it and assumes nothing about it. Games pass [the casino's own](../sdk/admits.md#admits), so every bet they build
is one the casino admits at the planning bankroll. `initialCash` sets the starting cash, provided it supports the
root's actions; it does not change terminal payouts. Without it the root uses its required continuation cash. For
blackjack, the `stake` that defines the terminal payouts and the initial cash needed to finance the sequence are
distinct quantities: report both rather than advertise a fixed-price hand when they differ.

### Why the price exceeds the expected value

For one action with successor cash v_i and probabilities p_i, current cash c and bankroll b, the price is the least
cash at which the step is one Kelly wager for the bankroll at zero commission:

```text
sum_i p_i × (c − v_i) / (b + c − v_i) >= 0        with every b + c − v_i > 0
```

Here `c − v_i` is what the bankroll gains when successor i is reached. The condition holds exactly when the step
[collapses](collapsing-bets.md) into bets the casino's rule admits one by one. A certain outcome v needs c = v and no
bet. For an uncertain one at a finite bankroll, c equal to the expected value makes the sum strictly negative by
concavity, so expected value alone does not fund the step: the difference is the risk premium in continuation cash, and
it shrinks as the bankroll grows. `priceTransition` finds the least grid cash that satisfies it by bisection, since
more cash is never less safe for the bankroll and the highest successor's cash always suffices. It weighs the
bankroll's losses one part in 2^32 heavier, so that every bet has room to round its chance to whole outcomes. A step
whose successors all need the same cash is priced at exactly that cash, off the grid. Backward pricing at a fixed
conservative floor does not make the whole hand one Kelly-optimal wager.

## One step is one bet

[transition.ts](../../sdk/src/engine/transition.ts) builds each step. Group the successors by the cash they need into
**cash classes**, each with its exact probability. With current cash c, a bet between a class below c, at cash L, and a
class above it, at cash H, is:

```text
stake   = c − L        the cash that can be lost
prize   = H − L        paid when the outcome is below the chance
kept    = L            never staked, never debited
```

Whatever the outcome, the player's cash after the bet is exactly the reached class's: the stake leaves, and the prize
comes back when the bet wins. A step of two classes, one on each side of c, is that one bet, winning with the higher
class's probability. A step of more is collapsed: the page draws which pair of classes to bet between, with weights and
chances that reach every class exactly as often as the rules say, and a class at exactly c is reached with no bet
([collapsing bets](collapsing-bets.md)). A step whose successors all need the same cash moves no money: nothing is bet,
and any cash above it is an explicit payment to the bankroll.

A chance is whole outcomes. A bet's chance is its win probability times 2^64, rounded down, and a second branch with
one outcome more carries the share of the weight that makes the mean exact, so every class is reached exactly as often
as the rules say, even when its probability does not divide 2^64 (one card rank in thirteen). A step whose odds are
finer than one outcome in 2^64 is refused. `evaluatePolicy` reports the rules' own exact probabilities.

## The round's outcome names the next state

An action states exact probabilities for its successor **states**, not only their cash. The round's outcome decides the
bet, and so the class. Which state of the class, when several need its cash, is
[`landing(class, outcome)`](../sdk/engine.md#landing): drawn from the outcome with
[`seededRandom`](../sdk/engine.md#seededrandom), a deterministic generator, so the verified outcome names the card as
well as what it paid, and a reload lands on the same state. The same generator then draws `settlement.draw`, what the
page shows the result with, so the picture is drawn apart from the state. Equal cash does not make two states interchangeable: their
later actions can differ. Each state's own cash already finances whatever follows from it, so which of them the step
reaches cannot cost the bankroll anything.

A step that places no bet has no outcome. When a collapsed step draws its branch without a bet, or every successor of
an action needs the same cash, the library draws the state from a caller-injected `RandomBelow`, the page's own
randomness.

Reaching each class exactly as often as the rules say, at every completed step, preserves the distribution of each
step's cash for the chosen policy; it does not make all policies share one distribution. `evaluatePolicy` computes the
exact terminal payout distribution and expectation of a policy that plays the graph to its end; stopping outside the
graph's own actions is left out. Net EV subtracts both the initial cash and the expected additional contributions:
gross payout over the initial bet alone is not blackjack's return when doubles and splits exist. The policy must be a
pure, deterministic function of the current public node, because the evaluator caches by node; a policy that depends on
history works only when the graph's states carry that history. `optimalExpectedValuePolicy` chooses actions for
terminal payout expectation less later contributions, a different calculation from pricing continuation cash.

## Every step uses the casino's risk admission

For available bankroll B and total commission F, a bet with stake s, chance t and net win W = prize − s is admitted
when `B − W > 0` and:

```text
(B − W − F)(s − F) × 2^64 >= B × t × (s + W)
```

The casino takes the largest commission that satisfies it, the smaller root of that quadratic in F, and rounds it down
to an even amount for the split between developer and casino. A win reduces the bankroll by W + F; a loss raises it by
s − F. Commission accrues on executed bets only, win or lose. It is part of each step's economics, not a fee deferred to
the end of a hand. See [pricing and commission](../reference/economics.md).

The compiler checks every bet a step can place at `bankrollFloor`. `prepareAction` checks the runtime bankroll against
that floor, draws the step's branch, and asks the admission rule again at the live bankroll before it returns the bet.
A live adapter submits exactly that stake, chance and prize. The casino calculates commission against its capital at
admission; it cannot change the signed terms. Local calculations reserve no capital and promise no admission.

A rejected step is neither a loss nor a free card. A verified joint rejection advances the channel past the attempted
bet without touching the balance; the declined round is revealed, and the next attempt is on another. The step keeps
the branch it drew: try the same bet again under a fresh operation ID at the higher sequence, or stop. Drawing again
would change the game's odds. `RoundClient` keeps the pending step across a rejection and a reload. A timeout or an
HTTP error leaves the signed request unresolved: recover it or close the channel. There is no timeout outcome.

## A conservative bankroll floor across N transitions

Let D be the graph's greatest number of remaining steps from the root and M its greatest continuation cash, any chosen
initial cash included. Start with available bankroll of at least:

```text
bankrollFloor + D × M
```

When a step's bet wins, with prize g, the bankroll falls by g − s + F. Since F < s:

```text
g − s + F < g = H − L <= M
```

A player loss raises the bankroll, a payment raises it, and a step with no bet leaves it unchanged. So after at most k
completed steps the bankroll is at least its starting amount less k × M, and through at most D steps it stays above the
planning floor. The plan exposes this conservative requirement as `conservativeBankroll`; it can be far above a
practical budget.

The argument assumes no competing bets, owner withdrawals or other bankroll decreases between steps. Nothing locks a
hand's future capacity: the casino serves other bets, and the owner can withdraw, between steps. Without that isolation,
check capacity again and pause when the floor is unavailable. An off-chain request reserves no future capacity.

## Actions, entropy and cash-out

Choose an action from the current public state **before** its round's outcome exists. The page then draws the step's
branch, and the step is fully determined: its bet, and the class each outcome leads to. Save the pending action, its
branch and its operation ID before anything is signed in a live integration. Policy evaluation assumes this boundary.

A step has two sources of entropy. The page's own, an injected `RandomBelow`, draws the branch, and the state when no
bet is placed; it must be uniform over the requested interval, and `rngFromBytes` adapts a secure byte source with
rejection sampling. The page draws before the wallet picks the round's seed, so the draw is independent of the outcome.
The round's is the seed the wallet signs and the secret of the round the casino named beforehand: together they fix the
64-bit outcome, which decides the bet and names the successor and its card. The local resolver takes that verified
outcome from outside; drawing one with a test generator is a simulation, not a settlement. The library has no
randomness of its own.

At a settled step the player can stop and keep the current continuation cash: a
[settled trade-off](../overview/architecture.md#settled-trade-offs). Keeping that signed balance needs no favourable
future outcome; withdrawing ETH still needs the channel closed, and its winnings depend on the casino's liquidity.
Stopping changes the policy, and so the terminal distribution, compared with playing to the graph's terminals. Stopping
cannot cancel a signed request still pending: recover its exact result or verified rejection, or resolve it by closing
the channel, before abandoning the action. A clock or an HTTP error cannot establish cancellation. The blackjack rules
have no surrender; stopping between settled bets is a consequence of funding with actual cash, not a conventional
surrender.

## Blackjack rules and completed-hand edge

The game implements the rules [Stake Originals Blackjack](https://stake.com/casino/games/blackjack) publishes under
Game Info → Rules (read on 2026-09-17), doubling after a split included. Stake's
[card-generation documentation](https://stake.com/provably-fair/game-events) specifies independent draws from unlimited
decks.

| Rule         | Behaviour                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Cards        | Every card face and suit is an independent 1/52 draw, with replacement                                     |
| Dealer       | Stands on all 17s; checks for a natural before ordinary player decisions                                   |
| Initial deal | Two player cards and one visible dealer card. Insurance is offered against an Ace before the check         |
| Double       | Any first two cards, a split hand included; add S and draw exactly one card                                |
| Split        | One initial equal-value pair into two hands; add S; no re-splitting. Both hands share one dealer           |
| Split aces   | One more card per ace, then stand. A split 21 pays as an ordinary 21                                       |
| Insurance    | Optional S/2 against an Ace; returns 3S/2 gross on a dealer blackjack and nothing otherwise                |
| Payouts      | Loss or bust 0, push the hand's bet, win twice the hand's bet gross, natural 5S/2 gross. Two naturals push |
| Surrender    | None. Stopping in the wallet, outside the game, is left out of completed-hand figures                      |

`stake` must be a positive even bigint. The round starts with exactly S; each chosen extra bet contributes its stated
amount from the spending limit. The wallet's final change is `terminal payout − S − every additional wager`. Commission
is house-side accounting, never an extra player debit. When capacity is short or a plan cannot be represented, the
stake is refused; probabilities and payouts never change.

The optimal completed-hand net return per initial stake is exactly:

```text
−40248916821673328324125295 / 7056410014866816666030739693
```

That is a **0.5703880122736% house edge**, or **99.4296119877264%** paid back on an initial-bet basis, matching Stake's
rounded 0.57% and 99.43%. It is not a claim that every strategy has that edge, nor that the edge is exactly
57/10,000. Optimal play declines insurance. The independent oracle in
[games/blackjack/test/blackjack-rules.test.ts](../../games/blackjack/test/blackjack-rules.test.ts) computes dealer
probabilities from raw totals and ace counts, and stand, hit, double and split values, without the game graph,
continuation pricing or commission code.

The graph merges economically equivalent states but keeps each card's face and suit in its outcome label. The verified
outcome names the card, as [above](#the-rounds-outcome-names-the-next-state), and only that card joins the visible
history. The dealer's blackjack is checked as a public chance event; after a negative check, the later hole-card draw
excludes the complementary rank. With replacement this gives the same public card and payout distribution as a hidden
hole card, without exposing future information to the player's decisions. The dealer's cards are revealed and drawn as
steps of their own once the player's hands finish. A round in which every hand busts finishes at once.

With S = 1 ETH, a 1,000,000 ETH planning floor and a 10^9-wei cash quantum, the graph has 14,065 states, a greatest
depth of 52 steps, a greatest cash of 8 ETH and a required root cash of 0.994297434 ETH. The game starts at the nominal
1 ETH, which keeps its stated payouts and edge. Extra wagers are why the greatest total stake and the expected gross
return exceed S.

A page loads the committed [funding table](../../sdk/src/generated/blackjack-funding.ts) and does not price in the
browser. `npm run generate:blackjack` generates it from the same rules graph and exact compiler, at a 1,000,000-wei
stake, a 256-stake planning floor and a 1-wei quantum. It stores only each action's required cash, not another copy of
the rules or every possible bet. `loadFundedGame` scales these amounts by an exact integer, builds steps as they are
used and keeps the runtime risk checks; probabilities and terminal payouts are unchanged. The table's root requires
0.999452 stakes; the player still contributes exactly one stake. It holds the least cash `priceTransition` finds for
each of the 28,229 actions.

The table serves stakes divisible by 1,000,000 wei (0.000000000001 ETH) when the starting bankroll covers 672 stakes:
the 256-stake floor plus the 52 × 8-stake conservative allowance. Exact integer scaling keeps the Kelly ratios; the
casino calculates actual commissions at admission rather than scaling them. `npm test` regenerates the table byte for
byte and checks that every blackjack action collapses into bets the casino admits, reaching each class of successors at
its stated odds. Regenerate the table with any rule or pricing change; `npm run generate:blackjack -- --check` checks
it without writing.

Other stake increments and smaller starting capital use `compileGameAsync`, which yields between batches of states. A
later round reuses its plan while the live bankroll covers the conservative requirement. The game keeps its own
checkpoint, contribution totals and resolved cards at its origin; it adds no blackjack authority, contract rule or
whole-hand collateral.

## Mines: another N-move graph

`createMines({ tiles, mines, cashouts })` models symmetric unrevealed tiles by the number of safe picks made so far.
After j safe picks, the next reveal succeeds with probability `(tiles − mines − j)/(tiles − j)` and hits a mine with
probability `mines/(tiles − j)`. Revealed safe tiles are removed; no hidden full board is exposed to the action
policy. The player may cash out after any safe pick.

The example uses five tiles, one mine and at most three safe picks, with gross cash-outs `[1.20, 1.56, 2.28]` for an
initial cash of 1. Its fixed-stop policies give:

| Cash out after   | Survival probability  | Gross cash-out | Return on initial cash 1 |
| ---------------- | --------------------- | -------------- | ------------------------ |
| One safe pick    | 4/5                   | 1.20           | 0.96                     |
| Two safe picks   | (4/5)(3/4) = 3/5      | 1.56           | 0.936                    |
| Three safe picks | (4/5)(3/4)(2/3) = 2/5 | 2.28           | 0.912                    |

Each further reveal carries its own positive edge: the conditional expected cash falls from 1 to 0.96, from 1.20 to
1.17, and from 1.56 to 1.52. At the example's bankroll floor each safe state is already funded at its cash-out value,
and `cash-out` is a step with no bet to that same cash; the example has no payments. A ladder with a constant overall
return would make later reveals zero-edge bets, which finite-bankroll Kelly admission refuses when they are funded only
at their stated cash-outs.

## Implementation boundary

The compiler and runtime are pure reference code. They submit no transactions, read no live bankroll, hold no player
keys, check no chain finality, and cannot enforce a policy against a modified caller. An adapter signs and saves each
step's bet, retries identical requests, and verifies the signed result. [`RoundClient`](../sdk/round.md#roundclient) is
that adapter for a game page: it saves its state and pending step at the game's origin and places each bet through the
wallet bridge, while the wallet saves the signed request in IndexedDB and verifies the settlement, and the spending
limit lives only in the open tab's memory. The library's ownership checks on plans and prepared steps are
process-local; another adapter supplies its own durable recovery and settlement journal.

A payment step is an explicit payment to the bankroll: in a page, `game.payment`. The wallet signs a deterministic
channel debit and verifies the casino's resulting checkpoint before the game advances. It lowers the signed balance and
raises the casino's accounting bankroll, with no ETH transfer and no commission.

Finite acyclic graphs, exact rational probabilities, odds no finer than one outcome in 2^64, whole-unit cash and
computing resources bound this implementation. The contract stays safe by validating each accepted bet on its own. The
wallet signs and verifies each step's bet, not the draw that chose it: an untrusted page can misrepresent the game, and
which bet a step places, but every bet it can place is admissible alone
([what is given up](collapsing-bets.md#what-is-given-up)).
