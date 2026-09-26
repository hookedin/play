---
title: Games and limits
description: The game library, how a game opens, the spending limit you give it, and what a game can see.
sidebar:
  order: 2
---

Every game is a site of its own, run in a sandboxed frame inside the wallet. A game spends only what you allow it in
the wallet's own dialog, and learns almost nothing about you.

## The library

The library at `/` lists the games `@hookedin` publishes and the games your own account publishes. Each card is read
from the game's manifest, and **Every bet** on it opens the game's public record
([a game's public record](bets-and-receipts.md#a-games-public-record)). The library reads at most 32 games of each
profile; the rest stay reachable at their own URL.

**Add a custom game** opens any game by the URL of its manifest.

## Opening a game

| URL                            | Opens                                                   |
| ------------------------------ | ------------------------------------------------------- |
| `/@alias/game`                 | The game published as `game` by the player `@alias`     |
| `/~uname/game`                 | The same, for a player named by their uname             |
| `/games/custom?manifest=<url>` | The game whose manifest is at `<url>`, published or not |

For a published game, the wallet asks the casino which manifest the profile names
([`GET /api/players/:name/:game`](../casino-api/public.md#get-apiplayersnamegame)), fetches it, and refuses the game if
the manifest names another developer than the account that published it. Every manifest must answer within 12 seconds,
fit in 16 KiB, allow cross-origin reads, and name the game's entry page and its developer, and neither the manifest nor
the entry page may be served from the wallet's own origin. [The manifest reference](../reference/manifest.md) has every
rule.

A game opened straight from its manifest is published by nobody: no developer earns its commission, and it takes no
developer bets. Its key is made from its manifest's developer and URL, which no published game can share.

An open game has the whole page under the top bar, and **Games** in the top bar leads back to the library. A game loads
without an open channel: it sees a limit of zero, and its bets fail until you give it money.

## Giving a game money

A game gets money only through the wallet's spending-limit dialog. The dialog opens when the game asks, suggesting an
amount and nothing else, or when you press **Give this game money** or **Take money back** in the top bar. Every word
in it is the wallet's own.

The dialog names the game, the host it is served from, and the developer who earns half of each casino bet's commission
and settles its developer bets. It shows three figures:

| Figure               | Meaning                                                       |
| -------------------- | ------------------------------------------------------------- |
| It holds now         | The game's limit as it stands                                 |
| It would hold        | The limit you are setting                                     |
| Stays in your wallet | Your playing balance less that limit, out of the game's reach |

Set the limit with the number field or the slider, which runs from nothing to your whole playing balance in hundredths.
The confirm button reads **Allow up to** an amount when you raise the limit and **Take back** an amount when you lower
it; **Take it all back** sets the limit to zero, and **Not now** leaves it as it is. The game is told what you decided.

The limit caps what the game may risk; it moves no money:

- The money stays in your channel. The limit is the most the game may put at risk.
- It lives only in this tab's memory. Leaving the game, reloading or closing the tab releases it, and the game asks
  again next time. The wallet remembers the last limit you chose for a game in this browser, only as the next
  suggestion.
- Every verified result of the game's own operations moves it: a win raises it and a loss lowers it. A game can lose
  everything it holds, its winnings included, and not a wei more.
- It signs nothing, so you can change it while an operation is pending, up to your balance less what that operation
  has already committed.

If no channel is open for the asset you play with, the dialog offers **Play with test coins** or **Set up my wallet**
instead of an amount.

## One funded game at a time

One game per account holds a limit at a time, across every tab of the browser. Once you have given a game money, a game
in another tab is refused at the dialog until you leave the first game or close its tab. Switching between ETH and TEST
is offered in the dialog while the game holds nothing, and the game then reloads to play with the other asset.

## What a game sees

A game learns:

- what the wallet offers and the asset it plays with: the methods, the asset's symbol and decimals, the chain ID and
  the protocol's limits on a bet ([`wallet.hello`](../reference/bridge.md#wallethello));
- your uname and alias, the bankroll figure the casino reports and a suggested stake
  ([`wallet.info`](../reference/bridge.md#walletinfo));
- its own limit, and whether one of its operations is pending ([`game.balance`](../reference/bridge.md#gamebalance));
- the receipts of its own operations, under its own IDs.

A game never sees your address, your channels, your balances, your keys or the wallet's storage, nor the secret of your
round or the wallet's seed before the result. It cannot ask for any signature but its own bets and payments, cannot
spend beyond its limit, and cannot choose who earns its commission. The frame runs with
`sandbox="allow-scripts allow-same-origin"`, no referrer, and no camera, microphone, geolocation, clipboard, payment or
fullscreen, and the wallet answers only the origin of the game's entry page. A game keeps its own state at its own
origin. [The bridge reference](../reference/bridge.md) has every method.

## What a game does with its limit

A game spends its limit through three requests, and the wallet signs each one whole:

- a **casino bet**: a stake and up to 64 prizes, settled at once against the bankroll;
- a **developer bet**: a stake and the game's own `meta`, whose stake goes into the developer's bank at once; only a
  published game takes them;
- a **payment**: a fixed amount to the bankroll.

The wallet computes each casino bet's exact return before it signs and records it, and does not refuse a bet for paying
back little: a game can spend its whole limit on poor bets. The limit you set bounds that, and your
[bet history](bets-and-receipts.md) shows what each game really paid back.

## The developer log

Opening the wallet with `?log` in its URL, such as `/@hookedin/dice?log`, adds a live log below the game: every bridge
request and reply with its round-trip time, the wallet's own actions, and the balance pushed to the game, newest first.
A request is summed up in one line: a casino bet's stake, how many prizes it has, the most they can pay together and its
exact return, or the amount a request for money suggests. Filters show all events, bridge traffic, wallet events or
errors, and the search covers payloads. **Export JSON** downloads the entries with their payloads whole.

The log keeps the latest 500 entries of this session and shows payloads up to 70,000 characters; **Clear**, or opening
another game, empties it. It does not see inside the game's frame.
