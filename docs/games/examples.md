---
title: Examples
description: The six house games and the template, what each shows, and the files to copy.
sidebar:
  order: 12
---

The house's games are what `@hookedin` publishes, each with its README, its tests and a Cloudflare deployment. The five
static ones live in play's [games/](../../games/) folder. Roulette, the one with a server, is a repository of its own,
[hookedin/game-roulette](https://github.com/hookedin/game-roulette), and so is the template. Every one of them is
complete: start from the one closest to your game.

| Game                                                       | What it shows                                                                | Copy                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Game template](https://github.com/hookedin/game-template) | A bridge probe: every wallet method, sent by hand                            | The whole repository: build, tests, deployment                                                     |
| [Dice](../../games/dice/)                                  | The smallest `RoundClient` game: one decision, two outcomes                  | [src/rules.ts](../../games/dice/src/rules.ts), [src/game.ts](../../games/dice/src/game.ts)         |
| [Plinko](../../games/plinko/)                              | A one-shot prize table written by hand, with no round helper                 | [src/tables.ts](../../games/plinko/src/tables.ts), [src/drop.ts](../../games/plinko/src/drop.ts)   |
| [Samson's Gold](../../games/samson/)                       | A 243-ways slot whose prize table is counted exactly from its reels          | [src/math.ts](../../games/samson/src/math.ts)                                                      |
| [Mines](../../games/mines/)                                | Reveal or cash out: the simplest multi-step graph                            | [src/rules.ts](../../games/mines/src/rules.ts)                                                     |
| [Blackjack](../../games/blackjack/)                        | A multi-step game with doubles, splits and insurance, and precomputed prices | [src/game.ts](../../games/blackjack/src/game.ts), [src/view.ts](../../games/blackjack/src/view.ts) |
| [Roulette](https://github.com/hookedin/game-roulette)      | Many players' developer bets on one spin, backed by the wheel's casino bet   | The whole repository: page, server, tests, deployment                                              |

## Game template

[hookedin/game-template](https://github.com/hookedin/game-template) is where a game of your own starts
([quick start](quick-start.md)). Its page is the bridge probe: presets for every method, a request you can edit, and
every reply and event printed as it arrives. Its tests place real casino and developer bets through the real wallet,
and its workflows deploy the game and keep the SDK current ([publishing](publishing.md)). Keep the probe in a branch
once you replace it: it reproduces any wallet reply you did not expect.

## Dice

One decision with two outcomes: a win chance from 10% to 90% and a payout of 99% divided by it.
[src/rules.ts](../../games/dice/src/rules.ts) is the whole graph, and [src/game.ts](../../games/dice/src/game.ts) the
page around `RoundClient`, including the startup that restores a roll whose reply was lost. The roll shown is where the
verified outcome fell in the signed range. Copy it for any game of one decision.

## Plinko

One drop is one casino bet: a prize per bucket, each as wide as its binomial odds, which divide 2^64 exactly.
[src/tables.ts](../../games/plinko/src/tables.ts) is pure arithmetic, with `dropBet` building the bet and `landing`
reading the ball's path back from the outcome. [src/drop.ts](../../games/plinko/src/drop.ts) is the money path without
the round helper: check the table with `admits`, save the drop and its ID, place the bet, recover a lost reply, and
refuse a payout that differs from the board. Its [test](../../games/plinko/test/plinko.test.ts) proves every board's
return from the signed prizes, and its floor at stakes from 1,000 wei to 10^18. Copy it for any one-shot game.

## Samson's Gold

A five-reel slot whose outcome distribution is counted exactly from its reel strips, then played as one bet of up to 64
prizes through `RoundClient`. [src/math.ts](../../games/samson/src/math.ts) holds the strips, the paytable, the exact
counter and `sampleStops`, which picks reel stops from where the verified outcome fell, among exactly the stops that
pay what was settled. Its bonus spins are prepaid bets, applied once by the round's `id`, and its sound is synthesized
with `createSynth`. Copy it for a game with many outcomes and presentation drawn from the outcome.

## Mines

Five tiles, one mine, up to three gems, cash out when you like. The rules are `createMines` from the SDK
([src/rules.ts](../../games/mines/src/rules.ts)); each reveal is one bet at the exact remaining odds, and `cash-out`
places no bet. Copy it for a game where the player decides when to stop; for other rules, copy
[mines.ts](../../sdk/src/engine/mines.ts) from the SDK and pass your own graph.

## Blackjack

Hit, stand, double, split and insurance from an unlimited deck, each card its own bet. `createBlackjack` builds the
graph and `blackjackFunding` prices it without compiling 14,065 states in the browser; the cards on screen are rebuilt
from the round's saved labels ([src/view.ts](../../games/blackjack/src/view.ts)). Its README says how to change the
rules and generate a table of your own. [Sequential games](sequential-games.md) derives its exact edge.

## Roulette

One wheel per asset, shared by every player at the table: each player's layout is one developer bet, and the wheel
backs them all with one casino bet on its own round.
[src/table.ts](https://github.com/hookedin/game-roulette/blob/main/src/table.ts) turns chips into prizes and is shared
by page and server; [server/wheel.ts](https://github.com/hookedin/game-roulette/blob/main/server/wheel.ts) is the
developer, and [server/worker.ts](https://github.com/hookedin/game-roulette/blob/main/server/worker.ts) the Worker and
its Durable Object. Its repository is a GitHub template that tests and deploys itself: start from it with **Use this
template** for any game where many players share one outcome ([developer bets](developer-bets.md)).

## Running a house game

From play's root, with Node 24.4 or later:

```sh
npm ci
node sdk/bin/hookedin-game.js serve games/dice
```

Then add `http://127.0.0.1:4185/manifest.json` as a custom game in the wallet. To make one your own, start a repository
from the template and copy the game's `src/` and `test/` over it, then set `developer` in `src/manifest.json` to your
address. Roulette runs with its server under `npm run dev` in its own repository
([its README](https://github.com/hookedin/game-roulette#run-it)).
