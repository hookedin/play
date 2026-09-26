---
title: Channel endpoints
description: The wallet's routes, for registering a channel, placing operations, acknowledging, closing, collecting what is owed, the fund, the developer bank and the profile.
sidebar:
  order: 2
---

Every route here concerns one channel, `:id`, and needs [channel access](index.md#authentication): a token signed by
the channel's key. The checkpoints, operations and statements they carry are specified on
[Signed messages](../reference/signed-messages.md). The examples come from one session: a player, `@alice`, plays
the game `wheel` of a developer, `@studio`, which also holds a developer bank and a test channel.

## Opening and reading a channel

### `POST /api/channels/:id/activate`

Registers a channel with the casino, or returns it if the casino already knows it.

**Auth:** channel access · **Idempotent:** yes: a known channel is returned as it stands

An ETH channel is opened on-chain first, and its deposit must be confirmed (2 blocks on Sepolia, 1 on Anvil). The casino
reads it at its last observed block and requires the same funding account, channel key, deposit and genesis hash as the
opening. A test channel exists at the casino alone: there is no deposit to show whose it is, so the body adds `owner`,
an `Access` for the channel signed by the funding account. The token is the channel key's, for `:id`. A channel the
casino knows is authenticated and returned with no chain read. Registering a channel counts against
[budgets](index.md#budgets-and-queues) of its own.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field | Type   | Meaning                                                                                                                                                                |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opening`  | object | `{channelId, player, signer, deposit}`: [the opening](../reference/signed-messages.md#channel-ids), whose `channelId` is `:id`                                         |
| `asset`    | string | `"test"` for a test channel; absent or `"eth"` for ETH                                                                                                                 |
| `owner`    | object | A test channel's proof: `{message: {channelId, expiresAt}, signature}`, an `Access` for the channel signed by `opening.player`, within the same time window as a token |

The reply is the channel as [`GET /api/channels/:id`](#get-apichannelsid) shows it.

```json title="Request"
{
  "opening": {
    "channelId": "0x8decb5798a4b46d1cdb76b091f2f013426083eb0925fb14c4b332974ac6fdf55",
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "signer": "0x03Bf6094F9A94a4002935554C3a7355643524223",
    "deposit": "0"
  },
  "asset": "test",
  "owner": {
    "message": {
      "channelId": "0x8decb5798a4b46d1cdb76b091f2f013426083eb0925fb14c4b332974ac6fdf55",
      "expiresAt": "1790384288"
    },
    "signature": "0x5bab60ac61cd765d74f5a5a4b3267f9870ad23085adc88690c417a428b7af8ec10cb96a5b42f58c6c8f6e0bba04f00f2a7b7535373f2fa33ddd2761415d6f60f1b"
  }
}
```

```json title="Response"
{
  "opening": {
    "channelId": "0x8decb5798a4b46d1cdb76b091f2f013426083eb0925fb14c4b332974ac6fdf55",
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "signer": "0x03Bf6094F9A94a4002935554C3a7355643524223",
    "deposit": "0"
  },
  "asset": "test",
  "uname": "biop5et6ov6i5sn3c6p7vxhx",
  "alias": null,
  "state": {
    "channelId": "0x8decb5798a4b46d1cdb76b091f2f013426083eb0925fb14c4b332974ac6fdf55",
    "sequence": "0",
    "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "transitionHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "balance": "0"
  },
  "playerSignature": "0x",
  "casinoSignature": "0x",
  "acknowledged": true,
  "lastResponse": null,
  "onchain": {
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "signer": "0x03Bf6094F9A94a4002935554C3a7355643524223",
    "deposit": "0",
    "initialHash": "0xee1eddd8597bcd974063431069ffb1c769853a92be4f3f366e45e23b386dbc7a",
    "status": "1",
    "deadline": "0",
    "closingSequence": "0",
    "closingHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "closingBalance": "0"
  },
  "closing": false,
  "bankroll": "10000000000000000000000000"
}
```

`invalid` answers an unknown `asset`. `refused` answers an opening whose `channelId` is not `:id` or does not fit its
fields, an ETH channel that is not confirmed or differs on-chain, and a chain that moved on during the check ("Chain
observation advanced; retry activation").

**Errors:** [`unauthorized`](index.md#errors) (401), [`invalid`](index.md#errors) (400), [`refused`](index.md#errors) (409), [`rate-limited`](index.md#errors) (429), [`busy`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

### `GET /api/channels/:id`

The channel as the casino holds it: its latest checkpoint and the reply that produced it.

**Auth:** channel access · **Idempotent:** yes

The casino answers this while paused and after the channel is closed, so a wallet can always recover its latest
evidence.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Response field    | Type                   | Meaning                                                                                                                                                                                                                                                           |
| ----------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opening`         | object                 | `{channelId, player, signer, deposit}`                                                                                                                                                                                                                            |
| `asset`           | string                 | `eth` or `test`                                                                                                                                                                                                                                                   |
| `uname`, `alias`  | string, string or null | The player's names                                                                                                                                                                                                                                                |
| `state`           | Checkpoint             | The latest checkpoint                                                                                                                                                                                                                                             |
| `playerSignature` | string                 | The channel key's countersignature of `state`; `0x` until given                                                                                                                                                                                                   |
| `casinoSignature` | string                 | The casino's signature of `state`; `0x` for the genesis                                                                                                                                                                                                           |
| `acknowledged`    | boolean                | Whether `state` is countersigned                                                                                                                                                                                                                                  |
| `lastResponse`    | object or null         | The reply that produced `state`, as [`POST …/operations`](#post-apichannelsidoperations) recorded it, without `bankroll` and `nextRound`                                                                                                                          |
| `onchain`         | object or null         | The contract's record of the channel, `{player, signer, deposit, initialHash, status, deadline, closingSequence, closingHash, closingBalance}`, in decimal strings (see [`channels`](../reference/contract.md#storage)); a test channel shows a fixed open record |
| `claim`           | object or null         | A finalized channel's claim, `{beneficiary, stateHash, amount, paid, protectedRemaining, winningsRemaining, finalizedAt}` (see [`claims`](../reference/contract.md#views)); absent or `null` before                                                               |
| `closing`         | boolean                | Whether the casino has signed a `Close` for the channel; it takes no more operations                                                                                                                                                                              |
| `bankroll`        | string                 | The bankroll of the channel's asset, a hint                                                                                                                                                                                                                       |

```json title="Response"
{
  "opening": {
    "channelId": "0x8decb5798a4b46d1cdb76b091f2f013426083eb0925fb14c4b332974ac6fdf55",
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "signer": "0x03Bf6094F9A94a4002935554C3a7355643524223",
    "deposit": "0"
  },
  "asset": "test",
  "uname": "biop5et6ov6i5sn3c6p7vxhx",
  "alias": null,
  "state": {
    "channelId": "0x8decb5798a4b46d1cdb76b091f2f013426083eb0925fb14c4b332974ac6fdf55",
    "sequence": "0",
    "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "transitionHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "balance": "0"
  },
  "playerSignature": "0x",
  "casinoSignature": "0x",
  "acknowledged": true,
  "lastResponse": null,
  "onchain": {
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "signer": "0x03Bf6094F9A94a4002935554C3a7355643524223",
    "deposit": "0",
    "initialHash": "0xee1eddd8597bcd974063431069ffb1c769853a92be4f3f366e45e23b386dbc7a",
    "status": "1",
    "deadline": "0",
    "closingSequence": "0",
    "closingHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "closingBalance": "0"
  },
  "closing": false,
  "bankroll": "10000000000000000000000000"
}
```

**Errors:** [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

## Playing

### `POST /api/channels/:id/round`

Names the round the channel's next casino bet settles on.

**Auth:** channel access · **Idempotent:** yes: the same round until a casino bet uses it

The wallet picks its seed only after it has the round, signs the round and the seed's hash into the casino bet, and
sends the seed with it. The reply to a casino bet names the channel's next round as `nextRound`, so a wallet asks here
only before a channel's first casino bet or after losing track. The body is ignored but must be JSON: send `{}`.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Response field | Type    | Meaning                                                                      |
| -------------- | ------- | ---------------------------------------------------------------------------- |
| `id`           | bytes32 | The round: the hash of a secret the casino keeps until the round is revealed |

```json title="Request"
{}
```

```json title="Response"
{
  "id": "0xb39efcd8ebe6465b195d6ac2970c5217d2e183abc34c799aa8bfa303c3acacb9"
}
```

**Errors:** [`unauthorized`](index.md#errors) (401), [`channel-closed`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503)

### `POST /api/channels/:id/operations`

Submits one signed operation, a casino bet, a debit or a credit, and answers with the casino's signed result or its
signed rejection.

**Auth:** channel access · **Idempotent:** yes, by operation ID

The casino takes one operation of a channel at a time, in order. Each reply must be acknowledged before the next
operation: the next request carries `acknowledgment`, the channel key's signature of the reply's `state` with that
state's hash, unless the wallet already posted it to [`…/ack`](#post-apichannelsidack). The exact request sent again
returns the recorded reply; see [retries](index.md#operations-and-retries).

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field       | Type      | Meaning                                                                                                                                                          |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`        | Operation | The signed [operation](../reference/signed-messages.md#transitions), with exactly its nine fields; `channelId` is `:id`                                          |
| `details`        | Details   | What it means: [details](../reference/signed-messages.md#details-and-memo) whose hash is `request.memo`                                                          |
| `signature`      | string    | The channel key's EIP-712 signature of `request`                                                                                                                 |
| `acknowledgment` | object    | `{stateHash, signature}`: the hash of the channel's latest checkpoint and the channel key's signature of it; required while the previous reply is unacknowledged |
| `seed`           | bytes32   | A casino bet's seed, whose hash `request.seedHash` signs                                                                                                         |

What the casino checks and answers, by operation:

| Operation                   | Details                                                  | The casino                                                                                                                                                                                                                                                                                           | The reply adds                                                                                       |
| --------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Casino bet, kind 1          | `{id, game, group?}`                                     | Needs `seed` when the bet is on the channel's own open round (`400` `invalid` without it); declines a bet on any other round. Admits the bet by [the Kelly rule](../reference/economics.md#a-casino-bet-is-one-wager) before it reads the round's secret, and declines what the bankroll cannot take | `commission`; `developer` when the game is published; `nextRound`; when declined, `secret` or `lost` |
| Payment, kind 2             | `{id, game, group?}`                                     | Moves the amount into the bankroll                                                                                                                                                                                                                                                                   | –                                                                                                    |
| Developer bet, kind 2       | `{id, game, group?, meta}`                               | Moves the stake into the bank of the game's developer; declines a bet on a game nobody publishes                                                                                                                                                                                                     | –                                                                                                    |
| Investment, kind 2          | `{id, counterparty: FUND_ID}`                            | Mints shares to the channel's player at the current price; declines one from a test channel, one too small to buy a share, and one while shares are in issue and the fund's equity is not positive                                                                                                   | `statement`: the `ShareStatement`                                                                    |
| Bank deposit, kind 2        | `{id, counterparty: BANK_ID}`                            | Moves the amount into the bank of the channel's own account                                                                                                                                                                                                                                          | `statement`: the `BankStatement`                                                                     |
| Test coins, kind 3          | `{id, counterparty: FAUCET_ID}`                          | Pays exactly 100 TEST to a test channel holding less than 10 TEST; `wrong-asset` on an ETH channel, `not-due` otherwise                                                                                                                                                                              | –                                                                                                    |
| Developer earnings, kind 3  | `{id, counterparty: DEVELOPER_ID}`                       | Pays at most what the account has earned and not collected; `not-due` beyond it                                                                                                                                                                                                                      | –                                                                                                    |
| Collecting a payout, kind 3 | `{id, counterparty: FUND_ID, BANK_ID or the bet's hash}` | Pays exactly the amount of a [payout](#get-apichannelsidpayouts) listed under that source; `not-due` otherwise                                                                                                                                                                                       | –                                                                                                    |

A debit that names any other counterparty is refused with `400` `invalid`. A game's operation its player already
carried out on another channel is declined with `used: true`. A developer bet is known afterwards by the hash of its
operation, which [`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet) takes.

| Response field    | Type       | Meaning                                                                                                                                             |
| ----------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`          | string     | `signed` for a result, `rejected` for a declined operation                                                                                          |
| `state`           | Checkpoint | The checkpoint that follows, signed by the casino: the result, or the [rejection checkpoint](../reference/signed-messages.md#rejection-checkpoints) |
| `casinoSignature` | string     | The casino's signature of `state`                                                                                                                   |
| `evidence`        | Evidence   | A result's base and step, enough to settle `state` on-chain; for a rejection, the base with the empty step                                          |
| `details`         | Details    | As sent                                                                                                                                             |
| `operationId`     | bytes32    | `details.id`                                                                                                                                        |
| `commission`      | string     | A casino bet's commission; `"0"` otherwise                                                                                                          |
| `developer`       | address    | A casino bet in a published game: its developer, who earns half the commission                                                                      |
| `statement`       | object     | An investment's `ShareStatement` or a deposit's `BankStatement`, as `{message, signature}`                                                          |
| `reason`          | string     | Rejected: why, for people                                                                                                                           |
| `request`         | Operation  | Rejected: the declined operation                                                                                                                    |
| `secret`          | bytes32    | A declined casino bet: its round's secret, to compute what the bet would have paid                                                                  |
| `lost`            | boolean    | A declined casino bet whose round the casino cannot reveal: `true`                                                                                  |
| `used`            | boolean    | A game's operation declined because its player carried it out on another channel: `true`                                                            |
| `bankroll`        | string     | The bankroll of the channel's asset, a hint; not recorded                                                                                           |
| `nextRound`       | bytes32    | After a casino bet, settled or declined: the channel's next round; not recorded                                                                     |

A casino bet, and its signed result:

```json title="Request"
{
  "request": {
    "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
    "previousStateHash": "0xcb111ba55bbeaa605bb7ac185746a75098a4593b93cb1155c99e8e52fd8ae9e2",
    "sequence": "1",
    "kind": 1,
    "amount": "1000000000000000",
    "chance": "9131138316486228049",
    "prize": "2000000000000000",
    "round": "0xb39efcd8ebe6465b195d6ac2970c5217d2e183abc34c799aa8bfa303c3acacb9",
    "seedHash": "0xf95f7e3bc56f388acb608f28410489b3ae466f494521a2de7dee7e01247166bc",
    "memo": "0xfa22ab1e93a122f6bbaf309a0bc12974a1d6e3fccf6c61eec46f2ab580bb7916"
  },
  "details": {
    "id": "0x07f8d268f497cba8348ca4ea632f74b4545327b7b1bc57ac4d5f21ab381eb142",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "group": "hand-1"
  },
  "signature": "0x310f61f0e595d2cab47c737aac5af28d5b297a943fbf843a6ecf80027341763e3e68b1792042276bb1e3eebf63a3cdbcdc1b6f436451235c38b5907adf4891381c",
  "seed": "0x0e7c738595fef8c566df866eaa72eaaa65b04ffb1a7eeda049efc91d7fdb2221"
}
```

```json title="Response"
{
  "status": "signed",
  "state": {
    "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
    "sequence": "1",
    "previousStateHash": "0xcb111ba55bbeaa605bb7ac185746a75098a4593b93cb1155c99e8e52fd8ae9e2",
    "transitionHash": "0x020c50b991fa94180f2fd157d752507789eaad1473072f49a7e5e69ad63af98d",
    "balance": "999000000000000000"
  },
  "casinoSignature": "0x712b1e6f10ef39a7ef770e96c5287f19f1036f19742c6798bea7169c193b9051080275ae7849d59fca353ab6359975e623ea3d4c5bc2ddc995595355204c735e1c",
  "evidence": {
    "base": {
      "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
      "sequence": "0",
      "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "transitionHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "balance": "1000000000000000000"
    },
    "playerSignature": "0x",
    "casinoSignature": "0x",
    "step": {
      "operation": {
        "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
        "previousStateHash": "0xcb111ba55bbeaa605bb7ac185746a75098a4593b93cb1155c99e8e52fd8ae9e2",
        "sequence": "1",
        "kind": 1,
        "amount": "1000000000000000",
        "chance": "9131138316486228049",
        "prize": "2000000000000000",
        "round": "0xb39efcd8ebe6465b195d6ac2970c5217d2e183abc34c799aa8bfa303c3acacb9",
        "seedHash": "0xf95f7e3bc56f388acb608f28410489b3ae466f494521a2de7dee7e01247166bc",
        "memo": "0xfa22ab1e93a122f6bbaf309a0bc12974a1d6e3fccf6c61eec46f2ab580bb7916"
      },
      "authorization": "0x310f61f0e595d2cab47c737aac5af28d5b297a943fbf843a6ecf80027341763e3e68b1792042276bb1e3eebf63a3cdbcdc1b6f436451235c38b5907adf4891381c",
      "seed": "0x0e7c738595fef8c566df866eaa72eaaa65b04ffb1a7eeda049efc91d7fdb2221",
      "secret": "0xabdbef940391493561a42b5576c188839c7376294258c4de39d4c4452118b673",
      "casinoSignature": "0x712b1e6f10ef39a7ef770e96c5287f19f1036f19742c6798bea7169c193b9051080275ae7849d59fca353ab6359975e623ea3d4c5bc2ddc995595355204c735e1c"
    }
  },
  "details": {
    "id": "0x07f8d268f497cba8348ca4ea632f74b4545327b7b1bc57ac4d5f21ab381eb142",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "group": "hand-1"
  },
  "operationId": "0x07f8d268f497cba8348ca4ea632f74b4545327b7b1bc57ac4d5f21ab381eb142",
  "commission": "9990000998000",
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "bankroll": "99999985014999503000",
  "nextRound": "0x8c3264f83c5bbb9fe48be555ccd793f911ef663066971bf495f7f9e019d19139"
}
```

The channel's next casino bet, which carries the acknowledgment of the first and which the bankroll declines: the
rejection reveals the round's secret and names the next round.

```json title="Request"
{
  "request": {
    "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
    "previousStateHash": "0xa959347273365dd6d3c634256dfbbe4db6e7d303bab27f61f513462fd23eef9b",
    "sequence": "2",
    "kind": 1,
    "amount": "1000000000000000",
    "chance": "9223372036854775808",
    "prize": "2000000000000000",
    "round": "0x8c3264f83c5bbb9fe48be555ccd793f911ef663066971bf495f7f9e019d19139",
    "seedHash": "0x809e5c713fe8d387a697f4f5d7442819d190cc11da9432171db7ffa0850918d0",
    "memo": "0xe874f410e33de0333b90435bb72d380da6f9cb76d2dd2816d5f6ab0f4df709ec"
  },
  "details": {
    "id": "0xa2b147194be992451b15908fddbc416c14c7509cae5ee2cd6a34fc9f5ea47fe6",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3"
  },
  "signature": "0xd384ee18627936072251e9c1bac369cc0e9e1f3a64ff4696f116ecd253639be73506ec3738e139628c824cf7326a04280cfdc952343a36d76dcd6551f7da64fe1b",
  "acknowledgment": {
    "stateHash": "0xa959347273365dd6d3c634256dfbbe4db6e7d303bab27f61f513462fd23eef9b",
    "signature": "0x9ad43b0deb9eb2a01ded1c8d65fd27ca0bda08aea2b3954045bb0005dd1414905bbf91adc2e6040181d0134903b61faa04d07616343810cb7d45c6e50bea13981c"
  },
  "seed": "0x41023df3fbb98208620a3a5747feb389abbe16fb65707b90fb2d31670d029425"
}
```

```json title="Response"
{
  "status": "rejected",
  "reason": "The bankroll cannot take this casino bet",
  "request": {
    "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
    "previousStateHash": "0xa959347273365dd6d3c634256dfbbe4db6e7d303bab27f61f513462fd23eef9b",
    "sequence": "2",
    "kind": 1,
    "amount": "1000000000000000",
    "chance": "9223372036854775808",
    "prize": "2000000000000000",
    "round": "0x8c3264f83c5bbb9fe48be555ccd793f911ef663066971bf495f7f9e019d19139",
    "seedHash": "0x809e5c713fe8d387a697f4f5d7442819d190cc11da9432171db7ffa0850918d0",
    "memo": "0xe874f410e33de0333b90435bb72d380da6f9cb76d2dd2816d5f6ab0f4df709ec"
  },
  "details": {
    "id": "0xa2b147194be992451b15908fddbc416c14c7509cae5ee2cd6a34fc9f5ea47fe6",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3"
  },
  "operationId": "0xa2b147194be992451b15908fddbc416c14c7509cae5ee2cd6a34fc9f5ea47fe6",
  "state": {
    "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
    "sequence": "3",
    "previousStateHash": "0xa959347273365dd6d3c634256dfbbe4db6e7d303bab27f61f513462fd23eef9b",
    "transitionHash": "0xa262900681d266388a0f304a73585f7b735ac12a67c983141e3acac853c066ea",
    "balance": "999000000000000000"
  },
  "casinoSignature": "0x964cbf1f7187376516b175222c69d194f11b36ffe1ea921904b39bbfdb37a75a4df4dae5225ded059a5f0924da7b6cb0e81dfcb842fc2e2ad16c387b7cc1f7041c",
  "commission": "0",
  "evidence": {
    "base": {
      "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
      "sequence": "1",
      "previousStateHash": "0xcb111ba55bbeaa605bb7ac185746a75098a4593b93cb1155c99e8e52fd8ae9e2",
      "transitionHash": "0x020c50b991fa94180f2fd157d752507789eaad1473072f49a7e5e69ad63af98d",
      "balance": "999000000000000000"
    },
    "playerSignature": "0x9ad43b0deb9eb2a01ded1c8d65fd27ca0bda08aea2b3954045bb0005dd1414905bbf91adc2e6040181d0134903b61faa04d07616343810cb7d45c6e50bea13981c",
    "casinoSignature": "0x712b1e6f10ef39a7ef770e96c5287f19f1036f19742c6798bea7169c193b9051080275ae7849d59fca353ab6359975e623ea3d4c5bc2ddc995595355204c735e1c",
    "step": {
      "operation": {
        "channelId": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "sequence": 0,
        "kind": 0,
        "amount": 0,
        "chance": "0",
        "prize": "0",
        "round": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "seedHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "memo": "0x0000000000000000000000000000000000000000000000000000000000000000"
      },
      "authorization": "0x",
      "seed": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "secret": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "casinoSignature": "0x"
    }
  },
  "secret": "0xfabbf538387e242c434304dbc3997e33f4431b2ad37b07e7f8101d422f80a860",
  "bankroll": "100000995005000501000",
  "nextRound": "0x7fbdac4494d19c3f940c382c938d9e538f3a2bfe37cc5117a4bd84c5a6bfca72"
}
```

A developer bet's details, whose `meta` is the game's own JSON:

```json title="Details"
{
  "id": "0x89a7cb2267695c5f0c294fa13c3650c7330f367e4c8d9c48fff02ee7682e2cb2",
  "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
  "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
  "meta": {
    "seedHash": "0x467bb18de40adce17a7bbde01c6cfc7ae8d1a069eae727ca981584b7869a1497",
    "pick": "red"
  }
}
```

`invalid` with `400` answers fields other than the operation's nine, details that do not hash to the memo, a missing
seed and a debit's unknown counterparty; with `409`, details that break [the details rules](../reference/signed-messages.md#details-and-memo).
`refused` answers a `request.channelId` other than `:id`, a bad signature or acknowledgment signature, an operation
that is not the channel's next, an amount above the balance, and a casino bet whose chance or prize breaks the rules.

**Errors:** [`unauthorized`](index.md#errors) (401), [`invalid`](index.md#errors) (400), [`invalid`](index.md#errors) (409), [`unacknowledged`](index.md#errors) (409), [`channel-closed`](index.md#errors) (409), [`id-conflict`](index.md#errors) (409), [`not-due`](index.md#errors) (409), [`wrong-asset`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

### `GET /api/channels/:id/operations/:operationId`

The recorded reply to one operation of the channel.

**Auth:** channel access · **Idempotent:** yes

This is how a wallet learns what happened to an operation whose reply it lost. The casino answers it while paused.

| Path          | Type    | Meaning                                                            |
| ------------- | ------- | ------------------------------------------------------------------ |
| `id`          | bytes32 | The channel                                                        |
| `operationId` | bytes32 | The operation's `details.id`, lowercase: the reply's `operationId` |

The reply is the operation's reply as recorded, without `bankroll` and `nextRound`.

```json title="Response"
{
  "status": "signed",
  "state": {
    "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
    "sequence": "1",
    "previousStateHash": "0xcb111ba55bbeaa605bb7ac185746a75098a4593b93cb1155c99e8e52fd8ae9e2",
    "transitionHash": "0x020c50b991fa94180f2fd157d752507789eaad1473072f49a7e5e69ad63af98d",
    "balance": "999000000000000000"
  },
  "casinoSignature": "0x712b1e6f10ef39a7ef770e96c5287f19f1036f19742c6798bea7169c193b9051080275ae7849d59fca353ab6359975e623ea3d4c5bc2ddc995595355204c735e1c",
  "evidence": {
    "base": {
      "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
      "sequence": "0",
      "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "transitionHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "balance": "1000000000000000000"
    },
    "playerSignature": "0x",
    "casinoSignature": "0x",
    "step": {
      "operation": {
        "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
        "previousStateHash": "0xcb111ba55bbeaa605bb7ac185746a75098a4593b93cb1155c99e8e52fd8ae9e2",
        "sequence": "1",
        "kind": 1,
        "amount": "1000000000000000",
        "chance": "9131138316486228049",
        "prize": "2000000000000000",
        "round": "0xb39efcd8ebe6465b195d6ac2970c5217d2e183abc34c799aa8bfa303c3acacb9",
        "seedHash": "0xf95f7e3bc56f388acb608f28410489b3ae466f494521a2de7dee7e01247166bc",
        "memo": "0xfa22ab1e93a122f6bbaf309a0bc12974a1d6e3fccf6c61eec46f2ab580bb7916"
      },
      "authorization": "0x310f61f0e595d2cab47c737aac5af28d5b297a943fbf843a6ecf80027341763e3e68b1792042276bb1e3eebf63a3cdbcdc1b6f436451235c38b5907adf4891381c",
      "seed": "0x0e7c738595fef8c566df866eaa72eaaa65b04ffb1a7eeda049efc91d7fdb2221",
      "secret": "0xabdbef940391493561a42b5576c188839c7376294258c4de39d4c4452118b673",
      "casinoSignature": "0x712b1e6f10ef39a7ef770e96c5287f19f1036f19742c6798bea7169c193b9051080275ae7849d59fca353ab6359975e623ea3d4c5bc2ddc995595355204c735e1c"
    }
  },
  "details": {
    "id": "0x07f8d268f497cba8348ca4ea632f74b4545327b7b1bc57ac4d5f21ab381eb142",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "group": "hand-1"
  },
  "operationId": "0x07f8d268f497cba8348ca4ea632f74b4545327b7b1bc57ac4d5f21ab381eb142",
  "commission": "9990000998000",
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
}
```

`not-found` means no result is recorded: the exact request may be sent again.

**Errors:** [`not-found`](index.md#errors) (404), [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

### `POST /api/channels/:id/ack`

Countersigns the channel's latest checkpoint, without an operation.

**Auth:** channel access · **Idempotent:** yes

The wallet posts its countersignature here as soon as it has saved a reply. A channel with nothing to acknowledge
answers `{"acknowledged": true}` all the same.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field  | Type    | Meaning                                                               |
| ----------- | ------- | --------------------------------------------------------------------- |
| `stateHash` | bytes32 | The hash of the channel's latest checkpoint, the last reply's `state` |
| `signature` | string  | The channel key's EIP-712 signature of that checkpoint                |

```json title="Request"
{
  "stateHash": "0x39156d11000824d5abff6f9dbc3287ba4eeed648ed8bdbf02c719c046241509c",
  "signature": "0xe5a9331b7f0f48796657442e197d810ad476fec751d74df0843e4ebe2b9dd1a63b512fcea59f58c5ba0001a6095e6feec5523ba90c9c818e3416ea43f116a34b1b"
}
```

```json title="Response"
{
  "acknowledged": true
}
```

`unacknowledged` answers a hash that is not the latest checkpoint's, and `refused` a bad signature.

**Errors:** [`unacknowledged`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

## Closing

### `POST /api/channels/:id/close`

Asks for the casino's `Close` signature over the channel's latest checkpoint, to close it at once on-chain with
`cooperativeClose`.

**Auth:** channel access · **Idempotent:** yes

The body carries evidence of the channel's latest checkpoint, either the last reply's evidence or the latest jointly
signed checkpoint with the empty step, and the funding account's [`Close`](../reference/signed-messages.md#close)
signature of the channel and that checkpoint's hash. The casino checks that the evidence yields its latest checkpoint
and that the funding account signed, records the channel as closing, so that it takes no more operations, and signs.
The wallet then calls [`cooperativeClose`](../reference/contract.md#functions-that-change-state) with both signatures.
ETH channels only: a test channel has nothing on-chain to close.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field  | Type     | Meaning                                                                                                      |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `evidence`  | Evidence | [Evidence](../reference/signed-messages.md#evidence) of the latest checkpoint                                |
| `signature` | string   | The `Close` of `{channelId, stateHash}` signed by the funding account, `opening.player`, not the channel key |

| Response field | Type   | Meaning                        |
| -------------- | ------ | ------------------------------ |
| `message`      | object | `{channelId, stateHash}`       |
| `signature`    | string | The casino's `Close` signature |

```json title="Request"
{
  "evidence": {
    "base": {
      "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
      "sequence": "8",
      "previousStateHash": "0x4b50de24e2c162784bd97161b6137926ee06832337e8f0470b4bc0ced254a146",
      "transitionHash": "0xc7a0466a9b9906cc5f28f2d8fe420bb034ec0fd679305df42cdef0ff7b8f7172",
      "balance": "991900000000000000"
    },
    "playerSignature": "0x5d61d4e9d0641ccbda471882a0c2a389be37e36c3b18361848e2d98eae84db8175dc10003384263e0199cce95112273296c9fc17f347c015dbeebfe0435df99b1c",
    "casinoSignature": "0xcc40131e943130644dab7fe411806a3c0c46b493e7573df6499dbc7ee85fdba103f362e4ca4ebcd9ad0b4482707c35fad7ffb4d00c580e07275de09a1c3b1d5a1b",
    "step": {
      "operation": {
        "channelId": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "sequence": 0,
        "kind": 0,
        "amount": 0,
        "chance": "0",
        "prize": "0",
        "round": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "seedHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "memo": "0x0000000000000000000000000000000000000000000000000000000000000000"
      },
      "authorization": "0x",
      "seed": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "secret": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "casinoSignature": "0x"
    }
  },
  "signature": "0xea7f2322aa67b2256896ba696a18201fa7ac2ce0f434eb8f3e66e2a5e2b0c1713b7088b71003ead04ccabbcca980c13b7ead5f63c05e65556808c2e4f08bf4c61c"
}
```

```json title="Response"
{
  "message": {
    "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
    "stateHash": "0xb71fe8b5af210c2660a10dd0ec6d40ca608090aeb54356c682b494ff375fe0d0"
  },
  "signature": "0x5762910f655e34cd69cd3d9a06b81b35ab3675bc9335ace1e3a858e8e11094c348f2268f210782e27e092162107a6ba869f4311d774044831e08b90e5643ba181b"
}
```

`refused` answers evidence of any other checkpoint ("Recover the latest checkpoint before closing") and a signature
that is not the funding account's.

**Errors:** [`wrong-asset`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

## Payouts and developer bets

### `GET /api/channels/:id/payouts`

What the casino owes the channel's account in this asset, for the wallet to collect with credits.

**Auth:** channel access · **Idempotent:** yes

The list holds at most 256 entries. First comes the account's developer earnings, if it has ever earned any in this
asset; then every payout not yet collected, ordered by source and index. The wallet collects each with a credit whose
details name `source` as their `counterparty`, for exactly `amount` (for earnings, at most `amount`), and the next reply
lists the rest. Payouts belong to the account, so any of its channels in the asset lists and collects them.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Response field | Type    | Meaning                                                                                                                                                                                                                       |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`       | bytes32 | `DEVELOPER_ID` for developer earnings; `FUND_ID` for redeemed shares; `BANK_ID` for a bank withdrawal; a developer bet's hash for what its settlement paid ([counterparties](../reference/signed-messages.md#counterparties)) |
| `index`        | number  | Earnings and developer bets: 0. Redeemed shares: the number of the fund change. A bank withdrawal: its statement's `sequence`                                                                                                 |
| `amount`       | string  | What is owed; for earnings, `earned − collected`, which may be `"0"`                                                                                                                                                          |
| `earned`       | string  | Earnings only: the commission the account has earned in this asset                                                                                                                                                            |
| `collected`    | string  | Earnings only: what of it has been collected                                                                                                                                                                                  |
| `games`        | array   | Earnings only: `{game, earned, name}` for each game that earned it, the most first; `name` is the name the game is published under, or `null`                                                                                 |

```text title="Request"
GET /api/channels/0x39dce1a0c5bccc3b0eddbcefe952e49579a457f0bec73657675fbf0c4e041da7/payouts
```

```json title="Response"
[
  {
    "source": "0x2fc2d32d54413eba8857124e3e8c3261740cccc0ba5885f6ea7498ea5bc68adc",
    "index": 0,
    "amount": "18503517716823",
    "earned": "18503517716823",
    "collected": "0",
    "games": [
      {
        "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
        "earned": "18503517716823",
        "name": "wheel"
      }
    ]
  },
  {
    "source": "0x6036e2ff95363cd3feb09ac645f9fa63a1d231a7d546f8ea5688615e683b9263",
    "index": 2,
    "amount": "10000000000000000"
  }
]
```

**Errors:** [`paused`](index.md#errors) (503), [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

### `GET /api/channels/:id/developer-bets`

The account's developer bets in this channel's asset, across all its channels.

**Auth:** channel access · **Idempotent:** yes

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Query    | Type   | Meaning                                                                                                    |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `status` | string | `open` or `settled`; required                                                                              |
| `after`  | string | The `cursor` of the previous page: a lowercase bet hash for open bets, a decimal position for settled ones |
| `limit`  | number | How many, a whole number from 1 to 100; default 50                                                         |

The reply is `{bets, cursor, more}` ([pages](index.md#pages)). A bet is `{bet, game, group?, asset, status, stake,
collected}`, and a settled one adds `payout`, what its settlement pays the player, and `settledAt`, in milliseconds.
`collected` is `true` once a positive payout has been credited to a channel; a payout of `"0"` needs no collecting and
stays `false`.

```text title="Request"
GET /api/channels/0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78/developer-bets?status=settled&after=0
```

```json title="Response"
{
  "bets": [
    {
      "bet": "0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67",
      "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
      "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
      "asset": "eth",
      "status": "settled",
      "stake": "1000000000000000",
      "collected": false,
      "payout": "0",
      "settledAt": 1790384229614
    }
  ],
  "cursor": "33000",
  "more": false
}
```

**Errors:** [`invalid`](index.md#errors) (400), [`paused`](index.md#errors) (503), [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

## The bankroll fund

A holding belongs to the channel's funding account, so it outlives any one channel. [The bankroll fund](../wallet/bankroll-fund.md)
explains investing; an investment is an [operation](#post-apichannelsidoperations).

### `GET /api/channels/:id/fund`

The channel's player's shares in the bankroll fund, with the casino's latest statement of them.

**Auth:** channel access · **Idempotent:** yes

The casino answers this while paused.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Response field | Type           | Meaning                                                                                                       |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `holder`       | address        | The channel's funding account                                                                                 |
| `shares`       | string         | The shares held                                                                                               |
| `sequence`     | number         | The number of the latest statement; 0 before any                                                              |
| `statement`    | object or null | The latest [`ShareStatement`](../reference/signed-messages.md#bankroll-fund-messages), `{message, signature}` |
| `value`        | string         | What the shares are worth at the current price, rounded down                                                  |

```json title="Response"
{
  "holder": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "shares": "10000000000000000",
  "sequence": 1,
  "statement": {
    "message": {
      "holder": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      "sequence": "1",
      "shares": "10000000000000000",
      "amount": "10000000000000000",
      "equity": "100002081496483283177",
      "totalShares": "100002081496483283177",
      "cause": "0xd99d6a6fc6eb8e6b50ed346d5b5624cf6853697318668c76c8318097a3555bf5"
    },
    "signature": "0x5b8cfa746f3fd2dbf47bae38ae8479c10deba30d49122490bea251c076bc78252a1b6be8e69001274eb3f16c73d9afdd1d5f96bd67726316b8b94b95cd5444471b"
  },
  "value": "10000000000000000"
}
```

**Errors:** [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

### `POST /api/channels/:id/fund/redeem`

Burns shares at the current price; what they are worth leaves the bankroll and is owed to the player.

**Auth:** channel access · **Idempotent:** yes, by statement: the same `Redeem` again returns its statement while it is the holding's latest

The `Redeem` is signed by the key of an open ETH channel of the holder, and its `sequence` is the holding's plus one.
The amount must be more than zero and within the unreserved bankroll; a larger redemption is refused until the casino
bets counting on that money settle. The amount is owed at once: [`…/payouts`](#get-apichannelsidpayouts) lists it under
`FUND_ID`, to be collected with a credit.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field  | Type   | Meaning                                                                                              |
| ----------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `message`   | object | The [`Redeem`](../reference/signed-messages.md#bankroll-fund-messages): `{holder, shares, sequence}` |
| `signature` | string | The channel key's EIP-712 signature of `message`                                                     |

| Response field | Type   | Meaning                                                                                       |
| -------------- | ------ | --------------------------------------------------------------------------------------------- |
| `statement`    | object | The casino's `ShareStatement`, `{message, signature}`, whose `amount` is what the shares paid |

```json title="Request"
{
  "message": {
    "holder": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "shares": "5000000000000000",
    "sequence": "2"
  },
  "signature": "0x66ba4bfb54faf7a19c6a9fee393627a06116d319cd5e25d621c89e285f0fbad41a289bc9241f4555b9705eeed8d3a64319047c89b046e893cb8a80db6bd7d9ab1c"
}
```

```json title="Response"
{
  "statement": {
    "message": {
      "holder": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      "sequence": "2",
      "shares": "5000000000000000",
      "amount": "5000000000000000",
      "equity": "100012081496483283177",
      "totalShares": "100012081496483283177",
      "cause": "0xe59cfada6bf7c1559c04a07651ffebf8840c423bdcb5fa32d7e4af72c006b62b"
    },
    "signature": "0x6dc457bd54f914874fd646eb3cbd988430e22b1f2def70a226786dfd1d00add56f13919e8d63c82fd0bf08e56cb14a6fefd9e1fa48910f0086b02cf30517428a1c"
  }
}
```

`refused` answers another holder, a bad signature, a `sequence` that does not follow the latest statement, more shares
than are held, shares worth nothing, and an amount the bankroll cannot release yet.

**Errors:** [`channel-closed`](index.md#errors) (409), [`wrong-asset`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

## The developer bank

A developer's bank holds its money at the casino in one asset: the stakes of its games' developer bets go in, its
settlements and casino bets are paid from it. It belongs to the channel's funding account. A deposit is an
[operation](#post-apichannelsidoperations).

### `GET /api/channels/:id/bank`

The account's bank in this channel's asset, with the casino's latest statement.

**Auth:** channel access · **Idempotent:** yes

Developer bets, settlements and casino bets move the balance between statements, so `balance` can differ from the
statement's, as in the example, where developer bets and the developer's casino bet have moved it since the deposit.
The casino answers this while paused.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Response field | Type           | Meaning                                                                                                       |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `developer`    | address        | The account                                                                                                   |
| `asset`        | string         | `eth` or `test`                                                                                               |
| `balance`      | string         | What the bank holds                                                                                           |
| `sequence`     | number         | The number of the latest statement; 0 before any                                                              |
| `statement`    | object or null | The latest [`BankStatement`](../reference/signed-messages.md#developer-bank-messages), `{message, signature}` |

```json title="Response"
{
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "asset": "eth",
  "balance": "101000000000000000",
  "sequence": 1,
  "statement": {
    "message": {
      "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "asset": "eth",
      "sequence": "1",
      "balance": "100000000000000000",
      "cause": "0x8fe78efba9627ab4d3cefcf345599b103c587beb5e0455d56de0132a295ec5d2"
    },
    "signature": "0x8364e85d90368fdce35f5ee65643adfe87765e90033787a8dad6659eb89fa0880fed2af897cf175b2b3735833b5a4f65e228aa1c77a9a99695d787b93e354ea61b"
  }
}
```

**Errors:** [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

### `POST /api/channels/:id/bank/withdraw`

Takes money out of the account's bank; it is owed at once and collected with a credit.

**Auth:** channel access · **Idempotent:** yes, by statement: the same `Withdraw` again returns its statement while it is the bank's latest

The `Withdraw` names the channel's own account and asset, is signed by the channel's key, and its `sequence` is the
bank's plus one. Nothing in a bank is reserved: any amount up to the balance may leave at any time.
[`…/payouts`](#get-apichannelsidpayouts) then lists it under `BANK_ID`, with the statement's `sequence` as its index.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field  | Type   | Meaning                                                                                                           |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `message`   | object | The [`Withdraw`](../reference/signed-messages.md#developer-bank-messages): `{developer, asset, amount, sequence}` |
| `signature` | string | The channel key's EIP-712 signature of `message`                                                                  |

| Response field | Type   | Meaning                                                                                     |
| -------------- | ------ | ------------------------------------------------------------------------------------------- |
| `statement`    | object | The casino's `BankStatement`, `{message, signature}`, with the balance after the withdrawal |

```json title="Request"
{
  "message": {
    "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "asset": "eth",
    "amount": "10000000000000000",
    "sequence": "2"
  },
  "signature": "0x6d5490a00dced1f8d647315f6174b964d75e1ff947152e19ef282a349d2cf41633e49e1066d406400643a38e38f29ad226e659efc0eeca65a356de5b1fc8fe5f1c"
}
```

```json title="Response"
{
  "statement": {
    "message": {
      "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "asset": "eth",
      "sequence": "2",
      "balance": "91000000000000000",
      "cause": "0x1a37ef55cd1a3c35801b76e8a7de2fbac131cc34f0cf15081d896786f65d348a"
    },
    "signature": "0xf45ea30ef2edd877933fca1499c5f01f3bbd3a72ff7e5c12db299ec3769528d257377c1fda0b038b953038494d684055ac8ac4f18b20fd4bb57529fc4056195d1c"
  }
}
```

`invalid` answers another account's or another asset's bank ("This is another bank"). `refused` answers a bad
signature, a `sequence` that does not follow the latest statement, and an amount of zero or above the balance.

**Errors:** [`invalid`](index.md#errors) (400), [`channel-closed`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

## The profile

A player's profile is public: [`GET /api/players/:name`](public.md#get-apiplayersname) shows it. These two routes
change it, and together take at most 200 changes a minute for one channel.

### `POST /api/channels/:id/alias`

Takes an alias for the channel's player, or gives it up.

**Auth:** channel access · **Idempotent:** yes

An alias is 3 to 20 ASCII letters, digits and underscores, starting with a letter. It is taken from an open ETH
channel: a test channel costs nothing to open, and an alias is one of a kind. Two aliases that read alike, compared in
lower case with `l` and `1` read as `i` and `0` as `o`, are the same alias. `hookedin`, `casino`, `house`, `bankroll`,
`operator`, `admin`, `support`, `system`, `faucet` and `custom` are reserved, and so is anything that reads like them.
A `null` alias gives it up, and the player is shown by their uname again.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field | Type           | Meaning                                    |
| ---------- | -------------- | ------------------------------------------ |
| `alias`    | string or null | The alias to take, or `null` to give it up |

The reply is the player's [profile](public.md#get-apiplayersname).

```json title="Request"
{
  "alias": "studio"
}
```

```json title="Response"
{
  "uname": "biop5et6ov6i5sn3c6p7vxhx",
  "alias": "studio",
  "since": 1790384228636,
  "stats": {
    "eth": {
      "plays": 0,
      "staked": "0",
      "won": "0"
    },
    "test": {
      "plays": 0,
      "staked": "0",
      "won": "0"
    }
  },
  "games": []
}
```

**Errors:** [`invalid`](index.md#errors) (400), [`reserved`](index.md#errors) (400), [`not-funded`](index.md#errors) (403), [`taken`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

### `POST /api/channels/:id/games`

Publishes a game under the channel's player, or takes it down.

**Auth:** channel access · **Idempotent:** yes

The player becomes the game's developer: it earns the game's commission and settles its developer bets, and the
game's key is [`gameKey(player, name)`](../reference/signed-messages.md#game-keys). Publishing a name again with
another URL moves the game and keeps its key. Publishing takes an open ETH channel; taking a game down, with a `null`
`url`, works from any channel. A profile holds at most 100 games. The wallet opens the game only if its manifest names
this developer ([the manifest](../reference/manifest.md)).

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field | Type           | Meaning                                                                                                                                                                                                |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`     | string         | 1 to 32 of `a-z`, `0-9` and `-`, starting with a letter or digit                                                                                                                                       |
| `url`      | string or null | The manifest's URL: `https`, or `http` for `localhost`, `127.0.0.1` or `[::1]`; at most 300 characters; no user name and no fragment; kept as the URL parser normalises it. `null` takes the game down |

The reply is the player's [profile](public.md#get-apiplayersname).

```json title="Request"
{
  "name": "wheel",
  "url": "https://wheel.example/manifest.json"
}
```

```json title="Response"
{
  "uname": "biop5et6ov6i5sn3c6p7vxhx",
  "alias": "studio",
  "since": 1790384228636,
  "stats": {
    "eth": {
      "plays": 0,
      "staked": "0",
      "won": "0"
    },
    "test": {
      "plays": 0,
      "staked": "0",
      "won": "0"
    }
  },
  "games": [
    {
      "name": "wheel",
      "url": "https://wheel.example/manifest.json",
      "key": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
      "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
    }
  ]
}
```

**Errors:** [`invalid`](index.md#errors) (400), [`not-funded`](index.md#errors) (403), [`too-many`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)
