---
title: Collapsing bets
description: Playing a prize table too large for one bet, by drawing in the client which small bet to place.
sidebar:
  order: 6
---

A casino bet is a stake and up to 64 prizes, each paying when the round's outcome falls in its range
([casino bets](casino-bets.md#prizes)). That covers almost every game directly: a Plinko board is at most 17 prizes, a
roulette layout at most 37, a 243-ways slot a few dozen distinct pays, and the wallet signs the whole distribution. No
house game needs the technique below, and the SDK does not implement it.

Some prize tables do not fit: a slot with millions of distinct payouts, a lottery with a prize per ticket number, or a
table whose entries are rarer than one outcome in 2^64. Such a game can still be played on the same primitive by
**collapsing** its table: the client draws, with its own randomness, which small bet to place, so that placing that bet
and letting the casino settle it reproduces the full table exactly.

## The idea

Let the game have nominal stake `S` and gross payouts `G_i` with probabilities `π_i`. The client holds a set of
**branches**. A branch is one simple bet between a low payout `L` and a high payout `H`, with `L < S < H`:

```text
stake   s = S − L            the part of the nominal stake actually at risk
prize   [0, t) pays H − L    so the player ends on L or on H
kept    L                    never staked, never debited
```

The client selects branch `b` with probability `a_b` and submits only that bet. If its win probability is
`p_b = t_b / 2^64`, the branch contributes:

```text
probability mass at H = a_b × p_b
probability mass at L = a_b × (1 − p_b)
```

The collapse is correct when, summed over every branch, those masses equal the table's `π_i` for every payout.
Preserving every probability preserves the whole payout distribution, and so the return; preserving only the average
would not.

## Every branch must stand alone

The casino sees one branch, never the table, so each branch must pass [admission](../reference/economics.md) by itself
against the planning bankroll `B`. Without commission, a branch with stake `s` and net win `W = H − S` is admitted only
if:

```text
p <= pMax = s × (1 − W/B) / (s + W)
```

A bigger prize needs more edge. That is the constraint that shapes the construction: a client that could pick any `a`
and `p` with `a × p = π` must also keep `p <= pMax` for that branch.

## Payouts of zero and above the stake

When the only low payout is zero, every branch stakes `S`. For each positive payout take the Kelly cap as its
conditional win probability, scaled by one common factor `A`:

```text
pMax_i = S × (1 − W_i/B) / G_i
A      = sum(π_i / pMax_i)
a_i    = (π_i / pMax_i) / A          selection probability
p_i    = A × pMax_i                  conditional win probability
```

If `A <= 1` the selection weights sum to one and `a_i × p_i = π_i` for every prize. Every losing branch produces zero,
so the full table is reproduced with no losing branch of the client's own. The conditional edge of branch `i` is
`1 − A + A × W_i/B`: larger prizes carry more edge and are selected often enough to compensate. These edges are
components of the table's overall edge, not extra deductions. If `A > 1` the table does not fit this bankroll: lower
the stake or wait for more capital. Raising edges cannot repair a fixed table.

## Payouts between zero and the stake

Pair low payouts `L_j` (probability `ℓ_j`) with high payouts `H_i` (probability `h_i`). With `a_j = S − L_j`,
`b_i = H_i − S`, `v_j = (B + a_j)/a_j` and `u_i = b_i/(B − b_i)`, the least loss-to-win mass ratio a pair can carry is
`u_i × v_j`. Let `D = sum(h_i × u_i)` and `C = sum(ℓ_j / v_j)`. If `D > C` there is not enough low mass to support the
high mass at Kelly-safe odds, and no pairing exists. Otherwise, for a parameter `0 < t <= 1`:

```text
z_j  = ℓ_j / ((1 − t) × sum(h) + v_j × D)
x_ji = h_i × z_j / sum(z)                       win mass of pair j/i
y_ji = h_i × z_j × ((1 − t) + u_i × v_j)        loss mass of pair j/i
```

Pair `j/i` is selected with probability `x_ji + y_ji` and wins with conditional probability `x_ji / (x_ji + y_ji)`. For
every `t` the win masses sum to `h_i` and the loss masses to `ℓ_j`, so no candidate changes the table; `t` is searched,
by bisection toward `t × sum(z) = 1`, until every pair's actual integer range passes admission. A payout exactly equal
to the stake has no bet to make: it is a branch that places nothing.

## Exact probabilities on an integer outcome space

A conditional probability is rarely a whole number of outcomes. Write the ideal width as `k + δ`, with integer `k` and
`0 <= δ < 1`, and have the client submit the range `[0, k + 1)` with probability `δ` and `[0, k)` otherwise. The mean
width is exact, so `a × E[width] / 2^64 = π` holds with no rounding. Both widths must pass admission.

## Collapsing only part of a table

The two extremes are not the only choices. A game can keep its common outcomes as native prizes and collapse only a
rare tail: reserve one range for the tail, and let the client draw which tail prize that range pays before signing. The
same invariant applies to the tail alone. Prefer this whenever it fits: everything left native is signed and verified
by the wallet.

## What is given up

A native prize table is a fact the player signs: the wallet computes its exact return and largest payout, the round's
outcome alone decides the result, and even the presentation can be read from the outcome. A collapsed table trades
that away:

- **The wallet sees one branch, not the game.** It verifies that branch completely and knows nothing of the
  distribution it was drawn from. The table the game advertises is the game's word.
- **The client's randomness matters.** The selection must be uniform over exact integer weights, independent of the
  round's outcome and of the seed the wallet signs. A biased or replayed source changes the game. A modified client can
  choose its branch outright, which is why every branch must be admissible alone; it cannot harm the bankroll, only
  misrepresent the game to its player.
- **Never redraw.** Draw the branch once, save it before the wallet signs, and offer the same branch again after a
  verified rejection. Redrawing until a cheap branch is admitted, or dropping the rare expensive ones, silently changes
  the distribution. Keep declined, cancelled and withheld attempts apart from outcomes in any claim about returns.
- **The kept amount was never debited.** When showing a gross result, the player ends with `L` or `H`; do not add `L`
  again.
- **It costs more to price.** Finding selection weights and widths that are all admissible is a search over the whole
  table, growing roughly with the cube of its distinct payouts. Native prizes are priced by the casino's rule in one
  pass.

The identities above are algebraic consequences of the pair masses. The bankroll criterion and commission they rely on
are in [pricing and commission](../reference/economics.md).
