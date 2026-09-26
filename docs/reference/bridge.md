---
title: Game bridge
description: The postMessage protocol between a game page and the HookedIn wallet, with its envelopes, methods, events, receipts, limits and error codes.
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

| Field      | Type      | Meaning                                                                                                                 |
| ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hookedin` | `boolean` | Always `true`                                                                                                           |
| `id`       | `number`  | The envelope ID: a safe integer, at least 0, above every earlier request's since the frame loaded. The reply carries it |
| `method`   | `string`  | One of the [methods](#methods)                                                                                          |
| `params`   | object    | The method's parameters and no others: a plain object, which may be left out when the method takes none                 |

The wallet answers each request once, with the same `id` and either `result` or `error`. Here `null` is what
`game.receipt` answers for an operation the wallet has no record of:

```json title="Result"
{ "hookedin": true, "id": 7, "result": null }
```

```json title="Refusal"
{ "hookedin": true, "id": 8, "error": { "code": "insufficient-funds", "message": "Bet exceeds the game balance" } }
```

`code` is stable, and a game acts on it; `message` is for people. The codes are under [errors](#errors). An
[event](#events) the wallet sends unasked carries `event` in place of `id`.

## IDs

The envelope `id` only routes a reply. It must rise with every request since the frame last loaded a page; a request
whose ID does not is refused with `invalid-request`, and the SDK counts from 1. A request that fails the checks is
refused under its ID when that ID is a safe integer, and dropped unanswered otherwise.

The `id` inside a bet's or a payment's parameters is different: it is the game's own durable name for the operation, 1
to 64 letters, digits, `.`, `_`, `:` or `-`. The wallet keeps it for the player and the game, whichever channel the
operation is signed on, and apart for practice. The same request again returns the saved receipt, and other terms under
the same ID are refused with `id-conflict`. [State and recovery](../games/state-and-recovery.md) shows how a game uses
it.

## Origins

The wallet frames the game's entry page, and the entry page's origin is the game's. It accepts a message only from that
frame's window and that origin, and posts every reply and event to that origin alone: a frame that has navigated to
another origin is not the game, and hears nothing. It answers only the open game. A game accepts only messages whose
`source` is `window.parent`, as the SDK does.

When the frame loads a page, a reload included, the wallet forgets the page before it: IDs count afresh, its queued
requests are dropped, and replies to its requests are not sent. An operation the wallet already signed stands, and the
page that follows finds it with [`game.receipt`](#gamereceipt).

## Size

The wallet refuses with `invalid-request` a request whose estimated JSON size is above 70,000 characters, or that nests
deeper than 64 levels. A developer bet's meta is bounded more tightly, by the [limits](#limits).

## Queueing

`wallet.hello`, `wallet.info`, `wallet.round` and `game.receipt` are answered at once, also while a bet or the player's
dialog is open. `game.casinoBet`, `game.developerBet`, `game.payment` and `game.requestFunds` sign something or ask the
player, so they take their turn one at a time, in the order the game sent them. At most 32 wait; one more is refused
with `busy`. A request whose turn comes while the wallet is busy with another operation, its own or the player's, is
refused with `busy` too.

## Amounts

Every amount is a decimal string of whole smallest units of what the wallet plays with: digits only, no sign and no
leading zeros, below 2^256. ETH and test coins both count in units of 10^-18, so for ETH the unit is the wei. A stake, a
prize and an amount are above zero. A `group`, on a bet or a payment, is a label of 1 to 64 characters for operations
that belong together, such as the steps of one hand: the player signs it, and the wallet and the game's public record
show a group as one.

## Practice

A wallet with no funded channel practices, and so does one whose player chose to: `wallet.hello` says `practice: true`
and names the money `TEST`. It plays with test coins it keeps in the tab's memory, 100 at the start and 100 more once it
holds fewer than 10, and a reload starts again at 100. It settles `game.casinoBet` and `game.payment` itself, with the
same receipts and retry rules, holding a casino bet to the casino's own rule against a practice bankroll of ten million
coins and drawing its outcome itself. It signs nothing, sends the casino nothing and records nothing. It takes no
developer bets: a developer's server settles them at the casino, so `game.developerBet` is refused with `practice`. When
what the wallet plays with changes, because the player switched or a channel opened or closed, the wallet takes back the
game's balance and loads its page again, so a page is greeted once for each money.

## Methods

### `wallet.hello`

What this wallet offers, the money it plays with, and the bounds it holds a bet to. Answered at once. It takes no
parameters.

| Result field | Type       | Meaning                                                                                                        |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `methods`    | `string[]` | The methods this wallet offers: the eight on this page, and in practice all but `game.developerBet`            |
| `asset`      | object     | `{ symbol, decimals }`: `symbol` is `ETH` or `Sepolia ETH`, or `TEST` in practice; `decimals` is 18            |
| `practice`   | `boolean`  | The wallet [practices](#practice): it plays with test coins of its own, and nothing it does reaches the casino |
| `chainId`    | `string`   | The chain the wallet is pinned to, in decimal: `11155111` for Sepolia, `31337` for a local Anvil               |
| `limits`     | object     | The bounds a bet is held to: see [limits](#limits)                                                             |

```json title="Request"
{ "hookedin": true, "id": 1, "method": "wallet.hello", "params": {} }
```

```json title="Reply"
{
  "hookedin": true,
  "id": 1,
  "result": {
    "methods": [
      "wallet.hello",
      "wallet.info",
      "wallet.round",
      "game.receipt",
      "game.casinoBet",
      "game.developerBet",
      "game.payment",
      "game.requestFunds"
    ],
    "asset": { "symbol": "Sepolia ETH", "decimals": 18 },
    "practice": false,
    "chainId": "11155111",
    "limits": { "outcomeSpace": "18446744073709551616", "meta": 4096, "group": 64 }
  }
}
```

### `wallet.info`

Everything a game learns about the player, and what to price bets against. Answered at once. It takes no parameters.
The player's address, channel and balances are not a game's to know.

| Result field       | Type               | Meaning                                                                                                                                                                        |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uname`            | `string` or `null` | The player's uname, theirs for good, written `~uname`. `null` until the casino knows the player, which it does once they fund a channel. A game keys anything of its own by it |
| `alias`            | `string` or `null` | The name the player is shown by, written `@alias`; `null` unless they took one                                                                                                 |
| `chainId`          | `string`           | As in `wallet.hello`                                                                                                                                                           |
| `bankroll`         | decimal string     | The casino's bankroll as last reported, or in practice the practice bankroll: what to price bets against, not a promise to admit them                                          |
| `recommendedStake` | decimal string     | A stake to start the stake field at: 10^12 wei on Sepolia, 10^15 on a local Anvil, one coin in practice                                                                        |

