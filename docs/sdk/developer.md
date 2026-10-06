---
title: Developer kit
description: Reference for @hookedin/play/sdk/developer, the kit a game's server opens rounds, places its casino bets and settles developer bets with.
sidebar:
  order: 4
---

`import { createDeveloper } from '@hookedin/play/sdk/developer';` is the server side of a game with developer bets. The
module is Node-safe and runs wherever `fetch` does: Node, a Cloudflare Worker, a browser. Every call goes to the
casino's public API. [Developer bets](../games/developer-bets.md) is the guide, with the order of requests; the kit
signs with the game's server key, which its developer names on the wallet's **Developer** page.

```ts
import { createDeveloper } from '@hookedin/play/sdk/developer';

const developer = await createDeveloper({
  casinoURL: 'https://casino.hookedin.com',
  key: process.env.SERVER_KEY!,
  game: process.env.GAME!,
});
const round = await developer.openRound();
const seedHash = await developer.seedHash(round.id); // commit to both before anybody bets
```

## The developer

### `createDeveloper`

| Parameter   | Meaning                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `casinoURL` | The casino's base URL, without a trailing slash: `https://casino.hookedin.com`, or `http://127.0.0.1:4183` locally     |
| `key`       | The private key of the game's server, hex: the key its developer named, or the developer's own                         |
| `game`      | The game's [ID](../reference/signed-messages.md#game-ids), which the wallet's **Developer** page shows beside the game |

