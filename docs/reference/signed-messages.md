---
title: Signed messages
description: The EIP-712 domain, the twelve signed structures, the IDs and hashes built from them, and the test vectors that fix them.
sidebar:
  order: 4
---

Every signature in HookedIn is an EIP-712 typed-data signature under one domain. This page is the byte-level
reference: an implementation built from it computes the same hashes as [protocol.ts](../../protocol/protocol.ts) and
[the contract](../../contracts/HookedInCasino.sol), and the [test vectors](#test-vectors) confirm it. What the contract
does with these messages is on [the contract page](contract.md); how the casino's API carries them is in the
[Casino API](../casino-api/index.md).

## Domain

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
```

| Field               | Value                                                 |
| ------------------- | ----------------------------------------------------- |
| `name`              | `HookedIn`                                            |
| `version`           | `1`                                                   |
| `chainId`           | `11155111` on Sepolia, `31337` on a local Anvil chain |
| `verifyingContract` | The address of the HookedInCasino deployment          |

Every structure uses this one domain, including the ones that never reach the contract. A digest is `keccak256(0x1901 ‖
domainSeparator ‖ hashStruct(message))`. A signature is 65 bytes, `r ‖ s ‖ v`, from an externally owned account, with
`v` of 27 or 28 and a low `s`: the only form the contract accepts, and so the only one the casino and the wallet take,
of any structure.

The hash of a signed structure, wherever HookedIn uses one, is its full digest, never its struct hash: a checkpoint's
state hash (`previousStateHash`, `Close.stateHash`, the contract's `initialHash` and `closingHash`), an operation's hash
(a developer bet's ID, a rejection's `transitionHash`, a statement's `cause`), and the hashes of `Redeem` and
`Withdraw`. The contract exposes the three it uses as `hashState`, `hashOperation` and `hashClose`.

## Structures

| Structure         | Fields, in order                                                                                                                                                                              | Signed by                                            | Checked by               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------ |
| `Checkpoint`      | `bytes32 channelId`, `uint256 sequence`, `bytes32 previousStateHash`, `bytes32 transitionHash`, `uint256 balance`                                                                             | The casino, and the channel key when it countersigns | Contract, wallet, casino |
| `Operation`       | `bytes32 channelId`, `bytes32 previousStateHash`, `uint256 sequence`, `uint256 kind`, `uint256 amount`, `uint64 chance`, `uint256 prize`, `bytes32 round`, `bytes32 seedHash`, `bytes32 memo` | The channel key                                      | Contract, casino, wallet |
| `Close`           | `bytes32 channelId`, `bytes32 stateHash`                                                                                                                                                      | The funding account and the casino                   | Contract, casino, wallet |
| `Access`          | `bytes32 channelId`, `uint256 expiresAt`                                                                                                                                                      | The channel key                                      | Casino                   |
| `DeveloperAccess` | `address developer`, `uint256 expiresAt`                                                                                                                                                      | The developer                                        | Casino                   |
| `Settlement`      | `bytes32 bet`, `uint256 player`, `uint256 casino`                                                                                                                                             | The developer                                        | Casino, wallet           |
| `BankCasinoBet`   | `bytes32 round`, `bytes32 game`, `uint256 stake`, `uint64 chance`, `uint256 prize`, `string group`, `bytes32 seedHash`, `bytes32 meta`                                                        | The developer                                        | Casino                   |
| `ShareStatement`  | `address holder`, `uint256 sequence`, `uint256 shares`, `uint256 amount`, `uint256 equity`, `uint256 totalShares`, `bytes32 cause`                                                            | The casino                                           | Wallet                   |
| `Fund`            | `uint256 sequence`, `uint256 totalShares`, `uint256 houseShares`, `uint256 equity`, `uint256 overdrawn`, `uint256 at`                                                                         | The casino                                           | Wallet                   |
| `Redeem`          | `address holder`, `uint256 shares`, `uint256 sequence`                                                                                                                                        | The holder's channel key                             | Casino                   |
| `BankStatement`   | `address developer`, `uint256 sequence`, `uint256 balance`, `bytes32 cause`                                                                                                                   | The casino                                           | Wallet                   |
| `Withdraw`        | `address developer`, `uint256 amount`, `uint256 sequence`                                                                                                                                     | The developer's channel key                          | Casino                   |

The _channel key_ is a channel's `signer` and the _funding account_ its `player`
([the two keys](contract.md#the-two-keys-of-a-channel)). The _casino_ is the contract's `owner`, which
[`GET /api/config`](../casino-api/public.md#get-apiconfig) reports as `operator`. The _developer_ is the account that
publishes a game. In JSON an integer is a decimal string, except an operation's `kind` and a token's `expiresAt`, which
the wallet writes as numbers.

## Channels

### Channel IDs

A channel's identity, its _opening_, is `{channelId, player, signer, deposit}`, unsigned. `player` is the funding
account and `signer` the channel key; neither is the zero address. `deposit` is the wei sent to `openChannel`, 1 to
2^128 − 1.

```text
channelId = keccak256(abi.encode(address player, address signer, uint256 deposit))
```

The contract computes a channel's ID in `openChannel`, from its caller, the key it names and the value it receives.
`keccak256("…")` of a string, here and below, hashes its UTF-8 bytes (ethers `id`).

### Genesis

A channel starts at its genesis checkpoint:

```json
{
  "channelId": "<the channel>",
  "sequence": "0",
  "previousStateHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "transitionHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "balance": "<deposit>"
}
```

The contract records its hash as `initialHash` when the channel opens. It needs no signature: a channel can close on its
genesis without the casino ever answering.

### Transitions

An operation names the checkpoint it follows, its _base_: `channelId` is the base's, `previousStateHash` the base's
hash and `sequence` the base's plus one. Applied, it produces the next checkpoint:

| Field               | Next checkpoint                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `channelId`         | The base's                                                                                                                  |
| `sequence`          | The base's plus one                                                                                                         |
| `previousStateHash` | The hash of the base                                                                                                        |
| `transitionHash`    | `keccak256(abi.encode(bytes32 operationHash, bytes32 secret))`, with the round's secret for a casino bet and zero otherwise |
| `balance`           | By kind, below                                                                                                              |

| Kind       | `kind` | Balance                                                                       | `chance`, `prize`, `round`, `seedHash`                                                |
| ---------- | ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Casino bet | 1      | Base − `amount`, + `prize` when the [outcome](#the-outcome) is below `chance` | The bet's terms; `round = keccak256(secret)`; `seedHash = keccak256(seed)`; none zero |
| Debit      | 2      | Base − `amount`                                                               | All zero                                                                              |
| Credit     | 3      | Base + `amount`                                                               | All zero                                                                              |
| None       | 0      | –                                                                             | Only in the [empty step](#evidence)                                                   |

Every transition holds to these rules, which the contract, the wallet and the casino apply alike:

- `amount` is 1 to 2^128 − 1, and a casino bet's (its stake) or a debit's is at most the base balance.
- A casino bet's `chance` is 1 to 2^64 − 1, the winning outcomes out of 2^64, and its `prize` is 1 to 2^128 − 1: a sure
  loss or a sure win is no bet.
- The next balance is below 2^128.
- Every field a kind does not use is zero, and a debit or credit carries a zero seed and secret: one meaning, one
  encoding.

The casino signs the next checkpoint. A _step_, `{operation, authorization, seed, secret, casinoSignature}`, carries the
signed operation, the channel key's signature of it, the revealed seed and secret (zero unless a casino bet), and the
casino's signature of the next checkpoint. With its base, a step proves the next checkpoint on-chain without the
player's countersignature. The player countersigns the next checkpoint and hands the casino that signature before the
channel's next operation: the `acknowledgment` of
[`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations).

