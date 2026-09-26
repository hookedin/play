---
title: Quick start
description: Run the game template on your machine, open it in the wallet and place a first bet.
sidebar:
  order: 1
---

A HookedIn game is a static web page that the wallet frames. This page takes you from the game template to a settled
bet: you run the template's bridge probe on your machine and play it from the public wallet.

## What you need

- Node 24.4 or later.
- A HookedIn wallet: open [play.hookedin.com](https://play.hookedin.com). A wallet with no deposit plays with test
  coins, which the faucet fills ([getting started](../wallet/getting-started.md)).

## Create the game

On GitHub, choose **Use this template** on [hookedin/game-template](https://github.com/hookedin/game-template), or
clone it:

```sh
git clone https://github.com/hookedin/game-template my-game
cd my-game
npm install
```

The template depends on `@hookedin/play` at its `main` branch ([packages and imports](../sdk/index.md)). It holds:

| File                                   | What it holds                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/manifest.json`                    | What the wallet reads to load the game                                              |
| `src/index.html`                       | The page. It loads `./shared.css`, `./style.css` and `./game.js`                    |
| `src/game.ts`                          | The entry point, bundled to `dist/game.js`. Here, the probe                         |
| `src/style.css`                        | The page's styles, on top of the SDK's `shared.css`                                 |
| `test/`                                | Casino and developer bets through the real wallet ([testing](testing.md))           |
| `wrangler.jsonc`, `.github/workflows/` | Deployment to Cloudflare, and keeping the SDK current ([publishing](publishing.md)) |

## Set the developer

`src/manifest.json` names the game, its page and its developer:

```json
{
  "name": "Bridge probe",
  "description": "A developer tool, not a game: send any bridge request by hand and read the raw reply.",
  "entry": "./index.html",
  "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
}
```

Set `developer` to the address of the account you will publish the game from: the deposit address on the wallet's
**My wallet** page. That account earns the game's [commission](earnings.md) and settles its
[developer bets](developer-bets.md). The build refuses anything but `0x` and 40 hex digits, and the zero address. Every
field is in the [manifest reference](../reference/manifest.md).

## Run it

```sh
npm run dev
```

This runs [`hookedin-game serve`](../reference/cli.md#serve): it builds `src/` into `dist/`, serves it at
`http://127.0.0.1:4185` and builds again on every page load, so a change shows on reload. `PORT` moves it.

## Open it in the wallet

1. Open [play.hookedin.com](https://play.hookedin.com) and go to **Games**.
2. Choose **Add a custom game**, enter `http://127.0.0.1:4185/manifest.json` and choose **Load game**.

The wallet fetches the manifest from your machine, frames `index.html` in a sandbox and connects the bridge. The probe
prints the replies to `wallet.hello` and `wallet.info` as it starts. A game served from your machine plays against the
public wallet and casino, because your browser loads both.

Open the wallet as `https://play.hookedin.com/?log` to see every bridge message below the game
([the developer log](../wallet/games-and-limits.md#the-developer-log)).

## Place a first bet

1. Press **Add funds**. The wallet asks how much the game may play with; choose an amount. The probe prints the
   `game.balance` event that follows.
2. Press **game.casinoBet · 50% to double**, then **Send**. The bet pays twice the stake on half the outcomes, which
   leaves the casino no edge, so it declines it: the receipt says `"status": "rejected"`, and the balance is unchanged.
3. Press the preset again, for a fresh operation ID. In the request, change `payout` to `"1900000000000"`, 1.9 times
   the stake, and press **Send**. The casino takes this bet:

```json title="Reply"
{
  "id": "probe-1790380800000",
  "kind": "casino-bet",
  "status": "settled",
  "stake": "1000000000000",
  "prizes": [{ "rangeStart": "0", "rangeEnd": "9223372036854775808", "payout": "1900000000000" }],
  "outcome": "3878210764775671129",
  "payout": "1900000000000"
}
```

`outcome` is the round's 64-bit value, which the wallet checked against the round it signed; it fell inside the prize's
range, so the prize paid. Send the same request again and the wallet returns the same receipt: an operation ID names
one operation. Send other terms under the same ID and it refuses them with `id-conflict`.

## Next

Replace the probe with your game in `src/`, and keep the probe in a branch: it is the quickest way to reproduce a wallet
reply you did not expect.

- [How a game works](how-a-game-works.md): what the game owns, what the wallet owns, the sandbox and the spending
  limit.
- [Casino bets](casino-bets.md): a one-shot game, the casino's edge and measured return.
- [Multi-step games](multi-step-games.md): decisions, one casino bet per step, with `RoundClient`.
- [State and recovery](state-and-recovery.md): operation IDs, lost replies and reloads.
- [Developer bets](developer-bets.md): a server of your own, and bets against you.
- [Testing](testing.md), [publishing](publishing.md) and [the house games](examples.md).
