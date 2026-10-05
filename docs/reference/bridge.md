---
title: Game bridge
description: The postMessage protocol between a game page and the HookedIn wallet, with its envelopes, methods, events, receipts, bounds and error codes.
sidebar:
  order: 1
---

A game page talks to the wallet that frames it with `window.postMessage`. [`HookedIn`](../sdk/hookedin.md) speaks this
protocol for a page that uses the SDK; this page is for a game that does not, and the reference for what the wallet
checks and answers. The wallet's side is [client/bridge.ts](../../client/bridge.ts), which checks every request, and
[client/wallet-games.ts](../../client/wallet-games.ts), which answers it.

## Envelopes

A request is a plain object with these keys and no others, posted to `window.parent` with the target origin `'*'`:

```js
window.parent.postMessage({ hookedin: true, id: 1, method: 'wallet.hello', params: {} }, '*');
```

| Field      | Type      | Meaning                                                                                                      |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `hookedin` | `boolean` | Always `true`                                                                                                |
| `id`       | `number`  | The envelope ID: a safe integer, at least 0, above every earlier request's of the page. The reply carries it |
| `method`   | `string`  | One of the [methods](#methods)                                                                               |
| `params`   | object    | The method's parameters and no others: a plain object, which may be left out when the method takes none      |

The wallet answers each request once, with the same `id` and either `result` or `error`. Here `null` is what
`game.receipt` answers for an operation the wallet has no record of:

```json title="Result"
{ "hookedin": true, "id": 7, "result": null }
```

```json title="Refusal"
{
  "hookedin": true,
  "id": 8,
  "error": { "code": "insufficient-allowance", "message": "Not enough allowance for this bet. Set it in the top bar." }
}
```

`code` is stable, and a game acts on it; `message` is for people. The codes are under [errors](#errors). An
[event](#events) the wallet sends unasked carries `event` in place of `id`.

## IDs

The envelope `id` only routes a reply. It must rise with every request of a page; a request whose ID does not is
refused with `invalid-request`, and the SDK counts from 1. A page begins with [`wallet.hello`](#wallethello): a greeting
whose ID does not rise is a page the frame loaded afresh, and its count starts there. A request that fails the checks is
refused under its ID when that ID is a safe integer, and dropped unanswered otherwise.

The `id` inside a bet's or a payment's parameters is different: it is the game's own durable name for the operation, 1
to 64 letters, digits, `.`, `_`, `:` or `-`. The wallet keeps it for the player and the game, whichever channel the
operation is signed on. The same request again returns the saved receipt, and other terms under the same ID are refused
with `id-conflict`. [How a game works](../games/how-a-game-works.md) shows how a game uses it.

## Origins

The wallet frames the game's page, at its [URL](../games/publishing.md#the-games-url), and that page's origin is the
game's. It accepts a message only from that frame's window and that origin, and posts every reply and event to that
origin alone: a frame that has navigated to another origin is not the game, and hears nothing. It answers only the open
game. A game accepts only messages whose `source` is `window.parent`, as the SDK does.

When the frame loads a page, a reload included, the wallet forgets the page before it as soon as the new page greets
it: its queued requests are dropped, and replies to its requests are not sent. An operation the wallet already signed
stands, and the page that follows finds it with [`game.receipt`](#gamereceipt).

## Size

The wallet refuses with `invalid-request` a request whose estimated JSON size is above 70,000 characters, or that nests
deeper than 64 levels. A developer bet's meta is bounded more tightly, by the [bounds](#bounds).

## Queueing

`wallet.hello`, `wallet.round`, `game.receipt`, `game.allowance`, `game.placesDeveloperBets` and `game.end` are
answered at once, also while a bet is open, and so is `wallet.info`, except that it waits until the wallet has first
heard from the casino. `game.casinoBet`, `game.developerBet` and `game.payment` sign something, so they take their
turn one at a time, in the order the game sent them. At most 32 wait; one more is refused with `busy`. A request whose
turn comes while the player is doing something in the wallet is refused with `busy` too; one whose turn comes while the
wallet does work of its own, such as its regular look at the chain, waits for it.

## Amounts

Every amount is a decimal string of whole wei, 10^-12 METH: digits only, no sign and no leading zeros, below 2^256. A
stake, a prize and an amount are above zero. A `group`, on a bet or a payment, is a label of 1 to 64 characters, without
a NUL, for operations that belong together, such as the steps of one hand: the player signs it, and the wallet and the
game's public record show a group as one.

## Groups and the allowance the player sees

The wallet's top bar shows the game's allowance, in place of the player's balance once it is set. So that it never
gives a result away before the game shows it, and never moves while a round is played, the wallet holds a group's
winnings apart:

- A stake leaves the allowance when it is bet, and so does what a bet in a group says it `kept` of the group's cash:
  the least a step of a round is sure to leave it, which stays the round's whatever the outcome.
- What a bet in a group wins, a developer bet's collected payout included, stays with the group, with what it kept,
  out of the allowance and the balance the player sees. The group's own later bets stake it first; no other bet can.
- [`game.end`](#gameend) ends a group once the player has seen how it ended, and what it holds joins the allowance.
  Leaving the game ends every group.
- A bet with no group is shown as it settles.

A multi-step round is one group, so the figure drops by the whole stake on its first step and stays there until the
game ends the round. [`RoundClient`](../sdk/round.md#roundclient) sends each step's `kept` itself. The money is the player's throughout: it is in their balance, and the wallet's own window says how much of
it is in play.

## Methods

### `wallet.hello`

The page's first request. Answered at once, it takes no parameters and answers `{ bounds }`, the bounds the wallet holds
a bet to ([bounds](#bounds)).

### `wallet.info`

Everything a game learns about the player, and what to price bets against. It takes no parameters, and is answered
once the wallet has first heard from the casino. A page that asked is loaded again when the uname changes, as it does
when the player switches accounts, so that it keys what it saves by that name.

| Result field       | Type               | Meaning                                                                                                                                                                                                            |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uname`            | `string` or `null` | The player's uname, theirs for good, written `~uname`. Every account has one from the start, before its first deposit; `null` only while the wallet cannot reach the casino. A game keys anything of its own by it |
| `discordUsername`  | `string` or `null` | The name the player is shown by, written `@bob`: the username of the Discord account that verified them; `null` unless one did                                                                                     |
| `chainId`          | `string`           | The chain the wallet is pinned to, in decimal: `11155111` for Sepolia, `31337` for a local Anvil                                                                                                                   |
| `virtualBankroll`  | decimal string     | The virtual bankroll of the casino's latest quote, half the casino's bankroll when it quoted: what to price casino bets against. The casino settles every casino bet it admits                                     |
| `recommendedStake` | decimal string     | A stake to start the stake field at: 10^12 wei on Sepolia and 10^15 on a local Anvil                                                                                                                               |

### `wallet.round`

A game's round, as the casino shows it to anyone at
[`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround), read through the wallet. Answered at once.

| Param | Type          | Meaning                           |
| ----- | ------------- | --------------------------------- |
| `id`  | `bytes32` hex | The round, `0x` and 64 hex digits |

The result is the casino's reply as it came: `{ id, game, createdAt, status }`, and once the game's casino bet has
revealed the round, its `seed`, `secret`, `outcome` and `casinoBet`. The wallet checks none of it. A game whose players
share one draw, such as roulette, checks its rounds with it: each secret hashes to its round, each seed to
the seed hash its bet signed, and the outcomes lead where the game says. A round the casino does not know is refused
with the casino's `not-found`.

### `game.receipt`

The receipt of an earlier operation of this game, by the game's own ID. Answered at once.

| Param | Type     | Meaning            |
| ----- | -------- | ------------------ |
| `id`  | `string` | The operation's ID |

The result is the operation's [receipt](#receipt), or `null` when this wallet has none: the operation was never signed,
it is still pending ([`game.allowance`](#gameallowance)'s `pending` says so), or this wallet has lost its record. For an
open developer bet the wallet also asks the casino about it; once its developer has settled it, the wallet collects
what it pays and pushes the settled receipt as a [`game.receipt`](#gamereceipt-1) event.

### `game.casinoBet`

A casino bet: settled against the casino's bankroll in the one request, on the player's own
[round](../overview/how-it-works.md#rounds). The game's allowance drops by the stake, and rises by the prize when the
round's 64-bit outcome is below the chance, once the bet's [group](#groups-and-the-allowance-the-player-sees) ends if it
has one; the casino's commission is not charged to the player. The casino settles
every bet its [quote](../overview/how-it-works.md#quotes) covers, one whose terms the quote's virtual bankroll admits;
it declines any other, with a signed checkpoint that leaves the balance unchanged.

| Param    | Type           | Meaning                                                                                                                                                                                                          |
| -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | `string`       | The game's ID for the operation                                                                                                                                                                                  |
| `stake`  | decimal string | Paid to enter; at most the game's allowance and what its group holds                                                                                                                                             |
| `chance` | decimal string | How many of the 2^64 outcomes win: 1 to 2^64 − 1                                                                                                                                                                 |
| `prize`  | decimal string | What the bet pays when it wins; below 2^96                                                                                                                                                                       |
| `group`  | `string`       | Optional: the group the bet belongs to                                                                                                                                                                           |
| `kept`   | decimal string | Optional, in a group: what of the group's cash stays out of the bet, with the group ([groups](#groups-and-the-allowance-the-player-sees)); with the stake, at most the game's allowance and what its group holds |

The outcome is a uniform integer below 2^64, so the bet wins with probability `chance / 2^64`. A chance of 0, or of
2^64 or more, is refused with `invalid-request`: a sure loss or a sure win is no bet. So is a prize of 2^96 or more,
which no balance can hold. The stake was paid to enter, so a win gains `prize − stake`, and a prize below the stake is a
partial loss. The result is the bet's [receipt](#receipt), `settled` or `rejected`:

```json title="Reply"
{
  "hookedin": true,
  "id": 4,
  "result": {
    "id": "coin-17",
    "kind": "casino-bet",
    "status": "settled",
    "stake": "1000000000000",
    "chance": "9223372036854775808",
    "prize": "1980000000000",
    "group": "session-3",
    "outcome": "4417924718259038112",
    "payout": "1980000000000"
  }
}
```

### `game.developerBet`

A developer bet: a bet against the game's developer. Its stake comes out of the game's allowance and goes into the
game's bank at once, and the bet is final. The game's server settles it when it chooses, on its developer's word, and
the player trusts the developer to pay. So the player allows developer bets apart from casino bets, in the wallet's dialog, after a warning
that says so: a game that places them says so with [`game.placesDeveloperBets`](#gameplacesdeveloperbets), and until
the player has allowed them, a developer bet is refused with `developer-bets-not-allowed`.

| Param   | Type           | Meaning                                                                                                                                |
| ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | `string`       | The game's ID for the operation                                                                                                        |
| `stake` | decimal string | Paid into the game's bank; at most the game's allowance and what its group holds                                                       |
| `meta`  | object         | The game's own JSON, saying what the bet is. The casino keeps it with the bet and never reads it; the developer's server settles by it |
| `group` | `string`       | Optional: the group the bet belongs to, such as a match or a spin                                                                      |

`meta` is a plain object of JSON values whose canonical JSON, keys sorted and no spaces, takes at most 4,096 bytes of
UTF-8. Its numbers are whole, so odds of 2.1 go as the string `"2.1"`.

The result is the bet's receipt at once: `open`, with `bet`, the hash that names it at the casino and to the developer,
or `rejected` when the casino did not take it. The same request again returns the receipt as it stands. Once the
developer has settled the bet, the wallet checks the developer's signed settlement, collects what it pays into the
channel, adds it to the game's allowance while the game is open, through the bet's group if it has one, and pushes the
settled receipt as a
[`game.receipt`](#gamereceipt-1) event. A game opened by its URL alone is published by nobody and takes no developer
bets: `invalid-request`. The developer's side is the [developer kit](../sdk/developer.md).

```json title="Request"
{
  "hookedin": true,
  "id": 5,
  "method": "game.developerBet",
  "params": {
    "id": "match-812-home",
    "stake": "1000000000000",
    "meta": { "pick": "home", "odds": "2.1" },
    "group": "match-812"
  }
}
```

```json title="Reply"
{
  "hookedin": true,
  "id": 5,
  "result": {
    "id": "match-812-home",
    "kind": "developer-bet",
    "status": "open",
    "stake": "1000000000000",
    "meta": { "pick": "home", "odds": "2.1" },
    "group": "match-812",
    "bet": "0x9ef313d092ad9d9f5f2ac313d77b5be958fdab15452b07fe9c2b5fc71fb804b0"
  }
}
```

### `game.payment`

A payment to the bankroll: the balance drops by `amount`, with no chance involved and no commission.

| Param    | Type           | Meaning                                                              |
| -------- | -------------- | -------------------------------------------------------------------- |
| `id`     | `string`       | The game's ID for the operation                                      |
| `amount` | decimal string | What is paid; at most the game's allowance and what its group holds  |
| `group`  | `string`       | Optional: the group the payment belongs to                           |
| `kept`   | decimal string | Optional, in a group: what of the group's cash the payment leaves it |

The result is the payment's receipt, `settled` or `rejected`. It carries no amount.

### `game.placesDeveloperBets`

Says the game places developer bets. No params; the result is `null`, at once, and nothing opens. A game never asks the
player for money: only the player opens the wallet's allowance dialog, from its top bar, and sets in its own words how
much of their balance the game may risk ([the allowance](../games/how-a-game-works.md#the-allowance)). Once a game has
said this, that dialog also warns that the game's developer takes developer bets' stakes and decides what they pay,
and confirming it allows developer bets too. A game opened by its URL alone has no developer, and its dialog offers
none. Taking the whole allowance back takes back developer bets with it.

### `game.allowance`

What the game may stake now. Answered at once.

| Param   | Type     | Meaning                                                                                            |
| ------- | -------- | -------------------------------------------------------------------------------------------------- |
| `group` | `string` | Optional: what a bet in this group may stake, the allowance and what the group holds, in its place |

| Result field    | Type           | Meaning                                                                                                         |
| --------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| `allowance`     | decimal string | What the game may stake: what the player sees in the top bar, or with `group`, that and what the group holds    |
| `pending`       | `boolean`      | A signed operation of this game awaits recovery in the wallet. While it does, no other bet or payment is signed |
| `developerBets` | `boolean`      | Whether the player allows the game's developer bets                                                             |

```json title="Reply"
{
  "hookedin": true,
  "id": 4,
  "result": { "allowance": "5980000000000", "pending": false, "developerBets": false }
}
```

### `game.end`

The player has seen how a group ended: what its bets won joins the allowance the wallet shows, as
[groups](#groups-and-the-allowance-the-player-sees) describes. Answered at once with `null`, also for a group that holds
nothing.

| Param   | Type     | Meaning   |
| ------- | -------- | --------- |
| `group` | `string` | The group |

## Events

The wallet sends this unasked, with `event` in place of an envelope ID, to the game's origin.

### `game.receipt`

A developer bet this game placed has been settled by its developer and collected by the wallet. The wallet looks for
settled bets every 10 minutes while its tab is visible, and at once when the game asks [`game.receipt`](#gamereceipt)
about an open one; it sends the event while the game is open.

It carries `receipt`, the bet's [receipt](#receipt) as `game.developerBet` answered it, now `settled` and with its
`payout`.

## Receipt

Every reply about an operation, whichever method asked, is one receipt under the game's own ID: how the operation ended,
never the signed evidence. The evidence, the channel and its balance stay in the wallet, and every receipt a game gets
is one the wallet checked.

| `kind`          | `status`                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `casino-bet`    | `settled`: done, and what it paid is in the player's balance. `rejected`: declined, the balance unchanged, with a signed checkpoint the wallet checked       |
| `payment`       | `settled` or `rejected`, as for a casino bet                                                                                                                 |
| `developer-bet` | `open`: its stake is in the game's bank. `settled`: its developer settled it and the wallet collected what that pays. `rejected`: the casino did not take it |

| Field     | Type           | Present                                                                                                                    |
| --------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `string`       | Always: the game's ID for the operation                                                                                    |
| `kind`    | `string`       | Always: `casino-bet`, `developer-bet` or `payment`                                                                         |
| `status`  | `string`       | Always: `settled`, `rejected` or `open`                                                                                    |
| `stake`   | decimal string | For a casino bet and a developer bet, as placed                                                                            |
| `chance`  | decimal string | For a casino bet, as placed                                                                                                |
| `prize`   | decimal string | For a casino bet, as placed                                                                                                |
| `meta`    | object         | For a developer bet, as placed                                                                                             |
| `group`   | `string`       | When the operation had one                                                                                                 |
| `bet`     | `bytes32` hex  | For a developer bet the casino took: the hash that names it at the casino and to its developer                             |
| `outcome` | decimal string | For a settled casino bet: its round's 64-bit outcome                                                                       |
| `payout`  | decimal string | For a settled casino bet, what it paid: its prize or `0`; for a settled developer bet, what its settlement paid the player |
| `reason`  | `string`       | For a rejection, when the casino gave one: a message for people                                                            |

A casino bet's payout rests on its round's revealed secret and seed, which the wallet checked against the hashes the bet
signed. A game draws its presentation from `outcome`: which bucket, which card, which reel stops. A developer bet's
payout rests on its developer's signed settlement, which is the developer's word. A rejected operation changed nothing,
and its ID keeps returning the rejection:

```json
{
  "id": "coin-18",
  "kind": "casino-bet",
  "status": "rejected",
  "stake": "1000000000000",
  "chance": "9223372036854775808",
  "prize": "2000000000000",
  "reason": "No quote of the casino covers this casino bet"
}
```

## Bounds

`wallet.hello` reports `bounds`, every bound the wallet holds a bet to:

| Field          | Value                    | Meaning                                                                     |
| -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `outcomeSpace` | `"18446744073709551616"` | 2^64: a round's outcome is below it, and a chance counts outcomes out of it |
| `meta`         | `4096`                   | The most bytes a developer bet's meta takes as canonical JSON               |
| `group`        | `64`                     | The longest group label, in characters                                      |

They are [part of the protocol revision](signed-messages.md#bounds-and-the-protocol-revision): the casino reports the
same numbers as `bounds` in [`GET /api/config`](../casino-api/public.md#get-apiconfig), and the developer kit's
[`DEVELOPER_PROTOCOL`](../sdk/developer.md#developer_protocol) hashes them. A game reads them rather than carrying
copies.

## Errors

A refusal is `{ code, message }`. The wallet's codes:

| `code`                       | Meaning                                                                                                                                                 | What a game does                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-request`            | The envelope or its parameters break a rule on this page, the envelope ID did not rise, or the request asks a developer bet of a game published nowhere | Fixes the request: sent again unchanged, it fails again                                                                                                                                                                                                    |
| `unknown-method`             | The wallet offers no such method                                                                                                                        | Keeps to the methods on this page                                                                                                                                                                                                                          |
| `busy`                       | The player is doing something in the wallet, or 32 requests already wait                                                                                | Sends the same request again shortly                                                                                                                                                                                                                       |
| `insufficient-allowance`     | The stake or amount exceeds the game's allowance and what its group holds                                                                               | Shows the message, which tells the player to set the allowance in the top bar; the same request can go again once they have                                                                                                                                |
| `developer-bets-not-allowed` | The player has not allowed the game's developer bets                                                                                                    | Shows the message, which tells the player to allow them in the top bar, after `game.placesDeveloperBets`                                                                                                                                                   |
| `pending-operation`          | A signed operation under another ID awaits recovery in the wallet                                                                                       | Waits: the wallet finishes a deposit it is taking in by itself, and the player recovers anything else from the wallet's banner. When `game.allowance`'s `pending` is `true` the operation is this game's, and sending it again under its own ID resumes it |
| `id-conflict`                | The ID is bound to other terms or another game, or a pending request under it differs                                                                   | Sends the terms saved with the ID, or a fresh ID for a fresh operation                                                                                                                                                                                     |
| `id-used`                    | The operation was carried out on another channel, and this wallet has no receipt of it                                                                  | Does not place it again under another ID without asking the player                                                                                                                                                                                         |
| `game-closed`                | The game is not the open one: the player left it, or closed it while its request waited                                                                 | Stops: the page is leaving                                                                                                                                                                                                                                 |
| `failed`                     | Anything else, such as a casino that did not answer or chain observations that are out of date                                                          | Sends the same request again under the same ID: nothing proves it was not signed, and the wallet resumes it if it was                                                                                                                                      |

A casino bet the casino declines is no error: it is a `rejected` receipt.

The SDK adds two codes of its own, which never cross the bridge:

| `code`      | Meaning                                                      | What a game does                                                                                                |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `no-wallet` | The page is not inside a frame, so there is no wallet to ask | Tells the player to open the game in the HookedIn wallet                                                        |
| `timeout`   | No reply came within 180 seconds                             | Asks `game.receipt` for the operation's ID, or sends the same request again: the wallet may have carried it out |

A refusal by the casino reaches the game with the casino's own code, such as `paused` when the casino has stopped
signing, or `rate-limited`; the [casino's errors](../casino-api/index.md#errors) list them. A code that is not a lower-case
letter followed by at most 39 lower-case letters and hyphens, such as a library's, is reported as `failed`.
