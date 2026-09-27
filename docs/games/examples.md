---
title: Examples
description: The seven house games and the template, what each shows, and the files to copy.
sidebar:
  order: 12
---

The house's games are what `@hookedin` publishes, each with its README, its tests and a Cloudflare deployment. Four
static ones live in play's [games/](../../games/) folder. Blackjack is a repository of its own,
[hookedin/game-blackjack](https://github.com/hookedin/game-blackjack), and so are the two with a server, roulette
([hookedin/game-roulette](https://github.com/hookedin/game-roulette)) and crash
([hookedin/game-crash](https://github.com/hookedin/game-crash)), and the template. Every one of them is complete: start
from the one closest to your game.

| Game                                                       | What it shows                                                                   | Copy                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Game template](https://github.com/hookedin/game-template) | A bridge probe: every wallet method, sent by hand                               | The whole repository: build, tests, deployment                                                   |
| [Dice](../../games/dice/)                                  | The smallest `RoundClient` game: one decision, two outcomes                     | [src/rules.ts](../../games/dice/src/rules.ts), [src/game.ts](../../games/dice/src/game.ts)       |
| [Plinko](../../games/plinko/)                              | One decision of many outcomes, collapsed into one bet per drop                  | [src/tables.ts](../../games/plinko/src/tables.ts), [src/drop.ts](../../games/plinko/src/drop.ts) |
| [Samson's Gold](../../games/samson/)                       | A 243-ways slot whose odds are counted exactly from its reels                   | [src/math.ts](../../games/samson/src/math.ts)                                                    |
| [Mines](../../games/mines/)                                | Reveal or cash out: the simplest multi-step graph                               | [src/rules.ts](../../games/mines/src/rules.ts)                                                   |
| [Blackjack](https://github.com/hookedin/game-blackjack)    | A multi-step game with doubles, splits and insurance, and precomputed prices    | The whole repository: rules, prices, page, tests, deployment                                     |
| [Roulette](https://github.com/hookedin/game-roulette)      | Many players' developer bets on one spin, backed by the wheel's casino bets     | The whole repository: page, server, tests, deployment                                            |
| [Crash](https://github.com/hookedin/game-crash)            | Many players on one flight, each a developer bet paid from the developer's bank | The whole repository: page, server, tests, deployment                                            |

## Game template

[hookedin/game-template](https://github.com/hookedin/game-template) is where a game of your own starts
([quick start](quick-start.md)). Its page is the bridge probe: presets for every method, a request you can edit, and
every reply and event printed as it arrives. Its tests place real casino and developer bets through the real wallet,
and its workflow deploys the game ([publishing](publishing.md)). Keep the probe in a branch once you replace it: it
reproduces any wallet reply you did not expect.

## Dice

One decision with two outcomes: a win chance from 10% to 90% and a payout of 99% divided by it.
[src/rules.ts](../../games/dice/src/rules.ts) is the whole graph, and [src/game.ts](../../games/dice/src/game.ts) the
page around `RoundClient`, including the startup that restores a roll whose reply was lost. The roll shown is the
verified outcome against the signed chance. Copy it for a game of one decision and two outcomes.

## Plinko

One drop is a decision whose outcomes are the buckets, each at its binomial odds.
[src/tables.ts](../../games/plinko/src/tables.ts) is pure arithmetic: `dropGraph` builds the graph, and `path` draws the
ball's path into its bucket. [src/drop.ts](../../games/plinko/src/drop.ts) plays each drop through `RoundClient`, which
collapses the board into bets between two of its multipliers and draws one in the page; a drop saved before a reload
lands after it, once. Its [test](../../games/plinko/test/plinko.test.ts) proves every board's return, that the casino
takes every bet the page can draw, and the floor those bets pay back at stakes from 1,000 wei to 10^18. Copy it for a
one-shot game of many outcomes.

## Samson's Gold

A five-reel slot whose outcome distribution is counted exactly from its reel strips, then played through `RoundClient`
as at most one bet per spin: the whole stake against one pay, drawn in the page so that spins reach every pay exactly as
often as the reels do. [src/math.ts](../../games/samson/src/math.ts) holds the strips, the paytable, the exact counter
and `sampleStops`, which picks reel stops from the settled result, among exactly the stops that pay what was settled.
Its bonus spins are prepaid bets, applied once by the round's `id`, and its sound is synthesized with `createSynth`.
Copy it for a game with many outcomes and presentation drawn from the result.

## Mines

A five-by-five board with 1 to 24 mines, and a cash-out after any gem at 99% of fair odds. The rules are
`createMines` from the SDK ([src/rules.ts](../../games/mines/src/rules.ts)), built from the stake, the mines and how
many picks the casino covers at that stake; each reveal is one bet at the exact remaining odds, and `cash-out` places no
bet. Copy it for a game where the player decides when to stop; for other rules, copy
[mines.ts](../../sdk/src/engine/mines.ts) from the SDK and pass your own graph.

## Blackjack

Hit, stand, double, split and insurance from an unlimited deck, each step at most one bet.
[src/rules.ts](https://github.com/hookedin/game-blackjack/blob/main/src/rules.ts) builds the graph with
`createBlackjack`, and [src/funding.ts](https://github.com/hookedin/game-blackjack/blob/main/src/funding.ts), which
`npm run generate` writes, prices it without compiling 14,065 states in the browser; the cards on screen are rebuilt
from the round's saved labels ([src/view.ts](https://github.com/hookedin/game-blackjack/blob/main/src/view.ts)).
[Sequential games](sequential-games.md) derives its exact edge. It is a repository of its own that tests and deploys
itself: copy it for a game of many decisions with a precomputed table.

## Roulette

One wheel, shared by every player at the table, with ETH: each player's layout is one developer bet, and the wheel backs
them all with its own casino bets, one binary step per round down a tree of the 37 pockets.
[src/table.ts](https://github.com/hookedin/game-roulette/blob/main/src/table.ts) turns chips into what each pocket pays
and is shared by page and server; [server/wheel.ts](https://github.com/hookedin/game-roulette/blob/main/server/wheel.ts)
is the developer, and [server/worker.ts](https://github.com/hookedin/game-roulette/blob/main/server/worker.ts) the
Worker and its Durable Object. Its repository is a GitHub template that tests and deploys itself: start from it with
**Use this template** for any game where many players share one outcome ([developer bets](developer-bets.md)).

## Crash

One rocket for every player, with ETH: each seat is a developer bet, and the room pays each escape from the developer's
bank on its own word. A flight's ID is the hash of a secret the room reveals after the crash, so every crash point can
be checked against the ID the seats signed.
[src/rules.ts](https://github.com/hookedin/game-crash/blob/main/src/rules.ts) is the crash curve and the check, shared
by page and server; [server/room.ts](https://github.com/hookedin/game-crash/blob/main/server/room.ts) is the developer,
which saves every escape before it answers, and
[server/worker.ts](https://github.com/hookedin/game-crash/blob/main/server/worker.ts) the Worker and its Durable Object.
Copy it for a game whose players act on a shared outcome as it unfolds.

## Running a house game

From play's root, with Node 24.4 or later:

```sh
npm ci
node sdk/bin/hookedin-game.js serve games/dice
```

Then, in the wallet, choose **Open a game by its URL** and open `http://127.0.0.1:4185/`. To make one your own, start a
repository from the template and copy the game's `src/` and `test/` over it. Blackjack, and roulette and crash with
their servers, run in their own repositories ([blackjack](https://github.com/hookedin/game-blackjack#run-it),
[roulette](https://github.com/hookedin/game-roulette#run-it), [crash](https://github.com/hookedin/game-crash#try-it-locally)).
