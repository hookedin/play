---
title: Channel and account endpoints
description: The wallet's routes, for registering a channel, placing operations and collateral on it, and what belongs to the account, whatever its channels - its names, what it is owed, its developer bets, its shares, its games with their banks and servers, and verifying a Discord account.
sidebar:
  order: 2
---

The wallet's routes need [account access](index.md#authentication), which serves for all the account's channels. Those
under `/api/channels/:id` concern one channel; those under `/api/account/`, [the account](#the-account). [Signed
messages](../reference/signed-messages.md) specifies the checkpoints, operations and statements they carry.

## Registering a channel

### `POST /api/channels/:id/activate`

Registers the account's current channel, or returns one the casino knows as it holds it, with no chain read. The channel
is active from the start, with nothing to open: the casino registers it at its
[base](../reference/signed-messages.md#the-base), all zero, once the chain holds a
[confirmed](../reference/deployment.md#chains) deposit for it, whoever sent it, and the balance takes the deposit in
with a [deposit operation](#post-apichannelsidoperations). It also registers it before any deposit while it owes the
account something, such as a [transfer](#post-apichannelsidoperations). The body is `{}`: the token names the account,
and the chain which of its channels is current.

| Response field             | Type                   | Meaning                                                                                                                                           |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`, `discordUsername` | string, string or null | The player's names                                                                                                                                |
| `state`                    | Checkpoint             | The latest checkpoint                                                                                                                             |
| `lastResponse`             | object or null         | The reply that signed `state`, as [`POST …/operations`](#post-apichannelsidoperations) recorded it, without `quote` or `head`; `null` at the base |
| `head`                     | object or null         | The casino's latest [history head](../reference/signed-messages.md#history-heads), `{message, signature}`; `null` before its history has a record |

`refused` answers a `:id` that is not the account's current channel ("Channel is not the account's current one"), one
the confirmed chain holds no deposit for while the casino owes its account nothing ("Channel holds no deposit, and its
account is owed nothing"), and a chain that moved on during the check ("Chain observation advanced; retry activation").

## Playing

### `POST /api/channels/:id/quote`

Signs the casino's [quote](../reference/signed-messages.md#quotes) for the channel's next casino bet, on the channel's
round: `{quote}`, as `{message, signature}`. A checkpoint has one quote: asking again gives the same one until half its
day is left, then a new one on the same round. Every reply of [`POST …/operations`](#post-apichannelsidoperations) that
follows the channel's latest checkpoint brings its quote, so a wallet asks here only before a channel's first casino
bet, after losing track, or when its quote has less than half its day left. The body is `{}`. `channel-closed` answers a
channel that is not active, or not its account's current one.

### `POST /api/channels/:id/operations`

Submits one signed operation and answers with the casino's signed result or a rejection proposal. The casino takes a
channel's operations one at a time, in order, each with the account's acknowledgment of the reply before it. The exact
request sent again returns the recorded reply ([retries](index.md#retries)).

| Body field           | Type      | Meaning                                                                                                                                             |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`            | Operation | The signed [operation](../reference/signed-messages.md#transitions), with exactly its fields, following the latest checkpoint of `:id`              |
| `details`            | Details   | What it means: [details](../reference/signed-messages.md#details-and-memo) whose hash is `request.memo`                                             |
| `signature`          | string    | The account's EIP-712 signature of `request`                                                                                                        |
| `acknowledgment`     | object    | `{stateHash, signature}`: the hash of the channel's latest checkpoint and the account's signature of it; required unless the channel is at its base |
| `rejectionSignature` | string    | The account's signature of a verified rejection proposal's checkpoint, sent by repeating that operation to complete its cancellation                |
| `seed`               | bytes32   | A casino bet's seed, whose hash `request.seedHash` signs: sent only with a bet `quote` covers                                                       |
| `quote`              | object    | The casino's quote a casino bet relies on, `{message, signature}`, sent with `seed`                                                                 |

A declined operation is answered with a [rejection checkpoint](../reference/signed-messages.md#rejection-checkpoints)
proposal, `status: "rejected"`, whose `casinoSignature: "0x"` signs nothing. The wallet verifies it, saves its signature
of `state` and sends the operation again with `rejectionSignature`; the casino completes it with the reason
`Cancelled by player`. A retry requesting cancellation of a recorded result gets that result.

What the casino checks and answers, by operation:

| Operation                   | Details                                                                                | The casino                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The reply adds                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Casino bet, kind 1          | `{id, game, group?, table?}`                                                           | Settles every bet its `quote` covers: one the casino signed for the channel's latest checkpoint and open round, unexpired, whose virtual bankroll admits the bet by [the Kelly rule](../reference/economics.md#a-casino-bet-is-one-wager). Needs `seed`, and reads the round's secret only once the bet is admitted. Refuses with `400` `invalid` a bet whose [table](../reference/signed-messages.md#details-and-memo) cannot place it or names another bankroll than the quote's. Declines any other, revealing nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `commission`; `developer` when the game is published; `carried` when declined as `used` |
| Payment, kind 2             | `{id, game, group?, kept?}`                                                            | Moves the amount into the bankroll                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | –                                                                                       |
| Developer bet, kind 2       | `{id, game, group?, meta, round?}`                                                     | Moves the stake into the game's bank; declines a bet on a game nobody publishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | –                                                                                       |
| Investment, kind 2          | `{id, counterparty: FUND_ID}`                                                          | Mints shares to the channel's player at the current price; declines one too small to buy a share, and one while shares are in issue and the fund's equity is not positive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `statement`: the `ShareStatement`                                                       |
| Bank deposit, kind 2        | `{id, counterparty: the game's ID}`                                                    | Moves the amount into the bank of a game the channel's account publishes, or took down; refuses another's game with `400` `invalid`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `statement`: the `BankStatement`                                                        |
| Transfer, kind 2            | `{id, counterparty: "~" + the recipient's uname}`                                      | Owes the amount to the uname's player, as a [payout](#get-apiaccountpayouts) under this account's uname, which their wallet collects; nothing goes on-chain. Declines one to a uname nobody goes by ("Nobody goes by ~…") and one to the account itself ("A transfer goes to another player")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | –                                                                                       |
| Collecting a payout, kind 3 | `{id, counterparty: FUND_ID, a game's ID, the bet's hash or "~" + the sender's uname}` | Pays exactly the amount of a [payout](#get-apiaccountpayouts) listed under that source; `not-due` otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | –                                                                                       |
| Deposit fee, kind 3         | `{id, counterparty: DEPOSIT_FEE_ID}`, `id` the hash of a deposit's transaction         | Pays the network fee of a deposit the channel's account sent straight to the contract, into this channel, once per deposit and after the balance has taken it in (`unconfirmed` before, and before the casino sees the transaction): the transaction's gas limit at its fee cap, but no more than 20% over the gas it used and the 1.5% a node's estimate of it may run high, at twice the base fee of the block before its own plus its tip, when that is at most `depositFeeLimit` millionths of the deposit ([`GET /api/config`](public.md#get-apiconfig)) and both the casino's budget for the UTC day and the bankroll have room for it. `not-due`, after which the wallet asks no more, answers another transaction ("That is not a deposit this account sent into this balance"), another amount ("The casino pays that deposit … METH of its network fee"), a larger fee ("The casino pays a network fee only up to 1% of its deposit"), a spent budget ("The casino pays no more network fees today") and a bankroll short of it ("The bankroll cannot pay that network fee now") | –                                                                                       |
| Deposit, kind 4             | `{id}`                                                                                 | Takes in money deposited into the channel on-chain once the chain has confirmed, at the casino's finality, that the channel's deposits cover the state's `deposited` plus the amount; otherwise reads the chain again, and refuses with `unconfirmed` if it still has not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | –                                                                                       |
| Withdrawal, kind 5          | `{id}`                                                                                 | Has the contract pay the amount to the operation's `recipient`; declines one larger than it can pay now ("At most … METH can be withdrawn now"), one whose `fee` is below the [withdrawal fee](public.md#get-apiwithdrawal-fee) ("Sending a withdrawal costs a fee of … METH now"), and one to an address with code that would refuse the contract's payment or need more than [the gas the contract gives it](../reference/contract.md#withdrawals) to take it ("That address does not accept a payment from the contract"); an address without code takes any payment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | –                                                                                       |
| Lock-in, kind 6             | `{id}`                                                                                 | Has the contract put the amount into the account's current channel, as deposits; declines one larger than it can pay now or with too small a fee, as for a withdrawal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | –                                                                                       |

Money another account takes, a developer bet, an investment, a bank deposit or a transfer, comes only out of deposits
the chain has finalized, about 15 minutes after each: a reorganisation can still take back a newer one, and what it paid
would stay paid. One a newer deposit would pay is declined ("Until the chain finalizes this balance's latest deposit, in
about 15 minutes, it pays another account at most … METH"); what the balance won or was sent pays at once. A deposit
pays at once a casino bet or a payment, which the house takes, a withdrawal or a lock-in, which the contract records on
no checkpoint counting a deposit it does not hold, and a developer bet in one of the house's games.

A developer bet is known afterwards by the hash of its operation, which
[`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet) takes, and so is a withdrawal or a lock-in, whose
`evidence` is what the contract makes a claim of ([withdrawals](../reference/contract.md#withdrawals)): the contract has
recorded it once its channel's `claimed` has passed the `withdrawn` of the checkpoint it follows. The casino sends it as
it [promises](../overview/trust-model.md#what-you-trust-the-casino-for); while it cannot,
[`/api/status`](public.md#get-apistatus) raises `withdrawal-unsent`.

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
| `used`            | boolean    | A game's operation declined because its player carried it out on another channel, a covered casino bet only once settled there: `true`                                    |
| `carried`         | object     | A covered casino bet declined as `used`: `{base, operation, authorization, details}`, the operation the account signed on the other channel and the checkpoint it follows |
| `quote`           | object     | The quote for the channel's next casino bet, which follows `state`, when `state` is the channel's latest checkpoint; not recorded                                         |
| `head`            | object     | The casino's latest [history head](../reference/signed-messages.md#history-heads), `{message, signature}`, which the wallet keeps; not recorded                           |

A casino bet, and its signed result:

```json title="Request"
{
  "request": {
    "previousStateHash": "0xadf17ffce9d913ead9d4822afcba1d2215b42b1389e1da90b0fde64b2949c840",
    "kind": "1",
    "amount": "1000000000000000",
    "recipient": "0x0000000000000000000000000000000000000000",
    "fee": "0",
    "chance": "9131138316486228049",
    "prize": "2000000000000000",
    "round": "0xd66d18052d51b799348ff80954250c2d9df4dcb3f4b7e072e300d69aa5cf0599",
    "seedHash": "0xfa3cc4619661fee59d9d528dc41ee2d1f03b6bac3d855d94cf81f10354808e5f",
    "memo": "0x05e4f77ebc5d27307252c8c218966e001818c474471e7ef0cc7a751baca05feb"
  },
  "details": {
    "id": "0xef9dcc1eb1273ed3947730f697191b5f74ad40cfff6be51b88daee247abdfcf1",
    "game": "0199c4a2-7b3e-7d10-8f2a-5c6e1b9d3a47",
    "group": "hand-1"
  },
  "signature": "0x6298376addfb96a26c6826f2b389049f15582565ebfb715104b1c6fec04dae8b44afab34f8641263d2b20b0c4da3f1410ec16b5718b7ae1c233ed1d188befac11b",
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
    "transitionHash": "0x608c0fb5847c41a85bc63b9c33583b23fa9e1ae65e3267a67eada282e7b8131d",
    "balance": "1001000000000000000",
    "deposited": "1000000000000000000",
    "withdrawn": "0"
  },
  "casinoSignature": "0xa351321ec8c3aaf1306339b3b9134b3bb9184ad06c0c7189b9d5ee41342ec4f94ee22890ed2ccbb0a70687df3cdd62fc93762a800949368e791f049842eee7361b",
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
        "kind": "1",
        "amount": "1000000000000000",
        "recipient": "0x0000000000000000000000000000000000000000",
        "fee": "0",
        "chance": "9131138316486228049",
        "prize": "2000000000000000",
        "round": "0xd66d18052d51b799348ff80954250c2d9df4dcb3f4b7e072e300d69aa5cf0599",
        "seedHash": "0xfa3cc4619661fee59d9d528dc41ee2d1f03b6bac3d855d94cf81f10354808e5f",
        "memo": "0x05e4f77ebc5d27307252c8c218966e001818c474471e7ef0cc7a751baca05feb"
      },
      "authorization": "0x6298376addfb96a26c6826f2b389049f15582565ebfb715104b1c6fec04dae8b44afab34f8641263d2b20b0c4da3f1410ec16b5718b7ae1c233ed1d188befac11b",
      "seed": "0x9fb2e6252566fd6d559926ee050164b714b1b0050d390b606b5826cc06f50635",
      "secret": "0x03d26c92c8987bcfcf2fbe7eb579388c6e6549369b602e6bcb0f40a28c562acf",
      "casinoSignature": "0xa351321ec8c3aaf1306339b3b9134b3bb9184ad06c0c7189b9d5ee41342ec4f94ee22890ed2ccbb0a70687df3cdd62fc93762a800949368e791f049842eee7361b"
    }
  },
  "details": {
    "id": "0xef9dcc1eb1273ed3947730f697191b5f74ad40cfff6be51b88daee247abdfcf1",
    "game": "0199c4a2-7b3e-7d10-8f2a-5c6e1b9d3a47",
    "group": "hand-1"
  },
  "operationId": "0xef9dcc1eb1273ed3947730f697191b5f74ad40cfff6be51b88daee247abdfcf1",
  "commission": "9998000199920",
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "quote": {
    "message": {
      "previousStateHash": "0x50c284b7bf605deb91cb2a89e0e1958f6e150ec82dc8106f5f888fa61fc2350f",
      "round": "0xa33f40bd191331cbf3b13aa8568be118d833d49ca5204b650ef937f84369e510",
      "virtualBankroll": "499998992501499850060",
      "expiresAt": "1791216765"
    },
    "signature": "0xc7aa7ce2d3ee71111a95d33a3ae8449dce8cde2e7528ff61038797de9dcba0ff1ca9d6ad86447050abb0be491af913f97125f770f02c90ecd4d874fea7b7463b1c"
  }
}
```

A developer bet's details, whose `meta` is the game's own JSON:

```json title="Details"
{
  "id": "0x89a7cb2267695c5f0c294fa13c3650c7330f367e4c8d9c48fff02ee7682e2cb2",
  "game": "0199c4a2-9e51-7c3b-a4d8-2f7b6e0c1d95",
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
and never the contract"); with `409`, details that break [the details
rules](../reference/signed-messages.md#details-and-memo). `unacknowledged` answers a missing or wrong acknowledgment,
`channel-closed` a channel that is not active or not its account's current one, `id-conflict` an ID bound to another
operation, and `not-due` and `unconfirmed` what the table says. `refused` answers a bad signature or acknowledgment
signature, an operation that does not follow the latest checkpoint of `:id`, an amount above the balance (less its fee,
for a withdrawal or a lock-in), a nonzero `fee` on any other operation, and a casino bet whose chance or prize breaks
the rules.

## Collateral

### `POST /api/channels/:id/collateral`

Signs the casino's [offer](../reference/signed-messages.md#collateral-offers) of collateral for the channel, `{offer}`,
as `{message, signature}`, which anyone buys on-chain with [`buyCollateral`](../reference/contract.md#collateral) within
the hour. The body is `{amount}`, the collateral in wei as a decimal string, 1 to 2^96 − 1 (`400` `invalid` otherwise).
The casino offers no more than the house cash no claim or withdrawal it owes counts on, and refuses more ("At most …
METH of collateral is on offer now"). An offer reserves nothing: what is bought first is locked, and one bought once
that cash has gone reverts. `channel-closed` answers a channel that is not active, or not its account's current one.

## The account

What belongs to the account, whatever its channels. Every route takes the [account's token](index.md#authentication)
alone, so an account with no balance asks too. Its uname and Discord routes count against the
[budget](index.md#budgets-and-queues) of registering a channel, the rest against the account's own.

### `POST /api/account/uname`

The account's uname, told to the account alone, even before its first deposit. The first time an account asks, unless
the casino met it before, the casino meets it: from then on its uname finds its [profile](public.md#get-apiplayersname),
and a [transfer](#post-apichannelsidoperations) to it is owed to it. The casino derives unames with a key it keeps
secret, so nobody learns an address's uname without that address's signature. The body is `{}`.

| Response field | Type    | Meaning                                                                                                                                                     |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`        | string  | The account's uname                                                                                                                                         |
| `profile`      | object  | Its [public profile](public.md#get-apiplayersname), which unlinking a Discord account and publishing a game answer with too                                 |
| `registers`    | boolean | Whether the casino registers the account's current channel before the chain holds a deposit for it: it owes the account something, or registered it already |

### `GET /api/account/payouts`

What the casino owes the account, transfers from other players among them: every payout not yet collected, ordered by
source and then by record, at most 256. The wallet collects each into its balance with a credit whose details name
`source` as their `counterparty`, for exactly `amount`; the next reply lists the rest.

| Response field    | Type           | Meaning                                                                                                                                                                                                                                       |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`          | string         | `FUND_ID` for redeemed shares; a game's ID for money taken out of its bank; a developer bet's hash for what its settlement paid; `~` and the sender's uname for a transfer ([counterparties](../reference/signed-messages.md#counterparties)) |
| `record`          | string         | The ID of the signing-history record that made it owed                                                                                                                                                                                        |
| `amount`          | string         | What is owed                                                                                                                                                                                                                                  |
| `discordUsername` | string or null | Transfers only: the Discord username the sender goes by now, if any                                                                                                                                                                           |

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

### `GET /api/account/game-history`

The account's history of a game, or of every game it played, across all its channels, newest first:
`{entries, cursor, more}` ([pages](index.md#pages)). An entry is one of two kinds, each with `at`, when the casino made
the record:

- `{type: "operation", at, details, evidence, bet?}`: an operation of a game the casino carried out, a casino bet, a
  payment or a developer bet, with its [details](../reference/signed-messages.md#details-and-memo) and the evidence of
  its result, the checkpoint it follows and its step; and for a developer bet, `bet`, the bet as
  [`GET /api/developer-bets/:bet`](public.md#get-apideveloper-betsbet) shows it. A declined operation is not listed.
- `{type: "end", at, game, group, meta}`: a group a game ended with meta, its own JSON saying how the group went.

| Query   | Type   | Meaning                                                                          |
| ------- | ------ | -------------------------------------------------------------------------------- |
| `game`  | string | The [game's ID](../reference/signed-messages.md#game-ids); every game without it |
| `after` | string | The `cursor` of the previous page: the ID of the record its last entry is        |
| `limit` | number | How many, a whole number from 1 to 100; default 50                               |

`invalid` answers a game that is not a game ID, a malformed cursor or limit.

### `POST /api/account/game-history`

A group the account's game ended: `{game, group, meta}`, the game's ID, the group, and `meta`, the game's own JSON
saying how the group went, a plain object of JSON values with the bounds of a developer bet's, which the casino keeps
and never reads. A group ends once: the same meta again changes nothing, and other meta is refused with `id-conflict`.
The reply is `{}`. `invalid` answers a malformed body, and `not-found` an account the casino has not met.

### The bankroll fund

[The bankroll fund](../wallet/bankroll-fund.md) explains investing, which is an
[operation](#post-apichannelsidoperations); the messages are [the
fund's](../reference/signed-messages.md#bankroll-fund-messages).

### `GET /api/account/fund`

The account's holding: `{statement, redeems}`, the casino's latest `ShareStatement` of it (`null` before any), and the
`Redeem`s the account signed whose statements come after the sequence `after` names (0 unless given), oldest first and
at most 256 (`MAX_REDEEMS`), each as `{request: {message, signature}, statement}` with the statement it produced.
`invalid` answers an `after` that is not a whole number.

### `POST /api/account/fund/redeem`

Burns shares at the current price; what they are worth leaves the bankroll and is owed to the account at once, listed by
[`…/payouts`](#get-apiaccountpayouts) under `FUND_ID`. The same `Redeem` again returns its statement while it is the
holding's latest. The `Redeem` names the account as its holder and follows the holding's latest statement; the amount
must be more than zero and within the unreserved bankroll, so a larger redemption waits for the casino bets counting on
that money to settle.

| Body field  | Type   | Meaning                                      |
| ----------- | ------ | -------------------------------------------- |
| `message`   | object | The `Redeem`: `{holder, shares, sequence}`   |
| `signature` | string | The account's EIP-712 signature of `message` |

The reply is `{statement}`, the casino's `ShareStatement`, whose `amount` is what the shares paid. `invalid` answers
another holder, and `refused` a bad signature, a `sequence` that does not follow the latest statement, more shares than
are held, shares worth nothing, and an amount the bankroll cannot release yet.

### The account's games

A game is its developer's, the account that publishes it. The developer renames, moves and takes down the game, names
the key its server signs with, and alone puts money into its [bank](../games/publishing.md#earnings), with an
[operation](#post-apichannelsidoperations) naming the game's ID, and takes it out ([game bank
messages](../reference/signed-messages.md#game-bank-messages)). A game keeps its ID, its bank, its server and its record
under any name, at any URL and taken down.

### `GET /api/account/games`

Every game the account has published, taken down since or not, by slug: each
`{id, name, slug, url, takenDownAt, server, bank, sequence, statement, createdAt}`. `id` is its
[ID](../reference/signed-messages.md#game-ids), `name` the name it goes by and `slug` its address in the account's
profile; `url` is where it is served, or was last; `takenDownAt` is when it was taken down, and `null` while it is
published; `server` is the address its server signs with (the account's own until it names another), `bank` what the
bank holds, and `statement` the casino's latest `BankStatement` of it (`null` and `sequence` `"0"` before any).
Developer bets, settlements and casino bets move the bank between statements, so `bank` can differ from the statement's
balance.

### `POST /api/account/games`

Publishes a game under the account, renames or moves one of its games, or takes one down.

| Body field | Type           | Meaning                                                                                                                                                                                                                                                                   |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | string         | The name it goes by, such as `Super Dice`: 1 to 32 printable characters (no control, format, private-use or unassigned character), no space at either end, with a Latin letter or a digit for its slug                                                                    |
| `url`      | string or null | [The game's URL](../games/publishing.md#the-games-url): `https:`, or `http:` on a local host, at most 300 characters, written as `URL` writes it (`https://example.com/`, not `https://EXAMPLE.com`), with no user name, password or fragment; `null` takes the game down |
| `game`     | string         | Optional: the [ID](../reference/signed-messages.md#game-ids) of one of the account's games                                                                                                                                                                                |

A game's _slug_, its address in the account's profile (`@username/super-dice`, `~uname/super-dice`), is made from its
name: accents dropped, lowercase, each run of anything but `a-z` and `0-9` one hyphen, and no hyphen at either end. With
`game`, the request is about that game; without, a name whose slug one of the account's games has, taken down since or
not, names that game, and any other a new one, whose developer the account becomes. The game is then published under
`name` at `url`, which renames and moves it, or taken down with a `url` of `null`. Publishing a game taken down brings
it back, unless HookedIn holds it taken down, and publishing a game as it is published changes nothing. The reply is the
account's [public profile](public.md#get-apiplayersname). Taking a game down works whatever the account holds. `invalid`
answers a name or URL those rules do not allow and a `game` that is not one of the account's ("This is another
developer's game"), `refused` a name whose slug another of the account's games has ("Another of your games goes by
super-dice") and a game HookedIn holds taken down ("HookedIn has taken this game down. Write to support@hookedin.com."),
`channel-closed` publishing from an account with no balance that plays ("Publish games from a balance that plays"), and
`too-many` a profile that already publishes 100 games.

### `POST /api/account/games/server`

Names the key one of the account's games' server signs with, as a signed
[`GameServer`](../reference/signed-messages.md#developer-messages): from then on that key alone makes the game's
[server's requests](developers.md). Naming the account's own address gives the game back to the account's key.

| Body field  | Type   | Meaning                               |
| ----------- | ------ | ------------------------------------- |
| `message`   | object | The `GameServer`: `{game, server}`    |
| `signature` | string | The account's EIP-712 signature of it |

The reply is the game as [`GET /api/account/games`](#get-apiaccountgames) lists it. `invalid` answers another account's
game or a `server` that is not an address, and `refused` a bad signature.

### `POST /api/account/games/withdraw`

Takes money out of one of the account's games' banks: any amount up to what it holds, at any time, owed at once and
listed by [`…/payouts`](#get-apiaccountpayouts) under the game's ID. The `BankWithdraw` names the game and follows its
bank's latest statement; the same one again returns its statement while it is the bank's latest.

| Body field  | Type   | Meaning                                        |
| ----------- | ------ | ---------------------------------------------- |
| `message`   | object | The `BankWithdraw`: `{game, amount, sequence}` |
| `signature` | string | The account's EIP-712 signature of `message`   |

The reply is `{statement}`, the casino's `BankStatement` with the balance after the withdrawal. `invalid` answers
another account's game; `refused` a bad signature, a `sequence` that does not follow the latest statement, and an amount
of zero or above what the bank holds.

### Verifying a Discord account

An account goes by the username of the Discord account that verified it ([your
name](../wallet/getting-started.md#your-name)): the account asks for a code, and a member of the HookedIn Discord runs
`/verify` with it there. The casino learns of a Discord account only from the commands [Discord sends
it](#post-apidiscord). `not-found` answers where the casino has no Discord server: `discord` in
[`GET /api/config`](public.md#get-apiconfig) is `null`.

### `POST /api/account/discord/code`

A code for the account, `{code, expires}`: eight characters with no `l`, `0` or `1`, which a member runs `/verify` with
until `expires`, 10 minutes on. An account has one code at most: asking again ends the one before. `refused` answers the
house, which goes by `@hookedin`. The body is `{}`.

### `POST /api/account/discord/unlink`

Gives up the Discord account that verified the account: it goes by its uname again. Answers its own profile; `not-found`
answers an account that verified no Discord account. The body is `{}`.

### `POST /api/discord`

Discord's own route: the commands members run in the HookedIn Discord, each signed with the key of the casino's Discord
app in the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers. `unauthorized` answers anything else. The casino
answers a successful `/verify` with a message everyone in the channel sees, and anything else with one only the member
who ran it sees; one run in any other server is told only that it answers in the HookedIn server.

- `/verify code`: the account the code was given to goes by the member's Discord username from then on, under [the rules
  for names](../wallet/getting-started.md#your-name), and its profile says when it last verified. The code is spent, and
  an expired one does nothing.
