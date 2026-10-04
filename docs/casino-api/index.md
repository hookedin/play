---
title: Casino API
description: The casino's HTTP API, with its base URL, conventions, authentication, retries, pages, budgets, pauses and every error code.
---

The casino service answers one JSON-over-HTTP API. The wallet uses it to register channels, place bets and collect what
it is owed; a developer's server uses it to open rounds, place its casino bets and settle its developer bets; anyone can
read the public records. Games never call it: a game talks only to the wallet, over [the bridge](../reference/bridge.md).
The messages the API carries are specified on [Signed messages](../reference/signed-messages.md).

The routes are on three pages: [public](public.md), which need no authentication; [channels](channels.md), which need
[channel access](#authentication) and are the wallet's; and [developers](developers.md), which need
[developer access](#authentication) and are a developer's server's.

## Base URL

`https://casino.hookedin.com`. A wallet built without a configuration expects a local casino at
`http://127.0.0.1:4183` ([deployment](../reference/deployment.md)). Every route is under `/api/`. There is no WebSocket
or event stream: clients poll, and a developer's server [waits](public.md#get-apideveloper-bets) for its game's bets.

## Requests and replies

A request body is JSON of at most 1,000,000 bytes. The casino does not read `Content-Type`. Every `POST` needs a body
that parses as JSON, even where the route reads nothing from it (send `{}`). A route reads the body fields it lists and
ignores others.

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
`POST` only: a `GET` for a path with no `GET` route answers `404` `not-found`, and any other request without a route
`405` `unsupported-method`.

A request must arrive whole, headers included, within 10 seconds. An idle connection is closed after 5 seconds, and the
casino holds at most 512 connections at once.

## Values

| Value                                                   | On the wire                                                                                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amounts                                                 | Decimal strings of wei: `"1000000000000000"` is 1,000 µETH                                                                                                                                                      |
| Hashes and IDs                                          | `0x` followed by 64 lowercase hex digits. Path parameters also take upper-case hex, except a channel's `:id`, which must be lowercase                                                                           |
| Addresses                                               | Checksummed in openings, profiles, statements, `contractAddress`, `operator` and a casino bet's `developer`; lowercase in rounds and developer bets                                                             |
| Times in milliseconds since the Unix epoch              | `since`, `placedAt`, `settledAt`, a game record's `at`, `lastCheck`, `lastProgress`                                                                                                                             |
| Times in Unix seconds                                   | `expiresAt`, the fund's `at`, the observed block's `timestamp` and a channel's on-chain `deadline`                                                                                                              |
| Counts, indexes and the `sequence` of a holding or bank | JSON numbers                                                                                                                                                                                                    |
| Signed messages                                         | As signed: every `uint256` a decimal string, except an operation's `kind` and a token's `expiresAt`, which the wallet writes as numbers, and the zeros of an empty step, such as a rejection's evidence carries |

## Authentication

Two kinds of token travel in the `Authorization` header as `HookedIn <token>`, a signed message encoded as on
[Signed messages](../reference/signed-messages.md#access-tokens):

| Token            | Message                                  | Signed by                                        | Routes                                                                                                                             |
| ---------------- | ---------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Channel access   | `Access {channelId, expiresAt}`          | The channel's account                            | Every `/api/channels/:id/…` route                                                                                                  |
| Developer access | `DeveloperAccess {developer, expiresAt}` | The developer: the account that publishes a game | `POST /api/rounds`, `POST /api/rounds/:round/casino-bet`, `POST /api/developer-bets/settle`, `GET /api/developer-bets` with `wait` |

The casino accepts a token whose `expiresAt` is not in the past and at most 120 seconds ahead. A token is not bound to
one request and serves until it expires: the wallet signs one for 60 seconds and reuses it while at least 20 seconds
remain, and the [developer kit](../sdk/developer.md) signs one for each request.

A channel route answers `401` `unauthorized` to a missing, expired or wrongly signed token and to a channel it does not
know, before anything else: an unknown channel never answers `404`. The two routes that take an unknown channel are
[activation](channels.md#post-apichannelsidactivate) and the [uname](channels.md#post-apichannelsiduname), which check
the opening in their body and then the token against it. Opening a round needs a key whose account publishes a game; settling needs
only the key of the bets' developer, so a developer who takes their last game down still pays the bets placed on it.

The token only says who is asking. What a request commits to is signed in its body: an operation, a `Redeem`, a
`BankWithdraw`, a `Settlement` or a `BankCasinoBet`.

## Retries

An operation is known by its `details.id` and bound to the hash of what it signed. Sending the exact same request again
is always safe: if the casino recorded a reply, it answers with that reply again, with a fresh `quote` when the reply
is the channel's latest checkpoint; if it recorded none, it decides the request. So after a timeout or a dropped
connection, send the exact request again. The same ID with another operation is refused with `id-conflict`.

An error reply means nothing was recorded: `429`, `503` and `unconfirmed` are temporary, so send the same request
later; any other code says what to change, and a request with other terms is another operation, under another ID. A
wallet keeps a signed operation until it holds a reply: it never signs a different operation at the same sequence in
the meantime.

## Pages

The developer bet lists return `{bets, cursor, more}`. Pass `cursor` back as `after` while `more` is `true`. Open bets
come in the order they were placed and settled bets in the order they settled; each cursor is a decimal position in its
order, which survives restarts. An open cursor goes on to the bets placed since, leaving out those settled meanwhile, so
a server that follows it sees each bet once; start from the beginning to read every bet open now, and after `invalid`,
which answers an open cursor the casino's records do not reach, as after a restore of its database. A settled cursor
misses none: save it and resume from it, even after an empty page. `GET /api/players` and `GET /api/games/:key` take a
`limit` and have no cursor.

## Budgets and queues

The casino counts requests in fixed 60-second windows, each starting with a key's first request. A budget tracks at
most 1,024 keys and drops the oldest to make room. A spent budget answers `429` `rate-limited`.

| Budget                                                                                          | Per       | Requests a minute |
| ----------------------------------------------------------------------------------------------- | --------- | ----------------- |
| Every request but `OPTIONS`                                                                     | Client IP | 6,000             |
| Registering a channel the casino does not know, asking a uname, a Discord code and unlinking it | Client IP | 60                |
| Channel requests, after authentication                                                          | Channel   | 6,000             |
| Developer requests, after authentication                                                        | Developer | 6,000             |
| Publishing games                                                                                | Channel   | 200               |

The client IP is the connection's address; behind the production proxy it is the last `X-Forwarded-For` entry.

The casino does one thing at a time for each channel and for each shared thing a request touches: the bankroll fund, a
round, a profile, the counterparty of a credit, a developer's bank, the house cash withdrawals are paid from. Each of
these queues holds 8 waiting requests, a developer's bank 1,024, and at most 4,096 queues exist at once. At most four
channel registrations run at once. A full queue or a fifth registration answers `429` `busy`. A developer waits for
the bets of at most 4 games at once, and the casino holds at most 128 waits; one more answers `busy` too.

## Pauses

The casino stops signing while its chain observation fails or is more than 60 seconds old;
[`GET /api/status`](public.md#get-apistatus) shows why, in `status`, `stale` and `observationError`. Meanwhile every
`POST` answers `503` `paused`, except demo ETH, a uname, the activation of a channel the casino knows and an exact retry
of a recorded operation; so do `GET /api/fund`, `GET /api/developer-bets`, `GET /api/channels/:id/payouts` and
`GET /api/channels/:id/developer-bets`. Every other read goes on.

Once a write to its database fails, the casino stops until it restarts: every request, reads and `OPTIONS` included,
answers `503` `paused`.

## Errors

A refusal is `{"error": "…", "code": "…"}`: the text is for people, and the code is what a client acts on. Beside the
codes each route names, any request can be answered `rate-limited`, or `paused` ([pauses](#pauses)); a `POST`,
`too-large`, or `refused` when its body is not JSON; a channel or developer route, `unauthorized` first; and a route
that waits its turn, `busy`.

| Code                 | Status | Meaning                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid`            | 400    | A field, query parameter, cursor or signature in the request is malformed or does not match what it names. An operation whose details break [the details rules](../reference/signed-messages.md#details-and-memo) answers `409` with this code                                                                         |
| `unauthorized`       | 401    | The token is missing, expired, too far ahead or wrongly signed, the channel is unknown, or a developer key that publishes no game opens a round                                                                                                                                                                        |
| `not-found`          | 404    | No such path, name, game, round or developer bet, an account that verified no Discord account, or no demo ETH or Discord server here                                                                                                                                                                                   |
| `unsupported-method` | 405    | The path does not take this method                                                                                                                                                                                                                                                                                     |
| `unacknowledged`     | 409    | The previous reply's checkpoint is not countersigned: the acknowledgment is missing or names another checkpoint                                                                                                                                                                                                        |
| `channel-closed`     | 409    | The channel is closing or closed                                                                                                                                                                                                                                                                                       |
| `id-conflict`        | 409    | The operation ID is bound to another operation                                                                                                                                                                                                                                                                         |
| `not-due`            | 409    | A credit for money the casino does not owe                                                                                                                                                                                                                                                                             |
| `unconfirmed`        | 409    | A deposit operation for money the casino has not seen confirmed on-chain yet, or a loan of a deposit's network fee before the casino sees its transaction; the same request can go again later. A loan before the balance has taken its deposit in is refused the same way, and can go only once the take-in is signed |
| `round-revealed`     | 409    | Another casino bet has revealed the round                                                                                                                                                                                                                                                                              |
| `bank-short`         | 409    | The developer's bank cannot pay the stake, or the whole batch of settlements                                                                                                                                                                                                                                           |
| `too-many`           | 409    | The profile already publishes 100 games                                                                                                                                                                                                                                                                                |
| `refused`            | 409    | Anything else the casino considered and declined: a bad signature, an operation that is not next, a balance too small, a body that is not JSON, a chain read that failed                                                                                                                                               |
| `too-large`          | 413    | The body is over 1,000,000 bytes                                                                                                                                                                                                                                                                                       |
| `rate-limited`       | 429    | A request budget is spent; retry in the next window                                                                                                                                                                                                                                                                    |
| `busy`               | 429    | A queue is full, four channel registrations are in progress, or a wait for developer bets is one too many                                                                                                                                                                                                              |
| `paused`             | 503    | The casino has stopped signing                                                                                                                                                                                                                                                                                         |

A declined operation is not an error. It is a `200` reply with `status: "rejected"`, a rejection checkpoint and a
`reason`; `used: true` marks a game's operation its player already carried out on another channel. The proposal has
`casinoSignature: "0x"`. The wallet verifies and signs it, then repeats the operation with `rejectionSignature` for the
casino to complete the joint checkpoint ([operations](channels.md#post-apichannelsidoperations)).
