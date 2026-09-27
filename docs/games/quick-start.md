---
title: Quick start
description: Run the game template on your machine, open it in the wallet by its URL and place a first bet.
sidebar:
  order: 1
---

A HookedIn game is a static web page that the wallet frames, known by its URL. This page takes you from the game
template to a settled bet: you run the template's bridge probe on your machine and play it from the public wallet.

## What you need

- Node 24.4 or later.
- A HookedIn wallet: open [play.hookedin.com](https://play.hookedin.com). A wallet with no deposit practices with play
  money of its own, which settles casino bets and payments but no developer bets
  ([getting started](../wallet/getting-started.md#practice)).

## Create the game

On GitHub, choose **Use this template** on [hookedin/game-template](https://github.com/hookedin/game-template), or
clone it:

```sh
git clone https://github.com/hookedin/game-template my-game
cd my-game
npm install
```

The template depends on `@hookedin/play` at its `main` branch ([packages and imports](../sdk/index.md)). It holds:

| File                                   | What it holds                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/index.html`                       | The page. It loads `./shared.css`, `./style.css` and `./game.js`                                                  |
| `src/game.ts`                          | The entry point, bundled to `dist/game.js`. Here, the probe                                                       |
| `src/style.css`                        | The page's styles, on top of the SDK's `shared.css`                                                               |
| `src/icon.svg`                         | The icon the wallet shows the game by: a square SVG of one symbol ([the icon](../reference/game-url.md#the-icon)) |
| `test/`                                | Casino and developer bets through the real wallet ([testing](testing.md))                                         |
| `wrangler.jsonc`, `.github/workflows/` | Deployment to Cloudflare ([publishing](publishing.md))                                                            |

There is nothing to configure: a game is its [URL](../reference/game-url.md), and the account that publishes it is its
developer, which earns its [commission](earnings.md) and settles its [developer bets](developer-bets.md).

## Run it

```sh
npm run dev
```

This runs [`hookedin-game serve`](../reference/cli.md#serve): it builds `src/` into `dist/`, serves it at
`http://127.0.0.1:4185/` and builds again on every page load, so a change shows on reload. `PORT` moves it.

## Open it in the wallet

1. Open [play.hookedin.com](https://play.hookedin.com) and go to **Games**.
2. Choose **Open a game by URL**, enter `http://127.0.0.1:4185/` as the **Game URL** and choose **Open game**.

The wallet frames the page from your machine in a sandbox and connects the bridge. The probe prints the replies to
`wallet.hello` and `wallet.info` as it starts. A game served from your machine plays against the public wallet and
casino, because your browser loads both. A game opened by its URL alone is published by nobody, so it takes no
developer bets: those need the game [published](publishing.md) and opened at its name.

Open the wallet as `https://play.hookedin.com/?log` to see every bridge message below the game
([the developer log](../wallet/games-and-limits.md#the-developer-log)).

## Place a first bet

1. With ETH, press **Add funds**: the wallet's own dialog asks how much the game may play with, and the probe prints
   the `game.balance` event that follows. A wallet that practices needs no funds: the game plays with its play money.
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

## Next

Replace the probe with your game in `src/`, and keep the probe in a branch: it is the quickest way to reproduce a wallet
reply you did not expect.

- [How a game works](how-a-game-works.md): what the game owns, what the wallet owns, the sandbox and the spending
  limit.
- [Casino bets](casino-bets.md): a one-shot game, the casino's edge and measured return.
- [Multi-step games](multi-step-games.md): decisions, at most one casino bet per step, with `RoundClient`.
- [State and recovery](state-and-recovery.md): operation IDs, lost replies and reloads.
- [Developer bets](developer-bets.md): a server of your own, and bets against you.
- [Testing](testing.md), [publishing](publishing.md) and [the house games](examples.md).
