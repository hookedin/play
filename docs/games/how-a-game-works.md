---
title: How a game works
description: What a game owns and what the wallet owns, the manifest, the sandbox, the spending limit and the bridge.
sidebar:
  order: 2
---

A game is a static web page on its own host. The wallet frames it in a sandbox, and the two talk through `postMessage`.
The game asks for bets; the wallet signs each one, sends it to the casino and checks the result before the game hears
of it.

## Who does what

| The game                                              | The wallet                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Its rules, its bets and presentation                  | The player's keys and signed channel balance                                                                        |
| Its own saved state, at its own origin                | Checking each bet against the game's spending limit, and signing it whole                                           |
| An ID for each operation, saved before it asks        | Sending the bet to the casino and verifying the result: signatures, the round's secret and seed, the balance change |
| What the player sees, drawn from the verified outcome | Keeping the evidence, and settling on-chain                                                                         |

The casino admits each casino bet against its bankroll and signs each result; it never runs a game's rules
([how it works](../overview/how-it-works.md)). A game never sees a key and signs nothing. It cannot ask for arbitrary
signatures, supply a bet's seed, see a round's secret before the reveal, or choose who earns its commission.

## The manifest

The wallet loads a game from its manifest: a JSON file on the game's host naming the page to frame and the account
that publishes the game.

```json
{
  "name": "Coin flip",
  "description": "Heads doubles your stake.",
  "entry": "./index.html",
  "developer": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
}
```

`developer` is the account you publish the game from. It earns the game's [commission](earnings.md), its bank takes
the stakes of the game's [developer bets](developer-bets.md), and its key settles them. There is no field for what a
game pays back: a player's return is [measured](casino-bets.md#measured-return) from the bets themselves. Every rule is
in the [manifest reference](../reference/manifest.md).

## The sandbox

The wallet frames the entry page with `sandbox="allow-scripts allow-same-origin"`, `referrerpolicy="no-referrer"` and a
permissions policy that turns off the camera, microphone, geolocation, clipboard, payment and fullscreen. The page
keeps its own origin, so its `localStorage`, IndexedDB and cookies are its own.

A game can run scripts, use its origin's storage, fetch from its origin and post messages to the wallet. It cannot
reach the wallet's page, storage or keys, or a browser wallet extension; navigate the top window, open popups, submit
forms, show `alert` or `confirm` dialogs, or start downloads. The wallet refuses a manifest or entry page on its own
origin, and its host forbids framing its pages.

The build writes a Content-Security-Policy into the game's [`_headers`](../reference/cli.md#the-_headers-file) that
keeps the page to its own origin: scripts, styles, fonts, workers and requests from there only, and images from there
or as `data:` URLs. So there are no inline `<script>` or `<style>` elements, no scripts from a CDN and no third-party
requests: bundle what you need, and run a server on the page's own origin
([one Worker](developer-bets.md#one-cloudflare-worker)). The policy is the game's own. What the wallet needs is CORS on
the manifest, which it fetches from another origin.

## The spending limit

A game never learns the player's balance. It gets a spending limit for the open tab: what the player lets it risk, plus
its verified winnings.

- The wallet's own dialog is the only grant. A game asks with `HookedIn.requestFunds({ amount })`, where `amount` is how
  much more it suggests; every word in the dialog is the wallet's. The reply says whether the player set a limit
  (`funded`), the limit they chose (`amount`), and the resulting `balance` and `pending`.
- The wallet pushes `game.balance` with `{ balance, pending }` when the page loads and whenever either changes.
  `HookedIn.onBalance` hears it, and `HookedIn.balance()` resolves to the latest.
- Every bet and payment must fit the limit. Verified winnings raise it; stakes and payments lower it.
- The player can raise, lower or take back the limit from the wallet's top bar at any time.
- Leaving the game, reloading or closing the tab releases the limit. The money never left the channel.
- One game per wallet holds a limit at a time, across tabs.
- `pending: true` means the wallet holds a signed operation that has not resolved, and takes no other bet or payment
  until it does ([lost replies](state-and-recovery.md#lost-replies)).
- With no open channel the balance is zero, bets fail with `no-channel`, and `requestFunds` replies `funded: false`
  after the wallet has offered the player a channel. Render normally and ask again later.

[`mountBank`](../sdk/bank-and-synth.md#mountbank) draws the limit as the balance strip the house games show, with an
**Add funds** button.

## The bridge

The page posts `{ hookedin: true, id, method, params }` to its parent window; the wallet answers the entry page's
origin, and only it, with `{ hookedin: true, id, result }` or `{ hookedin: true, id, error: { code, message } }`.
`wallet.hello`, `wallet.info` and `game.receipt` are answered at once. Anything that signs or asks the player waits its
turn, in the order asked, up to 32 at a time. The [`HookedIn`](../sdk/hookedin.md#hookedin) object wraps all of it: a
typed method per call, and a `HookedInError` with a stable `code` for every refusal. The seven methods are
[`wallet.hello`](../reference/bridge.md#wallethello), [`wallet.info`](../reference/bridge.md#walletinfo),
[`game.receipt`](../reference/bridge.md#gamereceipt), [`game.casinoBet`](../reference/bridge.md#gamecasinobet),
[`game.developerBet`](../reference/bridge.md#gamedeveloperbet), [`game.payment`](../reference/bridge.md#gamepayment)
and [`game.requestFunds`](../reference/bridge.md#gamerequestfunds); the [bridge reference](../reference/bridge.md) has
every field, reply and error.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

HookedIn.onBalance(({ balance, pending }) => render(balance, pending)); // your page's own render
const hello = await HookedIn.hello(); // the methods, the asset and the limits a bet is held to
const info = await HookedIn.info(); // the player's names, the bankroll, a recommended stake
```

`HookedIn.initializeGame({ stakeInput, assetLabels })` is the read-only startup the house games share: the greeting,
the player, the first balance, the asset's name on the page and the recommended stake in the stake field.

## ETH and test coins

A wallet plays with the network's ETH or with the casino's test coins, which every wallet has and with which nobody wins
or loses anything real. `wallet.hello` names the asset: `id` is `eth` or `test`, `symbol` is what to show, and
`decimals` is 18. Amounts on the bridge are decimal strings of whole smallest units, wei for ETH.
`HookedIn.parseAmount('0.001')` is `'1000000000000000'`; `formatAmount`, `exactAmount` and `stepStake` convert the
other way. A game needs no code of its own for test coins. The player switches in the wallet, which releases the limit
and reloads the game: a limit, a round and saved state belong to one asset.

## What a game learns about the player

`wallet.info` answers `{ uname, alias, chainId, bankroll, recommendedStake }`. The uname, written `~uname`, is the
player's for good; the alias, written `@alias`, is what they are called today, and `null` unless they took one.
`HookedIn.showName(info)` writes either the way the wallet does. Key anything you save by the uname
([storage](state-and-recovery.md#storage)). The player's address, channel and balances never cross the bridge.
`bankroll` is the casino's bankroll as last reported: what to price bets against, not a promise to admit them.

## Three operations

- A [casino bet](casino-bets.md) settles against the bankroll in the request that places it.
- A [developer bet](developer-bets.md) is a bet against you, which your server settles later.
- A [payment](casino-bets.md#payments) is a debit to the bankroll with no outcome.
