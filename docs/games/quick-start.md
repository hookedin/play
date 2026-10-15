---
title: Quick start
description: Run the game template on your machine, open it in the wallet by its URL, place a first bet, and find the house game closest to yours.
sidebar:
  order: 1
---

A HookedIn game is a static web page that the wallet frames, known by its URL. This page takes you from the game
template to a settled bet: you run the template's bridge probe on your machine, try it with pretend money, and play it
from the public wallet.

## What you need

- Node 26 or later.
- To play it with ETH, a HookedIn wallet with a balance: open [play.hookedin.com](https://play.hookedin.com) and deposit
  ETH ([getting started](../wallet/getting-started.md#deposit)).

## Create the game

On GitHub, choose **Use this template** on [hookedin/game-template](https://github.com/hookedin/game-template), or
clone it:

```sh
git clone https://github.com/hookedin/game-template my-game
cd my-game
npm install
npm test
```

`npm test` runs `test/`, which places casino and developer bets through the real wallet against a stub casino held to
its rules ([testing](testing.md)): a first success, with no ETH. The template depends on `@hookedin/play` at its `main`
branch ([packages and imports](../sdk/index.md)), which changes without notice during the
[open beta](../index.md#open-beta). `src/` is the game: `index.html`, `style.css`, [`icon.svg`](publishing.md#the-icon)
and `game.ts`, here the probe. The workflow deploys the game ([publishing](publishing.md)), and `AGENTS.md` tells an AI
coding agent where the docs and examples are and what a game does. There is nothing to configure: the account that
publishes the game is its developer.

## Run it

```sh
npm run dev
```

This runs [`hookedin-game serve`](publishing.md#build): it builds `src/` into `dist/` and serves it at
`http://127.0.0.1:4185/`. Saving a file in `src/` builds it again and reloads the game wherever it is open, in the
wallet too, keeping its allowance. `PORT` moves it.

## Try it with pretend money

Open `http://localhost:4185/`, the local wallet `npm run dev` serves beside the game: it frames the game with a million
pretend METH, and **Allow** in its top bar gives the game an allowance. Its wallet and bridge are the wallet's own, so
the game behaves as it does at play.hookedin.com; its casino is the stand-in `npm test` uses, which settles every bet
by the casino's rules, in the page. It needs no wallet, ETH or network. It takes casino bets and payments, and declines
developer bets, which need the real casino. `wallet.showBet` prints the bet's receipt to the browser's console, and
reloading the local wallet starts it afresh.

## Open it in the wallet

1. Open [play.hookedin.com](https://play.hookedin.com).
2. Choose **Open a game by its URL**, enter `http://127.0.0.1:4185/` and choose **Open**.
3. When your browser asks whether the site may reach your local network, allow it. If you blocked it, change the
   answer in the site's settings and press **Try again**: until then, and while the game's server is stopped, the
   wallet says the game isn't answering.

The wallet frames the page from your machine in a sandbox and connects the bridge, and the probe prints the replies to
`wallet.hello` and `wallet.info` as it starts. A game served from your machine plays against the public wallet and
casino, because your browser loads both. Developer bets need the game [published](publishing.md#publish-it) and opened
at its name.

## Place a first bet

1. Press **Set allowance** in the wallet's top bar and allow the game some METH in the wallet's own dialog: a game
   never asks. The **game.allowance** preset prints what the game may now stake.
2. Press **game.casinoBet · 50% for 1.9×**, then **Send**. The request is a step of two results, `Win` and
   `Nothing`, as likely as each other: one bet, which pays 1.9 times the stake on half the outcomes. The casino takes
   it:

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

The probe shows requests and replies as JSON, every amount a decimal string; on the bridge each is a bigint.
The wallet split the step into one bet: `chance` is how many of the 2^64 outcomes win, here half of them. `outcome` is
the round's 64-bit value, which the wallet checked against the round it signed; it is below the chance, so the prize
paid, and the step landed on `result` 0, `Win`. `draw` is a value the wallet drew after it, for a game to show the
result with. **wallet.showBet · last ID** shows its proof in the wallet. Send the same request again and
the wallet returns the same receipt: an operation ID names one operation. Send other terms under the same ID and it
refuses them with `id-conflict`.

Press the preset again, for a fresh operation ID, change the `Win` result's `cash` to `"2000000000000"`, twice the
stake, and press **Send**. That leaves the casino no edge, so its quote does not cover the bet, and the wallet refuses
it with `not-covered` before signing anything: the balance is unchanged.

Replace the probe with your game in `src/`, and keep the probe in a branch: it is the quickest way to reproduce a wallet
reply you did not expect.

## The house games

The house's games are what `@hookedin` publishes, each with its README, its tests and its deployment. Start from the
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

The four static games come with `@hookedin/play`, in [games/](../../games/). To start from one, put it in place of the
probe, here dice:

```sh
rm -rf src test
cp -r node_modules/@hookedin/play/games/dice/src node_modules/@hookedin/play/games/dice/test .
npm test
npm run dev
```

Its tests pass as they are, and **Reload game** in the menu under the game's name loads it again after a change,
keeping its allowance. Blackjack, roulette and crash are repositories of their own, each with its README.
