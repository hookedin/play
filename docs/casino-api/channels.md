---
title: Channel and account endpoints
description: The wallet's routes, for registering a channel, placing operations and collateral on it, and what belongs to the account, whatever its channels - its names, what it is owed, its developer bets, its shares, its games with their banks and servers, and verifying a Discord account.
sidebar:
  order: 2
---

The wallet's routes need [account access](index.md#authentication): a token the account signed, which serves for all
its channels. Those under `/api/channels/:id` concern one channel, which the account signs everything on; those under
`/api/account/`, [the account](#the-account), what belongs to it whatever its channels. The checkpoints, operations
and statements they carry are specified on [Signed messages](../reference/signed-messages.md).

## Registering a channel

### `POST /api/channels/:id/activate`

Registers the account's current channel with the casino, or returns it as the casino holds it. The channel is active
from the start, with nothing to open: the casino registers it at its [base](../reference/signed-messages.md#the-base),
all zero, once the chain holds a deposit for it, [confirmed](../reference/deployment.md#chains), whoever sent it, and
the balance takes the deposit in with a [deposit operation](#post-apichannelsidoperations). It also registers it before
any deposit while it owes the account something, such as a [transfer](#post-apichannelsidoperations). A channel the
casino knows is returned with no chain read. The body is `{}`: the token names the account, and the chain which of its
channels is current. Registering a channel counts against [budgets](index.md#budgets-and-queues) of its own.

| Response field             | Type                   | Meaning                                                                                                                                 |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`, `discordUsername` | string, string or null | The player's names                                                                                                                      |
| `state`                    | Checkpoint             | The latest checkpoint                                                                                                                   |
| `lastResponse`             | object or null         | The reply that signed `state`, as [`POST …/operations`](#post-apichannelsidoperations) recorded it, without `quote`; `null` at the base |

`refused` answers a `:id` that is not the account's current channel ("Channel is not the account's current one"), one the confirmed chain holds no deposit for while
the casino owes its account nothing ("Channel holds no deposit, and its account is owed nothing"), and a chain that
moved on during the check ("Chain observation advanced; retry activation").

## Playing

### `POST /api/channels/:id/quote`

Signs the casino's [quote](../reference/signed-messages.md#quotes) for the channel's next casino bet, `{quote}`, as
`{message, signature}`: the bet follows the channel's latest checkpoint and settles on the channel's round, the hash of
a secret the casino keeps until a bet settles on it; the quote names the virtual bankroll the bet is admitted against,
half the bankroll, and holds for a day. A checkpoint has one quote: asking again gives the same one until half its day
is left, and a new one then, on the same round, the checkpoint's own. Every reply of
[`POST …/operations`](#post-apichannelsidoperations) that follows the channel's latest checkpoint brings its quote, so a
wallet asks here only before a channel's first casino bet, after losing track, or when its quote has less than half its
day left; it picks its seed once it has the round. The body is `{}`. `channel-closed` answers a channel that is not
active.

### `POST /api/channels/:id/operations`

Submits one signed operation, a casino bet, a debit, a credit, a deposit, a withdrawal or a lock-in, and
answers with the casino's signed result or a rejection proposal. The casino takes one operation of a channel at a time,
in order, each with the account's acknowledgment of the reply before it. The exact request sent again returns the
recorded reply ([retries](index.md#retries)).

| Body field           | Type      | Meaning                                                                                                                                             |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`            | Operation | The signed [operation](../reference/signed-messages.md#transitions), with exactly its fields, following the latest checkpoint of `:id`              |
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

| Operation                   | Details                                                                                 | The casino                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The reply adds                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Casino bet, kind 1          | `{id, game, group?}`                                                                    | Settles every bet its `quote` covers: one the casino signed for the channel's latest checkpoint and its open round, not expired, whose virtual bankroll admits the bet by [the Kelly rule](../reference/economics.md#a-casino-bet-is-one-wager); it then needs `seed` (`400` `invalid` without it), and reads the round's secret only after admitting the bet. Declines any other, revealing nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `commission`; `developer` when the game is published; `carried` when declined as `used` |
| Payment, kind 2             | `{id, game, group?}`                                                                    | Moves the amount into the bankroll                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | –                                                                                       |
| Developer bet, kind 2       | `{id, game, group?, meta}`                                                              | Moves the stake into the game's bank; declines a bet on a game nobody publishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | –                                                                                       |
| Investment, kind 2          | `{id, counterparty: FUND_ID}`                                                           | Mints shares to the channel's player at the current price; declines one too small to buy a share, and one while shares are in issue and the fund's equity is not positive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `statement`: the `ShareStatement`                                                       |
| Bank deposit, kind 2        | `{id, counterparty: the game's key}`                                                    | Moves the amount into the bank of a game the channel's account publishes, or took down; refuses another's game with `400` `invalid`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `statement`: the `BankStatement`                                                        |
| Transfer, kind 2            | `{id, counterparty: "~" + the recipient's uname}`                                       | Debits the amount and owes it to the player the uname belongs to, as a [payout](#get-apiaccountpayouts) under this account's uname, which their wallet collects; nothing goes on-chain. Declines one to a uname nobody goes by ("Nobody goes by ~…") and one to the account itself ("A transfer goes to another player")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | –                                                                                       |
| Collecting a payout, kind 3 | `{id, counterparty: FUND_ID, a game's key, the bet's hash or "~" + the sender's uname}` | Pays exactly the amount of a [payout](#get-apiaccountpayouts) listed under that source; `not-due` otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | –                                                                                       |
| Deposit fee, kind 3         | `{id, counterparty: DEPOSIT_FEE_ID}`, `id` the hash of a deposit's transaction          | Pays the network fee of a deposit the channel's account sent straight to the contract, into this channel, once the balance has taken it in (`unconfirmed` before, and before the casino sees the transaction): the transaction's gas limit at its fee cap, but no more than 20% over the gas it used and the 1.5% a node's estimate of it may run high, at twice the base fee of the block before its own plus its tip, when that is at most `depositFeeLimit` millionths of the deposit ([`GET /api/config`](public.md#get-apiconfig)) and both the casino's budget for the UTC day and the bankroll have room for it. The ID pays each deposit's fee once. `not-due` answers another transaction ("That is not a deposit this account sent into this balance"), another amount ("The casino pays that deposit … METH of its network fee"), a larger fee ("The casino pays a network fee only up to 1% of its deposit") a spent budget ("The casino pays no more network fees today") and a bankroll short of it ("The bankroll cannot pay that network fee now"), and the wallet asks no more | –                                                                                       |
| Deposit, kind 4             | `{id}`                                                                                  | Takes in money deposited into the channel on-chain: signs once the chain has confirmed, at the casino's finality, that the channel's deposits cover the state's `deposited` plus the amount; reads the chain again when it has not seen that, and refuses with `unconfirmed` if it still has not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | –                                                                                       |
| Withdrawal, kind 5          | `{id}`                                                                                  | Has the contract pay the amount to the operation's `recipient`; declines one larger than it can pay now ("At most … ETH can be withdrawn now"), one whose `fee` is below the [withdrawal fee](public.md#get-apiwithdrawal-fee) ("Sending a withdrawal costs a fee of … ETH now"), and one to an address that would refuse the contract's payment, a call with [the contract's gas](../reference/contract.md#withdrawals) ("That address does not accept a payment from the contract")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | –                                                                                       |
| Lock-in, kind 6             | `{id}`                                                                                  | Has the contract put the amount into the account's current channel, as deposits; declines one larger than it can pay now or with too small a fee, as for a withdrawal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | –                                                                                       |

A debit that names any other counterparty is refused with `400` `invalid`. A game's operation its player already carried
out on another channel is declined with `used: true`; a casino bet its quote covers only when that operation was
settled there, and with `carried`, the operation the account signed there and the checkpoint it follows, which the
wallet checks. A developer bet is
known afterwards by the hash of its operation, which [`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet)
takes.

So is a withdrawal or a lock-in: the reply's `evidence` is what the contract makes a claim of
([withdrawals](../reference/contract.md#withdrawals)), and it has recorded one once its channel's `claimed` has passed
the `withdrawn` of the checkpoint the withdrawal follows. The casino takes it on and sends it as it
[promises](../overview/trust-model.md#what-you-trust-the-casino-for); while one cannot be sent, `/api/status` raises
`withdrawal-unsent`.

| Response field    | Type       | Meaning                                                                                                                                                                   |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`          | string     | `signed` for a result, `rejected` for a declined operation                                                                                                                |
| `state`           | Checkpoint | The result, or the proposed or completed [rejection checkpoint](../reference/signed-messages.md#rejection-checkpoints)                                                    |
| `casinoSignature` | string     | The casino's signature of `state`, or `"0x"` for a rejection proposal                                                                                                     |
| `evidence`        | Evidence   | A result's base and step; a completed rejection's joint checkpoint and empty step; a proposal's unchanged base and empty step                                             |
| `details`         | Details    | As sent                                                                                                                                                                   |
| `operationId`     | bytes32    | `details.id`                                                                                                                                                              |
| `commission`      | string     | A casino bet's commission; `"0"` otherwise                                                                                                                                |
| `developer`       | address    | A casino bet in a published game: its developer, whose game's bank takes half the commission                                                                              |
| `statement`       | object     | An investment's `ShareStatement` or a deposit's `BankStatement`, as `{message, signature}`                                                                                |
| `reason`          | string     | Rejected: why, for people                                                                                                                                                 |
| `request`         | Operation  | Rejected: the declined operation                                                                                                                                          |
| `used`            | boolean    | A game's operation declined because its player carried it out on another channel: `true`                                                                                  |
| `carried`         | object     | A covered casino bet declined as `used`: `{base, operation, authorization, details}`, the operation the account signed on the other channel and the checkpoint it follows |
| `quote`           | object     | The quote for the channel's next casino bet, which follows `state`, when `state` is the channel's latest checkpoint; not recorded                                         |

A casino bet, and its signed result:

```json title="Request"
{
  "request": {
    "previousStateHash": "0xadf17ffce9d913ead9d4822afcba1d2215b42b1389e1da90b0fde64b2949c840",
    "kind": 1,
    "amount": "1000000000000000",
    "recipient": "0x0000000000000000000000000000000000000000",
    "fee": "0",
    "chance": "9131138316486228049",
    "prize": "2000000000000000",
    "round": "0xd66d18052d51b799348ff80954250c2d9df4dcb3f4b7e072e300d69aa5cf0599",
    "seedHash": "0xfa3cc4619661fee59d9d528dc41ee2d1f03b6bac3d855d94cf81f10354808e5f",
    "memo": "0x14c0e7a10ee2990b106abe2966d66289db7f7ad2c457a2d8790179809e579f76"
  },
  "details": {
    "id": "0xef9dcc1eb1273ed3947730f697191b5f74ad40cfff6be51b88daee247abdfcf1",
    "game": "0x582b13c97fb125c2ec72de240af75bfa92bb51690779516a414f85f65b9561b6",
    "group": "hand-1"
  },
  "signature": "0xea24d5fb60bf8129dbb9770b0674ab3db2d74ff8701447f0d9e1ef66fa16b51561827bf9778e7711dd4ec0486ac84507a2cd8af2e72ddd415d64fb8de3a534711b",
  "acknowledgment": {
    "stateHash": "0xadf17ffce9d913ead9d4822afcba1d2215b42b1389e1da90b0fde64b2949c840",
    "signature": "0xcf290d2f9691a819874e09b31ab84df51c07dd862259d670be9eba821f408ea53f412fa711224a7d6110b283f15d6bcc948bf0ce8bfe516e24a3ef092f000f8d1b"
  },
  "seed": "0x9fb2e6252566fd6d559926ee050164b714b1b0050d390b606b5826cc06f50635",
  "quote": {
    "message": {
      "previousStateHash": "0xadf17ffce9d913ead9d4822afcba1d2215b42b1389e1da90b0fde64b2949c840",
      "round": "0xd66d18052d51b799348ff80954250c2d9df4dcb3f4b7e072e300d69aa5cf0599",
      "virtualBankroll": "500000000000000000000",
      "expiresAt": "1791216765"
    },
    "signature": "0xaf7b5ceae069d1acab5b2738c184c1754a40afdf65dfc3fae6330a6bdfb02c4414fed299cf3732c0a30609dda4b7a7dc22a98690e450594c8f95131932eb47e11c"
  }
}
```

```json title="Response"
{
  "status": "signed",
  "state": {
    "player": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "index": "0",
    "sequence": "2",
    "previousStateHash": "0xadf17ffce9d913ead9d4822afcba1d2215b42b1389e1da90b0fde64b2949c840",
    "transitionHash": "0x4a679e9760bfdccc68fde145feaabc83ebbbe212e4d2a7f8c2dd30e2f23050fa",
    "balance": "1001000000000000000",
    "deposited": "1000000000000000000",
    "withdrawn": "0"
  },
  "casinoSignature": "0x8ab5d8d991a43e0b4a8a4952ccb43a5009673cefcaa923957ca496735a34fef301646dba41b5a3d10a248989b43d31f3b99f9d64e21d5c16b699a761c088e66b1c",
  "evidence": {
    "base": {
      "player": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      "index": "0",
      "sequence": "1",
      "previousStateHash": "0x836f9beb2ba08f6d31d003ae0cd8acbed41c3fd00ef38ad195a57af5bae061bd",
      "transitionHash": "0xcdb47be38e0fa1503e9a41371606dbca83e4f315a86b13206a7301d167ec6089",
      "balance": "1000000000000000000",
      "deposited": "1000000000000000000",
      "withdrawn": "0"
    },
    "playerSignature": "0xcf290d2f9691a819874e09b31ab84df51c07dd862259d670be9eba821f408ea53f412fa711224a7d6110b283f15d6bcc948bf0ce8bfe516e24a3ef092f000f8d1b",
    "casinoSignature": "0xd6f2cd72a1a595808d2c26e7b4f9ed8926bcb6d51b72003d2bfd4ae08cf59fc2181a40eb0737f8fa565df5e4934778d765eb17150239014d6a86eb80ac60702b1b",
    "step": {
      "operation": {
        "previousStateHash": "0xadf17ffce9d913ead9d4822afcba1d2215b42b1389e1da90b0fde64b2949c840",
        "kind": 1,
        "amount": "1000000000000000",
        "recipient": "0x0000000000000000000000000000000000000000",
        "fee": "0",
        "chance": "9131138316486228049",
        "prize": "2000000000000000",
        "round": "0xd66d18052d51b799348ff80954250c2d9df4dcb3f4b7e072e300d69aa5cf0599",
        "seedHash": "0xfa3cc4619661fee59d9d528dc41ee2d1f03b6bac3d855d94cf81f10354808e5f",
        "memo": "0x14c0e7a10ee2990b106abe2966d66289db7f7ad2c457a2d8790179809e579f76"
      },
      "authorization": "0xea24d5fb60bf8129dbb9770b0674ab3db2d74ff8701447f0d9e1ef66fa16b51561827bf9778e7711dd4ec0486ac84507a2cd8af2e72ddd415d64fb8de3a534711b",
      "seed": "0x9fb2e6252566fd6d559926ee050164b714b1b0050d390b606b5826cc06f50635",
      "secret": "0x03d26c92c8987bcfcf2fbe7eb579388c6e6549369b602e6bcb0f40a28c562acf",
      "casinoSignature": "0x8ab5d8d991a43e0b4a8a4952ccb43a5009673cefcaa923957ca496735a34fef301646dba41b5a3d10a248989b43d31f3b99f9d64e21d5c16b699a761c088e66b1c"
    }
  },
  "details": {
    "id": "0xef9dcc1eb1273ed3947730f697191b5f74ad40cfff6be51b88daee247abdfcf1",
    "game": "0x582b13c97fb125c2ec72de240af75bfa92bb51690779516a414f85f65b9561b6",
    "group": "hand-1"
  },
  "operationId": "0xef9dcc1eb1273ed3947730f697191b5f74ad40cfff6be51b88daee247abdfcf1",
  "commission": "9998000199920",
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "quote": {
    "message": {
      "previousStateHash": "0x0514b65c081713f5d0f9d08ad1da62b9d58ba7bfd6982d3c4473098c098e16a7",
      "round": "0xa33f40bd191331cbf3b13aa8568be118d833d49ca5204b650ef937f84369e510",
      "virtualBankroll": "499998992501499850060",
      "expiresAt": "1791216765"
    },
    "signature": "0x0294cf05ee689eecfa65fb9492bd6df6591c96a984311726cdd0fcb292134c26582403f9a472e19597fba19bc73675925c84d4e1936d84b91bc01e987817a4971b"
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
debit's unknown counterparty, a withdrawal whose `recipient` is not an address, is zero or is the contract, and a
nonzero `recipient` on any other operation, a lock-in's among them ("Only a withdrawal names a recipient, never nobody
and never the contract"); with `409`, details that break
[the details rules](../reference/signed-messages.md#details-and-memo). `unacknowledged` answers a missing or wrong
acknowledgment, `channel-closed` a channel that is not active, and `id-conflict`, `not-due` and `unconfirmed` what the
table says. `refused` answers a bad signature or acknowledgment signature, an operation that does not follow the
latest checkpoint of `:id`, an amount above the balance (less its fee, for a withdrawal or a
lock-in), a nonzero `fee` on any other operation, and a casino bet whose chance or prize breaks the rules.

## Collateral

### `POST /api/channels/:id/collateral`

Signs the casino's [offer](../reference/signed-messages.md#collateral-offers) of collateral for the channel, `{offer}`,
as `{message, signature}`: `amount` of house cash locked into the channel for `price`, at the casino's `collateralRate`
([`GET /api/config`](public.md#get-apiconfig)), which anyone buys on-chain with
[`buyCollateral`](../reference/contract.md#collateral) within the hour. The body is `{amount}`, the collateral in wei
as a decimal string, below 2^96 (`400` `invalid` otherwise). The casino offers no more than the house cash no claim or
withdrawal it owes counts on, and refuses more ("At most … ETH of collateral is on offer now"). An offer reserves
nothing: what is bought first is locked, and one bought once that cash has gone reverts. `channel-closed` answers a
channel that is not active.

## The account

What belongs to the account, whatever its channels: its names, what it is owed, its developer bets, its shares in the
fund and the games it publishes, with their banks and servers. Every route takes the [account's token](index.md#authentication) alone, so an
account with no balance asks too. Its uname and Discord routes count against the
[budget](index.md#budgets-and-queues) of registering a channel, and the rest against the account's own.

### `POST /api/account/uname`

The account's uname, told to the account alone: the token proves it holds the account's key, so an account has its
uname before its first deposit. The wallet asks as soon as it loads an account. Asking records nothing, and this route
tells nobody the uname of an address without that address's signature: the casino derives unames with a key it keeps
secret. The body is `{}`.

| Response field | Type           | Meaning                                                                                                                                                     |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`        | string         | The account's uname                                                                                                                                         |
| `profile`      | object or null | Its own profile, once the casino has met the account; `null` before                                                                                         |
| `registers`    | boolean        | Whether the casino registers the account's current channel before the chain holds a deposit for it: it owes the account something, or registered it already |

An account's own profile is its [public profile](public.md#get-apiplayersname). Unlinking a Discord account and
publishing a game answer with it too.

### `GET /api/account/payouts`

What the casino owes the account, for its wallet to collect into its balance with credits, transfers from other players
among them. The list holds at most 256 entries: every payout not yet collected, ordered by source and then by record.
The wallet collects each with a credit whose details name `source` as their `counterparty`, for exactly `amount`, and
the next reply lists the rest.

| Response field    | Type           | Meaning                                                                                                                                                                                                                                        |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`          | string         | `FUND_ID` for redeemed shares; a game's key for money taken out of its bank; a developer bet's hash for what its settlement paid; `~` and the sender's uname for a transfer ([counterparties](../reference/signed-messages.md#counterparties)) |
| `record`          | string         | The ID of the signing-history record that made it owed                                                                                                                                                                                         |
| `amount`          | string         | What is owed                                                                                                                                                                                                                                   |
| `discordUsername` | string or null | Transfers only: the Discord username the sender goes by now, if any                                                                                                                                                                            |

### `GET /api/account/developer-bets`

The account's developer bets, across all its channels: `{bets, cursor, more}` ([pages](index.md#pages)). A bet is
`{bet, game, group?, status, stake, collected}`, and a settled one adds `payout`, what its settlement pays the player,
and `settledAt`. `collected` is `true` once a positive payout has been credited to a channel; a payout of `"0"` needs no
collecting and stays `false`.

| Query    | Type   | Meaning                                                   |
| -------- | ------ | --------------------------------------------------------- |
| `status` | string | `open` or `settled`; required                             |
| `after`  | string | The `cursor` of the previous page: the ID of its last bet |
| `limit`  | number | How many, a whole number from 1 to 100; default 50        |

`invalid` answers a missing status, a malformed limit, or a cursor that names no bet, or for settled bets no settled
bet.

### The bankroll fund

[The bankroll fund](../wallet/bankroll-fund.md) explains investing, which is an
[operation](#post-apichannelsidoperations); the messages are [the fund's](../reference/signed-messages.md#bankroll-fund-messages).
A holding belongs to the account, so it outlives any one channel.

### `GET /api/account/fund`

The account's holding: `{statement, redeems}`, the casino's latest `ShareStatement` of it (`null` before any), and every
`Redeem` the account signed, each as `{request: {message, signature}, statement}` with the statement it produced. A
wallet that missed statements takes the latest up with them ([bankroll fund](../wallet/bankroll-fund.md)).

### `POST /api/account/fund/redeem`

Burns shares at the current price; what they are worth leaves the bankroll and is owed to the account at once, listed
by [`…/payouts`](#get-apiaccountpayouts) under `FUND_ID`. The same `Redeem` again returns its statement while it is
the holding's latest. The `Redeem` names the account as its holder and follows the holding's latest statement; the
amount must be more than zero and within the unreserved bankroll, so a larger redemption waits for the casino bets
counting on that money to settle.

| Body field  | Type   | Meaning                                      |
| ----------- | ------ | -------------------------------------------- |
| `message`   | object | The `Redeem`: `{holder, shares, sequence}`   |
| `signature` | string | The account's EIP-712 signature of `message` |

The reply is `{statement}`, the casino's `ShareStatement`, whose `amount` is what the shares paid. `refused` answers
another holder, a bad signature, a `sequence` that does not follow the latest statement, more shares than are held,
shares worth nothing, and an amount the bankroll cannot release yet.

### The account's games

A game is its developer's: the account that publishes it moves it, takes it down, names the key its server signs with
and takes money out of its bank. A game's bank holds its money at the casino: half the commission of its casino bets and
the stakes of its developer bets go in, and its settlements and its own casino bets are paid from it
([game bank messages](../reference/signed-messages.md#game-bank-messages)). Nothing in it is reserved. Only the developer
puts money in, with an [operation](#post-apichannelsidoperations) naming the game's key, and only the developer takes it
out. A game taken down keeps its URL, its bank, its server and its record.

### `GET /api/account/games`

Every game the account has published, taken down since or not, by name: each `{key, name, url, takenDownAt, server,
bank, sequence, statement, createdAt}`. `url` is where it is served, or was last; `takenDownAt` is when the account
took it down, and `null` while it is published; `server` is the address its server signs with (the account's own until
it names another), `bank` what the bank holds, and `statement` the casino's latest `BankStatement` of it (`null` and
`sequence` 0 before any). Developer bets, settlements and casino bets move the bank between statements, so `bank` can
differ from the statement's balance.

### `POST /api/account/games`

Publishes a game under the account, or takes it down: `{name, url}`. The account becomes the game's developer, and the
game's key is [`gameKey(player, name)`](../reference/signed-messages.md#game-keys). Publishing a name again with another
URL moves the game, and publishing one taken down brings it back: either way it keeps its key, its bank, its server and
its record. A player's profile is public: [`GET /api/players/:name`](public.md#get-apiplayersname) shows it, and it is
this route's reply. Publishing needs a balance that plays; taking a game down, with a `null` `url`, works whatever the
account holds. [The game's URL](../games/publishing.md#the-games-url) gives the rules for `name` and `url`. `invalid`
answers a name or URL those rules do not allow, `channel-closed` an account with no balance that plays ("Publish games
from a balance that plays"), and `too-many` a profile that already publishes 100 games.

### `POST /api/account/games/server`

Names the key one of the account's games' server signs with: from then on that key alone opens the game's rounds,
places its casino bets, settles its developer bets and waits for them ([developer endpoints](developers.md)). Naming
the account's own address gives the game back to the account's key. The casino keeps the signed `GameServer`, and every
developer bet a named server settles carries it, so a player's wallet checks the settlement against the developer's own
signature.

| Body field  | Type   | Meaning                               |
| ----------- | ------ | ------------------------------------- |
| `message`   | object | The `GameServer`: `{game, server}`    |
| `signature` | string | The account's EIP-712 signature of it |

The reply is the game as [`GET /api/account/games`](#get-apiaccountgames) lists it. `invalid` answers another account's
game or a `server` that is not an address, and `refused` a bad signature.

### `POST /api/account/games/withdraw`

Takes money out of one of the account's games' banks: any amount up to what it holds, at any time, owed at once and
listed by [`…/payouts`](#get-apiaccountpayouts) under the game's key. The same `BankWithdraw` again returns its
statement while it is the bank's latest. The `BankWithdraw` names the game and follows its bank's latest statement.

| Body field  | Type   | Meaning                                        |
| ----------- | ------ | ---------------------------------------------- |
| `message`   | object | The `BankWithdraw`: `{game, amount, sequence}` |
| `signature` | string | The account's EIP-712 signature of `message`   |

The reply is `{statement}`, the casino's `BankStatement` with the balance after the withdrawal. `invalid` answers another
account's game; `refused` a bad signature, a `sequence` that does not follow the latest statement, and an amount of zero
or above what the bank holds.

### Verifying a Discord account

An account goes by the username of the Discord account that verified it, and its profile says when it last did
([your name](../wallet/getting-started.md#your-name)). The account asks for a code, and a member of the
HookedIn Discord runs `/verify` with it there. Discord sends the casino each command run in that server, signed with
the key of the casino's Discord app, and the casino learns of a Discord account only from those. `not-found` answers
where the casino has no Discord server: `discord` in [`GET /api/config`](public.md#get-apiconfig) is `null`.

### `POST /api/account/discord/code`

A code for the account, `{code, expires}`: eight characters with no `l`, `0` or `1`, which a member runs `/verify` with
until `expires`, 10 minutes on. An account has one code at most: asking again ends the one before. `refused` answers
the house, which goes by `@hookedin`. The body is `{}`.

### `POST /api/account/discord/unlink`

Gives up the Discord account that verified the account: it goes by its uname again. Answers its own profile;
`not-found` answers an account that verified no Discord account. The body is `{}`.

### `POST /api/discord`

Discord's own route: the commands members run in the HookedIn Discord, each signed with the key of the casino's Discord
app in the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers. `unauthorized` answers anything else. The casino
answers a successful `/verify` with a message everyone in the channel sees, and anything else with one only the member
who ran it sees; one run in any other server is told only that it answers in the HookedIn server.

- `/verify code`: the account the code was given to goes by the member's Discord username from then on, under [the rules
  for names](../wallet/getting-started.md#your-name), and its profile says when it last verified. The code is spent, and
  an expired one does nothing.
