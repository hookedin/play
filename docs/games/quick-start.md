---
title: Quick start
description: Run the game template on your machine, open it in the wallet by its URL, place a first bet, and find the house game closest to yours.
sidebar:
  order: 1
---

A HookedIn game is a static web page that the wallet frames, known by its URL. This page takes you from the game
template to a settled bet: you run the template's bridge probe on your machine and play it from the public wallet.

## What you need

- Node 24.4 or later.
- A HookedIn wallet with a balance: open [play.hookedin.com](https://play.hookedin.com) and deposit Sepolia ETH, free
  from a faucet ([getting started](../wallet/getting-started.md#deposit)).

## Create the game

On GitHub, choose **Use this template** on [hookedin/game-template](https://github.com/hookedin/game-template), or
clone it:

```sh
git clone https://github.com/hookedin/game-template my-game
cd my-game
npm install
```

The template depends on `@hookedin/play` at its `main` branch ([packages and imports](../sdk/index.md)). `src/` is the
game: `index.html`, `style.css`, [`icon.svg`](publishing.md#the-icon) and `game.ts`, here the probe. `test/` places
casino and developer bets through the real wallet ([testing](testing.md)), and the workflow deploys the game
([publishing](publishing.md)). There is nothing to configure: the account that publishes the game is its developer.

## Run it

```sh
npm run dev
```

This runs [`hookedin-game serve`](publishing.md#build): it builds `src/` into `dist/`, serves it at
`http://127.0.0.1:4185/` and builds again on every page load, so a change shows on reload. `PORT` moves it.

## Open it in the wallet

1. Open [play.hookedin.com](https://play.hookedin.com) and go to **Games**.
2. Choose **Open a game by its URL**, enter `http://127.0.0.1:4185/` and choose **Open**.

The wallet frames the page from your machine in a sandbox and connects the bridge, and the probe prints the replies to
`wallet.hello` and `wallet.info` as it starts. A game served from your machine plays against the public wallet and
casino, because your browser loads both. Developer bets need the game [published](publishing.md#publish-it) and opened
at its name.

## Place a first bet

1. Press **Set allowance** in the wallet's top bar: the wallet's own dialog asks how much the game may play with. The
   **game.allowance** preset prints what the game may now stake.
2. Press **game.casinoBet · 50% to double**, then **Send**. The bet pays twice the stake on half the outcomes, which
   leaves the casino no edge, so it declines it: the receipt says `"status": "rejected"`, and the balance is unchanged.
3. Press the preset again, for a fresh operation ID. In the request, change `prize` to `"1900000000000"`, 1.9 times
   the stake, and press **Send**. The casino takes this bet:

```json title="Reply"
{
  "id": "probe-1790380800000",
  "kind": "casino-bet",
  "status": "settled",
  "stake": "1000000000000",
  "chance": "9223372036854775808",
  "prize": "1900000000000",
  "outcome": "3878210764775671129",
  "payout": "1900000000000"
}
```

`chance` is how many of the 2^64 outcomes win, here half of them. `outcome` is the round's 64-bit value, which the
wallet checked against the round it signed; it is below the chance, so the prize paid. Send the same request again and
the wallet returns the same receipt: an operation ID names one operation. Send other terms under the same ID and it
refuses them with `id-conflict`.

Replace the probe with your game in `src/`, and keep the probe in a branch: it is the quickest way to reproduce a wallet
reply you did not expect.

## The house games

The house's games are what `@hookedin` publishes, each with its README, its tests and its deployment. Start from the
one closest to your game.

| Game                                                    | What it shows                                                                   | Copy                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Dice](../../games/dice/)                               | The smallest `RoundClient` game: one decision, two outcomes                     | [src/rules.ts](../../games/dice/src/rules.ts), [src/game.ts](../../games/dice/src/game.ts)       |
| [Plinko](../../games/plinko/)                           | One decision of many outcomes, collapsed into one bet per drop                  | [src/tables.ts](../../games/plinko/src/tables.ts), [src/drop.ts](../../games/plinko/src/drop.ts) |
| [Samson](../../games/samson/)                           | A 243-ways slot whose odds are counted exactly from its reels                   | [src/math.ts](../../games/samson/src/math.ts)                                                    |
| [Mines](../../games/mines/)                             | Reveal or cash out: the simplest multi-step graph                               | [src/rules.ts](../../games/mines/src/rules.ts)                                                   |
| [Blackjack](https://github.com/hookedin/game-blackjack) | Doubles, splits and insurance, with precomputed prices                          | The whole repository                                                                             |
| [Roulette](https://github.com/hookedin/game-roulette)   | Many players' developer bets on one spin, backed by the wheel's casino bets     | The whole repository                                                                             |
| [Crash](https://github.com/hookedin/game-crash)         | Many players on one flight, each a developer bet paid from the developer's bank | The whole repository                                                                             |

The four static games live in play's [games/](../../games/) folder. From play's root, after `npm ci`,
`node sdk/bin/hookedin-game.js serve games/<id>` serves one at `http://127.0.0.1:4185/`. To make one your own, start a
repository from the template and copy the game's `src/` and `test/` over it. Blackjack, roulette and crash are
repositories of their own, each with its README.
