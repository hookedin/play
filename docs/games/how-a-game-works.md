---
title: How a game works
description: What a game owns and what the wallet owns, the sandbox, the allowance, the bridge, and how a game keeps every operation to exactly once across lost replies and reloads.
sidebar:
  order: 2
---

A game is a static web page on its own host, known by [its URL](publishing.md#the-games-url). The wallet frames it in a
sandbox, and the two talk through `postMessage`: the game asks for bets, and the wallet signs each one, sends it to the
casino and checks the result before the game hears of it. The wallet keeps no state for a game: a game saves its own at
its origin, and names every operation so that each happens exactly once whatever is lost on the way.

## Who does what

| The game                                              | The wallet                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Its rules, its bets and presentation                  | The player's key and signed channel balance                                                                         |
| Its own saved state, at its own origin                | Checking each bet against the game's allowance, and signing it whole                                                |
| An ID for each operation, saved before it asks        | Sending the bet to the casino and verifying the result: signatures, the round's secret and seed, the balance change |
| What the player sees, drawn from the verified outcome | Keeping the evidence, and settling on-chain                                                                         |

The casino never runs a game's rules, and a game never sees a key or signs anything ([what a game can and cannot
do](../overview/trust-model.md#what-a-game-can-and-cannot-do)).

## The sandbox

The wallet frames the page with `sandbox="allow-scripts allow-same-origin"`, `referrerpolicy="no-referrer"` and a
permissions policy that turns off the camera, microphone, geolocation, clipboard, payment and fullscreen. The page keeps
its own origin, so its `localStorage`, IndexedDB and cookies are its own. It can run scripts, use its origin's storage,
fetch from its origin and post messages to the wallet. It cannot reach the wallet's page, storage or keys, or a browser
wallet extension; navigate the top window, open popups, submit forms, show `alert` or `confirm` dialogs, or start
downloads. The wallet refuses a game on its own origin, and its host forbids framing its pages.

The build's [`_headers`](publishing.md#the-_headers-file) keep the page to its own origin: no inline `<script>` or
`<style>`, no scripts from a CDN and no third-party requests. Bundle what you need, and run a server on the page's own
origin ([one Worker](developer-bets.md#one-cloudflare-worker)).

## The allowance

A game never learns the player's balance. It gets an allowance for the open tab, what the player lets it risk plus its
verified winnings, which only the player sets, from **Set allowance** in the wallet's top bar. Every bet and payment
must fit it.

- A game starts with an allowance of zero, and nothing opens over it. Until the player sets one, the game says so with
  [`HookedIn.NO_ALLOWANCE`](../sdk/hookedin.md#no_allowance). A bet or payment the allowance does not cover is refused
  with `insufficient-allowance`, whose message,
  [`HookedIn.NOT_ENOUGH_ALLOWANCE`](../sdk/hookedin.md#not_enough_allowance), tells the player what to do: show it, or
  your own, before anything is drawn.
- Developer bets are allowed apart, after a warning that the game's developer takes their stakes and decides what they
  pay. A game that places them says so as its page loads, with `HookedIn.placesDeveloperBets()`, and the dialog then
  asks about them too.
- `HookedIn.allowance()` reads it, with `pending` and `developerBets`, and `HookedIn.onAllowance` hears whenever any of
  it changes: take the no-allowance word, or a refusal, down then. Stakes and payments lower it as they are made;
  verified winnings raise it, a group's once the game has ended the group.
- `pending: true` means the wallet holds a signed operation that has not resolved, and takes no other bet or payment
  until it does ([lost replies](#lost-replies)).
- Leaving the game, reloading or closing the tab takes the allowance back, and the leave to place developer bets with
  it: a game opens with nothing every time. The wallet runs in one tab at a time, and opens one game at a time.
- The wallet's top bar names the game and shows its allowance, so a page shows no header, allowance or balance of its
  own: only the game.

### Groups

What a bet in a group wins stays with its group, out of the allowance the player sees, until the page calls
[`HookedIn.end(group)`](../reference/bridge.md#gameend), so the figure never gives a result away
([groups](../reference/bridge.md#groups-and-the-allowance-the-player-sees)). Give every bet a group, and end it once the
result is on the page: when the ball lands, the reels stop or the round is over. `RoundClient` puts each step in its
round's group; end it with [`round.end(state)`](../sdk/round.md#end).

## The bridge

[`HookedIn`](../sdk/hookedin.md#hookedin) wraps the [bridge](../reference/bridge.md), the `postMessage` protocol between
page and wallet, with a typed method per request and a `HookedInError` for every refusal: act on its `code`, show its
`message`. Questions are answered at once; anything that signs waits its turn, in order, up to 32 at a time.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

const info = await HookedIn.info(); // the player's names, the virtual bankroll, a recommended stake
const { allowance, pending } = await HookedIn.allowance(); // what the game may stake, and whether a bet awaits recovery
```

Players read and type amounts in **METH**, a millionth of an ETH, 10^12 wei. On the bridge amounts are bigints of wei:
1,000 METH is `1000n * HookedIn.METH`; `parseAmount` reads what a player typed into one, and `formatAmount` shows one
back. [`wallet.info`](../reference/bridge.md#walletinfo) is all a game learns of the player besides their own plays of
it ([history](#history)): their uname, theirs for good, the Discord username they go by today, the virtual bankroll of
the casino's latest quote and a recommended stake. The player's address, channel and balances never cross the bridge.

## Operation IDs

Every casino bet, developer bet and payment carries an `id` the game chooses, such as `crypto.randomUUID()`: the game's
durable name for the operation, the same on every channel of the player's. The same `id` with the same terms returns the
operation's receipt, so an operation is placed once however often it is sent; the same `id` with other terms fails with
`id-conflict`.

Choose the action and its `id`, and save both at your origin, with anything your page drew for it, before you ask the
wallet. The wallet saves the signed request before it leaves, so the game's record and the wallet's meet by `id` after
any crash. [A coin flip](casino-bets.md#a-coin-flip) saves `{ id, stake }` and clears it once the receipt arrives.

## Lost replies

A reply can be lost to a reload, a crash, or the SDK's `timeout` after three minutes, and an error proves nothing about
the operation. On startup, read what you saved and ask the wallet:

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { read } from '@hookedin/play/sdk/json';
import { flipStep } from './flip.ts';

const key = `${HookedIn.storageScope(await HookedIn.info())}:flip`;
// What the page saved, read back in its one form: JSON holds the stake as a decimal string.
const saved = read.nullable(read.object<{ id: string; stake: bigint }>({ id: read.text, stake: read.whole }))(
  JSON.parse(localStorage.getItem(key) ?? 'null'),
);
if (saved) {
  const receipt = await HookedIn.receipt(saved.id);
  if (receipt) {
    localStorage.removeItem(key); // the reply that was lost: apply it once
    show(receipt);
  } else
    offer('Finish your flip', async () => {
      // No receipt in this wallet: the same request, under the same id.
      show(await HookedIn.casinoBet({ id: saved.id, ...flipStep(saved.stake), group: saved.id }));
      localStorage.removeItem(key);
    });
}
```

`show` and `offer` are your page's own. A receipt is the reply you lost: apply it exactly once, and clear your record.
`null` means this wallet holds no receipt for the `id`: send the same request under the same `id`, and the wallet sends
the signed request again if it still holds it, which the pushed `pending: true` shows, or signs it. While an operation
is pending, another `id` fails with `pending-operation`. [`RoundClient`](../sdk/round.md#roundclient) does all of this
for a multi-step game.

## Rejections

A receipt with `status: 'rejected'` is a checkpoint the casino signed and the wallet checked: the operation is
cancelled, with no outcome, no balance change and no commission, and `reason` says why. The `id` keeps returning that
rejection: to try again, send the same terms under a fresh `id`, as `RoundClient` does. The wallet draws a step only
once its quote covers every bet of the split, and refuses one it does not cover with `not-covered` before anything is
drawn, so a casino bet comes back declined only when its quote expired before the casino answered it ([rejected
bets](../wallet/bets-and-receipts.md#rejected-bets)).

## When a wallet has lost receipts

A wallet on another device, or one that lost its browser's data, may not hold the receipt of an operation its player
carried out on another channel. `game.receipt` returns `null` for it, and sending the request again fails with
`id-used`, as `game.receipt` does from then on: the operation was carried out, and its result is not in this wallet.
Clear your record and tell the player; do not send it again under another `id` without asking them.

## Storage

Keep state at your own origin, keyed by page, chain and player, so that games sharing a host and accounts sharing a
browser never read each other's. `HookedIn.storageScope(info)` builds such a key,
`hookedin:<page path>:<chainId>:<uname>`. It keys on the uname, the player's for good, never on the Discord username
they can change. A guest has no uname: the wallet loads the page again when a guest creates an account or signs in, and
when the player switches accounts. `RoundClient` saves its round under `hookedin:round:<name>:<chainId>:<uname>`, where
`name` is the page's path unless you pass one.

A reload takes back the allowance. The state at your origin survives, and every settled step's money is in the player's
balance, so a resumed round asks for an allowance again. Saved state stays in this browser, and a round left unfinished
leaves the player the cash it held. **Use here**, which moves the wallet to another tab, stops the game in the tab it
leaves, as a reload does. A game with state beyond one round, such as a slot's bonus counter, applies each finished
round once, by the round's `id`.

## History

[`HookedIn.history()`](../reference/bridge.md#gamehistory) reads the player's history of your game, newest first, from
any channel and device: each operation the casino carried out, as the receipt the wallet checked, and each group you
ended with meta. A receipt says what was bet and paid, not what your page drew from it, such as plinko's rows or the
tiles a mines player picked, so end each group with your own JSON saying how it went,
[`HookedIn.end(group, meta)`](../reference/bridge.md#gameend), and draw past plays from it. `RoundClient` does it for a
round: [`end(state)`](../sdk/round.md#end) keeps the state the round ended in, and [`past()`](../sdk/round.md#past)
reads it back. A step that places no bet is only in your meta.
