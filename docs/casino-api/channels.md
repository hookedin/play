---
title: Channel endpoints
description: The wallet's routes, for registering a channel, placing operations, collecting what is owed, the fund, the developer bank, the profile, signing in with X and the faucet.
sidebar:
  order: 2
---

Every route here concerns one channel, `:id`, and needs [channel access](index.md#authentication): a token signed by the
channel's account, which signs everything on its channel. The checkpoints, operations and statements they carry are
specified on [Signed messages](../reference/signed-messages.md).

## Opening a channel

### `POST /api/channels/:id/activate`

Registers a channel with the casino, or returns it as the casino holds it. A channel opens on-chain with the first
[deposit](../reference/contract.md#functions-that-change-state) into it, whoever sends it. The casino requires that
deposit confirmed (2 blocks on Sepolia, 1 on Anvil) and the channel open for the account the opening names, and
registers it at its [base](../reference/signed-messages.md#the-base), all zero: the balance takes the deposit in with a
[deposit operation](#post-apichannelsidoperations). A channel the casino knows is returned with no chain read.
Registering a channel counts against [budgets](index.md#budgets-and-queues) of its own.

| Body field | Type   | Meaning                                                                                                                                                                            |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opening`  | object | `{channelId, player, index}`: [the opening](../reference/signed-messages.md#channel-ids), the account and how many of its channels started closing before it; `channelId` is `:id` |

| Response field   | Type                   | Meaning                                                                                                                                 |
| ---------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`, `alias` | string, string or null | The player's names                                                                                                                      |
| `state`          | Checkpoint             | The latest checkpoint                                                                                                                   |
| `lastResponse`   | object or null         | The reply that signed `state`, as [`POST …/operations`](#post-apichannelsidoperations) recorded it, without `quote`; `null` at the base |

`refused` answers an opening whose `channelId` is not `:id` or does not fit its fields, a channel the confirmed chain
does not show open for that account ("Channel is not open on-chain or differs from registration"), and a chain that
moved on during the check ("Chain observation advanced; retry activation").

## Playing

### `POST /api/channels/:id/quote`

Signs the casino's [quote](../reference/signed-messages.md#quotes) for the channel's next casino bet, `{quote}`, as
`{message, signature}`: the bet follows the channel's latest checkpoint and settles on the channel's round, the hash of
a secret the casino keeps until a bet settles on it; the quote names the virtual bankroll the bet is admitted against,
half the bankroll, and holds for a day. A checkpoint has one quote: asking again gives the same one until half its day
is left, and a new one then, on the same round. The round is the same until a casino bet settles on it. Every reply of
[`POST …/operations`](#post-apichannelsidoperations) that follows the channel's latest checkpoint brings its quote, so a
wallet asks here only before a channel's first casino bet, after losing track, or when its quote has less than half its
day left; it picks its seed once it has the round. The body is `{}`. `channel-closed` answers a channel that is not open.

### `POST /api/channels/:id/operations`

Submits one signed operation, a casino bet, a debit, a credit, a deposit, a withdrawal, a transfer or a loan, and
answers with the casino's signed result or a rejection proposal. The casino takes one operation of a channel at a time,
in order, each with the account's acknowledgment of the reply before it. The exact request sent again returns the
recorded reply ([retries](index.md#retries)).

| Body field           | Type      | Meaning                                                                                                                                             |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`            | Operation | The signed [operation](../reference/signed-messages.md#transitions), with exactly its fields; `channelId` is `:id`                                  |
| `details`            | Details   | What it means: [details](../reference/signed-messages.md#details-and-memo) whose hash is `request.memo`                                             |
| `signature`          | string    | The account's EIP-712 signature of `request`                                                                                                        |
| `acknowledgment`     | object    | `{stateHash, signature}`: the hash of the channel's latest checkpoint and the account's signature of it; required unless the channel is at its base |
| `rejectionSignature` | string    | The account's signature of a verified rejection proposal's checkpoint, sent by repeating that operation to complete its cancellation                |
| `seed`               | bytes32   | A casino bet's seed, whose hash `request.seedHash` signs: sent only with a bet `quote` covers                                                       |
| `quote`              | object    | The casino's quote a casino bet relies on, `{message, signature}`, sent with `seed`                                                                 |

A rejection proposal has `status: "rejected"` and `casinoSignature: "0x"`; it signs nothing and leaves the channel at
its checkpoint. The wallet verifies the proposal, saves its signature of `state`, and retries with
`rejectionSignature`. The casino then signs the checkpoint and returns its joint evidence. A recorded result is
returned even when a retry requests cancellation. The wallet retains the proposal's reason for its receipt; the
completed cancellation's reason is `Cancelled by player`.

What the casino checks and answers, by operation:

| Operation                   | Details                                                  | The casino                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The reply adds                                                                          |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Casino bet, kind 1          | `{id, game, group?}`                                     | Settles every bet its `quote` covers: one the casino signed for the channel's latest checkpoint and its open round, not expired, whose virtual bankroll admits the bet by [the Kelly rule](../reference/economics.md#a-casino-bet-is-one-wager); it then needs `seed` (`400` `invalid` without it), and reads the round's secret only after admitting the bet. Declines any other, revealing nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `commission`; `developer` when the game is published; `carried` when declined as `used` |
| Payment, kind 2             | `{id, game, group?}`                                     | Moves the amount into the bankroll                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | –                                                                                       |
| Developer bet, kind 2       | `{id, game, group?, meta}`                               | Moves the stake into the bank of the game's developer; declines a bet on a game nobody publishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | –                                                                                       |
| Investment, kind 2          | `{id, counterparty: FUND_ID}`                            | Mints shares to the channel's player at the current price; declines one too small to buy a share, and one while shares are in issue and the fund's equity is not positive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `statement`: the `ShareStatement`                                                       |
| Bank deposit, kind 2        | `{id, counterparty: BANK_ID}`                            | Moves the amount into the bank of the channel's own account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `statement`: the `BankStatement`                                                        |
| Developer earnings, kind 3  | `{id, counterparty: DEVELOPER_ID}`                       | Pays at most what the account has earned and not collected; `not-due` beyond it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | –                                                                                       |
| Collecting a payout, kind 3 | `{id, counterparty: FUND_ID, BANK_ID or the bet's hash}` | Pays exactly the amount of a [payout](#get-apichannelsidpayouts) listed under that source; `not-due` otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | –                                                                                       |
| Deposit, kind 4             | `{id}`                                                   | Takes in money deposited into the channel on-chain: signs once the chain has confirmed, at the casino's finality, that the channel's deposits cover the state's `deposited` plus the amount; reads the chain again when it has not seen that, and refuses with `unconfirmed` if it still has not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | –                                                                                       |
| Withdrawal, kind 5          | `{id}`                                                   | Has the contract pay the amount to the operation's `recipient`; declines one larger than it can pay now ("At most … ETH can be withdrawn now"), one whose `fee` is below the [withdrawal fee](public.md#get-apiwithdrawal-fee) ("Sending a withdrawal costs a fee of … ETH now"), and one to an address that would refuse the contract's payment, a call with 100,000 gas ("That address does not accept a payment from the contract")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | –                                                                                       |
| Transfer, kind 6            | `{id}`                                                   | Has the contract put the amount into the current channel of the account the operation's `recipient` names, as deposits: a lock-in when that is the channel's own account; declines one larger than it can pay now or with too small a fee, as for a withdrawal, and one to an account with no channel it knows ("That address has no HookedIn balance to transfer into")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | –                                                                                       |
| Fee loan, kind 7            | `{id}`: the hash of a deposit's transaction              | Lends the network fee of a deposit the channel's account sent straight to the contract, into this channel, once the balance has taken it in (`unconfirmed` before, and before the casino sees the transaction): the transaction's gas limit at its fee cap, but no more than 20% over the gas it used and the 1.5% a node's estimate of it may run high, at twice the base fee of the block before its own plus its tip, when that is at most `loanLimit` millionths of the deposit ([`GET /api/config`](public.md#get-apiconfig)). The ID lends each deposit once. Declines another transaction ("That is not a deposit this account sent into this balance"), a balance that, less its loan, holds less than the deposit ("The balance no longer holds that deposit"), another amount ("The casino lends that deposit … ETH of its network fee") and a larger fee ("The casino lends a network fee only up to 1% of its deposit") | –                                                                                       |
| Faucet loan, kind 7         | `{id, counterparty: FAUCET_ID}`                          | Lends what [the faucet](#post-apichannelsidfaucet) lends, `faucet` in [`GET /api/config`](public.md#get-apiconfig), to a balance of less, while the channel's account is signed in with an X account the faucet lends to; once every 24 hours for that X account, whichever account signs in with it. Declines any other, with why ("The faucet lends 10 µETH, no more and no less", "The faucet lends only to a balance of less than 10 µETH", and the faucet's own refusals)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | –                                                                                       |

A debit that names any other counterparty is refused with `400` `invalid`. A game's operation its player already carried
out on another channel is declined with `used: true`; a casino bet its quote covers only when that operation was
settled there, and with `carried`, the operation the account signed there, which the wallet checks. A developer bet is
known afterwards by the hash of its operation, which [`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet)
takes.

So is a withdrawal or a transfer: the reply's `evidence` is what the contract makes a claim of
([withdrawals](../reference/contract.md#withdrawals)), and it has recorded one once its channel's `claimed` has passed
the `withdrawn` of the checkpoint the withdrawal follows. The casino takes on a withdrawal only when it can pay all of it
now ([what the casino promises](../overview/trust-model.md#what-you-trust-the-casino-for)), sends it at once, oldest
first, and owes it until the chain shows it recorded, or its channel's close final without it, which returns it to the
account; while one cannot be sent, `/api/status` raises `withdrawal-unsent`.

| Response field    | Type       | Meaning                                                                                                                               |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `status`          | string     | `signed` for a result, `rejected` for a declined operation                                                                            |
| `state`           | Checkpoint | The result, or the proposed or completed [rejection checkpoint](../reference/signed-messages.md#rejection-checkpoints)                |
| `casinoSignature` | string     | The casino's signature of `state`, or `"0x"` for a rejection proposal                                                                 |
| `evidence`        | Evidence   | A result's base and step; a completed rejection's joint checkpoint and empty step; a proposal's unchanged base and empty step         |
| `details`         | Details    | As sent                                                                                                                               |
| `operationId`     | bytes32    | `details.id`                                                                                                                          |
| `commission`      | string     | A casino bet's commission; `"0"` otherwise                                                                                            |
| `developer`       | address    | A casino bet in a published game: its developer, who earns half the commission                                                        |
| `statement`       | object     | An investment's `ShareStatement` or a deposit's `BankStatement`, as `{message, signature}`                                            |
| `reason`          | string     | Rejected: why, for people                                                                                                             |
| `request`         | Operation  | Rejected: the declined operation                                                                                                      |
| `used`            | boolean    | A game's operation declined because its player carried it out on another channel: `true`                                              |
| `carried`         | object     | A covered casino bet declined as `used`: `{operation, authorization, details}`, the operation the account signed on the other channel |
| `quote`           | object     | The quote for the channel's next casino bet, which follows `state`, when `state` is the channel's latest checkpoint; not recorded     |

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
    "fee": "0",
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
  "seed": "0x15a0475949567258453e0333760f324a2f243ef9f573009e0c42b40452deecc6",
  "quote": {
    "message": {
      "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
      "previousStateHash": "0x111739ff43adee0f9487a987022dedb98dc851f6e9606f61b5a58c5aba9b68d5",
      "round": "0x04b71074c8781f41322187ac63ec00b8b1b1dce26a027048295c4115ca653064",
      "virtualBankroll": "49999492507499751500",
      "expiresAt": "1790889131"
    },
    "signature": "0x5d2b4c1a9e0f7c83d6a41b2e9f07c5d318a6e2f40b9c7d15e8a3f62c0d4b97e1395a0c7e6b2f8d41a0c3e9b75f16d28a4c0e7b93d5f2a61c8e04b7d9136f2a581c"
  }
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
    "withdrawn": "0",
    "loan": "0"
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
      "withdrawn": "0",
      "loan": "0"
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
        "fee": "0",
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
  "quote": {
    "message": {
      "channelId": "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034",
      "previousStateHash": "0x9a3c61e0f4b27d58c1e3a90b6d25f7c48e0a1b93d6c5f2e7408b1d9a3c6e5f20",
      "round": "0x1bec23aaea291a614dc96efa7a96a0fd6a0020219eb6c0755e70b52f58fd1c1e",
      "virtualBankroll": "49998992507499751500",
      "expiresAt": "1790889132"
    },
    "signature": "0x7e40a9c2d51f3b86e0c4d27a9b15f68e3c0d2a74b9e61f58c3a0d7e24b96f1c5082d4e7a1c9b3f60e5d28a4c71b0f9e36d2c5a87e14b0f93d6c2a7e58b140d3e1b"
  }
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

`invalid` with `400` answers fields other than the operation's, details that do not hash to the memo, a missing seed, a
debit's unknown counterparty, a withdrawal or a transfer whose `recipient` is not an address, is zero or is the
contract, and a nonzero `recipient` on any other operation ("Only a withdrawal and a transfer name a recipient, never
nobody and never the contract"); with `409`, details that break
[the details rules](../reference/signed-messages.md#details-and-memo). `unacknowledged` answers a missing or wrong
acknowledgment, `channel-closed` a channel that is not open, and `id-conflict`, `not-due` and `unconfirmed` what the
table says. `refused` answers a `request.channelId` other than `:id`, a bad signature or acknowledgment signature, an
operation that is not the channel's next, an amount above the balance (less its loan and fee, for a withdrawal or a
transfer), a nonzero `fee` on any other operation, and a casino bet whose chance or prize breaks the rules.

## Collateral

### `POST /api/channels/:id/collateral`

Signs the casino's [offer](../reference/signed-messages.md#collateral-offers) of collateral for the channel, `{offer}`,
as `{message, signature}`: `amount` of house cash locked into the channel for `price`, at the casino's
`collateralRate` ([`GET /api/config`](public.md#get-apiconfig)), which anyone buys on-chain with
[`buyCollateral`](../reference/contract.md#collateral) within the hour. The body is `{amount}`, the collateral in wei as
a decimal string, below 2^96 (`400` `invalid` otherwise). The casino offers no more than the house cash no claim or
withdrawal it owes counts on, and refuses more ("At most … ETH of collateral is on offer now"). An
offer reserves nothing: what is bought first is locked, and one bought once that cash has gone reverts. `channel-closed`
answers a channel that is not open.

## Payouts and developer bets

### `GET /api/channels/:id/payouts`

What the casino owes the channel's account, for the wallet to collect with credits. Payouts belong to the account, so
any of its channels lists and collects them. The list holds at most 256 entries: first the account's developer
earnings, if it has ever earned any, then every payout not yet collected, ordered by source and index. The wallet
collects each with a credit whose details name `source` as their `counterparty`, for exactly `amount` (for earnings, at
most `amount`), and the next reply lists the rest.

| Response field | Type    | Meaning                                                                                                                                                                                                                       |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`       | bytes32 | `DEVELOPER_ID` for developer earnings; `FUND_ID` for redeemed shares; `BANK_ID` for a bank withdrawal; a developer bet's hash for what its settlement paid ([counterparties](../reference/signed-messages.md#counterparties)) |
| `index`        | number  | Earnings and developer bets: 0. Redeemed shares: the number of the fund change. A bank withdrawal: the index of the signing-history record that took it out                                                                   |
| `amount`       | string  | What is owed; for earnings, `earned − collected`, which may be `"0"`                                                                                                                                                          |
| `earned`       | string  | Earnings only: the commission the account has earned                                                                                                                                                                          |
| `collected`    | string  | Earnings only: what of it has been collected                                                                                                                                                                                  |

### `GET /api/channels/:id/developer-bets`

The account's developer bets, across all its channels: `{bets, cursor, more}` ([pages](index.md#pages)). A bet is
`{bet, game, group?, status, stake, collected}`, and a settled one adds `payout`, what its settlement pays the player,
and `settledAt`. `collected` is `true` once a positive payout has been credited to a channel; a payout of `"0"` needs no
collecting and stays `false`.

| Query    | Type   | Meaning                                                                                         |
| -------- | ------ | ----------------------------------------------------------------------------------------------- |
| `status` | string | `open` or `settled`; required                                                                   |
| `after`  | string | The `cursor` of the previous page: a decimal position in the order bets were placed, or settled |
| `limit`  | number | How many, a whole number from 1 to 100; default 50                                              |

`invalid` answers a missing status, or a malformed cursor or limit.

## The bankroll fund

[The bankroll fund](../wallet/bankroll-fund.md) explains investing, which is an
[operation](#post-apichannelsidoperations); the messages are [the fund's](../reference/signed-messages.md#bankroll-fund-messages).
A holding belongs to the channel's account, so it outlives any one channel.

### `GET /api/channels/:id/fund`

The account's holding: `{statement, redeems}`, the casino's latest `ShareStatement` of it (`null` before any), and every
`Redeem` the account signed, each as `{request: {message, signature}, statement}` with the statement it produced. A
wallet that missed statements takes the latest up with them ([bankroll fund](../wallet/bankroll-fund.md)).

### `POST /api/channels/:id/fund/redeem`

Burns shares at the current price; what they are worth leaves the bankroll and is owed to the account at once, listed
by [`…/payouts`](#get-apichannelsidpayouts) under `FUND_ID`. The same `Redeem` again returns its statement while it is
the holding's latest. The `Redeem` names the channel's own account as its holder and follows the holding's latest
statement; the amount must be more than zero and within the unreserved bankroll, so a larger redemption waits for the
casino bets counting on that money to settle.

| Body field  | Type   | Meaning                                      |
| ----------- | ------ | -------------------------------------------- |
| `message`   | object | The `Redeem`: `{holder, shares, sequence}`   |
| `signature` | string | The account's EIP-712 signature of `message` |

The reply is `{statement}`, the casino's `ShareStatement`, whose `amount` is what the shares paid. `channel-closed`
answers a channel that is not open; `refused` answers another holder, a bad signature, a `sequence` that does not follow
the latest statement, more shares than are held, shares worth nothing, and an amount the bankroll cannot release yet.

## The developer bank

A developer's bank holds its money at the casino: the stakes of its games' developer bets go in, its settlements and
casino bets are paid from it ([developer bank messages](../reference/signed-messages.md#developer-bank-messages)). It
belongs to the channel's account. A deposit is an [operation](#post-apichannelsidoperations).

### `GET /api/channels/:id/bank`

The account's bank: `{developer, balance, sequence, statement}`, what it holds and the casino's latest `BankStatement`
(`null` and 0 before any). Developer bets, settlements and casino bets move the balance between statements, so `balance`
can differ from the statement's.

### `POST /api/channels/:id/bank/withdraw`

Takes money out of the account's bank: any amount up to the balance, at any time, owed at once and listed by
[`…/payouts`](#get-apichannelsidpayouts) under `BANK_ID`. The same `BankWithdraw` again returns its statement while it is
the bank's latest. The `BankWithdraw` names the channel's own account and follows the bank's latest statement.

| Body field  | Type   | Meaning                                             |
| ----------- | ------ | --------------------------------------------------- |
| `message`   | object | The `BankWithdraw`: `{developer, amount, sequence}` |
| `signature` | string | The account's EIP-712 signature of `message`        |

The reply is `{statement}`, the casino's `BankStatement` with the balance after the withdrawal. `invalid` answers another
account's bank; `channel-closed` a channel that is not open; `refused` a bad signature, a `sequence` that does not follow
the latest statement, and an amount of zero or above the balance.

## The profile

A player's profile is public: [`GET /api/players/:name`](public.md#get-apiplayersname) shows it, and it is the reply of
the X and games routes. The casino has one for every account it has registered a channel of, and every account that
signed in with X.

### `POST /api/channels/:id/uname`

The account's uname, told to the account alone: the token proves it holds the account's key, for any of its channels,
opened or not, so an account has its uname before its first deposit. The wallet asks with its first channel, `index`
`0`, as soon as it loads an account. Asking records nothing, and this route tells nobody the uname of an address
without that address's signature: the casino derives unames with a key it keeps secret. It counts against the
[budget](index.md#budgets-and-queues) of registering a channel.

| Body field | Type   | Meaning                                                                                                                                         |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `opening`  | object | `{channelId, player, index}`: [the opening](../reference/signed-messages.md#channel-ids) of any of the account's channels; `channelId` is `:id` |

| Response field | Type           | Meaning                                                                |
| -------------- | -------------- | ---------------------------------------------------------------------- |
| `uname`        | string         | The account's uname                                                    |
| `profile`      | object or null | Its public profile, once the casino has met the account; `null` before |

`refused` answers an opening whose `channelId` is not `:id` or does not fit its fields.

### `POST /api/channels/:id/games`

Publishes a game under the channel's player, or takes it down: `{name, url}`. The player becomes the game's developer:
it earns the game's commission and settles its developer bets, and the game's key is
[`gameKey(player, name)`](../reference/signed-messages.md#game-keys). Publishing a name again with another URL moves the
game and keeps its key. Publishing needs an open channel; taking a game down, with a `null` `url`, works from any
channel. [The game's URL](../games/publishing.md#the-games-url) gives the rules for `name` and `url`.
`invalid` answers a name or URL those rules do not allow, `channel-closed` a channel that is closing or closed, and `too-many` a
profile that already publishes 100 games.

## Signing in with X

Signing in with X is the one way to an alias: an account signed in with an X account goes by its username
([your name](../wallet/getting-started.md#your-name)). The casino asks X about an X account only as its player signs
in, and keeps no token. These routes take `{opening}`, as [the uname](#post-apichannelsiduname) does, from an account
with a channel or without one, and count against the [budget](index.md#budgets-and-queues) of registering a channel.
`not-found` answers where the casino offers no signing in with X: `x` in [`GET /api/config`](public.md#get-apiconfig)
is `false`.

### `POST /api/channels/:id/x/start`

Starts signing in with X for the account, and answers `{url}`: X's sign-in page, which the wallet sends the browser to.
X sends it back to the wallet's `/x` page with `state` and `code`, or with `error` when the player cancels. A sign-in
waits 10 minutes, and an account has one waiting at most: starting another ends the one before.

### `POST /api/channels/:id/x/finish`

Finishes the account's sign-in with X: `{opening, state, code}`, what X sent the browser back with. The casino trades
the code for a token and reads the X account once with it, with the X API's `GET /2/users/me`: its ID, its username and
whether it has X Premium, X's blue check (`verified_type` `blue`). From then on the account's alias is the username, and
its profile's `x` says whether the X account had X Premium then, and when. An X account is one account's: signing in
with it on another account signs the first out of it. Answers the account's profile.

`x-refused` answers a sign-in another account started, one finished already or older than 10 minutes, and a code X
does not accept: sign in again. `x-unavailable` answers when X does not answer, or does not answer the casino's app.
`reserved` answers a username the casino keeps for itself, and `taken` one that reads like another player's alias. The
same username as another player's alias, whatever its case, is one X has moved to this X account: the player who had it
is signed out of X.

### `POST /api/channels/:id/x/sign-out`

Signs the account out of X, `{opening}`: it goes by its uname again, its profile's `x` is `null`, and the faucet lends to
it no more. Answers the profile; `not-found` answers an account not signed in with X.

## The faucet

### `POST /api/channels/:id/faucet`

Asks the faucet for free µETH, `{opening}`. The faucet lends `faucet` wei, 10 µETH ([`GET /api/config`](public.md#get-apiconfig)),
to an account signed in with an X account that had X Premium when it last signed in with it, at most 30 days ago, while
the account's balance holds less: once every 24 hours for each X account, whichever account signs in with it. It is a
[faucet loan](#post-apichannelsidoperations): bets stake it, and a withdrawal, a transfer or a close pays it back first.

| Response field | Type    | Meaning                                                                                                       |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `amount`       | string  | What the faucet lends                                                                                         |
| `opening`      | boolean | Whether the account has no open channel, which the casino opens for it with a deposit of 1 wei, as anyone may |

The account borrows with a faucet loan once its channel is open and registered. The casino opens a channel once every 24
hours for each X account, and answers `opening: true` again while that deposit is on its way. `not-premium` answers an
account not signed in with X, signed in with an X account that had no X Premium, or signed in more than 30 days ago:
sign in with X again. `refused` answers an X account the faucet lent to, or opened a channel for, in the last 24 hours,
saying when it does again, and a balance that holds what the faucet lends.