### Rejection checkpoints

The casino declines a signed casino bet or debit by signing a checkpoint two above its base, with the balance
unchanged:

| Field               | Rejection checkpoint              |
| ------------------- | --------------------------------- |
| `sequence`          | The base's plus two               |
| `previousStateHash` | The hash of the base              |
| `transitionHash`    | The declined operation's own hash |
| `balance`           | The base's                        |

The player countersigns it, and its next operation is at the base's sequence plus three. Once countersigned it
supersedes the declined operation, whose step would be at the base's sequence plus one: a challenge on-chain accepts a
strictly higher sequence. Until then the jointly signed base settles to the same balance. The player signs a rejection
only on receiving it, so no rejection the casino signs later can supersede a result the player already holds. Credits
are not declined this way: the casino refuses a credit it does not owe with an error.

A declined casino bet carries its round's `secret`, so the player can compute what the bet would have paid. When the
round is unknown to the casino, or is another channel's unrevealed round, the rejection carries `lost: true` instead.

### Evidence

`Evidence{Checkpoint base; bytes playerSignature; bytes casinoSignature; Step step}` is what the contract settles on.
`base` is the genesis, which needs no signatures (the wallet sends `0x`), or a checkpoint signed by the channel key
and the casino. `step` is one step from the base, or the _empty step_: the all-zero operation (`kind` 0, every number
and hash zero), `authorization` and `casinoSignature` both `0x`, and a zero seed and secret. Kind 0 appears nowhere
else. The casino's replies carry evidence in this form, `{base, playerSignature, casinoSignature, step}`.

