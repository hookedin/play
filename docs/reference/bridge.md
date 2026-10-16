---
title: Game bridge
description: The postMessage protocol between a game page and the HookedIn wallet, with its envelopes, methods, events, receipts, bounds and error codes.
sidebar:
  order: 1
---

A game page talks to the wallet that frames it with `window.postMessage`. [`HookedIn`](../sdk/hookedin.md) speaks this
protocol for a page that uses the SDK. [client/bridge.ts](../../client/bridge.ts) checks every request, and
[client/wallet-games.ts](../../client/wallet-games.ts) answers it.

## Envelopes

A request is a plain object with these keys and no others, posted to `window.parent`: the greeting with the target
origin `'*'`, and every later request to the [origin](#origins) of the wallet that answered it:

```js
window.parent.postMessage({ hookedin: true, id: 1, method: 'wallet.hello', params: {} }, '*');
```

| Field      | Type      | Meaning                                                                                                      |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `hookedin` | `boolean` | Always `true`                                                                                                |
| `id`       | `number`  | The envelope ID: a safe integer, at least 0, above every earlier request's of the page. The reply carries it |
| `method`   | `string`  | One of the [methods](#methods)                                                                               |
| `params`   | object    | The method's parameters and no others: a plain object, which may be left out when the method takes none      |

The wallet answers each request once, with its `id` and either `result`, such as `game.receipt`'s `null`, or `error`:

```json title="Result"
{ "hookedin": true, "id": 7, "result": null }
```

```json title="Refusal"
{
  "hookedin": true,
  "id": 8,
  "error": {
    "code": "insufficient-allowance",
    "message": "Not enough allowance for this bet: it is what you let this game play with. Set it in the top bar, creating a wallet or depositing first if it asks."
  }
}
```

`code` is stable and a game acts on it ([errors](#errors)); `message` is for people. An [event](#events) carries `event`
in place of `id`.

## IDs

The envelope `id` only routes a reply; the SDK counts from 1. A [`wallet.hello`](#wallethello) whose ID does not rise is
a page the frame loaded afresh; any other request whose ID does not rise is refused with `invalid-request`. A request
that fails the checks is refused under its ID when that is a safe integer, and dropped unanswered otherwise.

The `id` in a bet's or a payment's parameters is the game's own durable name for the operation, 1 to 64 letters, digits,
`.`, `_`, `:` or `-`, kept for the player and the game on every channel. The same request again returns the saved
receipt; other terms under the same ID are refused with `id-conflict` ([operation
IDs](../games/how-a-game-works.md#operation-ids)).

## Origins

The wallet frames the game's page at its [URL](../games/publishing.md#the-games-url), whose origin is the game's. It
accepts a message only from that frame's window and origin, and posts every reply and event to that origin alone: a
frame that has navigated elsewhere hears nothing. It answers only the open game.

A game accepts a message only from `window.parent` at a wallet's origin: HookedIn's, `https://play.hookedin.com`, or a
wallet the player runs on their own computer, at `http://localhost`, `http://127.0.0.1` or `http://[::1]` on any port.
Once a wallet has answered its greeting, the game hears and posts to that origin alone, and sends any other page that
frames it nothing but the greeting. The SDK does all of this.

When the frame loads a page, a reload included, the wallet forgets the page before it once the new page greets it: it
drops that page's queued requests and sends it no replies. An operation the wallet already signed stands, and the next
page finds it with [`game.receipt`](#gamereceipt).

## Size

The wallet refuses with `invalid-request` a request whose estimated JSON size is above 70,000 characters, or that nests
deeper than 64 levels. A developer bet's meta is bounded more tightly, by the [bounds](#bounds).

## Queueing

`game.casinoBet`, `game.developerBet` and `game.payment` sign, so they take their turn one at a time, in the order the
game sent them. At most 32 wait; one more is refused with `busy`. A request whose turn comes while the player is doing
something in the wallet is refused with `busy` too; one whose turn comes while the wallet does work of its own, such as
its regular look at the chain, waits for it. Every other method is answered at once, also while a bet is open, except
that `wallet.info` waits until the wallet has first heard from the casino.

## Amounts

Every amount is a bigint of whole wei, 10^-12 METH, below 2^256; the wallet refuses an amount of any other type. A
stake, an amount and a step's cash are above zero. A `group`, on a bet or a payment, is a label of 1 to 64 printable
characters (no control, format, private-use or unassigned character) for operations that belong together, such as the
steps of one hand: the player signs it, and the wallet and the game's public record show a group as one.

## Groups and the allowance the player sees

The wallet's top bar shows the game's allowance. So that it never gives a result away before the game shows it, and
never moves while a round is played, the wallet holds a group's winnings apart:

- A step in a group takes its whole `cash` out of the allowance when it is played, and so does what a payment in a group
  says it `kept`: the least a step of a round is sure to leave it, which stays the round's whatever the outcome. Outside
  a group, of a step's cash only its bet's stake leaves the allowance.
- What a bet in a group wins, a developer bet's collected payout included, stays with the group with what it kept, out
  of the allowance and the balance the player sees. The group's own later bets stake it first; no other bet can.
- [`game.end`](#gameend) ends a group once the player has seen how it ended, and what it holds joins the allowance.
  Leaving the game ends every group.
- A bet with no group is shown as it settles.

[`RoundClient`](../sdk/round.md#roundclient) plays a multi-step round as one group and sends each step's cash and each
payment's `kept` itself: the figure drops by the whole stake on its first step and stays there until the round ends.

## Methods

### `wallet.hello`

The page's first request, with no parameters. It answers `{ bounds }` ([bounds](#bounds)).

### `wallet.info`

Everything a game learns of the player and what to price bets against; no parameters. A page that asked is reloaded when
the uname changes, as when a guest signs up or in or the player switches accounts: it keys its state by that name.

| Result field       | Type               | Meaning                                                                                                                                                                                                         |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`            | `string` or `null` | The player's uname, theirs for good, written `~uname`. Every account has one from the start, before its first deposit; `null` for a guest, who has no account yet, and while the wallet cannot reach the casino |
| `discordUsername`  | `string` or `null` | The name the player is shown by, written `@bob`: the username of the Discord account that verified them; `null` unless one did                                                                                  |
| `chainId`          | `bigint`           | The chain the wallet is pinned to: `1n` for Ethereum, `31337n` for a local Anvil                                                                                                                                |
| `virtualBankroll`  | `bigint`           | The virtual bankroll of the casino's latest quote, half the casino's bankroll when it quoted: what to price casino bets against; `0n` while the account has no balance that plays                               |
| `recommendedStake` | `bigint`           | A stake to start the stake field at: 10^12 wei on Ethereum and 10^15 on a local Anvil                                                                                                                           |

### `wallet.round`

A game's round, as the casino shows it to anyone at
[`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround), read through the wallet.

| Param | Type          | Meaning                                     |
| ----- | ------------- | ------------------------------------------- |
| `id`  | `bytes32` hex | The round, `0x` and 64 lowercase hex digits |

The result is the casino's reply, its numbers bigints: `{ id, game, createdAt, status }`, and once the game's casino bet
has revealed the round, its `seed`, `secret`, `outcome` and `casinoBet`, none of it checked by the wallet. A game whose
players share one draw, such as roulette, checks its rounds ([checking a round](../sdk/outcome.md#checking-a-round)). A
round the casino does not know is refused with the casino's `not-found`.

### `wallet.showBet`

Shows the player, over the game, one of its operations in full by the game's own ID, with the proof of how it settled
([a bet in full](../wallet/bets-and-receipts.md#a-bet-in-full)), and answers `null`. A game links a result on its page
to it: the proof is the wallet's to show, never the game's.

| Param | Type     | Meaning            |
| ----- | -------- | ------------------ |
| `id`  | `string` | The operation's ID |

An operation this wallet keeps no receipt of, such as one played in another browser, is refused with `not-found`; the
wallet's own [menu](../wallet/bets-and-receipts.md#the-games-menu) opens the game's latest bet from any device.

### `game.receipt`

The receipt of an earlier operation of this game, by the game's own ID.

| Param | Type     | Meaning            |
| ----- | -------- | ------------------ |
| `id`  | `string` | The operation's ID |

The result is the operation's [receipt](#receipt), or `null` when this wallet has none: never signed, still pending
([`game.allowance`](#gameallowance)'s `pending` says so), or its record lost. One carried out on another channel, whose
result this wallet does not hold, is refused with `id-used`. For an open developer bet the wallet also looks for its
settlement ([`game.receipt`](#gamereceipt-1) event).

### `game.history`

The player's history of the game, newest first, from any channel and device, as the casino keeps it: none for a guest.

| Param   | Type     | Meaning                                                                    |
| ------- | -------- | -------------------------------------------------------------------------- |
| `after` | `string` | Optional: the `cursor` of the page before, for the entries older than it   |
| `limit` | `number` | Optional: how many entries, a whole number from 1 to 100; 50 when left out |

The result is `{ entries, cursor, more }`: pass `cursor` back as `after` while `more` is `true`. An entry is either:

- An operation of the game the casino carried out: a casino bet or a payment, `settled`, or a developer bet, `open` or
  `settled`. It is the operation's [receipt](#receipt) without `id`, which the casino keeps only as a hash, and with
  `at`, when the casino recorded it, in milliseconds. The wallet checks each against the evidence the casino kept, as it
  checks a reply: the account signed the operation, both checkpoints are signed, its details name this game, a casino
  bet's outcome comes from its seed and its round's secret, its step's `result` and `draw` from that seed and the table
  its details signed, and a developer bet's payout is the settlement its developer's server signed. A page with one that
  fails is refused with `failed`. A declined operation, and a step that drew no bet, which never reached the casino, are
  not listed.
- `{ kind: "end", group, meta, at }`: a group the game [ended](#gameend) with `meta`, as the casino kept it.

[`RoundClient`](../sdk/round.md#past) reads back the rounds it ended ([history](../games/how-a-game-works.md#history)).

```js title="Reply"
{
  "hookedin": true,
  "id": 9,
  "result": {
    "entries": [
      {
        "kind": "end",
        "group": "session-3",
        "meta": { "flips": ["heads"] },
        "at": 1791331200000
      },
      {
        "kind": "casino-bet",
        "status": "settled",
        "stake": 1000000000000n,
        "chance": 9223372036854775808n,
        "prize": 1980000000000n,
        "group": "session-3",
        "result": 0n,
        "draw": 14780349465718245980n,
        "outcome": 4417924718259038112n,
        "payout": 1980000000000n,
        "at": 1791331199000
      }
    ],
    "cursor": "019a0f3c-2b40-7c11-9e3a-5d1f7a0b8c42",
    "more": false
  }
}
```

### `game.casinoBet`

A step: the cash it holds and the table of results it can end in. A single bet is a table of two results: its prize, as
often as its chance says, and nothing.

| Param     | Type     | Meaning                                                                                                                            |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `string` | The game's ID for the operation                                                                                                    |
| `cash`    | `bigint` | What the step holds, below 2^96: at most the game's allowance and what its group holds. A bet stakes part of it and keeps the rest |
| `results` | array    | 1 to 128 results, each `{ weight, cash, label? }`: reached with the probability its `weight` gives it, it leaves the player `cash` |
| `group`   | `string` | Optional: the step's [group](#groups-and-the-allowance-the-player-sees)                                                            |

A `weight` is a bigint above zero, the weights together below 2^256. A result's `cash` is below 2^96, and its `label`, 1
to 64 printable characters such as `Bucket 3` or `16× win`, is what the wallet calls it. The wallet pairs every amount
the results leave below `cash` with every amount above it, or, when none is above it, every other amount with the
highest, at most 64 pairs. A table whose results all leave one amount must leave `cash`: it places no bet, and the
wallet only draws which result it reaches, such as which card comes. Anything else is refused with `invalid-request`.

The wallet, never the page, splits the table at the virtual bankroll of the casino's
[quote](../overview/how-it-works.md#quotes) into ways, each one casino bet staking part of `cash`, or none, draws a way
with the seed it signs that bet with, and lands the step on a result with the same seed ([how the wallet draws a
step](../games/collapsing-bets.md#the-wallet-draws-the-step)). The bet settles against the casino's bankroll in the one
request, on the player's own [round](../overview/how-it-works.md#rounds), without charging the player the casino's
commission; a way without a bet signs nothing, and the step keeps its cash. A step the quote does not cover in every bet
of the split is refused with `not-covered`, before anything is drawn or signed.

The result is the step's [receipt](#receipt), `settled` for a bet or `kept` for a way without one:

```js title="Request"
{
  "hookedin": true,
  "id": 4,
  "method": "game.casinoBet",
  "params": {
    "id": "coin-17",
    "cash": 1000000000000n,
    "results": [
      { "weight": 1n, "cash": 1980000000000n, "label": "Heads" },
      { "weight": 1n, "cash": 0n, "label": "Tails" }
    ],
    "group": "session-3"
  }
}
```

```js title="Reply"
{
  "hookedin": true,
  "id": 4,
  "result": {
    "id": "coin-17",
    "kind": "casino-bet",
    "status": "settled",
    "stake": 1000000000000n,
    "chance": 9223372036854775808n,
    "prize": 1980000000000n,
    "group": "session-3",
    "result": 0n,
    "draw": 14780349465718245980n,
    "outcome": 4417924718259038112n,
    "payout": 1980000000000n
  }
}
```

The wallet split this table into one bet: the whole cash for 1.98 times it, on half the outcomes. One [ID](#ids) is one
draw: the same request again returns the same receipt.

### `game.developerBet`

A bet against the game's developer ([developer bets](../overview/how-it-works.md#developer-bets)). Its stake goes from
the game's allowance into the game's bank at once, for good, and the game's server settles it when it chooses, on its
developer's word. Until the player allows the game's developer bets
([`game.placesDeveloperBets`](#gameplacesdeveloperbets)), one is refused with `developer-bets-not-allowed`.

| Param   | Type     | Meaning                                                                                                                                  |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | `string` | The game's ID for the operation                                                                                                          |
| `stake` | `bigint` | Paid into the game's bank; at most the game's allowance and what its group holds                                                         |
| `meta`  | object   | The game's own JSON, saying what the bet is. The casino keeps it with the bet and never reads it; the developer's server settles by it   |
| `round` | `string` | Optional: the hash of a secret the developer committed to before the bet, `0x` and 64 lowercase hex digits, which its settlement reveals |
| `group` | `string` | Optional: the group the bet belongs to, such as a match or a spin                                                                        |

`meta` is a plain object of JSON values whose canonical JSON, keys sorted and no spaces, takes at most 4,096 bytes of
UTF-8. Its numbers are safe integers, so odds of 2.1 go as the string `"2.1"`, and its text is well-formed, without a
NUL. `round` is signed with the bet: the casino settles the bet only with the secret that hashes to it, which the wallet
checks before it collects ([a round of your own](../games/developer-bets.md#a-round-of-your-own)).

The result is the bet's [receipt](#receipt) at once, `open` or `rejected`, and the same request again returns it as it
stands. Once the developer has settled the bet, the wallet checks the signed settlement, collects what it pays and
pushes a [`game.receipt`](#gamereceipt-1) event. A game opened by its URL alone is published by nobody, and its
developer bets are refused with `invalid-request`. The developer's side is the [developer kit](../sdk/developer.md).

```js title="Request"
{
  "hookedin": true,
  "id": 5,
  "method": "game.developerBet",
  "params": {
    "id": "match-812-home",
    "stake": 1000000000000n,
    "meta": { "pick": "home", "odds": "2.1" },
    "group": "match-812"
  }
}
```

```js title="Reply"
{
  "hookedin": true,
  "id": 5,
  "result": {
    "id": "match-812-home",
    "kind": "developer-bet",
    "status": "open",
    "stake": 1000000000000n,
    "meta": { "pick": "home", "odds": "2.1" },
    "group": "match-812",
    "bet": "0x9ef313d092ad9d9f5f2ac313d77b5be958fdab15452b07fe9c2b5fc71fb804b0"
  }
}
```

### `game.payment`

A payment to the bankroll: the balance drops by `amount`, with no chance involved and no commission.

| Param    | Type     | Meaning                                                                                                                            |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | `string` | The game's ID for the operation                                                                                                    |
| `amount` | `bigint` | What is paid: with `kept`, at most the game's allowance and what its group holds                                                   |
| `group`  | `string` | Optional: the group the payment belongs to                                                                                         |
| `kept`   | `bigint` | Optional, in a group: what of the group's cash the payment leaves it, signed in its [details](signed-messages.md#details-and-memo) |

The result is the payment's receipt, `settled` or `rejected`, with no amount.

### `game.placesDeveloperBets`

Says the game places developer bets, with no parameters, and answers `null`; nothing opens. From then on, confirming the
allowance dialog the player opens from the top bar also allows developer bets, after the wallet's warning ([the
allowance](../games/how-a-game-works.md#the-allowance)). A game opened by its URL alone has no developer, and its dialog
offers none. Taking the whole allowance back takes back developer bets with it.

### `game.allowance`

What the game may stake now; the [`game.allowance`](#gameallowance-1) event tells the game whenever it changes.

| Param   | Type     | Meaning                                           |
| ------- | -------- | ------------------------------------------------- |
| `group` | `string` | Optional: a group, for what a bet in it may stake |

| Result field    | Type      | Meaning                                                                                                         |
| --------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `allowance`     | `bigint`  | What the game may stake: what the player sees in the top bar, or with `group`, that and what the group holds    |
| `pending`       | `boolean` | A signed operation of this game awaits recovery in the wallet. While it does, no other bet or payment is signed |
| `developerBets` | `boolean` | Whether the player allows the game's developer bets                                                             |

```js title="Reply"
{
  "hookedin": true,
  "id": 4,
  "result": { "allowance": 5980000000000n, "pending": false, "developerBets": false }
}
```

### `game.end`

The player has seen how a [group](#groups-and-the-allowance-the-player-sees) ended: what it holds joins the allowance.
It answers `null`, also for a group that holds nothing: at once, or with `meta`, once the casino has kept it.

| Param   | Type     | Meaning                                                                                             |
| ------- | -------- | --------------------------------------------------------------------------------------------------- |
| `group` | `string` | The group                                                                                           |
| `meta`  | object   | Optional: the game's own JSON saying how the group went, which [`game.history`](#gamehistory) lists |

`meta` has the form and bounds of a developer bet's. The casino keeps it in the player's history of the game, once per
group: the same meta again is answered as before, other meta is refused with `id-conflict`. When the casino cannot be
reached the answer is `failed`, but the group has ended: sending the request again keeps its meta.

## Events

The wallet sends these unasked to the game's origin while the game is open, and only to a page that has greeted it with
[`wallet.hello`](#wallethello): a page asks for what it needs once it has.

### `game.receipt`

A developer bet this game placed has been settled by its developer and collected by the wallet, which looks for settled
bets every 10 minutes while its tab is visible, and at once when the game asks [`game.receipt`](#gamereceipt) about an
open one. It carries `receipt`, the bet's [receipt](#receipt), `settled`, with its `payout`.

### `game.allowance`

What the game may stake has changed: anything [`game.allowance`](#gameallowance) answers without a group, whatever
changed it, such as the player setting the allowance or allowing developer bets, a bet or a payment settling or
declined, a group ending, a developer bet collected, a withdrawal, a transfer or a lock-in leaving less in the balance,
or an operation of the game starting or finishing. It carries `allowance`, `pending` and `developerBets`, as
`game.allowance` answers them without a group: what a group holds changes only by the game's own requests and
`game.receipt`. It can arrive before the reply to the request that changed it.

```js title="Event"
{ "hookedin": true, "event": "game.allowance", "allowance": 5980000000000n, "pending": false, "developerBets": false }
```

## Receipt

Every reply about an operation, whichever method asked, is one receipt under the game's own ID: how the operation ended,
as the wallet checked it, never the signed evidence. The evidence, the channel and its balance stay in the wallet.

| `kind`          | `status`                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `casino-bet`    | `settled`: done, and what it paid is in the player's balance. `kept`: a step that drew no bet, and signed nothing. `rejected`: declined, the balance unchanged, with a signed checkpoint the wallet checked |
| `payment`       | `settled` or `rejected`, as for a casino bet                                                                                                                                                                |
| `developer-bet` | `open`: its stake is in the game's bank. `settled`: its developer settled it and the wallet collected what that pays. `rejected`: the casino did not take it                                                |

| Field     | Type          | Present                                                                                                                    |
| --------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `string`      | Always: the game's ID for the operation                                                                                    |
| `kind`    | `string`      | Always: `casino-bet`, `developer-bet` or `payment`                                                                         |
| `status`  | `string`      | Always: `settled`, `rejected`, `open` or `kept`                                                                            |
| `stake`   | `bigint`      | For a casino bet and a developer bet, as placed                                                                            |
| `chance`  | `bigint`      | For a casino bet, as placed                                                                                                |
| `prize`   | `bigint`      | For a casino bet, as placed                                                                                                |
| `meta`    | object        | For a developer bet, as placed                                                                                             |
| `group`   | `string`      | When the operation had one                                                                                                 |
| `bet`     | `bytes32` hex | For a developer bet the casino took: the hash that names it at the casino and to its developer                             |
| `result`  | `bigint`      | For a step, settled or `kept`: the result it landed on, as its place in the step's `results`, counting from 0              |
| `draw`    | `bigint`      | For a step, settled or `kept`: the 64-bit value the wallet drew after the result, which the game shows it with             |
| `outcome` | `bigint`      | For a settled casino bet: its round's 64-bit outcome                                                                       |
| `payout`  | `bigint`      | For a settled casino bet, what it paid: its prize or `0`; for a settled developer bet, what its settlement paid the player |
| `reason`  | `string`      | For a rejection, when the casino gave one: a message for people                                                            |

A casino bet's payout rests on its round's secret and seed, checked against the hashes the bet signed, and its way,
`result` and `draw` on the same seed, so a game's picture and the money cannot disagree. A developer bet's payout rests
on its developer's signed settlement. A rejected operation changed nothing, and its ID keeps returning it:

```js
{
  "id": "coin-18",
  "kind": "casino-bet",
  "status": "rejected",
  "stake": 1000000000000n,
  "chance": 9223372036854775808n,
  "prize": 2000000000000n,
  "reason": "No quote of the casino covers this casino bet"
}
```

## Bounds

`wallet.hello` reports `bounds`, every bound the wallet holds a bet to:

| Field          | Value                   | Meaning                                                                     |
| -------------- | ----------------------- | --------------------------------------------------------------------------- |
| `outcomeSpace` | `18446744073709551616n` | 2^64: a round's outcome is below it, and a chance counts outcomes out of it |
| `meta`         | `4096`                  | The most bytes a developer bet's meta takes as canonical JSON               |
| `group`        | `64`                    | The longest group label, in characters                                      |
| `results`      | `128`                   | The most results a step has                                                 |
| `pairs`        | `64`                    | The most pairs of amounts the wallet splits a step into                     |
| `weight`       | `2n ** 256n`            | What a step's results weigh less than, together                             |
| `label`        | `64`                    | The longest label of a result, in characters                                |

They are [part of the protocol revision](signed-messages.md#bounds-and-the-protocol-revision): the casino reports them
as `bounds` in [`GET /api/config`](../casino-api/public.md#get-apiconfig), and the developer kit's
[`DEVELOPER_PROTOCOL`](../sdk/developer.md#developer_protocol) hashes them. A game reads them and keeps no copies.

## Errors

A refusal is `{ code, message }`. The wallet's codes:

| `code`                       | Meaning                                                                                                                                                 | What a game does                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-request`            | The envelope or its parameters break a rule on this page, the envelope ID did not rise, or the request asks a developer bet of a game published nowhere | Fixes the request: sent again unchanged, it fails again                                                                                                                                                                                                    |
| `unknown-method`             | The wallet offers no such method                                                                                                                        | Keeps to the methods on this page                                                                                                                                                                                                                          |
| `busy`                       | The player is doing something in the wallet, or 32 requests already wait                                                                                | Sends the same request again shortly                                                                                                                                                                                                                       |
| `insufficient-allowance`     | The step's cash, the stake, or the amount with `kept`, exceeds the game's allowance and what its group holds                                            | Shows the message until the [`game.allowance`](#gameallowance-1) event says the player changed the allowance; the same request can go again then                                                                                                           |
| `developer-bets-not-allowed` | The player has not allowed the game's developer bets                                                                                                    | Shows the message until the `game.allowance` event says the player allowed them, which the top bar offers once the game has sent `game.placesDeveloperBets`                                                                                                |
| `pending-operation`          | A signed operation under another ID awaits recovery in the wallet                                                                                       | Waits: the wallet finishes a deposit it is taking in by itself, and the player recovers anything else from the wallet's banner. When `game.allowance`'s `pending` is `true` the operation is this game's, and sending it again under its own ID resumes it |
| `id-conflict`                | The ID is bound to other terms or another game, or a pending request under it differs; or the group ended with other meta                               | Sends the terms saved with the ID, or a fresh ID for a fresh operation; a group keeps the meta it ended with                                                                                                                                               |
| `id-used`                    | The operation was carried out on another channel, and this wallet has no receipt of it                                                                  | Does not place it again under another ID without asking the player                                                                                                                                                                                         |
| `not-covered`                | The casino's quote does not cover every bet the wallet splits the step into                                                                             | Shows the message, which asks the player to lower the stake, or what a step that returns all it holds or more pays; the same step can go again under the same ID once a quote covers it, or a cheaper one under a fresh ID                                 |
| `not-found`                  | `wallet.showBet` names an operation this wallet keeps no receipt of                                                                                     | Says the proof is in the browser that played it                                                                                                                                                                                                            |
| `game-closed`                | The game is not the open one: the player left it, or closed it while its request waited                                                                 | Stops: the page is leaving                                                                                                                                                                                                                                 |
| `failed`                     | Anything else, such as a casino that did not answer or chain observations that are out of date                                                          | Sends the same request again under the same ID: nothing proves it was not signed, and the wallet resumes it if it was                                                                                                                                      |

An operation the casino declines is no error but a `rejected` [receipt](#receipt)
([rejections](../games/how-a-game-works.md#rejections)).

The SDK adds two codes of its own, which never cross the bridge:

| `code`      | Meaning                                                      | What a game does                                                                                                |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `no-wallet` | The page is not inside a frame, so there is no wallet to ask | Tells the player to open the game in the HookedIn wallet                                                        |
| `timeout`   | No reply came within 180 seconds                             | Asks `game.receipt` for the operation's ID, or sends the same request again: the wallet may have carried it out |

A refusal by the casino reaches the game with the casino's own code, such as `paused` when the casino has stopped
signing, or `rate-limited` ([the casino's errors](../casino-api/index.md#errors)). A code that is not a lower-case
letter followed by at most 39 lower-case letters and hyphens, such as a library's, is reported as `failed`.
