---
title: Games and limits
description: The game library, how a game opens, the spending limit you give it, and what a game can see.
sidebar:
  order: 2
---

Every game is a site of its own, known by its URL and run in a sandboxed frame inside the wallet. A game spends only
the ETH you allow it in the wallet's own dialog, and learns almost nothing about you.

## The library

The library at `/` lists the games `@hookedin` publishes and the games your own account publishes. Each is a square
tile, the game's [icon](../reference/game-url.md#the-icon), or the first letter of its name when it has none, above the
name it is published under, and **Every bet** on it opens the game's public record
([a game's public record](bets-and-receipts.md#a-games-public-record)).

**Open a game by its URL**, below the tiles, opens any game by the URL of its page: enter it and choose **Open**.

## Opening a game

| URL                       | Opens                                               |
| ------------------------- | --------------------------------------------------- |
| `/@alias/game`            | The game published as `game` by the player `@alias` |
| `/~uname/game`            | The same, for a player named by their uname         |
| `/games/custom?url=<url>` | The game whose page is at `<url>`, as nobody's game |

For a published game, the wallet asks the casino which URL the profile records
([`GET /api/players/:name/:game`](../casino-api/public.md#get-apiplayersnamegame)) and frames that page; the account
that published it is its developer, and the wallet calls it by the name it is published under. The wallet refuses a
URL that is not `http:` or `https:`, carries a user name or password, or is on the wallet's own origin.
[The game URL reference](../reference/game-url.md) has every rule.

A game opened by its URL alone is published by nobody, and the wallet calls it by its host: no developer earns its
commission, the house keeps all of it, and it takes no developer bets. Its key is made from the zero address and its
URL, which no published game can share.

An open game has the page under the top bar, below a strip that says whether it practices or plays with ETH
([practice or ETH](getting-started.md#practice-or-eth)), and **Games** in the top bar leads back to the library. While
it loads, the wallet shows its icon. In practice a game plays at once; with ETH it starts with a limit of zero, and its
bets fail until it is given money.

## Giving a game money

A game gets ETH only through the wallet's own dialog, **Play … with ETH**, or **Change …'s limit** once it holds some.
The dialog opens when the game asks, suggesting an amount and nothing else, or when you press **Set a limit** or
**Change limit** in the strip above the game. Every word in it is the wallet's own.

The dialog names who publishes the game and the host it is served from, and says that its developer earns half of each
casino bet's commission and takes and settles its developer bets, or that nobody publishes it. Under
**It may play with up to**, set the limit with the number field or the slider, which runs from nothing to your whole
balance in hundredths. The confirm button reads **Allow** an amount when you raise the limit and **Take back** an amount
when you lower it; **Take it all back** fills in zero, and **Not now** leaves the limit as it is. The game is told what
you decided. **How a game limit works**, folded below, explains the limit, and **Deposit more** opens the wallet's
Deposit tab ([deposit](getting-started.md#deposit)).

The limit caps what the game may risk; it moves no money:

- The money stays in your balance. The limit is the most the game may put at risk, out of what your balance has taken
  in: a deposit still arriving cannot raise it.
- It lives only in this tab's memory. Leaving the game, reloading or closing the tab releases it, and the game asks
  again next time. The wallet remembers the last limit you chose for a game in this browser, only as the next
  suggestion.
- Every verified result of the game's own operations moves it: a win raises it and a loss lowers it. A game can lose
  everything it holds, its winnings included, and not a wei more.
- It signs nothing, so you can change it while an operation is pending, up to your balance less what that operation
  has already committed.

A game that [practices](getting-started.md#practice) has no limit and no dialog: it plays with all of your play money,
and gets more at once when it asks. Before a game holds any ETH, the dialog offers **Practice with play money instead**.

## One game with ETH at a time

One game per account holds a limit at a time, across every tab of the browser. Once you have given a game money, a game
in another tab is refused at the dialog until you leave the first game or close its tab. Play money is each tab's own,
so practice is not held to this.

## What a game sees

A game learns:

- what the wallet offers and what it plays with: the methods, whether it practices, the money's symbol and decimals, the
  chain ID and the protocol's limits on a bet ([`wallet.hello`](../reference/bridge.md#wallethello));
- your uname and alias, the bankroll figure the casino reports and a suggested stake
  ([`wallet.info`](../reference/bridge.md#walletinfo));
- its own limit, or in practice your play money, and whether one of its operations is pending
  ([`game.balance`](../reference/bridge.md#gamebalance));
- the receipts of its own operations, under its own IDs;
- a developer's round, as the casino shows it to anyone ([`wallet.round`](../reference/bridge.md#walletround)).

A game never sees your address, your channels, your balances, your keys or the wallet's storage, nor the secret of your
round or the wallet's seed before the result. It cannot ask for any signature but its own bets and payments, cannot
spend beyond its limit, and cannot choose who earns its commission. The frame runs with
`sandbox="allow-scripts allow-same-origin"`, no referrer, and no camera, microphone, geolocation, clipboard, payment or
fullscreen, and the wallet answers only the origin of the game's page. A game keeps its own state at its own
origin. [The bridge reference](../reference/bridge.md) has every method.

## What a game does with its limit

A game spends its limit through three requests, and the wallet signs each one whole:

- a **casino bet**: a stake, a chance and a prize, settled at once against the bankroll;
- a **developer bet**: a stake and the game's own `meta`, whose stake goes into the developer's bank at once; only a
  published game takes them;
- a **payment**: a fixed amount to the bankroll.

The wallet computes each casino bet's exact return before it signs and records it, and does not refuse a bet for paying
back little: a game can spend its whole limit on poor bets. The limit you set bounds that, and your
[bet history](bets-and-receipts.md) shows what each game really paid back.

## The developer log

Opening the wallet with `?log` in its URL, such as `/@hookedin/dice?log`, adds a live log below the game: every bridge
request and reply with its round-trip time, the wallet's own actions, and the balance pushed to the game, newest first.
A request is summed up in one line: a casino bet's stake, its prize, its chance and its exact return, or the amount a
request for money suggests. Filters show all events, bridge traffic, wallet events or errors, and the search covers
payloads. **Export JSON** downloads the entries with their payloads whole.

The log keeps the latest 500 entries of this session and shows payloads up to 70,000 characters; **Clear**, or opening
another game, empties it. It does not see inside the game's frame.