A wallet exports evidence as a bundle (`EvidenceBundle` in [types.ts](../../protocol/types.ts)), which the
[recovery tools](cli.md) read:

| Field      | Type     | Meaning                                                                 |
| ---------- | -------- | ----------------------------------------------------------------------- |
| `chainId`  | string   | The chain, as a decimal string                                          |
| `casino`   | address  | The contract                                                            |
| `operator` | address  | The casino, the contract's owner                                        |
| `opening`  | object   | `{channelId, player, signer, deposit}`                                  |
| `evidence` | Evidence | The latest evidence of the channel                                      |
| `details`  | Details  | Optional: the details of the step's operation, whose hash is its `memo` |

## Operations

### Details and memo

An operation signs what it means to the wallet and the casino as one hash, `memo`, of its _details_. The contract never
reads it. A request carries the details whole beside the signed operation, and both sides keep them with the evidence.

```text
memo = keccak256(utf8(canonicalJSON(details)))
```

| Field          | Type    | Meaning                                                                                                          |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`           | bytes32 | The hash of the operation's name: its [operation ID](#operation-ids)                                             |
| `game`         | bytes32 | The [key](#game-keys) of the game that asked for a casino bet, a developer bet or a payment                      |
| `group`        | string  | A label the game gives its bets and payments, such as one hand: 1 to 64 UTF-16 code units                        |
| `counterparty` | bytes32 | What a debit pays into or a credit collects from: a [counterparty ID](#counterparties) or a developer bet's hash |
| `meta`         | object  | A developer bet's own JSON: at most 4,096 bytes of canonical JSON, whose numbers are safe integers               |

No other key is allowed. `id`, `game` and `counterparty` are `0x` followed by 64 lowercase hex digits. `group` and
`meta` appear only beside `game`. By kind:

| Kind          | Details                                  |
| ------------- | ---------------------------------------- |
| 1, casino bet | `game`, no `counterparty`, no `meta`     |
| 2, debit      | Exactly one of `game` and `counterparty` |
| 3, credit     | `counterparty`, no `game`                |

Each operation the wallet signs, and what its details hold:

| Operation                                 | Kind | Details                                                              |
| ----------------------------------------- | ---- | -------------------------------------------------------------------- |
| Casino bet                                | 1    | `{id, game, group?}`                                                 |
| Payment to the bankroll                   | 2    | `{id, game, group?}`                                                 |
| Developer bet                             | 2    | `{id, game, group?, meta}`; the bet is known by the operation's hash |
| Investment in the bankroll fund           | 2    | `{id, counterparty: FUND_ID}`                                        |
| Deposit into the account's developer bank | 2    | `{id, counterparty: BANK_ID}`                                        |
| Collecting redeemed shares                | 3    | `{id, counterparty: FUND_ID}`                                        |
| Collecting a bank withdrawal              | 3    | `{id, counterparty: BANK_ID}`                                        |
| Collecting developer earnings             | 3    | `{id, counterparty: DEVELOPER_ID}`                                   |
| Collecting a developer bet's payout       | 3    | `{id, counterparty: <the bet's hash>}`                               |

What the casino checks for each, and what it answers, is under
[`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations).

### Canonical JSON

`canonicalJSON` (in [protocol.ts](../../protocol/protocol.ts)) writes one string for one value:

- Object keys are sorted by UTF-16 code units, as JavaScript's default sort orders them, and written
  `{"key":value,…}` with no whitespace.
- Arrays keep their order; strings, `true`, `false` and `null` are written as `JSON.stringify` writes them.
- A number must be a safe integer (at most 2^53 − 1 in magnitude); any other number is refused. A bigint is written as
  a decimal string.
- An `undefined` value is refused.
- The result is at most 1,000,000 bytes of UTF-8.

The developer bet in the [test vectors](#test-vectors) signs these details, in canonical JSON:

```text
{"game":"0x3ecebe6e27b57578960be6f32d017dd0aaa0de75c35a7208a74206db2dab2c5d","group":"spin-1","id":"0x8383838383838383838383838383838383838383838383838383838383838383","meta":{"chips":{"17":"20000000","9":"10000000","red":"30000000"}}}
```

Their keccak-256 is its `memo`, `0x88456920b0dce4c103868f21a4ecdcad753a3d3bfa56f2cdfb16a7a2c9d0b370`. The keys sort as
strings, so `"17"` comes before `"9"`.

### Operation IDs

`details.id` is the keccak-256 of the UTF-8 bytes of the operation's name, its _operation ID_. The casino keeps each
reply under the channel and this hash: the same ID with the same signed operation is a retry and gets the recorded
reply, and the same ID with another operation is refused with `id-conflict`. The reply's `operationId` is this hash, and
[`GET /api/channels/:id/operations/:operationId`](../casino-api/channels.md#get-apichannelsidoperationsoperationid)
takes it.

The wallet names a game's operation `game:<gameKey>:<id>`: the game's lowercase key and the ID the game chose (1 to 64
ASCII letters, digits, `.`, `_`, `:` or `-`). The name holds no channel, so the operation has the same `details.id` on
every channel of its player. The casino declines a game's operation that the player already carried out on another
channel with a signed rejection marked `used: true`, and never carries it out twice. The wallet names its other
operations itself.

### Counterparties

| Name           | Preimage             | Value                                                                | Debit          | Credit             |
| -------------- | -------------------- | -------------------------------------------------------------------- | -------------- | ------------------ |
| `FUND_ID`      | `HOOKEDIN/BANKROLL`  | `0x467fc5e32da989116c215bcba4b9354cdc62740ac7a21e74f31eb81d1f6c8530` | An investment  | Redeemed shares    |
| `BANK_ID`      | `HOOKEDIN/BANK`      | `0x6036e2ff95363cd3feb09ac645f9fa63a1d231a7d546f8ea5688615e683b9263` | A bank deposit | A bank withdrawal  |
| `DEVELOPER_ID` | `HOOKEDIN/DEVELOPER` | `0x2fc2d32d54413eba8857124e3e8c3261740cccc0ba5885f6ea7498ea5bc68adc` | –              | Developer earnings |

Each value is `keccak256` of its preimage. A credit that collects a developer bet's payout names the bet's hash instead.
The other fixed tag is `HOOKEDIN/OUTCOME` (`0xede2fdd26760847d3c92bb2ebf4da0fdbdf441ed687b86dc1257f1962e3857ff`), in
[the outcome](#the-outcome).

## Games, rounds and the outcome

### Game keys

```text
gameKey = keccak256(abi.encode(address developer, string name))
```

`developer` is the account that publishes the game and `name` the name it is published under (1 to 32 of `a-z`, `0-9`
and `-`, starting with a letter or digit). A game opened straight from its manifest takes the manifest's `developer`
and, as `name`, the manifest's URL as the URL parser normalises it, so no published game shares its key. The key is
lowercase hex in details and in the API. The vectors' game, developer `0x4444444444444444444444444444444444444444` and
name `roulette`, has the key `0x3ecebe6e27b57578960be6f32d017dd0aaa0de75c35a7208a74206db2dab2c5d`.

### Rounds

A _round_ is named by the hash of a secret: `round = keccak256(secret)`, where `secret` is 32 random bytes the casino
picks and keeps until the round is revealed. A casino bet signs its round and the hash of a _seed_,
`seedHash = keccak256(seed)`: 32 bytes the bettor picks after the round is named and sends with the bet. Both hashes are
of the 32 raw bytes. Only that secret and that seed settle the bet, so a round needs no signature of its own.

A round settles one casino bet. A channel's own round is the one its next casino bet names
([`POST /api/channels/:id/round`](../casino-api/channels.md#post-apichannelsidround)); a developer's round is revealed by
the developer's own `BankCasinoBet`, which may bet nothing
([`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet)). Once settled or
declined, a round is revealed and settles nothing more.

