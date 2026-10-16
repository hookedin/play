---
title: Quick start
description: Run the game template on your machine, open it in the wallet by its URL, place a first bet, and find the house game closest to yours.
sidebar:
  order: 1
---

A HookedIn game is a static web page that the wallet frames, known by its URL. This page takes you from the game
template to a settled bet.

## What you need

Node 26 or later and, to play with ETH, a HookedIn wallet with a balance ([getting
started](../wallet/getting-started.md#deposit)).

## Create the game

On GitHub, choose **Use this template** on [hookedin/game-template](https://github.com/hookedin/game-template), or clone
it:

```sh
git clone https://github.com/hookedin/game-template my-game
cd my-game
npm install
npm test
```

`npm test` places casino and developer bets through the real wallet against a stub casino held to its rules
([testing](testing.md)), with no ETH. `src/` is the game: `index.html`, `style.css`,
[`icon.svg`](publishing.md#the-icon) and `game.ts`, here a bridge probe. The template depends on `@hookedin/play` at its
`main` branch ([packages and imports](../sdk/index.md)), its workflow deploys the game ([publishing](publishing.md)),
and its `AGENTS.md` tells an AI coding agent where the docs and examples are. There is nothing to configure: the account
that publishes the game is its developer.

## Run it

`npm run dev` runs [`hookedin-game serve`](publishing.md#build), which builds `src/` into `dist/` and serves it at
`http://127.0.0.1:4185/` (`PORT` moves it). Saving a file in `src/` builds it again and reloads the game wherever it is
open, in the wallet too, keeping its allowance.

## Try it with pretend money

`http://localhost:4185/` is a local wallet, served beside the game, that frames it with a million pretend METH;
**Allow** in its top bar gives the game an allowance. Its wallet and bridge are the real wallet's, so the game behaves
as it does at play.hookedin.com, and its casino is the stand-in `npm test` uses, in the page: it needs no wallet, ETH or
network. It takes casino bets and payments, and declines developer bets, which need the real casino. `wallet.showBet`
prints the bet's receipt to the browser's console, and reloading starts it afresh.

## Open it in the wallet

1. Open [play.hookedin.com](https://play.hookedin.com).
2. Choose **Open a game by its URL**, enter `http://127.0.0.1:4185/` and choose **Open**.
3. When your browser asks whether the site may reach your local network, allow it. If you blocked it, change the answer
   in the site's settings and press **Try again**.

The wallet frames the page from your machine and connects the bridge, and the probe prints the replies to `wallet.hello`
and `wallet.info`. A game served from your machine plays against the public wallet and casino, because your browser
loads both. Developer bets need the game [published](publishing.md#publish-it) and opened at its name.

## Place a first bet

1. Press **Set allowance** in the wallet's top bar and allow the game some METH. The **game.allowance** preset prints
   what the game may now stake.
2. Press **game.casinoBet · 50% for 1.9×**, then **Send**: a step of two equally likely results, `Win` and `Nothing`,
   which is one bet paying 1.9 times the stake on half the outcomes. The casino takes it:

```json title="Reply"
{
  "id": "probe-1790380800000",
  "kind": "casino-bet",
  "status": "settled",
  "stake": "1000000000000",
  "chance": "9223372036854775808",
  "prize": "1900000000000",
  "result": "0",
  "draw": "14780349465718245980",
  "outcome": "3878210764775671129",
  "payout": "1900000000000"
}
```

The probe shows every amount as a decimal string; on the bridge each is a bigint. `chance` is how many of the 2^64
outcomes win. `outcome`, the round's value, which the wallet checked against the round it signed, is below it, so the
prize paid, and the step landed on `result` 0, `Win`. `draw` is a value the wallet drew after it, for a game to show the
result with. **wallet.showBet · last ID** shows the bet's proof in the wallet. The same request again returns the same
receipt, and other terms under the same ID are refused with `id-conflict`.

Press the preset again for a fresh ID, change the `Win` result's `cash` to `"2000000000000"`, twice the stake, and press
**Send**. That leaves the casino no edge, so its quote does not cover the bet, and the wallet refuses it with
`not-covered` before signing anything.

Replace the probe with your game in `src/`, and keep the probe in a branch: it is the quickest way to reproduce a reply
you did not expect.

## The house games

Each house game has its README, its tests and its deployment, and `@hookedin` publishes all but crash. Start from the
one closest to your game.

| Game                                                    | What it shows                                                               | Copy                                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Dice](../../games/dice/)                               | The smallest `RoundClient` game: one decision, two outcomes                 | [src/rules.ts](../../games/dice/src/rules.ts), [src/game.ts](../../games/dice/src/game.ts)       |
| [Plinko](../../games/plinko/)                           | One decision of many outcomes, collapsed into one bet per drop              | [src/tables.ts](../../games/plinko/src/tables.ts), [src/drop.ts](../../games/plinko/src/drop.ts) |
| [Samson](../../games/samson/)                           | A 243-ways slot whose odds are counted exactly from its reels               | [src/math.ts](../../games/samson/src/math.ts)                                                    |
| [Mines](../../games/mines/)                             | Reveal or cash out: the simplest multi-step graph                           | [src/rules.ts](../../games/mines/src/rules.ts)                                                   |
| [Blackjack](https://github.com/hookedin/game-blackjack) | Doubles, splits and insurance, with precomputed prices                      | The whole repository                                                                             |
| [Roulette](https://github.com/hookedin/game-roulette)   | Many players' developer bets on one spin, backed by the wheel's casino bets | The whole repository                                                                             |
| [Crash](https://github.com/hookedin/game-crash)         | Many players on one flight, each a developer bet paid from the game's bank  | The whole repository                                                                             |

The four static games come with `@hookedin/play`, in [games/](../../games/). To start from one, here dice, put it in
place of the probe; its tests pass as they are:

```sh
rm -rf src test
cp -r node_modules/@hookedin/play/games/dice/src node_modules/@hookedin/play/games/dice/test .
npm test
npm run dev
```