It reads [`GET /api/config`](../casino-api/public.md#get-apiconfig) and throws an `Error` with code `protocol-mismatch`
when the casino's `developerProtocol` is not the one this kit signs for: the casino speaks another revision of what a
developer signs ([signed messages](../reference/signed-messages.md)).

Every member that calls the casino rejects with an `Error` when the casino refuses: its message is the casino's `error`,
and it carries `status`, the HTTP status, and `code`, the casino's [error code](../casino-api/index.md#errors). A
request only the game's server may make carries a `DeveloperAccess` token signed with the key and valid for 60
seconds. A
request the casino has not answered in a minute is abandoned, and rejects with a `TimeoutError`.

### `Developer`

What `createDeveloper` resolves with: one game's server. Besides the members below, `round(id)` reads
a round as anyone may, revealed or not ([`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround)).

#### `virtualBankroll`

The casino's virtual bankroll, half its bankroll, as it last reported it in
[`GET /api/status`](../casino-api/public.md#get-apistatus): what it admits the game's casino bets against, and so
what to price them against, such as a shared draw's [binary steps](steps.md#pricesteps), not a promise to admit them.

#### `openRound`

A new round for the game's casino bet, named by the casino by the hash of a secret it keeps
([`POST /api/rounds`](../casino-api/developers.md#post-apirounds)). Every call names another round, `open`.

#### `seedHash`

The hash of the seed the game's casino bet on a round brings. It makes no request: the seed is `keccak256` of the
key's signature of the round (an Ethereum signed message over its 32 bytes), so only this key knows it before the bet,
and the same round always gets the same seed.

#### `casinoBet`

Places the game's casino bet on one of its rounds, a [`BankCasinoBet`](#bankcasinobet), from its bank, and
resolves with the revealed round
([`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet)). It signs the round,
the game, the stake, the chance, the prize, the group, the hash of the seed and the hash of `meta`, and sends the seed
with it. The round's `casinoBet.accepted` says whether the bankroll took it; either way the round is revealed. Placing
it again after a lost reply is the same bet and gets the same answer; a different casino bet on a revealed round is
refused with `round-revealed`, and one the bank cannot pay with `bank-short`. It throws an `Error` with `status` 400 and
code `invalid` before sending when `meta` is not a JSON object of up to 4,096 bytes of canonical JSON with whole
numbers and well-formed text without a NUL, and an `Error` when the reply is not this bet's reveal: the secret must hash
to the round, the seed and the signature must be this bet's, and the outcome must be their
[`outcome`](outcome.md#outcome).

#### `reveal`

Reveals one of the game's rounds without betting anything: [`casinoBet`](#casinobet) with a stake, chance and prize
of zero, in a group and with meta. It moves no money, `casinoBet.accepted` is `false`, and it throws as `casinoBet`
does.

#### `settle`

Settles the game's developer bets, each with a [`Settlement`](#settlement) signed here, paid from the game's bank
([`POST /api/developer-bets/settle`](../casino-api/developers.md#post-apideveloper-betssettle)). It sends them 256 at
a time; the casino takes each batch whole or refuses it with `bank-short`, and batches sent before a refused one stay
settled. A bet settled before answers with what settled it. It resolves with the bets as settled, in order.

#### `bets`

A page of the game's developer bets, `{ bets, cursor, more }`
([`GET /api/developer-bets`](../casino-api/public.md#get-apideveloper-bets)), `open` ones by default: pass each page's
`cursor` as `after` while `more` is `true`. Open bets come in the order they were placed, so a `cursor` goes on to the
bets placed since; settled ones come in the order they settled, so a saved `cursor` never misses one. With `wait`, 1 to
25 seconds, a page of open bets with none is held until a bet on the game is placed: the kit signs the request with the
key, since only the game's server waits, one wait per game at a time
([following bets](../games/developer-bets.md#your-server)).

## The protocol

### `DEVELOPER_PROTOCOL`

The revision of the protocol a game's server shares with the casino: the hash of the three structures it signs,
the outcome rule and the bounds a bet is held to. A casino's [`GET /api/config`](../casino-api/public.md#get-apiconfig)
names it as `developerProtocol`, and [`createDeveloper`](#createdeveloper) takes no other; a stub casino in your
server's tests answers with it. A change to what only a wallet signs leaves it alone.

## Types

### `Settlement`

What one developer bet is paid, `{ bet, player, casino }`, from the game's bank: `player` to its player and
`casino` to the casino. `bet` is the bet's hash ([the casino's share](../games/developer-bets.md#the-casinos-share)).

### `BankCasinoBet`

The game's casino bet on one of its rounds, `{ round, stake, chance, prize, group, meta }`: its `stake` pays `prize`
when the round's outcome is below `chance`, counted in outcomes out of 2^64. `group`, 1 to 64 characters, labels the
bets that belong together, such as a spin's steps. `meta` is the game's own JSON, which the casino keeps
with the reveal and never reads: what it commits to, it committed to before the outcome was revealed. A stake, chance
and prize all zero is a [reveal](#reveal).

### `PublicDeveloperBet`

A developer bet as anyone may read it by its hash.

| Field                      | Meaning                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bet`                      | The bet's hash: the hash of the operation that placed it, which signs its meta                                                                                                   |
| `game`, `group`            | The game's ID, and the group the page gave the bet                                                                                                                               |
| `uname`, `discordUsername` | The player's names                                                                                                                                                               |
| `stake`                    | The stake, a decimal string of wei                                                                                                                                               |
| `placedAt`                 | When the casino took it, in milliseconds since the Unix epoch                                                                                                                    |
| `status`                   | `open` until the game's server settles it                                                                                                                                        |
| `meta`                     | The game's own JSON, as the player signed it                                                                                                                                     |
| `settlement`               | Once settled: what it pays the player and gives the casino, the server's signature, and the developer's `GameServer` naming that server unless the developer's own key signed it |
| `settledAt`                | When it was settled, in milliseconds since the Unix epoch                                                                                                                        |

### `Round`

A game's round, as anyone may read it: `{ id, game, createdAt, status, seed?, secret?, outcome?, casinoBet? }`, the hash
of a secret the casino keeps, named for one game. It is `open` until the game's casino bet on it reveals it; a revealed
round shows the seed, the secret, their 64-bit `outcome` and the casino bet,
`{ game, stake, chance, prize, group, meta, signature, accepted, payout? }`: the bet as the game's server signed it,
whether the bankroll took it, and what it paid the bank when it did. A reveal's stake, chance and prize are `'0'`.
[`outcome`](outcome.md#outcome) and [`betPayout`](outcome.md#betpayout) check a revealed round.
