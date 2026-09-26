---
title: Developer endpoints
description: The routes a developer's server calls to open rounds, place its casino bets from its bank and settle its developer bets.
sidebar:
  order: 3
---

A game's developer is the account that publishes it. Its server proves itself with
[developer access](index.md#authentication), a `DeveloperAccess` token signed by that account's key, and uses these
three routes; it reads its rounds and its games' developer bets through the public
[`GET /api/rounds/:round`](public.md#get-apiroundsround) and [`GET /api/developer-bets`](public.md#get-apideveloper-bets).
The key is the publishing account's own, so a server that holds it holds everything that account holds.
[`createDeveloper`](../sdk/developer.md#createdeveloper) wraps all of it, and [developer bets](../games/developer-bets.md)
walks through the order of requests with roulette as the example.

A developer's requests share one budget, and the requests that touch its bank in one asset wait their turn
([budgets and queues](index.md#budgets-and-queues)). The signed structures, `DeveloperAccess`,
`BankCasinoBet` and `Settlement`, are on [Signed messages](../reference/signed-messages.md#developer-messages); a
developer's server checks `developerProtocol` in [`GET /api/config`](public.md#get-apiconfig) before it signs any.

## Rounds and casino bets

### `POST /api/rounds`

Opens a round for the developer's own casino bet.

**Auth:** developer access · **Idempotent:** no: every call names another round

The casino picks the round's secret and keeps it; only the developer's casino bet on the round reveals it. The developer
keeps track of its rounds: one it never bets on stays open.

| Body field | Type   | Meaning                                                                            |
| ---------- | ------ | ---------------------------------------------------------------------------------- |
| `asset`    | string | `"eth"` (the default) or `"test"`: the asset of the casino bet that will reveal it |

The reply is the round as [`GET /api/rounds/:round`](public.md#get-apiroundsround) shows it: `{id, developer, asset,
status}`, with `status` `open`.

```json title="Request"
{
  "asset": "eth"
}
```

```json title="Response"
{
  "id": "0x21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
  "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "asset": "eth",
  "status": "open"
}
```

**Errors:** [`invalid`](index.md#errors) (400), [`unauthorized`](index.md#errors) (401), [`refused`](index.md#errors) (409), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

### `POST /api/rounds/:round/casino-bet`

Places the developer's casino bet on one of its rounds, from its bank: it settles at once against the bankroll and
reveals the round.

**Auth:** developer access · **Idempotent:** yes, by round: the same bet again returns the round as it stands

The bet is the developer's `BankCasinoBet`, signed over the round, the game, the stake, the prizes, the hash of the seed
it brings and the hash of its meta. The casino checks the fields and the signature, that the round is the developer's
and not yet revealed, and that the bank holds the stake. It then admits the bet like any casino bet, by
[the Kelly rule](../reference/economics.md#a-casino-bet-is-one-wager), before it reads the round's secret, and records
the reveal: the seed, the secret and the bet, `accepted` or not. Accepted, the bank pays the stake and receives what the
prizes pay on the outcome, and the bet's commission accrues, half of it to the developer, as for any casino bet of its
game. Declined, no money moves. Either way the round is revealed; the same signature again returns it, and any other
bet on it is refused with `round-revealed`.

| Path    | Type    | Meaning                                                                 |
| ------- | ------- | ----------------------------------------------------------------------- |
| `round` | bytes32 | A round the developer opened with [`POST /api/rounds`](#post-apirounds) |

| Body field  | Type    | Meaning                                                                                                                                                  |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game`      | bytes32 | The key of a game the developer publishes: the game whose commission the bet earns                                                                       |
| `stake`     | string  | Decimal, 1 to 2^128 − 1, without leading zeros                                                                                                           |
| `prizes`    | array   | 1 to 64 prizes, `{rangeStart, rangeEnd, payout}` in decimal strings, with `rangeStart < rangeEnd ≤ 2^64` and `0 < payout < 2^128`                        |
| `meta`      | object  | The developer's own JSON: at most 4,096 bytes of canonical JSON, whose numbers are safe integers. The casino keeps it with the reveal and never reads it |
| `seed`      | bytes32 | The bet's seed                                                                                                                                           |
| `signature` | string  | The developer's EIP-712 `BankCasinoBet` over `{round, game, stake, prizes, seedHash: keccak256(seed), meta: keccak256(canonicalJSON(meta))}`             |

The path names the round: a `round` in the body, as the developer kit sends it, is ignored. The reply is the revealed
round as [`GET /api/rounds/:round`](public.md#get-apiroundsround) shows it.

```json title="Request"
{
  "round": "0x21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
  "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
  "stake": "1000000000000000",
  "prizes": [
    {
      "rangeStart": "0",
      "rangeEnd": "8974091711534376461",
      "payout": "2000000000000000"
    }
  ],
  "meta": {
    "covered": ["0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67"]
  },
  "seed": "0x677a5f560aadfc5627c98b34edd076d53481e76411befe62dd848cbed1fc9ed4",
  "signature": "0xc589853547d41893c31690f5479d2e15b6cb5ef43f5bf3e3c3de8e81cc3931d62ea510476f8041050c592144a95a4f4b99f604cee4793b0fbff84aa4261d6a491b"
}
```

```json title="Response"
{
  "id": "0x21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
  "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "asset": "eth",
  "status": "revealed",
  "seed": "0x677a5f560aadfc5627c98b34edd076d53481e76411befe62dd848cbed1fc9ed4",
  "secret": "0x54128284ebebd715b1274a0e304f9653b789d0bfeb013b428a086b1d78b0d725",
  "outcome": "12279579551977707713",
  "casinoBet": {
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "stake": "1000000000000000",
    "prizes": [
      {
        "rangeStart": "0",
        "rangeEnd": "8974091711534376461",
        "payout": "2000000000000000"
      }
    ],
    "meta": {
      "covered": ["0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67"]
    },
    "signature": "0xc589853547d41893c31690f5479d2e15b6cb5ef43f5bf3e3c3de8e81cc3931d62ea510476f8041050c592144a95a4f4b99f604cee4793b0fbff84aa4261d6a491b",
    "accepted": true,
    "payout": "0"
  }
}
```

`invalid` answers a malformed field, a game the developer does not publish, and a signature that is not the
developer's. `not-found` answers a round that is unknown, a channel's or another developer's.

**Errors:** [`invalid`](index.md#errors) (400), [`not-found`](index.md#errors) (404), [`round-revealed`](index.md#errors) (409), [`bank-short`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

## Settling developer bets

### `POST /api/developer-bets/settle`

Settles developer bets on the developer's games, each with its own signed `Settlement`, paid from its bank.

**Auth:** developer access · **Idempotent:** yes: a settled bet answers as it stands

Each `Settlement` says what the player is paid and what the casino is given, both from the developer's bank. The bank
must hold the sum over every bet in the batch not yet settled, in each asset, or nothing in the batch is settled
(`bank-short`). A bet already settled is left as it is, and its entry is not checked. A settled bet's payout is owed to
its player: [`GET /api/channels/:id/payouts`](channels.md#get-apichannelsidpayouts) lists it under the bet's hash, and
the player's wallet collects it after checking the developer's signature. The casino's part is its commission on the
bet.

| Body field                | Type    | Meaning                                                                 |
| ------------------------- | ------- | ----------------------------------------------------------------------- |
| `settlements`             | array   | 1 to 256 settlements, no bet twice                                      |
| `settlements[].bet`       | bytes32 | A developer bet on one of the developer's games                         |
| `settlements[].player`    | string  | What the player is paid: decimal, 0 to 2^128 − 1, without leading zeros |
| `settlements[].casino`    | string  | What the casino is given, in the same form                              |
| `settlements[].signature` | string  | The developer's EIP-712 `Settlement` over `{bet, player, casino}`       |

The reply lists every bet of the request, in its order, as [`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet)
shows it.

```json title="Request"
{
  "settlements": [
    {
      "bet": "0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67",
      "player": "0",
      "casino": "0",
      "signature": "0x1c07c1a140cca0e79dbc18dd2cce9134c445d0212ac0835a49e6625ad7875d652864892203f5471e5a2b7d7dd5f91da446d010ced98da1ca878dca7ed04d91101b"
    }
  ]
}
```

```json title="Response"
[
  {
    "bet": "0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
    "asset": "eth",
    "stake": "1000000000000000",
    "placedAt": 1790384229582,
    "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "status": "settled",
    "meta": {
      "seedHash": "0x467bb18de40adce17a7bbde01c6cfc7ae8d1a069eae727ca981584b7869a1497",
      "pick": "red"
    },
    "settlement": {
      "player": "0",
      "casino": "0",
      "signature": "0x1c07c1a140cca0e79dbc18dd2cce9134c445d0212ac0835a49e6625ad7875d652864892203f5471e5a2b7d7dd5f91da446d010ced98da1ca878dca7ed04d91101b"
    },
    "settledAt": 1790384229614,
    "uname": "zi26admbshgt8yfa6xfxs97r",
    "alias": "alice"
  }
]
```

`invalid` answers an empty or oversized batch, a bet named twice, an amount that is not a whole decimal below 2^128,
and a signature that is not the developer's. `not-found` answers a bet that is unknown or on another developer's game.

**Errors:** [`invalid`](index.md#errors) (400), [`not-found`](index.md#errors) (404), [`bank-short`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)
