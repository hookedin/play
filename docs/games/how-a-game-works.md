---
title: How a game works
description: What a game owns and what the wallet owns, the sandbox, the allowance, the bridge, and how a game keeps every operation to exactly once across lost replies, reloads and tabs.
sidebar:
  order: 2
---

A game is a static web page on its own host, known by [its URL](publishing.md#the-games-url). The wallet frames it in a
sandbox, and the two talk through `postMessage`. The game asks for bets; the wallet signs each one, sends it to the
casino and checks the result before the game hears of it. The wallet keeps no state for a game: a game saves its own at
its origin and names every operation, so that each happens exactly once whatever is lost on the way.

## Who does what

| The game                                              | The wallet                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Its rules, its bets and presentation                  | The player's key and signed channel balance                                                                         |
| Its own saved state, at its own origin                | Checking each bet against the game's allowance, and signing it whole                                                |
| An ID for each operation, saved before it asks        | Sending the bet to the casino and verifying the result: signatures, the round's secret and seed, the balance change |
| What the player sees, drawn from the verified outcome | Keeping the evidence, and settling on-chain                                                                         |

The casino admits each casino bet against its quote's virtual bankroll and signs each result; it never runs a game's
rules ([how it works](../overview/how-it-works.md)). A game never sees a key and signs nothing. It cannot ask for arbitrary
signatures, supply a bet's seed, see a round's secret before the reveal, or choose who earns its commission.

## The sandbox

The wallet frames the page with `sandbox="allow-scripts allow-same-origin"`, `referrerpolicy="no-referrer"` and a
permissions policy that turns off the camera, microphone, geolocation, clipboard, payment and fullscreen. The page
keeps its own origin, so its `localStorage`, IndexedDB and cookies are its own.

A game can run scripts, use its origin's storage, fetch from its origin and post messages to the wallet. It cannot
reach the wallet's page, storage or keys, or a browser wallet extension; navigate the top window, open popups, submit
forms, show `alert` or `confirm` dialogs, or start downloads. The wallet refuses a game on its own origin, and its host
forbids framing its pages.

The build's [`_headers`](publishing.md#the-_headers-file) keep the page to its own origin: no inline `<script>` or
`<style>`, no scripts from a CDN and no third-party requests. Bundle what you need, and run a server on the page's own
origin ([one Worker](developer-bets.md#one-cloudflare-worker)).

## The allowance

A game never learns the player's balance. It gets an allowance for the open tab: what the player lets it risk, plus its
verified winnings.

- A game starts with an allowance of zero, and the wallet's own dialog is the only grant. It asks with
  `HookedIn.requestAllowance({ amount })`, where `amount` is how much more it suggests; every word in the dialog is the
  wallet's. The reply says whether the player set an allowance (`allowed`), and the resulting `allowance`, `pending`
  and `developerBets`. When the player's balance has nothing to allow, the wallet opens its Deposit tab instead, and
  the reply says `allowed: false`.
- Developer bets are allowed apart: the dialog warns that the game's developer takes their stakes and decides what
  they pay, and only a request with `developerBets: true` asks for them. Casino bets need no more than the allowance,
  since the wallet checks their odds and their results itself.
- `HookedIn.allowance()` reads it. Every bet and payment must fit it. Stakes and payments lower it as they are made;
  verified winnings raise it, a group's once the game has ended the group.
- The wallet's top bar names the game, by the name it is published under, and shows its allowance in place of the
  player's balance. The player opens the dialog from there to change the allowance or take it all back. A page shows
  no header, allowance or balance of its own: only the game.
- Leaving the game, reloading or closing the tab releases the allowance. The money never left the player's balance.
- One game per wallet holds an allowance at a time, across tabs.
- `pending: true` means the wallet holds a signed operation that has not resolved, and takes no other bet or payment
  until it does ([lost replies](#lost-replies)).

### Groups

The figure in the top bar must not give a result away before the page shows it, nor move while a round is played. So
what a bet in a group wins stays with its group, out of the allowance and balance the player sees, until the page
calls [`HookedIn.end(group)`](../sdk/hookedin.md#end); only the group's own bets stake it meanwhile. Give every bet a
group, and end it once the result is on the page: when the ball lands, the reels stop or the round is over.
`RoundClient` puts each step in its round's group; end it with `HookedIn.end(state.id)`. A multi-step round then moves
the figure twice: down by the stake on its first step, and up by what it paid when it ends
([groups](../reference/bridge.md#groups-and-the-allowance-the-player-sees)).

## The bridge

The page posts `{ hookedin: true, id, method, params }` to its parent window; the wallet answers the page's origin,
and only it, with `{ hookedin: true, id, result }` or `{ hookedin: true, id, error: { code, message } }`. Questions are
answered at once; anything that signs or asks the player waits its turn, in the order asked, up to 32 at a time.
[`HookedIn`](../sdk/hookedin.md#hookedin) wraps all of it, with a typed method per request and a `HookedInError` for
every refusal: act on its `code`, show its `message`. The [bridge reference](../reference/bridge.md) has every method,
field, reply and [error](../reference/bridge.md#errors).

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

const info = await HookedIn.info(); // the player's names, the virtual bankroll, a recommended stake
const { allowance, pending } = await HookedIn.allowance(); // what the game may stake, and whether a bet awaits recovery
```

Amounts on the bridge are decimal strings of whole wei: `HookedIn.parseAmount('0.001')` is `'1000000000000000'`, and
`formatAmount` reads one back. [`wallet.info`](../reference/bridge.md#walletinfo) is all a game learns of the player:
their uname, theirs for good, the alias they go by today, the virtual bankroll of the casino's latest quote and a
recommended stake. The player's address, channel and balances never cross the bridge.

## Operation IDs

Every casino bet, developer bet and payment carries an `id` the game chooses, such as `crypto.randomUUID()`: the game's
durable name for the operation, kept for the player and the game on every channel of the player's. The same `id` with
the same terms returns the operation's receipt, so an operation is placed once however often it is sent; the same `id`
with other terms fails with `id-conflict`.

## Save before you send

Choose the action and its `id`, and save both at your origin, before you ask the wallet; a page that draws which bet to
place saves the bet it drew with them. The wallet saves the signed request before it leaves, so the game's record and
the wallet's meet by `id` after any crash. [A coin flip](casino-bets.md#a-coin-flip) saves `{ id, stake }` under its
storage key and clears it once the receipt arrives.

## Lost replies

A reply can be lost to a reload, a crash, or the SDK's `timeout` after three minutes. A timeout or any other error
proves nothing about the operation. On startup, read what you saved and ask the wallet:

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { flipBet, wire } from './flip.ts';

const key = `${HookedIn.storageScope(await HookedIn.info())}:flip`;
const saved: { id: string; stake: string } | null = JSON.parse(localStorage.getItem(key) ?? 'null');
if (saved) {
  const receipt = await HookedIn.receipt(saved.id);
  if (receipt) {
    localStorage.removeItem(key); // the reply that was lost: apply it once
    show(receipt);
  } else
    offer('Finish your flip', async () => {
      // No receipt in this wallet: the same request, under the same id.
      show(await HookedIn.casinoBet({ id: saved.id, ...wire(flipBet(BigInt(saved.stake))) }));
      localStorage.removeItem(key);
    });
}
```

`show` and `offer` are your page's own.

- **A receipt** is the reply you lost. Apply it exactly once, and clear your record.
- **`null`** means this wallet holds no receipt for the `id`. Send the same request under the same `id`. If the wallet
  still holds it signed, which the pushed `pending: true` shows, it sends that signed request again; if not, it signs
  it. The player can also retry a signed request from the wallet's banner.
- While an operation is pending, the wallet takes no other bet or payment: another `id` fails with
  `pending-operation`.

[`RoundClient`](../sdk/round.md#roundclient) does all of this for a multi-step game.

## Rejections

A receipt with `status: 'rejected'` is a checkpoint the casino signed one step above the operation, which the wallet
checked: the operation is cancelled, with no outcome, no balance change and no commission, and `reason` says why. The
`id` keeps returning that rejection. To try again, send the same terms under a fresh `id`; `RoundClient` keeps the
pending step and the bet it drew, and does so: drawing again would change the game's odds. A declined casino bet's
round is revealed with its rejection ([rejected bets](../wallet/bets-and-receipts.md#rejected-bets)).

## When a wallet has lost receipts

A wallet on another device, or one that lost its browser's data, may not hold the receipt of an operation its player
carried out on another channel. `game.receipt` returns `null` for it, and sending the request again fails with `id-used`: the operation was
carried out, and its result is not in this wallet. Clear your record and tell the player. Do not send it again under
another `id` without asking them.

## Storage

Keep state at your own origin, in `localStorage` or IndexedDB. Key it by page, chain and player, so that games sharing a
host and accounts sharing a browser never read each other's state. `HookedIn.storageScope(info)` builds such a key:

```text
hookedin:<page path>:<chainId>:<uname>
```

It keys on the uname, which is the player's for good; never key by the alias, which the player can change. A player has
no uname until their first deposit, and the wallet then loads the page again. `RoundClient` saves its round under
`hookedin:round:<name>:<chainId>:<uname>`, where `name` is the page's path unless you pass one.

## Reloads and tabs

- A reload releases the allowance. The state at your origin survives, and every settled step's money is in the channel
  balance: a resumed round asks for an allowance again.
- Saved state stays in this browser and does not follow the player to another device; a round left unfinished leaves
  the player the cash it held.
- Two tabs of one game share its origin storage. Read saved state again before every action; `RoundClient` does, and
  its `watch(listener)` reloads the round when another tab writes it. The wallet lets one game per wallet hold an
  allowance at a time and keeps one pending operation per channel, so the money stays consistent whatever the tabs do.
- A game with state beyond one round, such as a slot's bonus counter, applies each finished round once, by the round's
  `id`.
