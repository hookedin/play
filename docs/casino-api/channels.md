---
title: Channel endpoints
description: The wallet's routes, for registering a channel, placing operations, acknowledging, collecting what is owed, the fund, the developer bank and the profile.
sidebar:
  order: 2
---

Every route here concerns one channel, `:id`, and needs [channel access](index.md#authentication): a token signed by the
channel's account, which signs everything on its channel. The checkpoints, operations and statements they carry are
specified on [Signed messages](../reference/signed-messages.md). The examples come from one session: a player, `@alice`,
plays the game `wheel` of a developer, `@studio`, which also holds a developer bank.

## Opening and reading a channel

### `POST /api/channels/:id/activate`

Registers a channel with the casino, or returns it if the casino already knows it.

**Auth:** channel access · **Idempotent:** yes: a known channel is returned as it stands

An account's channel opens on-chain with the first [deposit](../reference/contract.md#functions-that-change-state) into
it, whoever sends it, and that deposit must be confirmed (2 blocks on Sepolia, 1 on Anvil). The casino reads the channel
at its last observed block and requires it open, for the account the opening names. The channel starts from its
[base](../reference/signed-messages.md#the-base), all zero: the balance takes the deposit in afterwards, with a
[deposit operation](#post-apichannelsidoperations). The token is the account's, for `:id`. A channel the casino knows is
authenticated and returned with no chain read. Registering a channel counts against
[budgets](index.md#budgets-and-queues) of its own.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field | Type   | Meaning                                                                                                                                                                            |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opening`  | object | `{channelId, player, index}`: [the opening](../reference/signed-messages.md#channel-ids), the account and how many of its channels started closing before it; `channelId` is `:id` |

The reply is the channel as [`GET /api/channels/:id`](#get-apichannelsid) shows it.

```json title="Request"
{
  "opening": {
    "channelId": "0x14e04a66bf74771820a7400ff6cf065175b3d7eb25805a5bd1633b161af5d101",
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "index": "0"
  }
}
```

```json title="Response"
{
  "opening": {
    "channelId": "0x14e04a66bf74771820a7400ff6cf065175b3d7eb25805a5bd1633b161af5d101",
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "index": "0"
  },
  "uname": "8h3hh3edgejmtdp2owso4ak7",
  "alias": null,
  "state": {
    "channelId": "0x14e04a66bf74771820a7400ff6cf065175b3d7eb25805a5bd1633b161af5d101",
    "sequence": "0",
    "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "transitionHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "balance": "0",
    "deposited": "0",
    "withdrawn": "0"
  },
  "playerSignature": "0x",
  "casinoSignature": "0x",
  "acknowledged": true,
  "lastResponse": null,
  "onchain": {
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "deposited": "1000000000000000000",
    "principal": "1000000000000000000",
    "paidOut": "0",
    "status": "1",
    "deadline": "0",
    "closingSequence": "0",
    "closingHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "closingBalance": "0"
  },
  "bankroll": "100000000000001000000"
}
```

`refused` answers an opening whose `channelId` is not `:id` or does not fit its fields, a channel the confirmed chain
does not show open for that account ("Channel is not open on-chain or differs from registration"), and a chain that
moved on during the check ("Chain observation advanced; retry activation").

**Errors:** [`unauthorized`](index.md#errors) (401), [`refused`](index.md#errors) (409),
[`rate-limited`](index.md#errors) (429), [`busy`](index.md#errors) (429), [`paused`](index.md#errors) (503),
[`too-large`](index.md#errors) (413)

### `GET /api/channels/:id`

The channel as the casino holds it: its latest checkpoint and the reply that produced it.

**Auth:** channel access · **Idempotent:** yes

The casino answers this while paused and after the channel is closed, so a wallet can always recover its latest
evidence.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Response field    | Type                   | Meaning                                                                                                                                                                                                                  |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `opening`         | object                 | `{channelId, player, index}`                                                                                                                                                                                             |
| `uname`, `alias`  | string, string or null | The player's names                                                                                                                                                                                                       |
| `state`           | Checkpoint             | The latest checkpoint                                                                                                                                                                                                    |
| `playerSignature` | string                 | The account's countersignature of `state`; `0x` until given                                                                                                                                                              |
| `casinoSignature` | string                 | The casino's signature of `state`; `0x` at the base                                                                                                                                                                      |
| `acknowledged`    | boolean                | Whether `state` is countersigned, or the base, which needs no signature                                                                                                                                                  |
| `lastResponse`    | object or null         | The reply that produced `state`, as [`POST …/operations`](#post-apichannelsidoperations) recorded it, without `bankroll` and `nextRound`; `null` at the base                                                             |
| `onchain`         | object or null         | The contract's record of the channel, `{player, deposited, principal, paidOut, status, deadline, closingSequence, closingHash, closingBalance}`, in decimal strings (see [`channels`](../reference/contract.md#storage)) |
| `claim`           | object or null         | A finalized channel's claim, `{beneficiary, stateHash, amount, paid, protectedRemaining, winningsRemaining, finalizedAt}` (see [`claims`](../reference/contract.md#views)); absent or `null` before                      |
| `bankroll`        | string                 | The bankroll, a hint                                                                                                                                                                                                     |

```json title="Response"
{
  "opening": {
    "channelId": "0x14e04a66bf74771820a7400ff6cf065175b3d7eb25805a5bd1633b161af5d101",
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "index": "0"
  },
  "uname": "8h3hh3edgejmtdp2owso4ak7",
  "alias": null,
  "state": {
    "channelId": "0x14e04a66bf74771820a7400ff6cf065175b3d7eb25805a5bd1633b161af5d101",
    "sequence": "0",
    "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "transitionHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "balance": "0",
    "deposited": "0",
    "withdrawn": "0"
  },
  "playerSignature": "0x",
  "casinoSignature": "0x",
  "acknowledged": true,
  "lastResponse": null,
  "onchain": {
    "player": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "deposited": "1000000000000000000",
    "principal": "1000000000000000000",
    "paidOut": "0",
    "status": "1",
    "deadline": "0",
    "closingSequence": "0",
    "closingHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "closingBalance": "0"
  },
  "bankroll": "100000000000001000000"
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
  "id": "0x04b71074c8781f41322187ac63ec00b8b1b1dce26a027048295c4115ca653064"
}
```

**Errors:** [`unauthorized`](index.md#errors) (401), [`channel-closed`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503)

### `POST /api/channels/:id/operations`

Submits one signed operation, a casino bet, a debit, a credit, a deposit, a withdrawal or a transfer, and answers with
the casino's signed result or its signed rejection.

**Auth:** channel access · **Idempotent:** yes, by operation ID

The casino takes one operation of a channel at a time, in order. Each reply must be acknowledged before the next
operation: the next request carries `acknowledgment`, the account's signature of the reply's `state` with that state's
hash, unless the wallet already posted it to [`…/ack`](#post-apichannelsidack). The exact request sent again returns
the recorded reply; see [retries](index.md#operations-and-retries).

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field       | Type      | Meaning                                                                                                                                                      |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`        | Operation | The signed [operation](../reference/signed-messages.md#transitions), with exactly its fields; `channelId` is `:id`                                           |
| `details`        | Details   | What it means: [details](../reference/signed-messages.md#details-and-memo) whose hash is `request.memo`                                                      |
| `signature`      | string    | The account's EIP-712 signature of `request`                                                                                                                 |
| `acknowledgment` | object    | `{stateHash, signature}`: the hash of the channel's latest checkpoint and the account's signature of it; required while the previous reply is unacknowledged |
| `seed`           | bytes32   | A casino bet's seed, whose hash `request.seedHash` signs                                                                                                     |

What the casino checks and answers, by operation:

| Operation                   | Details                                                  | The casino                                                                                                                                                                                                                                                                                                            | The reply adds                                                                                       |
| --------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Casino bet, kind 1          | `{id, game, group?}`                                     | Needs `seed` when the bet is on the channel's own open round (`400` `invalid` without it); declines a bet on any other round. Admits the bet by [the Kelly rule](../reference/economics.md#a-casino-bet-is-one-wager) before it reads the round's secret, and declines what the bankroll cannot take                  | `commission`; `developer` when the game is published; `nextRound`; when declined, `secret` or `lost` |
| Payment, kind 2             | `{id, game, group?}`                                     | Moves the amount into the bankroll                                                                                                                                                                                                                                                                                    | –                                                                                                    |
| Developer bet, kind 2       | `{id, game, group?, meta}`                               | Moves the stake into the bank of the game's developer; declines a bet on a game nobody publishes                                                                                                                                                                                                                      | –                                                                                                    |
| Investment, kind 2          | `{id, counterparty: FUND_ID}`                            | Mints shares to the channel's player at the current price; declines one too small to buy a share, and one while shares are in issue and the fund's equity is not positive                                                                                                                                             | `statement`: the `ShareStatement`                                                                    |
| Bank deposit, kind 2        | `{id, counterparty: BANK_ID}`                            | Moves the amount into the bank of the channel's own account                                                                                                                                                                                                                                                           | `statement`: the `BankStatement`                                                                     |
| Developer earnings, kind 3  | `{id, counterparty: DEVELOPER_ID}`                       | Pays at most what the account has earned and not collected; `not-due` beyond it                                                                                                                                                                                                                                       | –                                                                                                    |
| Collecting a payout, kind 3 | `{id, counterparty: FUND_ID, BANK_ID or the bet's hash}` | Pays exactly the amount of a [payout](#get-apichannelsidpayouts) listed under that source; `not-due` otherwise                                                                                                                                                                                                        | –                                                                                                    |
| Deposit, kind 4             | `{id}`                                                   | Takes in money deposited into the channel on-chain: signs once the chain has confirmed, at the casino's finality, that the channel's deposits cover the state's `deposited` plus the amount. When it has not seen that, it reads the chain again, and refuses with `unconfirmed` if it still has not, signing nothing | –                                                                                                    |
| Withdrawal, kind 5          | `{id}`                                                   | Has the contract pay the amount to the operation's `recipient`, as below; declines one larger than it can take on now ("At most … ETH can be withdrawn now"), and one to an address that would refuse a plain payment from the contract ("That address does not accept a payment from the contract")                  | –                                                                                                    |
| Transfer, kind 6            | `{id}`                                                   | Has the contract deposit the amount into the current channel of the operation's `recipient`, opening one if it has none, as below; declines one larger than it can take on now. The wallet's lock-in is one to the account itself                                                                                     | –                                                                                                    |

A debit that names any other counterparty is refused with `400` `invalid`. A game's operation its player already
carried out on another channel is declined with `used: true`. A developer bet is known afterwards by the hash of its
operation, which [`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet) takes. So are a withdrawal and a
transfer: the contract's `withdrawals` says whether it has paid one.

The contract pays each withdrawal or transfer once, when anyone sends it the reply's `evidence`, the operation and the
casino's signature after it ([`withdraw`](../reference/contract.md#functions-that-change-state)): out of the deposits it
holds for the channel first and house cash for the rest, all or nothing. The casino takes on one no larger than the
deposits the channel will still hold once the withdrawals owed from it are paid, plus what is left of
`withdrawableHouse` ([the books](public.md#get-apistatus)) once the withdrawals owed have taken what their channels'
deposits do not cover, and declines a larger one, naming that sum. A withdrawal its channel's deposits cover needs no
house cash. The casino sends the withdrawals it owes as soon as it takes them on, oldest first and one owner transaction
at a time. One the contract cannot pay yet, short of house cash, waits while the next is tried, and goes again on every
check of the chain until the chain shows it paid, whoever sent it, or its channel's close final; while none can be paid,
`/api/status` raises `withdrawal-unpaid`. One still unpaid when its channel's close is final comes back to the account
with the close.

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
| `bankroll`        | string     | The bankroll, a hint; not recorded                                                                                                                  |
| `nextRound`       | bytes32    | After a casino bet, settled or declined: the channel's next round; not recorded                                                                     |

A casino bet, and its signed result:

```json title="Request"
{
  "request": {
    "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
    "previousStateHash": "0x111739ff43adee0f9487a987022dedb98dc851f6e9606f61b5a58c5aba9b68d5",
    "sequence": "2",
    "kind": 1,
    "amount": "1000000000000000",
    "recipient": "0x0000000000000000000000000000000000000000",
    "chance": "9131138316486228049",
    "prize": "2000000000000000",
    "round": "0x04b71074c8781f41322187ac63ec00b8b1b1dce26a027048295c4115ca653064",
    "seedHash": "0xea1d67f022cb78a665653c306d850cb8364022e300a1979e0a828c11d579b74f",
    "memo": "0x3961ce1ce0c4af6107dc57d15c2529aee4dfc895d15466e59b4c0f97fd553b55"
  },
  "details": {
    "id": "0x7d356bc43b8055bb2b85cde2c30565d0246c4bf1619746b08105ddf34ac289ef",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "group": "hand-1"
  },
  "signature": "0xd7fb858d156249da5fdb9f8440bcf0ab3e0fc64a2c0a83a5d42fb112d813b4f303f37d91e4c97ae6c77e2af808b21ffa0e82a22e95c62bc191bd180869b5390c1b",
  "acknowledgment": {
    "stateHash": "0x111739ff43adee0f9487a987022dedb98dc851f6e9606f61b5a58c5aba9b68d5",
    "signature": "0x0b4d21d70375db74b5d5140399236706b832c96416b09386503684c2ba5f7fcd02d17c7ae4ef47ff9eb05221be13339dc3be076443022bf06740c39a52d249c41b"
  },
  "seed": "0x15a0475949567258453e0333760f324a2f243ef9f573009e0c42b40452deecc6"
}
```

```json title="Response"
{
  "status": "signed",
  "state": {
    "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
    "sequence": "2",
    "previousStateHash": "0x111739ff43adee0f9487a987022dedb98dc851f6e9606f61b5a58c5aba9b68d5",
    "transitionHash": "0xe56cfe8518544aaeb907795cb359008a92ea6defe0a07e2ce6b799025b5865e7",
    "balance": "1001000000000000000",
    "deposited": "1000000000000000000",
    "withdrawn": "0"
  },
  "casinoSignature": "0x7bc02687e2a128e01bf033ec44171101da589c01c9a7328570db2c99d45cddef1b09a1ba895c28e7d25e03706a4ba127b4a4652bdbf3510147241848c603df181b",
  "evidence": {
    "base": {
      "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
      "sequence": "1",
      "previousStateHash": "0x03a4949cf8dab89441a8dd3d97a00ba70241378963de55b71d4904f9947faaf7",
      "transitionHash": "0x55d7d3aaec36d5dcc2f93931ea03c9f8af126ae418902c57be007f663070a546",
      "balance": "1000000000000000000",
      "deposited": "1000000000000000000",
      "withdrawn": "0"
    },
    "playerSignature": "0x0b4d21d70375db74b5d5140399236706b832c96416b09386503684c2ba5f7fcd02d17c7ae4ef47ff9eb05221be13339dc3be076443022bf06740c39a52d249c41b",
    "casinoSignature": "0xe9bbcfbbe3301f83cc24c02ddaac74d545baf2eaded6aa2cb7f8774809c02a2474205687f4e17d9088a44abf35a66dd3e3636a8d0cad822dbfc1aa52a10e1dcf1b",
    "step": {
      "operation": {
        "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
        "previousStateHash": "0x111739ff43adee0f9487a987022dedb98dc851f6e9606f61b5a58c5aba9b68d5",
        "sequence": "2",
        "kind": 1,
        "amount": "1000000000000000",
        "recipient": "0x0000000000000000000000000000000000000000",
        "chance": "9131138316486228049",
        "prize": "2000000000000000",
        "round": "0x04b71074c8781f41322187ac63ec00b8b1b1dce26a027048295c4115ca653064",
        "seedHash": "0xea1d67f022cb78a665653c306d850cb8364022e300a1979e0a828c11d579b74f",
        "memo": "0x3961ce1ce0c4af6107dc57d15c2529aee4dfc895d15466e59b4c0f97fd553b55"
      },
      "authorization": "0xd7fb858d156249da5fdb9f8440bcf0ab3e0fc64a2c0a83a5d42fb112d813b4f303f37d91e4c97ae6c77e2af808b21ffa0e82a22e95c62bc191bd180869b5390c1b",
      "seed": "0x15a0475949567258453e0333760f324a2f243ef9f573009e0c42b40452deecc6",
      "secret": "0xd4e24340d8948ea05a2e977910ee74f150ff1866f01423c0e429f913e71fe236",
      "casinoSignature": "0x7bc02687e2a128e01bf033ec44171101da589c01c9a7328570db2c99d45cddef1b09a1ba895c28e7d25e03706a4ba127b4a4652bdbf3510147241848c603df181b"
    }
  },
  "details": {
    "id": "0x7d356bc43b8055bb2b85cde2c30565d0246c4bf1619746b08105ddf34ac289ef",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "group": "hand-1"
  },
  "operationId": "0x7d356bc43b8055bb2b85cde2c30565d0246c4bf1619746b08105ddf34ac289ef",
  "commission": "9990000998000",
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "bankroll": "99997985014999503000",
  "nextRound": "0x1bec23aaea291a614dc96efa7a96a0fd6a0020219eb6c0755e70b52f58fd1c1e"
}
```

The channel's next casino bet, which carries the acknowledgment of the first and which the bankroll declines: the
rejection reveals the round's secret and names the next round.

```json title="Request"
{
  "request": {
    "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
    "previousStateHash": "0xbb5ab2e2aa8df65bc80421a47d5a6dc0ec65fcc2fb54688a6c8cdf56d13dfd5d",
    "sequence": "3",
    "kind": 1,
    "amount": "1000000000000000",
    "recipient": "0x0000000000000000000000000000000000000000",
    "chance": "9223372036854775808",
    "prize": "2000000000000000",
    "round": "0x1bec23aaea291a614dc96efa7a96a0fd6a0020219eb6c0755e70b52f58fd1c1e",
    "seedHash": "0x7753a7d311a581c221a1c3cdf571037d0a8047e5f17ce8b4056c582bb72c288c",
    "memo": "0xa0214a9d31981b7ff7699fb4cd3ac8fa5be6c5e14391a3d20866101465d8963f"
  },
  "details": {
    "id": "0xe55e3e09482a48fb40c70077e3f99d173414177d500ed4638179160bf7ce2806",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3"
  },
  "signature": "0x9710d443d3c6d113fc5a8eba764ee649d51700b0d0061fc702e1ed639257c7410a2a99f1e3037fbe1e2b83c4e36ba99a5d32577ed309e11bf80fd03b84438efd1c",
  "acknowledgment": {
    "stateHash": "0xbb5ab2e2aa8df65bc80421a47d5a6dc0ec65fcc2fb54688a6c8cdf56d13dfd5d",
    "signature": "0x0e670bacfff91885dd82c3d6cb7bc854f1f8c2988a2930e1f86898a9b6f69cf8064d66ce308981a7b9e1d4cff3ea02eea9a245919a302855a348b0acd750118d1b"
  },
  "seed": "0x8eddff43f7149caec170c85a98ba858824e139874e456b69a49ec844919d2747"
}
```

```json title="Response"
{
  "status": "rejected",
  "reason": "The bankroll cannot take this casino bet",
  "request": {
    "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
    "previousStateHash": "0xbb5ab2e2aa8df65bc80421a47d5a6dc0ec65fcc2fb54688a6c8cdf56d13dfd5d",
    "sequence": "3",
    "kind": 1,
    "amount": "1000000000000000",
    "recipient": "0x0000000000000000000000000000000000000000",
    "chance": "9223372036854775808",
    "prize": "2000000000000000",
    "round": "0x1bec23aaea291a614dc96efa7a96a0fd6a0020219eb6c0755e70b52f58fd1c1e",
    "seedHash": "0x7753a7d311a581c221a1c3cdf571037d0a8047e5f17ce8b4056c582bb72c288c",
    "memo": "0xa0214a9d31981b7ff7699fb4cd3ac8fa5be6c5e14391a3d20866101465d8963f"
  },
  "details": {
    "id": "0xe55e3e09482a48fb40c70077e3f99d173414177d500ed4638179160bf7ce2806",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3"
  },
  "operationId": "0xe55e3e09482a48fb40c70077e3f99d173414177d500ed4638179160bf7ce2806",
  "state": {
    "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
    "sequence": "4",
    "previousStateHash": "0xbb5ab2e2aa8df65bc80421a47d5a6dc0ec65fcc2fb54688a6c8cdf56d13dfd5d",
    "transitionHash": "0xb0cd096d0a856c4a3c6310a143c7b95ea7a9d59a665990725a89b373349f03b7",
    "balance": "1001000000000000000",
    "deposited": "1000000000000000000",
    "withdrawn": "0"
  },
  "casinoSignature": "0xb7a1dfc739c0392212979f8604d6cb0fecd5bff530ff5a3beea05526d5e3019b02c4f7662d4bfe809772acac660703440642f0027581654757d18d3bcb469c821b",
  "commission": "0",
  "evidence": {
    "base": {
      "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
      "sequence": "2",
      "previousStateHash": "0x111739ff43adee0f9487a987022dedb98dc851f6e9606f61b5a58c5aba9b68d5",
      "transitionHash": "0xe56cfe8518544aaeb907795cb359008a92ea6defe0a07e2ce6b799025b5865e7",
      "balance": "1001000000000000000",
      "deposited": "1000000000000000000",
      "withdrawn": "0"
    },
    "playerSignature": "0x0e670bacfff91885dd82c3d6cb7bc854f1f8c2988a2930e1f86898a9b6f69cf8064d66ce308981a7b9e1d4cff3ea02eea9a245919a302855a348b0acd750118d1b",
    "casinoSignature": "0x7bc02687e2a128e01bf033ec44171101da589c01c9a7328570db2c99d45cddef1b09a1ba895c28e7d25e03706a4ba127b4a4652bdbf3510147241848c603df181b",
    "step": {
      "operation": {
        "channelId": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "sequence": 0,
        "kind": 0,
        "amount": 0,
        "recipient": "0x0000000000000000000000000000000000000000",
        "chance": 0,
        "prize": 0,
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
  "secret": "0xd4277ff4f53826dd17729dac2f6de0a4cf366ea2199e193e4be8c88283c66fee",
  "bankroll": "99998995005000501000",
  "nextRound": "0x4c4387619801cb4a41198fe442d6c06cbdea8c006f8d37ae9031e56f19c2dc78"
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

`invalid` with `400` answers fields other than the operation's, details that do not hash to the memo, a missing
seed, a debit's unknown counterparty, a withdrawal or a transfer whose `recipient` is not an address, or is zero or the
contract, and a nonzero `recipient` on any other operation ("Only a withdrawal or a transfer names a recipient, and
never the contract"); with `409`, details that break
[the details rules](../reference/signed-messages.md#details-and-memo).
`refused` answers a `request.channelId` other than `:id`, a bad signature or acknowledgment signature, an operation
that is not the channel's next, an amount above the balance, and a casino bet whose chance or prize breaks the rules.

**Errors:** [`unauthorized`](index.md#errors) (401), [`invalid`](index.md#errors) (400), [`invalid`](index.md#errors)
(409), [`unacknowledged`](index.md#errors) (409), [`channel-closed`](index.md#errors) (409),
[`id-conflict`](index.md#errors) (409), [`not-due`](index.md#errors) (409), [`unconfirmed`](index.md#errors) (409),
[`refused`](index.md#errors) (409), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429),
[`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

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
    "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
    "sequence": "2",
    "previousStateHash": "0x111739ff43adee0f9487a987022dedb98dc851f6e9606f61b5a58c5aba9b68d5",
    "transitionHash": "0xe56cfe8518544aaeb907795cb359008a92ea6defe0a07e2ce6b799025b5865e7",
    "balance": "1001000000000000000",
    "deposited": "1000000000000000000",
    "withdrawn": "0"
  },
  "casinoSignature": "0x7bc02687e2a128e01bf033ec44171101da589c01c9a7328570db2c99d45cddef1b09a1ba895c28e7d25e03706a4ba127b4a4652bdbf3510147241848c603df181b",
  "evidence": {
    "base": {
      "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
      "sequence": "1",
      "previousStateHash": "0x03a4949cf8dab89441a8dd3d97a00ba70241378963de55b71d4904f9947faaf7",
      "transitionHash": "0x55d7d3aaec36d5dcc2f93931ea03c9f8af126ae418902c57be007f663070a546",
      "balance": "1000000000000000000",
      "deposited": "1000000000000000000",
      "withdrawn": "0"
    },
    "playerSignature": "0x0b4d21d70375db74b5d5140399236706b832c96416b09386503684c2ba5f7fcd02d17c7ae4ef47ff9eb05221be13339dc3be076443022bf06740c39a52d249c41b",
    "casinoSignature": "0xe9bbcfbbe3301f83cc24c02ddaac74d545baf2eaded6aa2cb7f8774809c02a2474205687f4e17d9088a44abf35a66dd3e3636a8d0cad822dbfc1aa52a10e1dcf1b",
    "step": {
      "operation": {
        "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
        "previousStateHash": "0x111739ff43adee0f9487a987022dedb98dc851f6e9606f61b5a58c5aba9b68d5",
        "sequence": "2",
        "kind": 1,
        "amount": "1000000000000000",
        "recipient": "0x0000000000000000000000000000000000000000",
        "chance": "9131138316486228049",
        "prize": "2000000000000000",
        "round": "0x04b71074c8781f41322187ac63ec00b8b1b1dce26a027048295c4115ca653064",
        "seedHash": "0xea1d67f022cb78a665653c306d850cb8364022e300a1979e0a828c11d579b74f",
        "memo": "0x3961ce1ce0c4af6107dc57d15c2529aee4dfc895d15466e59b4c0f97fd553b55"
      },
      "authorization": "0xd7fb858d156249da5fdb9f8440bcf0ab3e0fc64a2c0a83a5d42fb112d813b4f303f37d91e4c97ae6c77e2af808b21ffa0e82a22e95c62bc191bd180869b5390c1b",
      "seed": "0x15a0475949567258453e0333760f324a2f243ef9f573009e0c42b40452deecc6",
      "secret": "0xd4e24340d8948ea05a2e977910ee74f150ff1866f01423c0e429f913e71fe236",
      "casinoSignature": "0x7bc02687e2a128e01bf033ec44171101da589c01c9a7328570db2c99d45cddef1b09a1ba895c28e7d25e03706a4ba127b4a4652bdbf3510147241848c603df181b"
    }
  },
  "details": {
    "id": "0x7d356bc43b8055bb2b85cde2c30565d0246c4bf1619746b08105ddf34ac289ef",
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "group": "hand-1"
  },
  "operationId": "0x7d356bc43b8055bb2b85cde2c30565d0246c4bf1619746b08105ddf34ac289ef",
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
| `signature` | string  | The account's EIP-712 signature of that checkpoint                    |

```json title="Request"
{
  "stateHash": "0xbb5ab2e2aa8df65bc80421a47d5a6dc0ec65fcc2fb54688a6c8cdf56d13dfd5d",
  "signature": "0x0e670bacfff91885dd82c3d6cb7bc854f1f8c2988a2930e1f86898a9b6f69cf8064d66ce308981a7b9e1d4cff3ea02eea9a245919a302855a348b0acd750118d1b"
}
```

```json title="Response"
{
  "acknowledged": true
}
```

`unacknowledged` answers a hash that is not the latest checkpoint's, and `refused` a bad signature.

**Errors:** [`unacknowledged`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

## Payouts and developer bets

### `GET /api/channels/:id/payouts`

What the casino owes the channel's account, for the wallet to collect with credits.

**Auth:** channel access · **Idempotent:** yes

The list holds at most 256 entries. First comes the account's developer earnings, if it has ever earned any; then every
payout not yet collected, ordered by source and index. The wallet collects each with a credit whose details name
`source` as their `counterparty`, for exactly `amount` (for earnings, at most `amount`), and the next reply lists the
rest. Payouts belong to the account, so any of its channels lists and collects them.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Response field | Type    | Meaning                                                                                                                                                                                                                       |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`       | bytes32 | `DEVELOPER_ID` for developer earnings; `FUND_ID` for redeemed shares; `BANK_ID` for a bank withdrawal; a developer bet's hash for what its settlement paid ([counterparties](../reference/signed-messages.md#counterparties)) |
| `index`        | number  | Earnings and developer bets: 0. Redeemed shares: the number of the fund change. A bank withdrawal: the index of the signing-history record that took it out                                                                   |
| `amount`       | string  | What is owed; for earnings, `earned − collected`, which may be `"0"`                                                                                                                                                          |
| `earned`       | string  | Earnings only: the commission the account has earned                                                                                                                                                                          |
| `collected`    | string  | Earnings only: what of it has been collected                                                                                                                                                                                  |
| `games`        | array   | Earnings only: `{game, earned, name}` for each game that earned it, the most first; `name` is the name the game is published under, or `null`                                                                                 |

```text title="Request"
GET /api/channels/0x14e04a66bf74771820a7400ff6cf065175b3d7eb25805a5bd1633b161af5d101/payouts
```

```json title="Response"
[
  {
    "source": "0x2fc2d32d54413eba8857124e3e8c3261740cccc0ba5885f6ea7498ea5bc68adc",
    "index": 0,
    "amount": "18503517611900",
    "earned": "18503517611900",
    "collected": "0",
    "games": [
      {
        "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
        "earned": "18503517611900",
        "name": "wheel"
      }
    ]
  },
  {
    "source": "0x6036e2ff95363cd3feb09ac645f9fa63a1d231a7d546f8ea5688615e683b9263",
    "index": 32,
    "amount": "10000000000000000"
  }
]
```

**Errors:** [`paused`](index.md#errors) (503), [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

### `GET /api/channels/:id/developer-bets`

The account's developer bets, across all its channels.

**Auth:** channel access · **Idempotent:** yes

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Query    | Type   | Meaning                                                                                                    |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `status` | string | `open` or `settled`; required                                                                              |
| `after`  | string | The `cursor` of the previous page: a lowercase bet hash for open bets, a decimal position for settled ones |
| `limit`  | number | How many, a whole number from 1 to 100; default 50                                                         |

The reply is `{bets, cursor, more}` ([pages](index.md#pages)). A bet is `{bet, game, group?, status, stake, collected}`,
and a settled one adds `payout`, what its settlement pays the player, and `settledAt`, in milliseconds. `collected` is
`true` once a positive payout has been credited to a channel; a payout of `"0"` needs no collecting and stays `false`.

```text title="Request"
GET /api/channels/0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034/developer-bets?status=settled&after=0
```

```json title="Response"
{
  "bets": [
    {
      "bet": "0x54dcdb0c1c8051ddf0b7cb98f3e2d04b97f53c2b9eaeaafdec2b7a0f198df40d",
      "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
      "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
      "status": "settled",
      "stake": "1000000000000000",
      "collected": false,
      "payout": "0",
      "settledAt": 1790585368584
    }
  ],
  "cursor": "31000",
  "more": false
}
```

**Errors:** [`invalid`](index.md#errors) (400), [`paused`](index.md#errors) (503), [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

## The bankroll fund

A holding belongs to the channel's account, so it outlives any one channel.
[The bankroll fund](../wallet/bankroll-fund.md) explains investing; an investment is an
[operation](#post-apichannelsidoperations).

### `GET /api/channels/:id/fund`

The channel's player's shares in the bankroll fund, with the casino's latest statement of them.

**Auth:** channel access · **Idempotent:** yes

The casino answers this while paused.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Response field | Type           | Meaning                                                                                                       |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `holder`       | address        | The channel's account                                                                                         |
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
      "equity": "99999981496483388100",
      "totalShares": "99999981496483388100",
      "cause": "0x8d74fa437b02817bea70458451554e18d53b23685b1118d0057473f6e4f1af18"
    },
    "signature": "0x63599632ce2c03cb5bb738f8d61744808f794993a5a11b526d9445d0927be7a27f05cb71c3be3f7af9e133170b0f707fb983dfe97455bb1cf9223be1011b81e11c"
  },
  "value": "10000000000000000"
}
```

**Errors:** [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

### `POST /api/channels/:id/fund/redeem`

Burns shares at the current price; what they are worth leaves the bankroll and is owed to the player.

**Auth:** channel access · **Idempotent:** yes, by statement: the same `Redeem` again returns its statement while it is the holding's latest

The `Redeem` names the channel's own account as its holder, which signs it on its open channel, and its `sequence` is
the holding's plus one. The amount must be more than zero and within the unreserved bankroll; a larger redemption is
refused until the casino bets counting on that money settle. The amount is owed at once:
[`…/payouts`](#get-apichannelsidpayouts) lists it under `FUND_ID`, to be collected with a credit.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field  | Type   | Meaning                                                                                              |
| ----------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `message`   | object | The [`Redeem`](../reference/signed-messages.md#bankroll-fund-messages): `{holder, shares, sequence}` |
| `signature` | string | The account's EIP-712 signature of `message`                                                         |

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
  "signature": "0x09cec4f31400e1f03272a8ba473fd256a25520885f2f961cb93a6b0b695beffd00af4e782086d805c9d2de1914fbe9c8343b23986656f34d61012274477715bb1c"
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
      "equity": "100009981496483388100",
      "totalShares": "100009981496483388100",
      "cause": "0xe59cfada6bf7c1559c04a07651ffebf8840c423bdcb5fa32d7e4af72c006b62b"
    },
    "signature": "0xea6a33f3d1a24b45524a2657be2b167734b4cfac87258e546f04b6e7e1ecaa143716c08c0ae35f28d64bb15f24fabf568e22d0e40aa6bb0c8a7803346679006a1c"
  }
}
```

`refused` answers another holder, a bad signature, a `sequence` that does not follow the latest statement, more shares
than are held, shares worth nothing, and an amount the bankroll cannot release yet.

**Errors:** [`channel-closed`](index.md#errors) (409), [`refused`](index.md#errors) (409),
[`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429),
[`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

## The developer bank

A developer's bank holds its money at the casino: the stakes of its games' developer bets go in, its settlements and
casino bets are paid from it. It belongs to the channel's account. A deposit is an
[operation](#post-apichannelsidoperations).

### `GET /api/channels/:id/bank`

The account's bank, with the casino's latest statement.

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
| `balance`      | string         | What the bank holds                                                                                           |
| `sequence`     | number         | The number of the latest statement; 0 before any                                                              |
| `statement`    | object or null | The latest [`BankStatement`](../reference/signed-messages.md#developer-bank-messages), `{message, signature}` |

```json title="Response"
{
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "balance": "101000000000000000",
  "sequence": 1,
  "statement": {
    "message": {
      "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "sequence": "1",
      "balance": "100000000000000000",
      "cause": "0x12aaa521dd723ee91de745552fd895c0ac4da5cc8f35bf8e74a44493f3e1a813"
    },
    "signature": "0xdcc693fbe340257fe3ff07bf4589d692857a796383bcc433dba245280e3650e83e88949c8f949851854431966a46750698723aa193430e34f18fa56ac00937381b"
  }
}
```

**Errors:** [`unauthorized`](index.md#errors) (401), [`rate-limited`](index.md#errors) (429)

### `POST /api/channels/:id/bank/withdraw`

Takes money out of the account's bank; it is owed at once and collected with a credit.

**Auth:** channel access · **Idempotent:** yes, by statement: the same `BankWithdraw` again returns its statement while
it is the bank's latest

The `BankWithdraw` names the channel's own account, which signs it, and its `sequence` is the bank's plus one. Nothing
in a bank is reserved: any amount up to the balance may leave at any time. [`…/payouts`](#get-apichannelsidpayouts) then
lists it under `BANK_ID`, indexed by its record in the signing history, since every bank counts its own `sequence`.

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field  | Type   | Meaning                                                                                                        |
| ----------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `message`   | object | The [`BankWithdraw`](../reference/signed-messages.md#developer-bank-messages): `{developer, amount, sequence}` |
| `signature` | string | The account's EIP-712 signature of `message`                                                                   |

| Response field | Type   | Meaning                                                                                     |
| -------------- | ------ | ------------------------------------------------------------------------------------------- |
| `statement`    | object | The casino's `BankStatement`, `{message, signature}`, with the balance after the withdrawal |

```json title="Request"
{
  "message": {
    "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "amount": "10000000000000000",
    "sequence": "2"
  },
  "signature": "0x59ce2609dcd4d4347356d3cebec939c0e1df3bdde9cdb63783c8337a3a3d30d74a6da474f518758e2511184267d3c939d871b67896b42fde0eb47f166eca82a31b"
}
```

```json title="Response"
{
  "statement": {
    "message": {
      "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "sequence": "2",
      "balance": "91000000000000000",
      "cause": "0xae4b7b8ab43e358c97f1a7c881463b83053bc606a5a1ae444373baa5ff6d5378"
    },
    "signature": "0x020a66cfcfba4572eae84461d1000891b783b307ba54df09710ae6350810c2017d9d3978f1f5ab2b738e8cf1f6cd6937c793f968c3b35e89b23914814baf1af11b"
  }
}
```

`invalid` answers another account's bank ("This is another bank"). `refused` answers a bad signature, a `sequence` that
does not follow the latest statement, and an amount of zero or above the balance.

**Errors:** [`invalid`](index.md#errors) (400), [`channel-closed`](index.md#errors) (409), [`refused`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

## The profile

A player's profile is public: [`GET /api/players/:name`](public.md#get-apiplayersname) shows it. These two routes
change it, and together take at most 200 changes a minute for one channel.

### `POST /api/channels/:id/alias`

Takes an alias for the channel's player, or gives it up.

**Auth:** channel access · **Idempotent:** yes

An alias is 3 to 20 ASCII letters, digits and underscores, starting with a letter. It is taken from an open channel: an
alias is one of a kind. Two aliases that read alike, compared in lower case with `l` and `1` read as `i` and `0` as `o`,
are the same alias. `hookedin`, `casino`, `house`, `bankroll`, `operator`, `admin`, `support`, `system`, `faucet` and
`custom` are reserved, and so is anything that reads like them. A `null` alias gives it up, and the player is shown by
their uname again.

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
  "uname": "8h3hh3edgejmtdp2owso4ak7",
  "alias": "studio",
  "since": 1790585368360,
  "stats": {
    "plays": 0,
    "staked": "0",
    "won": "0"
  },
  "games": []
}
```

**Errors:** [`invalid`](index.md#errors) (400), [`reserved`](index.md#errors) (400), [`not-funded`](index.md#errors) (403), [`taken`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)

### `POST /api/channels/:id/games`

Publishes a game under the channel's player, or takes it down.

**Auth:** channel access · **Idempotent:** yes

The player becomes the game's developer: it earns the game's commission and settles its developer bets, and the game's
key is [`gameKey(player, name)`](../reference/signed-messages.md#game-keys). Publishing a name again with another URL
moves the game and keeps its key. Publishing takes an open channel; taking a game down, with a `null` `url`, works from
any channel. A profile holds at most 100 games. A `url` the URL parser cannot read is refused with `invalid`,
"A game is the URL of its page" ([game URL](../reference/game-url.md)).

| Path | Type    | Meaning     |
| ---- | ------- | ----------- |
| `id` | bytes32 | The channel |

| Body field | Type           | Meaning                                                                                                                                                                                                        |
| ---------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | string         | 1 to 32 of `a-z`, `0-9` and `-`, starting with a letter or digit                                                                                                                                               |
| `url`      | string or null | The game's URL: `https`, or `http` for `localhost`, `127.0.0.1` or `[::1]`; at most 300 characters; no user name or password and no fragment; kept as the URL parser normalises it. `null` takes the game down |

The reply is the player's [profile](public.md#get-apiplayersname).

```json title="Request"
{
  "name": "wheel",
  "url": "https://wheel.example/"
}
```

```json title="Response"
{
  "uname": "8h3hh3edgejmtdp2owso4ak7",
  "alias": "studio",
  "since": 1790585368360,
  "stats": {
    "plays": 0,
    "staked": "0",
    "won": "0"
  },
  "games": [
    {
      "name": "wheel",
      "url": "https://wheel.example/",
      "key": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
      "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
    }
  ]
}
```

**Errors:** [`invalid`](index.md#errors) (400), [`not-funded`](index.md#errors) (403), [`too-many`](index.md#errors) (409), [`unauthorized`](index.md#errors) (401), [`busy`](index.md#errors) (429), [`rate-limited`](index.md#errors) (429), [`paused`](index.md#errors) (503), [`too-large`](index.md#errors) (413)