### The outcome

```text
outcome = uint64(keccak256(abi.encode(bytes32 OUTCOME_DOMAIN, bytes32 seed, bytes32 secret)))
OUTCOME_DOMAIN = keccak256("HOOKEDIN/OUTCOME")
```

`uint64(…)` keeps the low 64 bits. A casino bet pays its stake to enter, and pays its `prize` when
`outcome < chance`, so it wins with probability `chance / 2^64`; otherwise it pays nothing. The outcome depends only on
the seed and the secret, so every bet on one round and seed sees the same value. To check a revealed round:
`keccak256(secret)` is the round, `keccak256(seed)` is the bet's `seedHash`, and the formula gives the outcome and so
the payout.

## Other signed messages

### Close

`Close(channelId, stateHash)` closes a channel at once on-chain, through `cooperativeClose`. `stateHash` is the hash of
the checkpoint the channel closes on. The funding account signs it and asks the casino for its signature with
[`POST /api/channels/:id/close`](../casino-api/channels.md#post-apichannelsidclose).

### Access tokens

`Access(channelId, expiresAt)` and `DeveloperAccess(developer, expiresAt)` authenticate API requests. `expiresAt` is a
time in Unix seconds, a JSON number or a decimal string. A token is the header value

```text
HookedIn <base64url(utf8(JSON {"message": <message>, "signature": "0x…"}))>
```

with base64url as in RFC 4648 §5, without padding. The token of the captured
[round request](../casino-api/channels.md#post-apichannelsidround) decodes to:

```json
{
  "message": {
    "channelId": "0xc371347813a907f3f2f2b8b31acd535791ef417fb74d4a1173d48198c283cf78",
    "expiresAt": 1790384289
  },
  "signature": "0xa32132780c848dd14aeeb8ff5b20f87d5e0f928bd005a7b52478614ba9d3d066314074ae4502cc387a6cf90c669723fca6233d87d0cf26a4469a38e5b725a9111c"
}
```

Which key signs which token, and the time window the casino accepts, are under
[Authentication](../casino-api/index.md#authentication).

### Developer messages

`Settlement(bet, player, casino)` settles a developer bet. `bet` is the bet's hash, the hash of the operation that
placed it, which signed its meta. `player` is what the player is paid and `casino` what the casino is given, both from
the developer's bank and each below 2^128.

`BankCasinoBet(round, game, stake, chance, prize, group, seedHash, meta)` is a developer's casino bet from its bank, on
a round of its own. `game` is the key of one of the developer's games, whose commission the bet earns; `stake`,
`chance` and `prize` are as for any casino bet; `group` is the label the game gives the bets that belong together, 1 to
64 UTF-16 code units; `seedHash` is `keccak256(seed)` of the seed the request brings; `meta` is
`keccak256(utf8(canonicalJSON(meta)))` of the developer's own JSON, which the casino keeps with the reveal and never
reads. A stake, chance and prize all zero is a _reveal_: it bets nothing and only reveals the round, and is signed,
grouped and kept like any other.

### Bankroll fund messages

`ShareStatement(holder, sequence, shares, amount, equity, totalShares, cause)` is the casino's statement of one holding
after each change. `holder` is the player's funding account, so a holding outlives any one channel. `sequence` numbers
the holding's statements from 1. `shares` is what the holder has afterwards and `amount` the wei invested or paid out.
`equity` and `totalShares` are the fund's before the change, and fix the price: an investment mints
`amount × totalShares / equity` shares and a redemption of `s` shares pays `s × equity / totalShares`, each rounded
down. At the first investment the equity the bankroll already holds becomes the house's shares, one per wei, so the
first price is one wei a share; with no shares in issue, an investment mints one share per wei. `cause` is the hash of
the investing operation or of the `Redeem`.

`Redeem(holder, shares, sequence)` turns shares back into money. The channel key of an open channel of `holder` signs
it, and `sequence` is the number of the statement it will produce, so it works once.

`Fund(sequence, totalShares, houseShares, equity, overdrawn, at)` is the fund's public state, signed when asked for:
the number of fund changes so far, every share in issue, the house's own shares, the equity the shares are a claim on
(0 when there is none), the wei the owner withdrew beyond the house's shares (a loss the other holders bore), and the
time in Unix seconds. [The bankroll fund](../wallet/bankroll-fund.md) explains holding shares.

### Developer bank messages

`BankStatement(developer, sequence, balance, cause)` is the casino's statement of a developer's bank after each deposit
and withdrawal: `sequence` numbers the bank's statements from 1, `balance` is what it holds afterwards, and `cause` is
the hash of the depositing operation or of the `Withdraw`. Between statements, developer bets, settlements and the
developer's casino bets move the balance without a statement.

`Withdraw(developer, amount, sequence)` takes money out of the bank. The channel key of a channel of `developer` signs
it, and `sequence` is the number of the statement it will produce, so it works once.

## Limits and the protocol revision

| Bound                                                         | Value                                          |
| ------------------------------------------------------------- | ---------------------------------------------- |
| Outcome space, which a chance counts in                       | 2^64, `18446744073709551616` (`OUTCOME_SPACE`) |
| A bet's meta                                                  | 4,096 bytes of canonical JSON                  |
| A group label                                                 | 64 UTF-16 code units                           |
| Amounts, deposits, prizes and balances                        | Below 2^128 (`MAX_BALANCE`)                    |
| Canonical JSON and API request bodies                         | 1,000,000 bytes                                |
| Settlements in one request, developer bets in one public page | 256                                            |
| Payouts listed in one reply                                   | 256                                            |

The first three are `LIMITS`, which `GET /api/config` reports as `limits`:
`{"outcomeSpace": "18446744073709551616", "meta": 4096, "group": 64}`.

`PROTOCOL` fixes everything a wallet and the casino must agree on. It is the keccak-256 of the UTF-8 bytes of the
twelve EIP-712 `encodeType` strings, in the order of [the structures table](#structures), concatenated, followed by the
canonical JSON of the rules they apply alike. An `encodeType` string is a structure's name and its fields, as in
`Close(bytes32 channelId,bytes32 stateHash)`. The rules:

```text
{"counterparties":{"bank":"0x6036e2ff95363cd3feb09ac645f9fa63a1d231a7d546f8ea5688615e683b9263","developer":"0x2fc2d32d54413eba8857124e3e8c3261740cccc0ba5885f6ea7498ea5bc68adc","fund":"0x467fc5e32da989116c215bcba4b9354cdc62740ac7a21e74f31eb81d1f6c8530"},"kinds":{"casinoBet":1,"credit":3,"debit":2,"none":0},"limits":{"group":64,"meta":4096,"outcomeSpace":"18446744073709551616"},"outcome":"HOOKEDIN/OUTCOME"}
```

`DEVELOPER_PROTOCOL` fixes only what a developer's server shares with the casino: the `encodeType` strings of
`DeveloperAccess`, `Settlement` and `BankCasinoBet`, followed by:

```text
{"limits":{"group":64,"meta":4096,"outcomeSpace":"18446744073709551616"},"outcome":"HOOKEDIN/OUTCOME"}
```

`GET /api/config` reports both, as `protocol` and `developerProtocol`. A wallet compares `protocol`, and a developer's
server `developerProtocol`, with its own before it signs anything, and stops on a difference (`assertProtocol`; the SDK
throws `protocol-mismatch`). A change to a structure only wallets sign moves `PROTOCOL` and leaves
`DEVELOPER_PROTOCOL` as it is.

## Test vectors

[vectors/protocol.json](../../vectors/protocol.json), written by [scripts/vectors.ts](../../scripts/vectors.ts), fixes
the hashing and pricing rules in numbers.

| Key                             | Contents                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`                      | Chain `31337` and contract `0x1111…11`, the domain of every hash below; the player `0x2222…22`, its channel key `0x3333…33` and the developer `0x4444…44`                                                                                           |
| `protocol`, `developerProtocol` | [`PROTOCOL` and `DEVELOPER_PROTOCOL`](#limits-and-the-protocol-revision)                                                                                                                                                                            |
| `opening`                       | The opening of the player's channel, with that channel key and a deposit of `1000000000`                                                                                                                                                            |
| `genesis`, `genesisHash`        | The channel's genesis checkpoint, and its hash                                                                                                                                                                                                      |
| `operations`                    | Three operations, each on the checkpoint before it: its `details`, their `canonical` JSON, the signed `operation`, its `hash`, the `seed` and `secret` it settles with (zero but for the casino bet), and the `next` checkpoint with its `nextHash` |
| `outcome`                       | `{randomHash, value, payout}` of the casino bet                                                                                                                                                                                                     |
| `rejection`, `rejectionHash`    | The checkpoint that declines the casino bet instead, and its hash                                                                                                                                                                                   |
| `close`, `closeHash`            | The `Close` of the channel on its last checkpoint, and its hash                                                                                                                                                                                     |
| `cases`                         | Four casino bets at a bankroll of `10000000000`, each with `risk`: `{maxFee, fee, liability}`                                                                                                                                                       |
| `warning`                       | Text saying these seeds are public                                                                                                                                                                                                                  |

The operations are of the developer's game `roulette`:

1. A casino bet on red: a stake of `100000000` that pays `200000000` on 18 of 37 pockets, a chance of
   `18 × floor(2^64 / 37)`, with the seed `0x7272…72`. Its secret is the first `keccak256("HOOKEDIN/VECTOR/SECRET/<n>")`
   whose outcome is below that chance, so the bet pays.
2. A developer bet: a debit with a group, and a layout of chips as its meta.
3. The credit that collects what the developer paid for that bet, naming its `hash` as the counterparty.

An independent implementation checks, with the domain of `identity`:

1. `PROTOCOL` and `DEVELOPER_PROTOCOL`, built as [above](#limits-and-the-protocol-revision), equal `protocol` and
   `developerProtocol`.
2. The opening's [channel ID](#channel-ids), from its `player`, `signer` and `deposit`, equals its `channelId`.
3. `hashState(genesis)` equals `genesisHash`.
4. For each operation, `canonicalJSON(details)` equals `canonical`, whose keccak-256 is `operation.memo`, and
   `hashOperation(operation)` equals `hash`.
5. Each operation, applied with its `seed` and `secret` to the checkpoint before it, the genesis for the first, gives
   its `next`, whose `transitionHash` is `keccak256(abi.encode(hash, secret))` and whose hash is `nextHash`.
6. For the casino bet, `keccak256(secret)` equals its `round` and `keccak256(seed)` its `seedHash`;
   `keccak256(abi.encode(OUTCOME_DOMAIN, seed, secret))` equals `outcome.randomHash`, its low 64 bits `outcome.value`,
   and `outcome.payout` is the bet's `prize`, the value being below its `chance`.
7. The rejection checkpoint of the casino bet equals `rejection`, and its hash `rejectionHash`.
8. `close.stateHash` is the last `nextHash`, and `hashClose(close)` equals `closeHash`.
9. The [admission rule](economics.md#a-casino-bet-is-one-wager) gives each case's `risk` from its `bankroll` and `bet`.

`node scripts/vectors.ts --check`, part of `npm test`, fails when the file differs from what the code computes, and
`npm run vectors` writes it again. [test/derivation.test.ts](../../test/derivation.test.ts) runs the contract's
`derive` and `supported` beside `deriveState` for every kind and every invalid encoding and requires the same verdict.
