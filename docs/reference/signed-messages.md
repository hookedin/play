---
title: Signed messages
description: The EIP-712 domain, the thirteen signed structures, the IDs and hashes built from them, and the test vectors that fix them.
sidebar:
  order: 2
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
state hash (`previousStateHash`, the contract's `closingHash`), an operation's hash (a developer bet's ID, a
withdrawal's or a lock-in's ID, a rejection's `transitionHash`, a statement's `cause`), and the hashes of `Redeem` and
`BankWithdraw`. The contract exposes the two it uses as `hashState` and `hashOperation`.

## Structures

| Structure         | Fields, in order                                                                                                                                                                          | Signed by                                        | Checked by               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------ |
| `Checkpoint`      | `address player`, `uint256 index`, `uint256 sequence`, `bytes32 previousStateHash`, `bytes32 transitionHash`, `uint256 balance`, `uint256 deposited`, `uint256 withdrawn`, `uint256 loan` | The casino, and the account when it countersigns | Contract, wallet, casino |
| `Operation`       | `bytes32 previousStateHash`, `uint256 kind`, `uint256 amount`, `address recipient`, `uint256 fee`, `uint64 chance`, `uint256 prize`, `bytes32 round`, `bytes32 seedHash`, `bytes32 memo`  | The account                                      | Contract, casino, wallet |
| `Quote`           | `bytes32 previousStateHash`, `bytes32 round`, `uint256 virtualBankroll`, `uint256 expiresAt`                                                                                              | The casino                                       | Wallet, casino, contract |
| `CollateralOffer` | `address player`, `uint256 index`, `uint256 amount`, `uint256 price`, `uint256 expiresAt`                                                                                                 | The casino                                       | Wallet, contract         |
| `Access`          | `address player`, `uint256 expiresAt`                                                                                                                                                     | The account                                      | Casino                   |
| `DeveloperAccess` | `address developer`, `uint256 expiresAt`                                                                                                                                                  | The developer                                    | Casino                   |
| `Settlement`      | `bytes32 bet`, `uint256 player`, `uint256 casino`                                                                                                                                         | The developer                                    | Casino, wallet           |
| `BankCasinoBet`   | `bytes32 round`, `bytes32 game`, `uint256 stake`, `uint64 chance`, `uint256 prize`, `string group`, `bytes32 seedHash`, `bytes32 meta`                                                    | The developer                                    | Casino                   |
| `ShareStatement`  | `address holder`, `uint256 sequence`, `uint256 shares`, `uint256 amount`, `uint256 equity`, `uint256 totalShares`, `bytes32 cause`                                                        | The casino                                       | Wallet                   |
| `Fund`            | `uint256 sequence`, `uint256 totalShares`, `uint256 houseShares`, `uint256 equity`, `uint256 overdrawn`, `uint256 at`                                                                     | The casino                                       | Wallet                   |
| `Redeem`          | `address holder`, `uint256 shares`, `uint256 sequence`                                                                                                                                    | The holder                                       | Casino                   |
| `BankStatement`   | `address developer`, `uint256 sequence`, `uint256 balance`, `bytes32 cause`                                                                                                               | The casino                                       | Wallet                   |
| `BankWithdraw`    | `address developer`, `uint256 amount`, `uint256 sequence`                                                                                                                                 | The developer                                    | Casino                   |

The _account_ is the `player` a channel's checkpoints name, which signs everything on it. The _casino_ is the contract's `owner`, which
[`GET /api/config`](../casino-api/public.md#get-apiconfig) reports as `operator`. The _developer_ is the account that
publishes a game. In JSON an integer is a decimal string, except an operation's `kind` and a token's `expiresAt`, which
the wallet writes as numbers.

## Channels

### Channel IDs

A channel is an account's and an index: `player` is the account, not the zero address, and `index` how many of the
account's channels started closing before this one, 0 for its first. Every checkpoint names both, so it settles on its
channel alone. Off-chain a channel goes by its ID, which nothing signs:

```text
channelId = keccak256(abi.encode(address player, uint256 index))
```

The account's current channel, the one at the contract's `channelIndex(player)`, is active from the start, with
nothing to open: anyone can deposit into it, and both sides sign its states whether or not the chain holds anything for
it. On-chain the ID is only the ID of the channel's close in `claims`. `keccak256("…")` of a string, here and below,
hashes its UTF-8 bytes (ethers `id`).

### The base

A channel starts from its base, its zero checkpoint `(player, index, 0, 0x0, 0x0, 0, 0, 0, 0)`: zero but for its
account and index, so the balance is 0 until a deposit operation, or a credit, adds to it. It needs no signature: a channel can
close on it without the casino ever answering. Any other checkpoint the contract settles on is signed by both sides.

`deposited` is how much of the channel's deposits the balance has taken in, `withdrawn` how much it has paid out in
withdrawals and lock-ins, and `loan` how much of the balance the casino lent. The balance takes deposits in with a
[deposit operation](#transitions); [finalization](contract.md#finalization) says what a close on a checkpoint is owed.

### Transitions

An operation names the checkpoint it follows, its _base_, by its hash, `previousStateHash`, and so its channel and
its place. Applied, it produces the next checkpoint:

| Field               | Next checkpoint                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `player`, `index`   | The base's                                                                                                                  |
| `sequence`          | The base's plus one                                                                                                         |
| `previousStateHash` | The hash of the base                                                                                                        |
| `transitionHash`    | `keccak256(abi.encode(bytes32 operationHash, bytes32 secret))`, with the round's secret for a casino bet and zero otherwise |
| `balance`           | By kind, below                                                                                                              |
| `deposited`         | The base's, plus `amount` for a deposit                                                                                     |
| `withdrawn`         | The base's, plus `amount` for a withdrawal or a lock-in                                                                     |
| `loan`              | The base's, plus `amount` for a loan; 0 after a withdrawal or a lock-in                                                     |

| Kind       | `kind` | Balance                                                                       | `recipient`                                      | `fee`                                           | `chance`, `prize`, `round`, `seedHash`                                                |
| ---------- | ------ | ----------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Casino bet | 1      | Base − `amount`, + `prize` when the [outcome](#the-outcome) is below `chance` | Zero                                             | Zero                                            | The bet's terms; `round = keccak256(secret)`; `seedHash = keccak256(seed)`; none zero |
| Debit      | 2      | Base − `amount`                                                               | Zero                                             | Zero                                            | All zero                                                                              |
| Credit     | 3      | Base + `amount`                                                               | Zero                                             | Zero                                            | All zero                                                                              |
| Deposit    | 4      | Base + `amount`                                                               | Zero                                             | Zero                                            | All zero                                                                              |
| Withdrawal | 5      | Base − `amount` − `loan` − `fee`                                              | The address the contract pays                    | What the balance pays the casino for sending it | All zero                                                                              |
| Lock-in    | 6      | Base − `amount` − `loan` − `fee`                                              | Zero: it goes into the account's current channel | What the balance pays the casino for sending it | All zero                                                                              |
| Loan       | 7      | Base + `amount`                                                               | Zero                                             | Zero                                            | All zero                                                                              |
| None       | 0      | –                                                                             | –                                                | –                                               | Only in the [empty step](#evidence)                                                   |

Every transition holds to these rules, which the contract, the wallet and the casino apply alike:

- `amount` is 1 to 2^96 − 1. A casino bet's (its stake) or a debit's is at most the base balance, and a withdrawal's
  or a lock-in's at most the base balance less its `loan`, which it pays back first, and its `fee`.
- A casino bet's `chance` is 1 to 2^64 − 1, the winning outcomes out of 2^64, and its `prize` is 1 to 2^96 − 1: a sure
  loss or a sure win is no bet.
- A withdrawal's `recipient` is any address but zero and the contract; every other kind's, a lock-in's among them, is
  the zero address. A withdrawal's or a lock-in's `fee`, below 2^96, is what it pays the casino for sending it to the
  contract: it leaves the balance, and nothing pays it out. Every other kind's `fee` is 0.
- The next `balance`, `deposited`, `withdrawn` and `loan` are below 2^96.
- Every field a kind does not use is zero, and every kind but a casino bet carries a zero seed and secret: one meaning,
  one encoding.

The casino signs the next checkpoint. A _step_, `{operation, authorization, seed, secret, casinoSignature}`, carries the
signed operation, the account's signature of it, the revealed seed and secret (zero unless a casino bet), and the
casino's signature of the next checkpoint. With its base, a step proves the next checkpoint on-chain without the
player's countersignature. The player countersigns the next checkpoint and hands the casino that signature before the
channel's next operation: the `acknowledgment` of
[`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations). A withdrawal's or a
lock-in's step, with its base, is also what the contract records and pays it on
([withdrawals](contract.md#withdrawals)).

### Rejection checkpoints

The casino declines a signed casino bet, debit, withdrawal, lock-in or loan by proposing a checkpoint two above its
base, with the balance unchanged. The player signs it first, and the casino completes the rejection with its signature:

| Field               | Rejection checkpoint              |
| ------------------- | --------------------------------- |
| `sequence`          | The base's plus two               |
| `previousStateHash` | The hash of the base              |
| `transitionHash`    | The declined operation's own hash |
| `balance`           | The base's                        |
| `deposited`         | The base's                        |
| `withdrawn`         | The base's                        |
| `loan`              | The base's                        |

The proposal has `casinoSignature: "0x"` and does not advance the channel. The player verifies it, saves its signature,
and repeats the operation with `rejectionSignature`. The casino signs and records the joint checkpoint, whose evidence
settles on-chain, and the next operation follows it, at the base's sequence plus three. It supersedes the declined
operation, whose step would be at the base's sequence plus one. The casino issues no signed rejection without the player's
signature, so a player cannot choose to complete a rejection after learning a disputed bet's outcome. A recorded
result takes precedence over a cancellation retry at the casino, but a wallet that has signed the rejection takes no
result of the operation: the casino would hold a checkpoint the account signed at the sequence of the state after that
result, which it could complete later to supersede it. The operation then stays pending, and closing without the
casino settles it. Credits and deposits are not declined this way: the casino refuses a credit it does not owe, or a
deposit it has not seen confirmed on-chain, with an error.

A declined casino bet reveals nothing: the casino declines only a bet no [quote](#quotes) covers, which comes without
its seed, and the round takes the channel's next bet. The player signs no rejection of a bet its quote covers,
but one declined as a game's operation its account carried out on another channel, which carries `carried`, the
operation the account signed there and the checkpoint it follows, which names that channel:
`{base, operation, authorization, details}`.

### Evidence

`Evidence{Checkpoint base; bytes playerSignature; bytes casinoSignature; Step step}` is what the contract settles on.
`base` is the channel's [base](#the-base), which carries no signatures (both are `0x`), or another checkpoint
signed by the account and the casino. `step` is one step from the base, or the _empty step_: the all-zero operation
(`kind` 0, every number, address and hash zero), `authorization` and `casinoSignature` both `0x`, and a zero seed and
secret. Kind 0 appears nowhere else. The casino's replies carry evidence in this form,
`{base, playerSignature, casinoSignature, step}`.

A wallet exports evidence as a bundle (`EvidenceBundle` in [types.ts](../../protocol/types.ts)), which a wallet imports
and the [watchtower](../wallet/keys-and-recovery.md#the-watchtower) reads:

| Field         | Type       | Meaning                                                                                                                                                                                                                         |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chainId`     | string     | The chain, as a decimal string                                                                                                                                                                                                  |
| `casino`      | address    | The contract                                                                                                                                                                                                                    |
| `operator`    | address    | The casino, the contract's owner                                                                                                                                                                                                |
| `evidence`    | Evidence   | The latest evidence of the channel, whose base names it                                                                                                                                                                         |
| `details`     | Details    | Optional: the details of the step's operation, whose hash is its `memo`                                                                                                                                                         |
| `withdrawals` | Evidence[] | Optional: the evidence of each of the account's withdrawals and lock-ins the contract may still owe something, whose step is the withdrawal or the lock-in ([withdrawals](contract.md#withdrawals))                             |
| `dispute`     | object     | Optional: `{step, quote}`, a casino bet the account sent with its seed on a [quote](#quotes) that covers it, which the casino has not settled: its disputed step, which follows the checkpoint `evidence` proves, and the quote |

`verifyEvidence` in [protocol.ts](../../protocol/protocol.ts) checks a bundle's signatures, none for evidence on the
channel's base, and those of its `dispute`, and returns the checkpoint it proves. A bundle with a `dispute` carries the
checkpoint itself, with the empty step.

A casino bet a quote covers that the casino has not settled is disputed with a _disputed step_: its operation, the
account's `authorization` and the `seed`, with a zero `secret` and `casinoSignature` `0x`. Only the contract's
`dispute` takes it, with the quote, from anyone ([disputes](contract.md#disputes)); the casino settles it with the step
of its result, at the same sequence.

## Operations

### Details and memo

An operation signs what it means to the wallet and the casino as one hash, `memo`, of its _details_. The contract never
reads it. A request carries the details whole beside the signed operation, and both sides keep them with the evidence.

```text
memo = keccak256(utf8(canonicalJSON(details)))
```

| Field          | Type    | Meaning                                                                                                                                            |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | bytes32 | The hash of the operation's name: its [operation ID](#operation-ids)                                                                               |
| `game`         | bytes32 | The [key](#game-keys) of the game that asked for a casino bet, a developer bet or a payment                                                        |
| `group`        | string  | A label the game gives its bets and payments, such as one hand: 1 to 64 UTF-16 code units                                                          |
| `counterparty` | string  | What a debit pays into or a credit collects from: a [counterparty ID](#counterparties), a developer bet's hash or another player, written `~uname` |
| `meta`         | object  | A developer bet's own JSON: at most 4,096 bytes of canonical JSON, whose numbers are safe integers                                                 |

No other key is allowed. `id` and `game` are `0x` followed by 64 lowercase hex digits, and so is `counterparty`, unless
it names a player: `~` and their 24-character uname. `group` and `meta` appear only beside `game`. A withdrawal's
recipient is in the operation, not in its details. By kind:

| Kind          | Details                                  |
| ------------- | ---------------------------------------- |
| 1, casino bet | `game`, no `counterparty`, no `meta`     |
| 2, debit      | Exactly one of `game` and `counterparty` |
| 3, credit     | `counterparty`, no `game`                |
| 4, deposit    | Neither `game` nor `counterparty`        |
| 5, withdrawal | Neither `game` nor `counterparty`        |
| 6, lock-in    | Neither `game` nor `counterparty`        |
| 7, loan       | Neither `game` nor `counterparty`        |

Each operation the wallet signs, and what its details hold:

| Operation                                 | Kind | Details                                                              |
| ----------------------------------------- | ---- | -------------------------------------------------------------------- |
| Casino bet                                | 1    | `{id, game, group?}`                                                 |
| Payment to the bankroll                   | 2    | `{id, game, group?}`                                                 |
| Developer bet                             | 2    | `{id, game, group?, meta}`; the bet is known by the operation's hash |
| Investment in the bankroll fund           | 2    | `{id, counterparty: FUND_ID}`                                        |
| Deposit into the account's developer bank | 2    | `{id, counterparty: BANK_ID}`                                        |
| Transfer to another player                | 2    | `{id, counterparty: "~" + their uname}`                              |
| Collecting redeemed shares                | 3    | `{id, counterparty: FUND_ID}`                                        |
| Collecting a bank withdrawal              | 3    | `{id, counterparty: BANK_ID}`                                        |
| Collecting developer earnings             | 3    | `{id, counterparty: DEVELOPER_ID}`                                   |
| Collecting a developer bet's payout       | 3    | `{id, counterparty: <the bet's hash>}`                               |
| Collecting a transfer                     | 3    | `{id, counterparty: "~" + the sender's uname}`                       |
| Taking in a deposit                       | 4    | `{id}`                                                               |
| Withdrawal                                | 5    | `{id}`; the operation names the address it pays as `recipient`       |
| Locking in the balance                    | 6    | `{id}`; the operation names no `recipient`                           |
| Loan of a deposit's network fee           | 7    | `{id}`, the hash of the deposit's transaction                        |

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

`details.id` is the keccak-256 of the UTF-8 bytes of the operation's name, its _operation ID_; a loan of a deposit's
network fee has the hash of the deposit's transaction, so each deposit is lent once. The casino keeps each reply under the
channel and this hash: the same ID with the same signed operation is a retry and gets the recorded reply, and the same
ID with another operation is refused with `id-conflict`. The reply's `operationId` is this hash.

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

Each value is `keccak256` of its preimage. A credit that collects a developer bet's payout names the bet's hash instead,
and a transfer names a player: its debit the player it pays, and the credit that collects it the player it came from,
each written `~` and their uname, 24 characters of `23456789abcdefghijkmnopqrstvwxyz`.
The other fixed tag is `HOOKEDIN/OUTCOME` (`0xede2fdd26760847d3c92bb2ebf4da0fdbdf441ed687b86dc1257f1962e3857ff`), in
[the outcome](#the-outcome).

## Games, rounds and the outcome

### Game keys

```text
gameKey = keccak256(abi.encode(address developer, string name))
```

`developer` is the account that publishes the game and `name` the name it is published under (1 to 32 of `a-z`, `0-9`
and `-`, starting with a letter or digit). A game opened by its [URL](../games/publishing.md#the-games-url) alone takes
the zero address as `developer` and, as `name`, its URL as the URL parser normalises it, so no published game shares its
key; nobody earns its commission, and it takes no developer bets. The key is lowercase hex in details and in the API.
The vectors' game, developer `0x4444444444444444444444444444444444444444` and name `roulette`, has the key
`0x3ecebe6e27b57578960be6f32d017dd0aaa0de75c35a7208a74206db2dab2c5d`.

### Rounds

A _round_ is named by the hash of a secret: `round = keccak256(secret)`, where `secret` is 32 random bytes the casino
picks and keeps until the round is revealed. A casino bet signs its round and the hash of a _seed_,
`seedHash = keccak256(seed)`: 32 bytes the bettor picks after the round is named and sends with the bet. Both hashes are
of the 32 raw bytes. Only that secret and that seed settle the bet.

A round settles one casino bet. A channel's own round is the one its [quote](#quotes) names, revealed only by the casino
bet that settles on it; a developer's round is revealed by the developer's own `BankCasinoBet`, which may bet nothing
([`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet)). Once revealed, a
round settles nothing more.

### Quotes

A _quote_ is the casino's promise to settle the casino bet that follows a checkpoint, signed as `Quote` and sent as
`{message, signature}`. It names the checkpoint the bet follows (`previousStateHash`), and so its channel, the
channel's round, the virtual bankroll the bet is admitted against, half the casino's bankroll when it quoted, and
`expiresAt`, in Unix seconds, a day (`QUOTE_PERIOD`, 86,400) after the casino signed it. It _covers_ a casino bet whose
operation names its checkpoint and round, until `expiresAt`, and whose terms its virtual bankroll admits by
[the Kelly rule](economics.md#a-casino-bet-is-one-wager) with no commission: `covers` in
[protocol.ts](../../protocol/protocol.ts), which the contract's `dispute` checks too.

The casino settles every casino bet a quote of its own covers, and gives a checkpoint [one quote at a
time](../casino-api/channels.md#post-apichannelsidquote), so a wallet cannot collect several and keep the best. The
wallet sends a bet's seed and quote only when the quote covers it with at least half its day left, and never
countersigns a decline of a bet it sent so. Every reply that follows a channel's latest checkpoint brings the quote for
the next casino bet; a wallet asks for one with
[`POST /api/channels/:id/quote`](../casino-api/channels.md#post-apichannelsidquote).

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

### Collateral offers

A _collateral offer_ is the casino's offer to lock `amount` of house cash into a channel as
[collateral](contract.md#collateral) for `price`, signed as `CollateralOffer` and sent as `{message, signature}`.
Anyone buys it on-chain with `buyCollateral`, paying the price, once and until `expiresAt`, in Unix seconds, an hour
after the casino signed it. The casino prices it at its rate, `collateralRate` in
[`GET /api/config`](../casino-api/public.md#get-apiconfig), in millionths of the amount:
`price = ceil(amount × collateralRate / 1,000,000)` (`collateralPrice`), which the wallet checks before it buys. A wallet
asks for one with [`POST /api/channels/:id/collateral`](../casino-api/channels.md#post-apichannelsidcollateral).

### Access tokens

`Access(player, expiresAt)` and `DeveloperAccess(developer, expiresAt)` authenticate API requests: an account's token
serves for every one of its channels. `expiresAt` is a
time in Unix seconds, a JSON number or a decimal string. A token is the header value

```text
HookedIn <base64url(utf8(JSON {"message": <message>, "signature": "0x…"}))>
```

with base64url as in RFC 4648 §5, without padding. The token of the captured
[casino bet](../casino-api/channels.md#post-apichannelsidoperations) decodes to:

```json
{
  "message": {
    "player": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "expiresAt": 1791130425
  },
  "signature": "0x672f82109ab9714f55564ae91ebee535aa54a5fe6fa938f3542e0e7874ed22d204cb946ceded6d09ebb267034aa2cb589678dd14485c105cc4248c9006ef541e1b"
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
after each change. `holder` is the player's account, so a holding outlives any one channel. `sequence` numbers the
holding's statements from 1. `shares` is what the holder has afterwards and `amount` the wei invested or paid out.
`equity` and `totalShares` are the fund's before the change, and fix the price: an investment mints
`amount × totalShares / equity` shares and a redemption of `s` shares pays `s × equity / totalShares`, each rounded
down. At the first investment the equity the bankroll already holds becomes the house's shares, one per wei, so the
first price is one wei a share; with no shares in issue, an investment mints one share per wei. `cause` is the hash of
the investing operation or of the `Redeem`.

`Redeem(holder, shares, sequence)` turns shares back into money. `holder` signs it and sends it through its active
channel, and `sequence` is the number of the statement it will produce, so it works once.

`Fund(sequence, totalShares, houseShares, equity, overdrawn, at)` is the fund's public state, signed when asked for:
the number of fund changes so far, every share in issue, the house's own shares, the equity the shares are a claim on
(0 when there is none), the wei the owner withdrew beyond the house's shares (a loss the other holders bore), and the
time in Unix seconds. [The bankroll fund](../wallet/bankroll-fund.md) explains holding shares.

### Developer bank messages

`BankStatement(developer, sequence, balance, cause)` is the casino's statement of a developer's bank after each deposit
and withdrawal: `sequence` numbers the bank's statements from 1, `balance` is what it holds afterwards, and `cause` is
the hash of the depositing operation or of the `BankWithdraw`. Between statements, developer bets, settlements and the
developer's casino bets move the balance without a statement.

`BankWithdraw(developer, amount, sequence)` takes money out of the bank. `developer` signs it and sends it through its
active channel, and `sequence` is the number of the statement it will produce, so it works once.

## Bounds and the protocol revision

| Bound                                                                                                   | Value                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Outcome space, which a chance counts in                                                                 | 2^64, `18446744073709551616` (`OUTCOME_SPACE`) |
| A bet's meta                                                                                            | 4,096 bytes of canonical JSON                  |
| A group label                                                                                           | 64 UTF-16 code units                           |
| Amounts, fees, deposits, prizes, balances, `deposited`, `withdrawn`, `loan`, a quote's virtual bankroll | Below 2^96 (`MAX_BALANCE`)                     |
| Canonical JSON and API request bodies                                                                   | 1,000,000 bytes                                |
| Settlements in one request, developer bets in one public page                                           | 256                                            |
| Payouts listed in one reply                                                                             | 256                                            |

The first three are `BOUNDS`, which `GET /api/config` reports as `bounds`:
`{"outcomeSpace": "18446744073709551616", "meta": 4096, "group": 64}`.

`PROTOCOL` fixes everything a wallet and the casino must agree on. It is the keccak-256 of the UTF-8 bytes of the
thirteen EIP-712 `encodeType` strings, in the order of [the structures table](#structures), concatenated, followed by the
canonical JSON of the rules they apply alike. An `encodeType` string is a structure's name and its fields, as in
`Access(address player,uint256 expiresAt)`. The rules:

```text
{"bounds":{"group":64,"meta":4096,"outcomeSpace":"18446744073709551616"},"counterparties":{"bank":"0x6036e2ff95363cd3feb09ac645f9fa63a1d231a7d546f8ea5688615e683b9263","developer":"0x2fc2d32d54413eba8857124e3e8c3261740cccc0ba5885f6ea7498ea5bc68adc","fund":"0x467fc5e32da989116c215bcba4b9354cdc62740ac7a21e74f31eb81d1f6c8530","player":"^~[23456789abcdefghijkmnopqrstvwxyz]{24}$"},"kinds":{"casinoBet":1,"credit":3,"debit":2,"deposit":4,"loan":7,"lockIn":6,"none":0,"withdrawal":5},"outcome":"HOOKEDIN/OUTCOME"}
```

`DEVELOPER_PROTOCOL` fixes only what a developer's server shares with the casino: the `encodeType` strings of
`DeveloperAccess`, `Settlement` and `BankCasinoBet`, followed by:

```text
{"bounds":{"group":64,"meta":4096,"outcomeSpace":"18446744073709551616"},"outcome":"HOOKEDIN/OUTCOME"}
```

`GET /api/config` reports both, as `protocol` and `developerProtocol`. A wallet compares `protocol`, and a developer's
server `developerProtocol`, with its own before it signs anything, and stops on a difference (`assertProtocol`; the SDK
throws `protocol-mismatch`). A change to a structure only wallets sign moves `PROTOCOL` and leaves
`DEVELOPER_PROTOCOL` as it is.

## Test vectors

[vectors/protocol.json](../../vectors/protocol.json), written by [scripts/vectors.ts](../../scripts/vectors.ts), fixes
the hashing and pricing rules in numbers.

| Key                             | Contents                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`                      | Chain `31337` and contract `0x1111…11`, the domain of every hash below; the player `0x2222…22`, the developer `0x4444…44`, the recipient `0x5555…55` and the friend's uname `3byt9ocwnnzaxanmiz3stocj`                                             |
| `protocol`, `developerProtocol` | [`PROTOCOL` and `DEVELOPER_PROTOCOL`](#bounds-and-the-protocol-revision)                                                                                                                                                                           |
| `channel`                       | The player's first channel, whose `index` is `0`, with its ID                                                                                                                                                                                      |
| `base`, `baseHash`              | The channel's base, and its hash                                                                                                                                                                                                                   |
| `operations`                    | Nine operations, each on the checkpoint before it: its `details`, their `canonical` JSON, the signed `operation`, its `hash`, the `seed` and `secret` it settles with (zero but for the casino bet), and the `next` checkpoint with its `nextHash` |
| `outcome`                       | `{randomHash, value, payout}` of the casino bet                                                                                                                                                                                                    |
| `rejection`, `rejectionHash`    | The checkpoint that declines the casino bet instead, and its hash                                                                                                                                                                                  |
| `quote`                         | The casino's quote for the casino bet: its `message`, the `hash` the casino signs, and whether its virtual bankroll of `5000000000` `admitted` the bet                                                                                             |
| `offer`                         | The casino's offer of `2000000000` of collateral for the channel: its `message`, priced at the `rate` of `10000` millionths, and the `hash` the casino signs                                                                                       |
| `cases`                         | Four casino bets at a bankroll of `10000000000`, each with `risk`: `{maxFee, fee, liability}`                                                                                                                                                      |
| `warning`                       | Text saying these seeds are public                                                                                                                                                                                                                 |

The operations are a deposit of `1000000000` that takes in money deposited into the channel; a casino bet on red in
the developer's game `roulette`, a stake of `100000000` that pays `200000000` on 18 of 37 pockets (a chance of
`18 × floor(2^64 / 37)`, the seed `0x7272…72`, and as its secret the first `keccak256("HOOKEDIN/VECTOR/SECRET/<n>")`
whose outcome wins); a developer bet in the same game, with a group and a layout of chips as its meta; the credit that
collects what the developer paid for it, naming its `hash` as the counterparty; a deposit of `500000000`; a loan of
`5000000`, that deposit's network fee, whose `id` stands for the deposit transaction's hash; a withdrawal of `700000000`
to `identity.recipient` with a fee of `1000000`, which pays the loan back first; a lock-in of `100000000` with the same
fee; and a transfer of `50000000` to `identity.friend`, a debit naming `~` and the friend's uname, leaving a balance of
`808000000`, `withdrawn` at `800000000` and `loan` at `0`.

An implementation built from this page reproduces the file with the domain of `identity`: both protocol hashes; the
channel's [ID](#channel-ids), the [base](#the-base) and `baseHash`; each operation's `canonical` details, their
hash as its `memo`, and its `hash`; each `next`, the operation applied with its `seed` and `secret` to the checkpoint
before it, whose `transitionHash` is `keccak256(abi.encode(hash, secret))`, and its `nextHash`; the casino bet's
`round`, `seedHash` and [outcome](#the-outcome); the [rejection checkpoint](#rejection-checkpoints) and its hash; the
[quote](#quotes)'s hash and whether it covers the casino bet; and each case's `risk` from the
[admission rule](economics.md#a-casino-bet-is-one-wager).

`node scripts/vectors.ts --check`, part of `npm test`, fails when the file differs from what the code computes, and
`npm run vectors` writes it again. [test/derivation.test.ts](../../test/derivation.test.ts) runs the contract's
`supported` beside `deriveState` for every kind and every invalid encoding and requires the same verdict.
