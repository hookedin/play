---
title: Architecture
description: The design principle, and the trade-offs made on purpose.
sidebar:
  order: 3
---

HookedIn is one immutable contract, one casino that signs, a wallet that checks everything it can, and games in
sandboxed frames. The design keeps the fewest parts that are correct: clearly disclosed trust assumptions and manual
responsibilities are accepted in place of more protocol machinery, and every added authority, service, state or setting
needs a concrete requirement. [How it works](how-it-works.md) walks through the parts, and [the trust
model](trust-model.md) says what each is trusted for.

## Settled trade-offs

These are chosen on purpose and stay chosen; [AGENTS.md](../../AGENTS.md#settled-decisions) asks that they not be
reopened.

**Commission is the edge the bankroll does not need.** A casino bet is admitted when the bankroll can take it with no
commission at all; commission is then the most that still leaves the bankroll's residual wager Kelly-sound, split
equally between the game's developer and the casino. The calculation is more involved than a fixed rate, and that is
the point: a fee taken first would shrink every bet the bankroll can take, while this admits the largest ones and
charges only the surplus. A game sets its own tables, and its developer earns half of the edge they carry. Nothing here
pretends to protect a player from a game: any game can waste the money it is given on bets that pay back little,
whatever the fee, and a cap would only hide that. The player's protection is the allowance they set, and the measured
return of every casino bet, which the wallet records and does not enforce.

**A multi-step game is a sequence of casino bets.** Every step is one casino bet, settled on its own, so the bankroll
moves atomically with each step and no step waits on another. A player can walk away after any settled step with the
cash that step left them; nothing makes them finish a hand. A game built this way is a series of casino bets, each
admitted and charged by itself, not a committed hand, and its prices follow from that.

**A developer's solvency is outside HookedIn.** A game's bank reserves nothing, and a settlement is paid from it
only as far as it can pay. Whether a developer can pay what its developer bets are owed, and proving it, is between the
developer and its players; the casino does not attempt it. Playing a developer's game trusts that developer: for its
tables in any game, and with a developer bet for its payment and for whatever its scheme promises.

## Limitations

**The bankroll overcommits.** A casino bet its quote covers is binding, and a quote holds for a day, so the casino
cannot take one back once its bankroll has moved. The quotes out at once are not divided between them: each admits bets
against the whole virtual bankroll as it was when quoted. Together the bets on them can stake more than the Kelly rule
lets the bankroll take at once, and win more than it holds, which then waits in the winnings queue. The virtual
bankroll is half the bankroll, a half-Kelly margin and the only one. Dividing the bankroll between the quotes out would
bound it, at the cost of every player's limits shrinking with the number of players holding a quote. A player who wants
winnings that wait for nothing buys [collateral](../wallet/closing-and-claims.md#collateral), which takes them out of
the queue up to its amount.