```json title="Request"
{ "hookedin": true, "id": 2, "method": "wallet.info", "params": {} }
```

```json title="Reply"
{
  "hookedin": true,
  "id": 2,
  "result": {
    "uname": "3byt9ocwnnzaxanmiz3stocj",
    "alias": "Bob",
    "chainId": "11155111",
    "bankroll": "4861203318520114210",
    "recommendedStake": "1000000000000"
  }
}
```

### `wallet.round`

A developer's round, as the casino shows it to anyone at
[`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround), read through the wallet. Answered at once.

| Param | Type          | Meaning                           |
| ----- | ------------- | --------------------------------- |
| `id`  | `bytes32` hex | The round, `0x` and 64 hex digits |

The result is the casino's reply as it came: `{ id, developer, status }`, and once the developer's casino bet has
revealed the round, its `seed`, `secret`, `outcome` and `casinoBet`. The wallet checks none of it. A game whose players
share one draw, such as roulette, checks its developer's rounds with it: each secret hashes to its round, each seed to
the seed hash its bet signed, and the outcomes lead where the game says. A round the casino does not know is refused
with the casino's `not-found`.

```json title="Request"
{
  "hookedin": true,
  "id": 9,
  "method": "wallet.round",
  "params": { "id": "0x21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c" }
}
```

### `game.receipt`

The receipt of an earlier operation of this game, by the game's own ID. Answered at once.

| Param | Type     | Meaning            |
| ----- | -------- | ------------------ |
| `id`  | `string` | The operation's ID |

The result is the operation's [receipt](#receipt), or `null` when this wallet has none: the operation was never signed,
it is still pending (the pushed `pending` says so), or this wallet has lost its record. For an open developer bet the
wallet also asks the casino about it; once its developer has settled it, the wallet collects what it pays and pushes the
settled receipt as a [`game.receipt`](#gamereceipt-1) event.

```json title="Request"
{ "hookedin": true, "id": 7, "method": "game.receipt", "params": { "id": "coin-17" } }
```

```json title="Reply"
{
  "hookedin": true,
  "id": 7,
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

### `game.casinoBet`

A casino bet: settled against the casino's bankroll in the one request, on the player's own round. The casino names the
round before the wallet picks the seed, so neither knows the outcome before both are out. The game's balance drops by
the stake, and rises by the prize when the round's 64-bit outcome is below the chance; the casino's commission is not
charged to the player. The casino may decline the bet instead, with a signed checkpoint that leaves the balance
unchanged. In [practice](#practice) the wallet settles it itself, by the same rules.

| Param    | Type           | Meaning                                          |
| -------- | -------------- | ------------------------------------------------ |
| `id`     | `string`       | The game's ID for the operation                  |
| `stake`  | decimal string | Paid to enter; at most the game's balance        |
| `chance` | decimal string | How many of the 2^64 outcomes win: 1 to 2^64 − 1 |
| `prize`  | decimal string | What the bet pays when it wins; below 2^128      |
| `group`  | `string`       | Optional: the group the bet belongs to           |

The outcome is a uniform integer below 2^64, so the bet wins with probability `chance / 2^64`. A chance of 0, or of
2^64 or more, is refused with `invalid-request`: a sure loss or a sure win is no bet. So is a prize of 2^128 or more,
which no balance can hold. The stake was paid to enter, so a
win gains `prize − stake`, and a prize below the stake is a partial loss. The result is the bet's receipt, `settled` or
`rejected`.

```json title="Request"
{
  "hookedin": true,
  "id": 4,
  "method": "game.casinoBet",
  "params": {
    "id": "coin-17",
    "stake": "1000000000000",
    "chance": "9223372036854775808",
    "prize": "1980000000000",
    "group": "session-3"
  }
}
```

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

A developer bet: a bet against the game's developer. Its stake leaves the game's balance and goes into the developer's
bank at once, and the bet is final. The developer settles it when it chooses, on its word, and the player trusts it to
pay. In [practice](#practice) it is refused with `practice`.

| Param   | Type           | Meaning                                                                                                                                |
| ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | `string`       | The game's ID for the operation                                                                                                        |
| `stake` | decimal string | Paid into the developer's bank; at most the game's balance                                                                             |
| `meta`  | object         | The game's own JSON, saying what the bet is. The casino keeps it with the bet and never reads it; the developer's server settles by it |
| `group` | `string`       | Optional: the group the bet belongs to, such as a match or a spin                                                                      |

`meta` is a plain object of JSON values whose canonical JSON, keys sorted and no spaces, takes at most 4,096 bytes of
UTF-8. Its numbers are whole, so odds of 2.1 go as the string `"2.1"`.

The result is the bet's receipt at once: `open`, with `bet`, the hash that names it at the casino and to the developer,
or `rejected` when the casino did not take it. The same request again returns the receipt as it stands. Once the
developer has settled the bet, the wallet checks the developer's signed settlement, collects what it pays into the
channel, raises the game's balance by it while the game is open, and pushes the settled receipt as a
[`game.receipt`](#gamereceipt-1) event. A game loaded straight from its manifest is published by nobody and takes no
developer bets: `invalid-request`. The developer's side is the [developer kit](../sdk/developer.md).

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

A payment to the bankroll: the balance drops by `amount`, with no chance involved and no commission. In
[practice](#practice) the wallet settles it itself.

| Param    | Type           | Meaning                                    |
| -------- | -------------- | ------------------------------------------ |
| `id`     | `string`       | The game's ID for the operation            |
| `amount` | decimal string | What is paid; at most the game's balance   |
| `group`  | `string`       | Optional: the group the payment belongs to |

The result is the payment's receipt, `settled` or `rejected`. It carries no amount.

```json title="Request"
{
  "hookedin": true,
  "id": 6,
  "method": "game.payment",
  "params": { "id": "hand-9-insurance", "amount": "500000000000", "group": "hand-9" }
}
```

```json title="Reply"
{
  "hookedin": true,
  "id": 6,
  "result": { "id": "hand-9-insurance", "kind": "payment", "status": "settled", "group": "hand-9" }
}
```

### `game.requestFunds`

Asks the player for money. The wallet opens its own dialog, in its own words, where the player sets how much of their
playing balance the game may risk, or declines. The game passes it an amount and nothing else, and only the player's
confirmation there grants a game money. The reply comes once the player has decided. In [practice](#practice) the amount
is in test coins, and the dialog also shows the player the way to ETH.

| Param    | Type           | Meaning                                                                                                                  |
| -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `amount` | decimal string | Optional: how much more than the game holds. The dialog suggests the game's balance plus this, up to the playing balance |

| Result field | Type                     | Meaning                                                                                   |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------------- |
| `funded`     | `boolean`                | Whether the player set a limit                                                            |
| `amount`     | decimal string or `null` | The limit the player set, which may be lower than the game had; `null` when they declined |
| `balance`    | decimal string           | The game's balance after it                                                               |
| `pending`    | `boolean`                | Whether an operation of this game awaits recovery                                         |

The player can raise or lower the limit from the wallet's top bar at any time as well, and [`game.balance`](#gamebalance)
reports every change.

```json title="Request"
{ "hookedin": true, "id": 3, "method": "game.requestFunds", "params": { "amount": "5000000000000" } }
```

```json title="Reply"
{
  "hookedin": true,
  "id": 3,
  "result": { "funded": true, "amount": "5000000000000", "balance": "5000000000000", "pending": false }
}
```

## Events

The wallet sends these unasked, with `event` in place of an envelope ID, to the entry page's origin.

### `game.balance`

The game's balance: what it may still risk in this tab, including its winnings. The wallet sends it when the frame has
loaded and whenever the balance or `pending` changes, so there is nothing to poll. The balance lives in the tab's memory
only: leaving the game, reloading or closing the tab releases it, and the money never left the channel.

| Field     | Type           | Meaning                                                                                                                                     |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `balance` | decimal string | What the game may still risk, in what the wallet plays with                                                                                 |
| `pending` | `boolean`      | A signed operation of this game awaits recovery in the wallet. While it does, no other bet or payment is signed. Always `false` in practice |

```json
{ "hookedin": true, "event": "game.balance", "balance": "5980000000000", "pending": false }
```

### `game.receipt`

A developer bet this game placed has been settled by its developer and collected by the wallet. The wallet looks for
settled bets every 4 seconds, and at once when the game asks [`game.receipt`](#gamereceipt) about an open one; it sends
the event while the game is open.

| Field     | Type                | Meaning                                         |
| --------- | ------------------- | ----------------------------------------------- |
| `receipt` | [Receipt](#receipt) | The bet's receipt, `settled`, with its `payout` |

```json
{
  "hookedin": true,
  "event": "game.receipt",
  "receipt": {
    "id": "match-812-home",
    "kind": "developer-bet",
    "status": "settled",
    "stake": "1000000000000",
    "meta": { "pick": "home", "odds": "2.1" },
    "group": "match-812",
    "bet": "0x9ef313d092ad9d9f5f2ac313d77b5be958fdab15452b07fe9c2b5fc71fb804b0",
    "payout": "2100000000000"
  }
}
```

## Receipt

Every reply about an operation, whichever method asked, is one receipt under the game's own ID: how the operation ended,
never the signed evidence. The evidence, the channel and its balance stay in the wallet, and every receipt a game gets
is one the wallet checked.

| `kind`          | `status`                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `casino-bet`    | `settled`: done, and what it paid is in the channel, or in practice in the wallet's test coins. `rejected`: declined, the balance unchanged, with a signed checkpoint the wallet checked, or in practice by the casino's rule |
| `payment`       | `settled` or `rejected`, as for a casino bet                                                                                                                                                                                  |
| `developer-bet` | `open`: its stake is in the developer's bank. `settled`: its developer settled it and the wallet collected what that pays. `rejected`: the casino did not take it                                                             |

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
  "reason": "The bankroll cannot take this casino bet"
}
```

## Limits

`wallet.hello` reports `limits`, every bound the wallet holds a bet to:

| Field          | Value                    | Meaning                                                                     |
| -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `outcomeSpace` | `"18446744073709551616"` | 2^64: a round's outcome is below it, and a chance counts outcomes out of it |
| `meta`         | `4096`                   | The most bytes a developer bet's meta takes as canonical JSON               |
| `group`        | `64`                     | The longest group label, in characters                                      |

They are part of the protocol revision the wallet and its casino share, the same numbers the casino reports as
`limits` in [`GET /api/config`](../casino-api/public.md#get-apiconfig) and the [developer kit](../sdk/developer.md#limits)
reads: a wallet or a developer that holds other ones stops before it signs anything. A game reads them rather than
carrying copies.

## Errors

A refusal is `{ code, message }`. The wallet's codes:

| `code`               | Meaning                                                                                                                                                 | What a game does                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-request`    | The envelope or its parameters break a rule on this page, the envelope ID did not rise, or the request asks a developer bet of a game published nowhere | Fixes the request: sent again unchanged, it fails again                                                                                                                    |
| `unknown-method`     | The wallet offers no such method                                                                                                                        | Keeps to the `methods` of `wallet.hello`                                                                                                                                   |
| `busy`               | The wallet is carrying out another operation, its own or the player's, or 32 requests already wait                                                      | Sends the same request again shortly                                                                                                                                       |
| `insufficient-funds` | The stake or amount exceeds the game's balance                                                                                                          | Calls `game.requestFunds`, then sends the same request again                                                                                                               |
| `pending-operation`  | A signed operation under another ID awaits recovery in the wallet                                                                                       | Waits: the player recovers it from the wallet's banner. When the pushed `pending` is `true` the operation is this game's, and sending it again under its own ID resumes it |
| `id-conflict`        | The ID is bound to other terms or another game, or a pending request under it differs                                                                   | Sends the terms saved with the ID, or a fresh ID for a fresh operation                                                                                                     |
| `id-used`            | The operation was carried out on another channel, and this wallet has no receipt of it                                                                  | Does not place it again under another ID without asking the player                                                                                                         |
| `game-closed`        | The game is not the open one: the player left it, or closed it while its request waited                                                                 | Stops: the page is leaving                                                                                                                                                 |
| `practice`           | The wallet practices, and takes no developer bets                                                                                                       | Lets the player watch, and says that the game plays with ETH                                                                                                               |
| `failed`             | Anything else, such as a casino that did not answer or chain observations that are out of date                                                          | Sends the same request again under the same ID: nothing proves it was not signed, and the wallet resumes it if it was                                                      |

A casino bet the casino declines is no error: it is a `rejected` receipt.

The SDK adds two codes of its own, which never cross the bridge:

| `code`      | Meaning                                                      | What a game does                                                                                                |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `no-wallet` | The page is not inside a frame, so there is no wallet to ask | Tells the player to open the game in the HookedIn wallet                                                        |
| `timeout`   | No reply came within 180 seconds                             | Asks `game.receipt` for the operation's ID, or sends the same request again: the wallet may have carried it out |

A refusal by the casino reaches the game with the casino's own code, such as `paused` when the casino has stopped
signing, or `rate-limited`; the [casino's errors](../casino-api/index.md#errors) list them. A code that is not a lower-case
letter followed by at most 39 lower-case letters and hyphens, such as a library's, is reported as `failed`.
