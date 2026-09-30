---
title: Developer endpoints
description: The routes a developer's server calls to open rounds, place its casino bets from its bank and settle its developer bets.
sidebar:
  order: 3
---

A game's developer is the account that publishes it. Its server proves itself with
[developer access](index.md#authentication), signed by that account's key, and uses these three routes; it reads its
rounds and its games' developer bets through the public [`GET /api/rounds/:round`](public.md#get-apiroundsround) and
[`GET /api/developer-bets`](public.md#get-apideveloper-bets). The key is the publishing account's own, so a server that
holds it holds everything that account holds. [`createDeveloper`](../sdk/developer.md#createdeveloper) wraps all of it,
and [developer bets](../games/developer-bets.md) walks through the order of requests. The signed structures are on
[Signed messages](../reference/signed-messages.md#developer-messages).

## Rounds and casino bets

### `POST /api/rounds`

Opens a round for the developer's own casino bet, and answers it as [`GET /api/rounds/:round`](public.md#get-apiroundsround)
shows it, `open`. Every call opens another. The casino picks the round's secret and keeps it until the developer's casino
bet on the round reveals it; a round it never bets on stays open. The body is `{}`. `unauthorized` answers a key whose
account publishes no game.

### `POST /api/rounds/:round/casino-bet`

Places the developer's casino bet on one of its rounds, from its bank: it settles at once against the bankroll and
reveals the round. The same bet again returns the round as it stands.

The casino checks the fields and the developer's `BankCasinoBet` signature, that the round is the developer's and not
yet revealed, and that the bank holds the stake. It then admits the bet like any casino bet, by
[the Kelly rule](../reference/economics.md#a-casino-bet-is-one-wager), before it reads the round's secret, and records
the reveal: the seed, the secret and the bet, `accepted` or not. Accepted, the bank pays the stake and receives the prize
when the round's outcome is below the chance, and the bet's commission accrues as for any casino bet of its game; it is
listed in its game's public record, in its group. Declined, no money moves. A stake, chance and prize of zero bet
nothing: they only reveal the round, with no bank check and no admission, and `accepted` is false.

| Body field  | Type    | Meaning                                                                                                                                                    |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game`      | bytes32 | The key of a game the developer publishes: the game whose commission the bet earns                                                                         |
| `stake`     | string  | Decimal, 1 to 2^128 − 1, without leading zeros; `0` to reveal                                                                                              |
| `chance`    | string  | Decimal: how many of the 2^64 outcomes win, 1 to 2^64 − 1; `0` to reveal                                                                                   |
| `prize`     | string  | Decimal: what the bet pays when it wins, 1 to 2^128 − 1; `0` to reveal                                                                                     |
| `group`     | string  | 1 to 64 characters: the label the game gives the bets that belong together                                                                                 |
| `meta`      | object  | The developer's own JSON: at most 4,096 bytes of canonical JSON, whose numbers are safe integers. The casino keeps it with the reveal and never reads it   |
| `seed`      | bytes32 | The bet's seed                                                                                                                                             |
| `signature` | string  | The developer's EIP-712 `BankCasinoBet` over `{round, game, stake, chance, prize, group, seedHash: keccak256(seed), meta: keccak256(canonicalJSON(meta))}` |

```json title="Request"
{
  "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
  "stake": "1000000000000000",
  "chance": "8974091711534376461",
  "prize": "2000000000000000",
  "group": "5b1f3d9a0c2e47f6a8d4e1b7c9f0a3d2e6b8c1f4a7d0e3b6c9f2a5d8e1b4c7f0",
  "meta": {
    "covered": "0x2b9e0f3c7a1d5e8b4f6a9c2d0e7b3f1a8c5d9e2b6f0a4c7d1e3b8f5a9c2d6e0b",
    "side": "left"
  },
  "seed": "0x677a5f560aadfc5627c98b34edd076d53481e76411befe62dd848cbed1fc9ed4",
  "signature": "0x4ea3a2c14eb3d6abcd9733f43d71fbac9ba458193187cae6f71427b3ca63dfab4244e9525980e79ca3ecc202e818ae0090a828e7d19bca07c271a6e832de5c971b"
}
```

The reply is the revealed round as [`GET /api/rounds/:round`](public.md#get-apiroundsround) shows it. `invalid` answers a
malformed field, a game the developer does not publish, and a signature that is not the developer's; `not-found` a round
that is unknown, a channel's or another developer's; `round-revealed` another bet on a revealed round; and `bank-short` a
bank that cannot pay the stake.

## Settling developer bets

### `POST /api/developer-bets/settle`

Settles developer bets on the developer's games, each with its own signed `Settlement` of what the player is paid and
what the casino is given, both from the developer's bank. The bank must hold the sum over every bet in the batch not yet
settled, or nothing in the batch is settled (`bank-short`). A bet already settled is left as it is, unchecked, so a
batch sent again answers as it stands. A settled bet's payout is owed to its player:
[`…/payouts`](channels.md#get-apichannelsidpayouts) lists it under the bet's hash, and the player's wallet collects it
after checking the developer's signature. The casino's part is its commission on the bet.

| Body field                | Type    | Meaning                                                                 |
| ------------------------- | ------- | ----------------------------------------------------------------------- |
| `settlements`             | array   | 1 to 256 settlements, no bet twice                                      |
| `settlements[].bet`       | bytes32 | A developer bet on one of the developer's games                         |
| `settlements[].player`    | string  | What the player is paid: decimal, 0 to 2^128 − 1, without leading zeros |
| `settlements[].casino`    | string  | What the casino is given, in the same form                              |
| `settlements[].signature` | string  | The developer's EIP-712 `Settlement` over `{bet, player, casino}`       |

```json title="Request"
{
  "settlements": [
    {
      "bet": "0x54dcdb0c1c8051ddf0b7cb98f3e2d04b97f53c2b9eaeaafdec2b7a0f198df40d",
      "player": "0",
      "casino": "0",
      "signature": "0x066e90a90dbaaa2bc844a2759a34990991530fbb6e0e5e9a31107ae1e07aaff32685d88b43d3ee09a5a61236c07bbaa192f8a845da4448ca8ae30418090272c01b"
    }
  ]
}
```

The reply lists every bet of the request, in its order, as
[`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet) shows it. `invalid` answers an empty or oversized
batch, a bet named twice, an amount that is not a whole decimal below 2^128, and a signature that is not the
developer's; `not-found` a bet that is unknown or on another developer's game.
