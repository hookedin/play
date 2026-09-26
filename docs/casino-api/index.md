---
title: Casino API
description: The casino's HTTP API, with its base URL, conventions, authentication, retries, pages, budgets, pauses and every error code.
---

The casino service answers one JSON-over-HTTP API. The wallet uses it to register channels, place bets and collect what
it is owed; a developer's server uses it to open rounds, place its casino bets and settle its developer bets; anyone can
read the public records. Games never call it: a game talks only to the wallet, over [the bridge](../reference/bridge.md).
The messages the API carries are specified on [Signed messages](../reference/signed-messages.md).

## Base URL

`https://casino.hookedin.com`. A wallet built without a configuration expects a local casino at
`http://127.0.0.1:4183` ([deployment](../reference/deployment.md)). Every route is under `/api/`, except `GET /`. There
is no WebSocket or event stream: clients poll.

## Endpoints

**[Public](public.md)**, no authentication:

| Endpoint                                                             | What it answers                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`GET /api/config`](public.md#get-apiconfig)                         | The deployment, the protocol revision and the limits                          |
| [`GET /api/status`](public.md#get-apistatus)                         | Health, the books, developer earnings, the last observed block and the commit |
| [`GET /`](public.md#get-)                                            | The same as `GET /api/status`, outside the request budgets                    |
| [`GET /api/metrics`](public.md#get-apimetrics)                       | Health and the books                                                          |
| [`GET /api/fund`](public.md#get-apifund)                             | The bankroll fund, signed                                                     |
| [`GET /api/players`](public.md#get-apiplayers)                       | Every player's public record, the most played first                           |
| [`GET /api/players/:name`](public.md#get-apiplayersname)             | One player's public record                                                    |
| [`GET /api/players/:name/:game`](public.md#get-apiplayersnamegame)   | A game a player publishes                                                     |
| [`GET /api/games/:key`](public.md#get-apigameskey)                   | A game's settled bets and their totals                                        |
| [`GET /api/rounds/:round`](public.md#get-apiroundsround)             | A developer's round                                                           |
| [`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet) | One developer bet                                                             |
| [`GET /api/developer-bets`](public.md#get-apideveloper-bets)         | A page of one game's developer bets                                           |
| [`POST /api/faucet`](public.md#post-apifaucet)                       | Demo ETH, on a local Anvil stack only                                         |

**[Channels](channels.md)**, with channel access:

| Endpoint                                                                                              | What it does                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`POST /api/channels/:id/activate`](channels.md#post-apichannelsidactivate)                           | Registers a channel                              |
| [`GET /api/channels/:id`](channels.md#get-apichannelsid)                                              | The channel as the casino holds it               |
| [`POST /api/channels/:id/round`](channels.md#post-apichannelsidround)                                 | Names the round of the channel's next casino bet |
| [`POST /api/channels/:id/operations`](channels.md#post-apichannelsidoperations)                       | Submits a signed operation                       |
| [`GET /api/channels/:id/operations/:operationId`](channels.md#get-apichannelsidoperationsoperationid) | The recorded reply to one operation              |
| [`POST /api/channels/:id/ack`](channels.md#post-apichannelsidack)                                     | Countersigns the latest checkpoint               |
| [`POST /api/channels/:id/close`](channels.md#post-apichannelsidclose)                                 | The casino's `Close` signature                   |
| [`GET /api/channels/:id/payouts`](channels.md#get-apichannelsidpayouts)                               | What the casino owes the player                  |
| [`GET /api/channels/:id/developer-bets`](channels.md#get-apichannelsiddeveloper-bets)                 | The account's developer bets                     |
| [`GET /api/channels/:id/fund`](channels.md#get-apichannelsidfund)                                     | The player's shares in the bankroll fund         |
| [`POST /api/channels/:id/fund/redeem`](channels.md#post-apichannelsidfundredeem)                      | Redeems shares                                   |
| [`GET /api/channels/:id/bank`](channels.md#get-apichannelsidbank)                                     | The account's developer bank                     |
| [`POST /api/channels/:id/bank/withdraw`](channels.md#post-apichannelsidbankwithdraw)                  | Withdraws from the bank                          |
| [`POST /api/channels/:id/alias`](channels.md#post-apichannelsidalias)                                 | Takes or gives up an alias                       |
| [`POST /api/channels/:id/games`](channels.md#post-apichannelsidgames)                                 | Publishes or removes a game                      |

**[Developers](developers.md)**, with developer access:

| Endpoint                                                                            | What it does                                               |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`POST /api/rounds`](developers.md#post-apirounds)                                  | Opens a round                                              |
| [`POST /api/rounds/:round/casino-bet`](developers.md#post-apiroundsroundcasino-bet) | Places the developer's casino bet, which reveals the round |
| [`POST /api/developer-bets/settle`](developers.md#post-apideveloper-betssettle)     | Settles developer bets                                     |

## Requests and replies

A request body is JSON of at most 1,000,000 bytes; a larger one is refused with `too-large`. The casino does not read
`Content-Type`. Every `POST` needs a body that parses as JSON, even where the route reads nothing from it (send `{}`):
an empty or malformed body is refused with `refused`. A route reads the body fields it lists and ignores others, except
where it says so.

Every reply is JSON, errors included, with these headers:

```text
content-type: application/json
cache-control: no-store
access-control-allow-origin: *
access-control-allow-methods: GET,POST,OPTIONS
access-control-allow-headers: content-type,authorization
access-control-max-age: 7200
x-content-type-options: nosniff
```

Any origin may call the API, and no cookies are used. `OPTIONS` on any path answers `204` with these headers and no
body, before any budget or body is read, so a browser's preflight is asked once in two hours. The API takes `GET` and
`POST` only. A `GET` for a path with no `GET` route answers `404` with `not-found`, and any other request without a
route answers `405` with `unsupported-method`; `GET /api/rounds`, `GET /api/rounds/:round/casino-bet` and
`GET /api/developer-bets/settle` answer `405` too.

A request must arrive whole, headers included, within 10 seconds. An idle connection is closed after 5 seconds, and the
casino holds at most 512 connections at once.

## Values

| Value                                                   | On the wire                                                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amounts                                                 | Decimal strings of wei: `"1000000000000000"` is 0.001 ETH                                                                                                   |
| Hashes and IDs                                          | `0x` followed by 64 lowercase hex digits. Path parameters also take upper-case hex, except a channel's `:id` and an `:operationId`, which must be lowercase |
| Addresses                                               | Checksummed in openings, profiles, statements, `contractAddress`, `operator` and a casino bet's `developer`; lowercase in rounds and developer bets         |
| Times in milliseconds since the Unix epoch              | `since`, `placedAt`, `settledAt`, a game record's `at`, `lastCheck`, `lastProgress`                                                                         |
| Times in Unix seconds                                   | `expiresAt`, the fund's `at`, the observed block's `timestamp`, a channel's on-chain `deadline` and a claim's `finalizedAt`                                 |
| Counts, indexes and the `sequence` of a holding or bank | JSON numbers                                                                                                                                                |
| Signed messages                                         | As signed: every `uint256` a decimal string, except an operation's `kind` and a token's `expiresAt`, which the wallet writes as numbers                     |

## Authentication

Two kinds of token travel in the `Authorization` header as `HookedIn <token>`, a signed message encoded as on
[Signed messages](../reference/signed-messages.md#access-tokens):

| Token            | Message                                  | Signed by                                        | Routes                                                                                      |
| ---------------- | ---------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Channel access   | `Access {channelId, expiresAt}`          | The channel key registered for the channel       | Every `/api/channels/:id/…` route                                                           |
| Developer access | `DeveloperAccess {developer, expiresAt}` | The developer: the account that publishes a game | `POST /api/rounds`, `POST /api/rounds/:round/casino-bet`, `POST /api/developer-bets/settle` |

The casino accepts a token whose `expiresAt` is not in the past and at most 120 seconds ahead. A token is not bound to
one request and serves until it expires: the wallet signs one for 60 seconds and reuses it while at least 20 seconds
remain, and the [developer kit](../sdk/developer.md) signs one for each request.

A channel route answers `401` with `unauthorized` to a missing, expired or wrongly signed token and to a channel it does
not know, before anything else: an unknown channel never answers `404`. `:id` must be the channel ID in lowercase. The
one route that takes an unknown channel is [activation](channels.md#post-apichannelsidactivate), which checks the token
against the opening in its body. Opening a round needs a key whose account publishes a game
(`401`, "This key publishes no game"). Settling needs only the key of the bets' developer, so a developer who takes their
last game down still pays the bets placed on it.

The token only says who is asking. What a request commits to is signed in its body: an operation, a `Redeem`, a
`Withdraw`, a `Close`, a `Settlement` or a `BankCasinoBet`.

## Operations and retries

A channel runs one operation at a time:

1. The wallet signs the operation and saves it, with a casino bet's seed, before sending anything.
2. It sends it to [`POST /api/channels/:id/operations`](channels.md#post-apichannelsidoperations) with its
   countersignature of the previous reply's checkpoint as `acknowledgment`.
3. The casino records its signed result or signed rejection before the reply leaves.
4. The wallet checks the reply, countersigns the reply's checkpoint and saves both; it posts the countersignature to
   [`…/ack`](channels.md#post-apichannelsidack) and sends it again with its next operation.

An operation is known by its `details.id` and bound to the hash of what it signed. Sending the exact same request again
is always safe: if the casino recorded a reply, it answers with that reply again, with a fresh `bankroll` and, after a
casino bet, the channel's `nextRound`; if it recorded none, it decides the request. The same ID with another operation is
refused with `id-conflict`.

After a timeout or a dropped connection the outcome is unknown. Ask
[`GET /api/channels/:id/operations/:operationId`](channels.md#get-apichannelsidoperationsoperationid) with the
operation's `details.id`: `200` is the recorded reply, and `404` means none is recorded, so the exact request can go
again. An error reply means no result was recorded: `429` and `503` are temporary, so send the same request later; any
other code says what to change, and a request with other terms is another operation, under another ID. A wallet keeps a signed
operation until it holds a reply: it never signs a different operation at the same sequence in the meantime. The
casino answers an exact retry of a recorded operation even while its chain observation is stale.

## Pages

The developer bet lists return `{bets, cursor, more}`. Pass `cursor` back as `after` while `more` is `true`. Open bets
come in hash order and their cursor is the last hash: the set changes as bets settle, so start from the beginning on
each refresh. Settled bets come in the order they settled and their cursor is a decimal position in that order, which
survives restarts: save it and resume from it, even after an empty page. `GET /api/players` and `GET /api/games/:key`
take a `limit` only.

## Budgets and queues

The casino counts requests in fixed 60-second windows, each starting with a key's first request. A budget tracks at
most 1,024 keys and drops the oldest to make room. A spent budget answers `429` with `rate-limited`.

| Budget                                         | Per       | Requests a minute |
| ---------------------------------------------- | --------- | ----------------- |
| Every `/api/` request                          | Client IP | 6,000             |
| Registering a channel the casino does not know | Client IP | 60                |
| Channel requests, after authentication         | Channel   | 6,000             |
| Developer requests, after authentication       | Developer | 6,000             |
| Alias and game changes                         | Channel   | 200               |

`GET /` and `OPTIONS` count against no budget, and the local faucet takes one request a second. The client IP is the
connection's address; behind the production proxy it is the last `X-Forwarded-For` entry.

The casino does one thing at a time for each channel and for each shared thing a request touches: the bankroll fund, a
round, a profile, the counterparty of a credit, a developer's bank. Each of these queues holds 8 waiting requests, a
developer's bank 1,024, and at most 4,096 queues exist at once. At most four channel registrations run at once. A full
queue or a fifth registration answers `429` with `busy`.

## Pauses

The casino stops signing when its chain observation fails or is more than 60 seconds old, or when a write to its
signing history or its database fails. [`GET /api/status`](public.md#get-apistatus) shows why: `status`, `stale` and
`observationError`. While paused, every `POST` answers `503` with `paused`, except the local faucet, the activation of
a channel the casino already knows, and, while only the chain observation is at fault, an exact retry of a recorded
operation. So do `GET /api/fund`, `GET /api/developer-bets`, `GET /api/channels/:id/payouts` and
`GET /api/channels/:id/developer-bets`. Every other read goes on, so a wallet can always recover its latest evidence.

## Errors

A refusal is `{"error": "…", "code": "…"}`: the text is for people, and the code is what a client acts on.

```json
{ "error": "Unsupported method", "code": "unsupported-method" }
```

| Code                 | Status | Meaning                                                                                                                                                                                                                                        |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid`            | 400    | A field, query parameter, cursor or signature in the request is malformed or does not match what it names. An operation whose details break [the details rules](../reference/signed-messages.md#details-and-memo) answers `409` with this code |
| `reserved`           | 400    | The alias is one the casino keeps for itself                                                                                                                                                                                                   |
| `unauthorized`       | 401    | The token is missing, expired, too far ahead or wrongly signed, the channel is unknown, or a developer key that publishes no game opens a round. The local faucet answers `403` with this code to anything but the local wallet                |
| `not-funded`         | 403    | Taking an alias or publishing a game needs an open channel                                                                                                                                                                                     |
| `not-found`          | 404    | No such path, name, game, round, developer bet or recorded operation, or the faucet is not offered                                                                                                                                             |
| `unsupported-method` | 405    | The path does not take this method                                                                                                                                                                                                             |
| `unacknowledged`     | 409    | The previous reply's checkpoint is not countersigned: the acknowledgment is missing or names another checkpoint                                                                                                                                |
| `channel-closed`     | 409    | The channel is closing or closed                                                                                                                                                                                                               |
| `id-conflict`        | 409    | The operation ID is bound to another operation                                                                                                                                                                                                 |
| `not-due`            | 409    | A credit for money the casino does not owe                                                                                                                                                                                                     |
| `round-revealed`     | 409    | Another casino bet has revealed the round                                                                                                                                                                                                      |
| `bank-short`         | 409    | The developer's bank cannot pay the stake, or the whole batch of settlements                                                                                                                                                                   |
| `taken`              | 409    | Another player holds the alias, or one that reads the same                                                                                                                                                                                     |
| `too-many`           | 409    | The profile already publishes 100 games                                                                                                                                                                                                        |
| `refused`            | 409    | Anything else the casino considered and declined: a bad signature, an operation that is not next, a balance too small, a body that is not JSON, a chain read that failed                                                                       |
| `too-large`          | 413    | The body is over 1,000,000 bytes                                                                                                                                                                                                               |
| `rate-limited`       | 429    | A request budget is spent; retry in the next window                                                                                                                                                                                            |
| `busy`               | 429    | A queue is full, or four channel registrations are in progress                                                                                                                                                                                 |
| `paused`             | 503    | The casino has stopped signing                                                                                                                                                                                                                 |

A declined operation is not an error. It is a `200` reply with `status: "rejected"`, a signed rejection checkpoint and
a `reason`; `used: true` marks a game's operation its player already carried out on another channel.
