---
title: Signed messages
description: The EIP-712 domain, the fifteen signed structures, the IDs and hashes built from them, and the test vectors that fix them.
sidebar:
  order: 2
---

Every signature in HookedIn is an EIP-712 typed-data signature under one domain. An implementation built from this page
computes the same hashes as [protocol.ts](../../protocol/protocol.ts) and [the
contract](../../contracts/HookedInCasino.sol), as the [test vectors](#test-vectors) confirm. [The contract
page](contract.md) says what the contract does with these messages, and the [Casino API](../casino-api/index.md) how
they travel.

## Domain

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
```

| Field               | Value                                           |
| ------------------- | ----------------------------------------------- |
| `name`              | `HookedIn`                                      |
| `version`           | `1`                                             |
| `chainId`           | `1` on Ethereum, `31337` on a local Anvil chain |
| `verifyingContract` | The address of the HookedInCasino deployment    |

Every structure uses this domain, including those that never reach the contract. A digest is
`keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`. A signature of any structure is 65 bytes, `r ‖ s ‖ v`, from
an externally owned account, with `v` of 27 or 28 and a low `s`: the only form the contract accepts, and so the only one
the casino and the wallet take.

The hash of a signed structure, wherever HookedIn uses one, is its full digest, never its struct hash: a checkpoint's
state hash (`previousStateHash`, the contract's `closingHash`), an operation's hash (a developer bet's ID, a
withdrawal's or a lock-in's ID, a rejection's `transitionHash`, a statement's `cause`), and the hashes of `Redeem` and
`BankWithdraw`. The contract exposes the two it uses as `hashState` and `hashOperation`.

## Structures

| Structure         | Fields, in order                                                                                                                                                                         | Signed by                                        | Checked by               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------ |
| `Checkpoint`      | `address player`, `uint256 index`, `uint256 sequence`, `bytes32 previousStateHash`, `bytes32 transitionHash`, `uint256 balance`, `uint256 deposited`, `uint256 withdrawn`                | The casino, and the account when it countersigns | Contract, wallet, casino |
| `Operation`       | `bytes32 previousStateHash`, `uint256 kind`, `uint256 amount`, `address recipient`, `uint256 fee`, `uint64 chance`, `uint256 prize`, `bytes32 round`, `bytes32 seedHash`, `bytes32 memo` | The account                                      | Contract, casino, wallet |
| `Quote`           | `bytes32 previousStateHash`, `bytes32 round`, `uint256 virtualBankroll`, `uint256 expiresAt`                                                                                             | The casino                                       | Wallet, casino, contract |
| `CollateralOffer` | `address player`, `uint256 index`, `uint256 amount`, `uint256 price`, `uint256 expiresAt`                                                                                                | The casino                                       | Wallet, contract         |
| `Access`          | `address player`, `uint256 expiresAt`                                                                                                                                                    | The account                                      | Casino                   |
| `GameServer`      | `string game`, `address server`                                                                                                                                                          | The developer                                    | Casino, wallet           |
| `DeveloperAccess` | `address server`, `uint256 expiresAt`                                                                                                                                                    | The game's server                                | Casino                   |
| `Settlement`      | `bytes32 bet`, `uint256 player`, `uint256 casino`                                                                                                                                        | The game's server                                | Casino, wallet           |
| `BankCasinoBet`   | `bytes32 round`, `string game`, `uint256 stake`, `uint64 chance`, `uint256 prize`, `string group`, `bytes32 seedHash`, `bytes32 meta`                                                    | The game's server                                | Casino                   |
| `ShareStatement`  | `address holder`, `uint256 sequence`, `uint256 shares`, `uint256 amount`, `uint256 equity`, `uint256 totalShares`, `bytes32 cause`                                                       | The casino                                       | Wallet                   |
| `Fund`            | `uint256 sequence`, `uint256 totalShares`, `uint256 houseShares`, `uint256 equity`, `uint256 overdrawn`, `uint256 at`                                                                    | The casino                                       | Wallet                   |
| `Redeem`          | `address holder`, `uint256 shares`, `uint256 sequence`                                                                                                                                   | The holder                                       | Casino                   |
| `BankStatement`   | `string game`, `uint256 sequence`, `uint256 balance`, `bytes32 cause`                                                                                                                    | The casino                                       | Wallet                   |
| `BankWithdraw`    | `string game`, `uint256 amount`, `uint256 sequence`                                                                                                                                      | The developer                                    | Casino                   |
| `HistoryHead`     | `string record`, `bytes32 digest`                                                                                                                                                        | The casino                                       | Wallet                   |

The _account_ is the `player` a channel's checkpoints name, which signs everything on it. The _casino_ is the contract's
`signer`, which [`GET /api/config`](../casino-api/public.md#get-apiconfig) reports as `operator`. The _developer_ is the
account that publishes a game, and the game's _server_ the key the developer names for it in a `GameServer`, the
developer's own until they name another. Code holds every whole number as a bigint; JSON holds it as a decimal string,
read back into a bigint and refused in any other form.

## Channels

### Channel IDs

A [channel](../overview/how-it-works.md#channels) is an account, `player`, never the zero address, and an `index`, the
number of the account's channels whose close started before it. Every checkpoint names both. Off-chain a channel goes by
its ID, which nothing signs; on-chain the ID is only that of the channel's close in `claims`:

```text
channelId = keccak256(abi.encode(address player, uint256 index))
```

`keccak256("…")` of a string, here and below, hashes its UTF-8 bytes (ethers `id`).

### The base

A channel starts from its base, its zero checkpoint `(player, index, 0, 0x0, 0x0, 0, 0, 0)`, which needs no signature;
any other checkpoint the contract settles on is signed by both sides. `deposited` is how much of the channel's deposits
the balance has taken in, with [deposit operations](#transitions), and `withdrawn` how much it has paid out in
withdrawals and lock-ins; [finalization](contract.md#finalization) says what a close on a checkpoint is owed.

### Transitions

An operation names the checkpoint it follows, its _base_, by its hash, `previousStateHash`, and so its channel and its
place. Applied, it produces the next checkpoint:

| Field               | Next checkpoint                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `player`, `index`   | The base's                                                                                                                  |
| `sequence`          | The base's plus one                                                                                                         |
| `previousStateHash` | The hash of the base                                                                                                        |
| `transitionHash`    | `keccak256(abi.encode(bytes32 operationHash, bytes32 secret))`, with the round's secret for a casino bet and zero otherwise |
| `balance`           | By kind, below                                                                                                              |
| `deposited`         | The base's, plus `amount` for a deposit                                                                                     |
| `withdrawn`         | The base's, plus `amount` for a withdrawal or a lock-in                                                                     |

| Kind       | `kind` | Balance                                                                       | `recipient`                                      | `fee`                                           | `chance`, `prize`, `round`, `seedHash`                                                |
| ---------- | ------ | ----------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Casino bet | 1      | Base − `amount`, + `prize` when the [outcome](#the-outcome) is below `chance` | Zero                                             | Zero                                            | The bet's terms; `round = keccak256(secret)`; `seedHash = keccak256(seed)`; none zero |
| Debit      | 2      | Base − `amount`                                                               | Zero                                             | Zero                                            | All zero                                                                              |
| Credit     | 3      | Base + `amount`                                                               | Zero                                             | Zero                                            | All zero                                                                              |
| Deposit    | 4      | Base + `amount`                                                               | Zero                                             | Zero                                            | All zero                                                                              |
| Withdrawal | 5      | Base − `amount` − `fee`                                                       | The address the contract pays                    | What the balance pays the casino for sending it | All zero                                                                              |
| Lock-in    | 6      | Base − `amount` − `fee`                                                       | Zero: it goes into the account's current channel | What the balance pays the casino for sending it | All zero                                                                              |
| None       | 0      | –                                                                             | –                                                | –                                               | Only in the [empty step](#evidence)                                                   |

Every transition holds to these rules, which the contract, the wallet and the casino apply alike:

- `amount` is 1 to 2^96 − 1. A casino bet's (its stake) or a debit's is at most the base balance, and a withdrawal's or
  a lock-in's at most the base balance less its `fee`.
- A casino bet's `chance` is 1 to 2^64 − 1, the winning outcomes out of 2^64, and its `prize` 1 to 2^96 − 1.
- A withdrawal's `recipient` is neither zero nor the contract. A withdrawal's or a lock-in's `fee` is below 2^96, and
  nothing pays it out.
- The next `balance`, `deposited` and `withdrawn` are below 2^96.
- Every field a kind does not use is zero, as are the seed and secret of every kind but a casino bet: one meaning, one
  encoding.

A _step_, `{operation, authorization, seed, secret, casinoSignature}`, carries the signed operation, the account's
signature of it, the revealed seed and secret (zero unless a casino bet), and the casino's signature of the next
checkpoint. With its base, a step proves the next checkpoint on-chain without the player's countersignature, and a
withdrawal's or a lock-in's is what the contract [records and pays](contract.md#withdrawals). The player countersigns
the next checkpoint and sends the casino that signature, the `acknowledgment` of
[`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations), before the channel's next
operation.

### Rejection checkpoints

The casino declines a signed casino bet, debit, withdrawal or lock-in with a checkpoint the player signs first and the
casino completes:

| Field               | Rejection checkpoint              |
| ------------------- | --------------------------------- |
| `sequence`          | The base's plus two               |
| `previousStateHash` | The hash of the base              |
| `transitionHash`    | The declined operation's own hash |
| `balance`           | The base's                        |
| `deposited`         | The base's                        |
| `withdrawn`         | The base's                        |

The casino proposes it with `casinoSignature: "0x"`, which advances nothing; the player verifies it and sends the
operation again with its signature as `rejectionSignature`
([`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations)), so no player holds a
rejection it could complete after learning a disputed bet's outcome. The joint checkpoint settles on-chain, supersedes
the declined operation's step, one sequence below it, and is what the next operation follows. A wallet that has signed a
rejection takes no result of the operation: the casino would hold the account's signature of a checkpoint at the base's
sequence plus two, which it could complete later to supersede what follows that result. The operation then stays
pending, and closing without the casino settles it.

A casino bet no [quote](#quotes) covers comes without its seed, so its rejection reveals nothing. The player signs no
rejection of a covered bet but one declined as a game's operation its account [carried out on another
channel](#operation-ids), with `carried`, `{base, operation, authorization, details}`: the operation the account signed
there and the checkpoint it follows, which names that channel.

### Evidence

`Evidence{Checkpoint base; bytes playerSignature; bytes casinoSignature; Step step}` is what the contract settles on,
and the casino's replies carry evidence in this form. `base` is the channel's [base](#the-base), with both signatures
`0x`, or another checkpoint signed by the account and the casino. `step` is one step from the base, or the _empty step_:
the all-zero operation (`kind` 0, every number, address and hash zero), `authorization` and `casinoSignature` both `0x`,
and a zero seed and secret. Kind 0 appears nowhere else.

A wallet exports evidence as a bundle (`EvidenceBundle` in [types.ts](../../protocol/types.ts)), which a wallet imports
and the [watchtower](../wallet/keys-and-recovery.md#the-watchtower) reads:

| Field         | Type       | Meaning                                                                                                                                                                                                                         |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chainId`     | string     | The chain, as a decimal string                                                                                                                                                                                                  |
| `casino`      | address    | The contract                                                                                                                                                                                                                    |
| `operator`    | address    | The casino, the contract's signer                                                                                                                                                                                               |
| `evidence`    | Evidence   | The latest evidence of the channel, whose base names it                                                                                                                                                                         |
| `details`     | Details    | Optional: the details of the step's operation, whose hash is its `memo`                                                                                                                                                         |
| `withdrawals` | Evidence[] | Optional: the evidence of each of the account's withdrawals and lock-ins the contract may still owe something, whose step is the withdrawal or the lock-in ([withdrawals](contract.md#withdrawals))                             |
| `dispute`     | object     | Optional: `{step, quote}`, a casino bet the account sent with its seed on a [quote](#quotes) that covers it, which the casino has not settled: its disputed step, which follows the checkpoint `evidence` proves, and the quote |

`verifyEvidence` in [protocol.ts](../../protocol/protocol.ts) checks a bundle's signatures, none for evidence on the
channel's base, and those of its `dispute`, and returns the checkpoint it proves. A bundle with a `dispute` carries the
checkpoint itself, with the empty step.

A covered casino bet the casino has not settled is disputed with a _disputed step_: its operation, the account's
`authorization` and the `seed`, with a zero `secret` and `casinoSignature` `0x`. Only the contract's `dispute` takes it,
with the quote ([disputes](contract.md#disputes)); the casino settles it with the step of its result, at the same
sequence.

## Operations

### Details and memo

An operation signs what it means to the wallet and the casino as one hash, `memo`, of its _details_, which the contract
never reads. A request carries the details whole beside the signed operation, and both sides keep them with the
evidence.

```text
memo = keccak256(utf8(canonicalJSON(details)))
```

| Field          | Type    | Meaning                                                                                                                                                              |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | bytes32 | The hash of the operation's name: its [operation ID](#operation-ids)                                                                                                 |
| `game`         | string  | The [ID](#game-ids) of the game that asked for a casino bet, a developer bet or a payment                                                                            |
| `group`        | string  | A label the game gives its bets and payments, such as one hand: 1 to 64 UTF-16 code units of printable text: no control, format, private-use or unassigned character |
| `counterparty` | string  | What a debit pays into or a credit collects from: a [counterparty ID](#counterparties), a game's ID, a developer bet's hash or another player, written `~uname`      |
| `meta`         | object  | A developer bet's own JSON: at most 4,096 bytes of canonical JSON, whose numbers are safe integers and whose text is well-formed, without a NUL                      |
| `round`        | bytes32 | A developer bet's round: the hash of a secret its developer committed to before the bet, which its settlement reveals                                                |
| `table`        | object  | A casino bet's step: `{cash, bankroll?, results}`, the table of results the game offered, which the wallet split into the bets it drew this one from                 |
| `kept`         | string  | A game's payment in a group: the cash it leaves with the group, a decimal string below 2^96, so what the round held is the payment's amount and `kept`               |

No other key is allowed. `id` and `round` are `0x` followed by 64 lowercase hex digits and `game` a [game
ID](#game-ids), and `counterparty` is one of the two, unless it names a player: `~` and their 24-character uname.
`group` and `meta` appear only beside `game`, `round` only beside `meta`, `table` only on a casino bet, and `kept` only
on a debit with `group` and with neither `meta` nor `counterparty`.

A `table` holds the step's `cash`, from 1 to below 2^96, and its `results`, 1 to 128 of them, each
`{weight, cash, label?}`: a weight above zero, the cash the result leaves the player, below 2^96, and a label of 1 to 64
printable characters. The weights add up to less than 2^256, and the amounts below `cash` paired with those above it, or
with none above it, every other amount with the highest, come to at most 64 pairs. A table of several amounts names
`bankroll`, the virtual bankroll of the quote the wallet split it at, and one of one amount, which places no bet, names
none. Every amount is a decimal string. The casino refuses with `invalid` a casino bet its table cannot place, one that
stakes more than `cash` or whose `cash − amount`, or that with its prize, is no amount a result leaves, and one whose
`bankroll` is not its quote's virtual bankroll. By kind:

| Kind          | Details                                  |
| ------------- | ---------------------------------------- |
| 1, casino bet | `game`, no `counterparty`, no `meta`     |
| 2, debit      | Exactly one of `game` and `counterparty` |
| 3, credit     | `counterparty`, no `game`                |
| 4, deposit    | Neither `game` nor `counterparty`        |
| 5, withdrawal | Neither `game` nor `counterparty`        |
| 6, lock-in    | Neither `game` nor `counterparty`        |

Each operation the wallet signs, and what its details hold; what the casino checks for each, and what it answers, is
under [`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations):

| Operation                                           | Kind | Details                                                                          |
| --------------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| Casino bet                                          | 1    | `{id, game, group?, table?}`; a game's step signs its `table`                    |
| Payment to the bankroll                             | 2    | `{id, game, group?, kept?}`; a payment in a group can sign what it `kept`        |
| Developer bet                                       | 2    | `{id, game, group?, meta, round?}`; the bet is known by the operation's hash     |
| Investment in the bankroll fund                     | 2    | `{id, counterparty: FUND_ID}`                                                    |
| Deposit into the bank of one of the account's games | 2    | `{id, counterparty: <the game's ID>}`                                            |
| Transfer to another player                          | 2    | `{id, counterparty: "~" + their uname}`                                          |
| Collecting redeemed shares                          | 3    | `{id, counterparty: FUND_ID}`                                                    |
| Collecting a withdrawal from a game's bank          | 3    | `{id, counterparty: <the game's ID>}`                                            |
| Collecting a developer bet's payout                 | 3    | `{id, counterparty: <the bet's hash>}`                                           |
| Collecting a transfer                               | 3    | `{id, counterparty: "~" + the sender's uname}`                                   |
| Collecting a deposit's network fee                  | 3    | `{id, counterparty: DEPOSIT_FEE_ID}`, `id` the hash of the deposit's transaction |
| Taking in a deposit                                 | 4    | `{id}`                                                                           |
| Withdrawal                                          | 5    | `{id}`; the operation names the address it pays as `recipient`                   |
| Locking in the balance                              | 6    | `{id}`; the operation names no `recipient`                                       |

### Canonical JSON

`canonicalJSON` (in [protocol.ts](../../protocol/protocol.ts)) writes one string for one value:

- Object keys are sorted by UTF-16 code units, as JavaScript's default sort orders them, and written `{"key":value,…}`
  with no whitespace.
- Arrays keep their order; strings, `true`, `false` and `null` are written as `JSON.stringify` writes them.
- A number must be a safe integer (at most 2^53 − 1 in magnitude); any other number is refused. A bigint is written as a
  decimal string.
- An `undefined` value is refused.
- The result is at most 1,000,000 bytes of UTF-8.

The developer bet in the [test vectors](#test-vectors) signs these details, in canonical JSON:

```text
{"game":"0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b","group":"spin-1","id":"0x8383838383838383838383838383838383838383838383838383838383838383","meta":{"chips":{"17":"20000000","9":"10000000","red":"30000000"}}}
```

Their keccak-256 is its `memo`, `0xe79fe1282f97f35828b06b4e58b0ebb6f2edf95a743751ee29b4a6bfb1e08238`. The keys sort as
strings, so `"17"` comes before `"9"`.

### Operation IDs

`details.id`, the _operation ID_, is the keccak-256 of the UTF-8 bytes of the operation's name, or for a deposit's
network fee the hash of the deposit's transaction. The casino keeps each reply under the channel and this hash, the
reply's `operationId`: the same ID with the same signed operation is a retry and gets the recorded reply, and with
another operation is refused with `id-conflict`.

The wallet names its own operations, and a game's `game:<gameId>:<id>`: the game's [ID](#game-ids) and the ID the game
chose (1 to 64 ASCII letters, digits, `.`, `_`, `:` or `-`). The name holds no channel, so the operation has the same
`details.id` on every channel of its player: the casino declines one the player already carried out on another channel
with a signed rejection marked `used: true`, and never carries it out twice.

### Counterparties

| Name             | Preimage               | Value                                                                | Debit         | Credit                                         |
| ---------------- | ---------------------- | -------------------------------------------------------------------- | ------------- | ---------------------------------------------- |
| `FUND_ID`        | `HOOKEDIN/BANKROLL`    | `0x467fc5e32da989116c215bcba4b9354cdc62740ac7a21e74f31eb81d1f6c8530` | An investment | Redeemed shares                                |
| `DEPOSIT_FEE_ID` | `HOOKEDIN/DEPOSIT_FEE` | `0x4a76f24c4a2e1baddfe7c90d2db7f7a9330453e17ca13b620770e752dd15ebaf` | –             | A deposit's network fee, which the casino pays |

Each value is `keccak256` of its preimage. The [other counterparties](#details-and-memo) are a game's ID, a developer
bet's hash and a player, written `~` and their uname, 24 characters of `23456789abcdefghijkmnopqrstvwxyz`. The other
fixed tags are `HOOKEDIN/OUTCOME`, in [the outcome](#the-outcome), and `HOOKEDIN/BRANCH` and `HOOKEDIN/RESULT`, which
[draw a game's step](../games/collapsing-bets.md#the-wallet-draws-the-step).

## Games, rounds and the outcome

### Game IDs

A game is known by its ID, a UUID, written in lowercase with dashes in details, in signed messages and in the API. A
published game's is the UUIDv7 of the signing-history record that first published it
([`POST /api/account/games`](../casino-api/channels.md#post-apiaccountgames)), which it keeps under any name and at any
URL. A game opened by its [URL](../games/publishing.md#the-games-url) alone, which nobody publishes, has its URL's ID, a
UUIDv8 made from the URL as the URL parser normalises it:

```text
b = first 16 bytes of keccak256(utf8(url))
b[6] = 0x80 | (b[6] & 0x0f)    the version, 8
b[8] = 0x80 | (b[8] & 0x3f)    the variant
urlGameId = b as a UUID
```

Such a game has no bank, and takes no developer bets.

### Rounds

A _round_ ([how rounds work](../overview/how-it-works.md#rounds)) is named by the hash of a secret,
`round = keccak256(secret)`, where `secret` is 32 random bytes the casino picks and keeps until the round is revealed. A
casino bet signs its round and the hash of a _seed_, `seedHash = keccak256(seed)`: 32 bytes the bettor picks after the
round is named and sends with the bet. Both hashes are of the 32 raw bytes, and only that secret and that seed settle
the bet. A round settles one casino bet, which reveals it: a channel's, the one its [quote](#quotes) names, or a game's
own `BankCasinoBet`, which may bet nothing
([`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet)).

### Quotes

A _quote_ is the casino's promise to settle the casino bet that follows a checkpoint ([how quotes
work](../overview/how-it-works.md#quotes)), signed as `Quote` and sent as `{message, signature}`. It names that
checkpoint (`previousStateHash`), the channel's round, the virtual bankroll the bet is admitted against, half the
casino's bankroll when it quoted, and `expiresAt`, in Unix seconds, a day (`QUOTE_PERIOD`, 86,400) after the casino
signed it. It _covers_ a casino bet whose operation names its checkpoint and round, until `expiresAt`, and whose terms
its virtual bankroll admits by [the Kelly rule](economics.md#a-casino-bet-is-one-wager) with no commission: `covers` in
[protocol.ts](../../protocol/protocol.ts), which the contract's `dispute` checks too.

The casino gives a checkpoint one quote at a time, so a wallet cannot collect several and keep the best: every reply
that follows a channel's latest checkpoint brings it, and
[`POST /api/channels/:id/quote`](../casino-api/channels.md#post-apichannelsidquote) asks for it.

### The outcome

```text
outcome = uint64(keccak256(abi.encode(bytes32 OUTCOME_DOMAIN, bytes32 seed, bytes32 secret)))
OUTCOME_DOMAIN = keccak256("HOOKEDIN/OUTCOME")
```

`uint64(…)` keeps the low 64 bits. A casino bet costs its stake and pays its `prize` when `outcome < chance`, with
probability `chance / 2^64`. The outcome depends only on the seed and the secret, so every bet on one round and seed
sees the same value. To check a revealed round: `keccak256(secret)` is the round, `keccak256(seed)` the bet's
`seedHash`, and the formula gives the outcome and so the payout.

## Other signed messages

### Collateral offers

A _collateral offer_ is the casino's offer to lock `amount` of house cash into a channel as
[collateral](contract.md#collateral) for `price`, signed as `CollateralOffer` and sent as `{message, signature}`. Anyone
buys it once with `buyCollateral`, until `expiresAt`, in Unix seconds, an hour after the casino signed it. The casino
prices it at its rate, `collateralRate` in [`GET /api/config`](../casino-api/public.md#get-apiconfig), in millionths of
the amount: `price = ceil(amount × collateralRate / 1,000,000)` (`collateralPrice`). A wallet asks for one with
[`POST /api/channels/:id/collateral`](../casino-api/channels.md#post-apichannelsidcollateral).

### Access tokens

`Access(player, expiresAt)` and `DeveloperAccess(server, expiresAt)` authenticate API requests: an account's token
serves for every one of its channels, and a server's for every game whose server it is. `expiresAt` is in Unix seconds,
a decimal string. A token is the header value

```text
HookedIn <base64url(utf8(JSON {"message": <message>, "signature": "0x…"}))>
```

with base64url as in RFC 4648 §5, without padding. The token of the captured [casino
bet](../casino-api/channels.md#post-apichannelsidoperations) decodes to:

```json
{
  "message": {
    "player": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "expiresAt": "1791130425"
  },
  "signature": "0x672f82109ab9714f55564ae91ebee535aa54a5fe6fa938f3542e0e7874ed22d204cb946ceded6d09ebb267034aa2cb589678dd14485c105cc4248c9006ef541e1b"
}
```

Which key signs which token, and the time window the casino accepts, are under
[Authentication](../casino-api/index.md#authentication).

### Developer messages

`GameServer(game, server)`, signed by the game's developer, names the key the game's server signs with: `game` is the
game's ID and `server` an address, the developer's own giving the game back to the developer's key. The casino keeps it,
takes the game's `DeveloperAccess`, `Settlement` and `BankCasinoBet` from that key alone from then on, and gives it with
every developer bet that key settles, so a wallet checks the settlement against the developer's own signature.

`Settlement(bet, player, casino)` settles a developer bet, signed by its game's server. `bet` is the hash of the
operation that placed the bet, which signed its meta and its round. `player` is what the player is paid and `casino`
what the casino is given, both from the game's bank and each below 2^96. A settlement of a bet that names a round comes
with the round's `secret` beside it, unsigned, since it hashes to the round; any other settlement has none.

`BankCasinoBet(round, game, stake, chance, prize, group, seedHash, meta)` is a game's casino bet from its bank, on a
round of its own, signed by its server. `game` is the game's ID; `stake`, `chance` and `prize` are as for any casino
bet; `group` is a [group](#details-and-memo) label; `seedHash` is `keccak256(seed)` of the seed the request brings;
`meta` is `keccak256(utf8(canonicalJSON(meta)))` of the game's own JSON, which the casino keeps with the reveal and
never reads. A stake, chance and prize all zero is a _reveal_: it bets nothing and only reveals the round, and is
signed, grouped and kept like any other.

### Bankroll fund messages

`ShareStatement(holder, sequence, shares, amount, equity, totalShares, cause)` is the casino's statement of one holding
after each change. `holder` is the player's account, so a holding outlives any one channel. `sequence` numbers the
holding's statements from 1. `shares` is what the holder has afterwards and `amount` the wei invested or paid out.
`equity` and `totalShares` are the fund's before the change, and fix the price: an investment mints
`amount × totalShares / equity` shares and a redemption of `s` shares pays `s × equity / totalShares`, each rounded
down. At the first investment the equity the bankroll already holds becomes the house's shares, one per wei; with no
shares in issue, an investment mints one share per wei. `cause` is the hash of the investing operation or of the
`Redeem`.

`Redeem(holder, shares, sequence)` turns shares back into money. `holder` signs it and sends it through its active
channel, and `sequence` is the number of the statement it will produce, so it works once.

`Fund(sequence, totalShares, houseShares, equity, overdrawn, at)` is the fund's public state, signed when asked for: the
number of fund changes so far, every share in issue, the house's own shares, the equity the shares are a claim on (0
when there is none), the wei the treasury withdrew beyond the house's shares (a loss the other holders bore), and the
time in Unix seconds. [The bankroll fund](../wallet/bankroll-fund.md) explains holding shares.

### Game bank messages

`BankStatement(game, sequence, balance, cause)` is the casino's statement of a game's bank after each deposit and
withdrawal: `sequence` numbers the bank's statements from 1, `balance` is what it holds afterwards, and `cause` is the
hash of the depositing operation or of the `BankWithdraw`. Between statements, the game's casino bets and developer bets
and their settlements move the balance without a statement.

`BankWithdraw(game, amount, sequence)` takes money out of a game's bank. The game's developer signs it and sends it with
its account's token, and `sequence` is the number of the statement it will produce, so it works once.

### History heads

`HistoryHead(record, digest)` is the casino's statement of where its signing history, the record of everything it
decides, ended when it signed:

| Field    | Type    | Meaning                                                              |
| -------- | ------- | -------------------------------------------------------------------- |
| `record` | string  | The ID of the history's last committed record, a UUIDv7 in lowercase |
| `digest` | bytes32 | That record's digest, which commits to every record before it        |

The casino signs one at most once a second. Every reply to an operation on a channel, and
[activation](../casino-api/channels.md#post-apichannelsidactivate)'s, carries the latest as `head`,
`{message, signature}`. [`GET /api/history/:id`](../casino-api/public.md#get-apihistoryid) gives any record's digest, so
whoever holds a head checks that the history still holds its record as signed, and so every record before it ([the
casino's history](../wallet/keys-and-recovery.md#the-casinos-history)).

## Bounds and the protocol revision

| Bound                                                                                           | Value                                          |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Outcome space, which a chance counts in                                                         | 2^64, `18446744073709551616` (`OUTCOME_SPACE`) |
| A bet's meta                                                                                    | 4,096 bytes of canonical JSON                  |
| A group label                                                                                   | 64 UTF-16 code units                           |
| A step's results, the pairs it is split into, and a result's label                              | 128, 64 and 64 UTF-16 code units               |
| A step's results' total weight                                                                  | Below 2^256                                    |
| Amounts, fees, deposits, prizes, balances, `deposited`, `withdrawn`, a quote's virtual bankroll | Below 2^96 (`MAX_BALANCE`)                     |
| Canonical JSON and API request bodies                                                           | 1,000,000 bytes                                |
| Settlements in one request, developer bets in one public page                                   | 256                                            |
| Payouts listed in one reply                                                                     | 256                                            |

The first five are `BOUNDS`, which `GET /api/config` reports as `bounds`:
`{"outcomeSpace": "18446744073709551616", "meta": 4096, "group": 64, "results": 128, "pairs": 64, "weight": "115792089237316195423570985008687907853269984665640564039457584007913129639936", "label": 64}`.

`PROTOCOL` fixes everything a wallet and the casino must agree on: the keccak-256 of the UTF-8 bytes of the fifteen
EIP-712 `encodeType` strings, in the order of [the structures table](#structures), concatenated, followed by the
canonical JSON of the rules they apply alike. An `encodeType` string is a structure's name and its fields, as in
`Access(address player,uint256 expiresAt)`. The rules:

```text
{"bounds":{"group":64,"label":64,"meta":4096,"outcomeSpace":"18446744073709551616","pairs":64,"results":128,"weight":"115792089237316195423570985008687907853269984665640564039457584007913129639936"},"counterparties":{"depositFee":"0x4a76f24c4a2e1baddfe7c90d2db7f7a9330453e17ca13b620770e752dd15ebaf","fund":"0x467fc5e32da989116c215bcba4b9354cdc62740ac7a21e74f31eb81d1f6c8530","player":"^~[23456789abcdefghijkmnopqrstvwxyz]{24}$"},"kinds":{"casinoBet":"1","credit":"3","debit":"2","deposit":"4","lockIn":"6","none":"0","withdrawal":"5"},"outcome":"HOOKEDIN/OUTCOME"}
```

`DEVELOPER_PROTOCOL` fixes only what a game's server shares with the casino: the `encodeType` strings of
`DeveloperAccess`, `Settlement` and `BankCasinoBet`, followed by:

```text
{"bounds":{"group":64,"label":64,"meta":4096,"outcomeSpace":"18446744073709551616","pairs":64,"results":128,"weight":"115792089237316195423570985008687907853269984665640564039457584007913129639936"},"outcome":"HOOKEDIN/OUTCOME"}
```

`GET /api/config` reports both, as `protocol` and `developerProtocol`. A wallet compares `protocol`, and a game's server
`developerProtocol`, with its own before it signs anything, and stops on a difference (`assertProtocol`; the SDK throws
`protocol-mismatch`).

## Test vectors

[vectors/protocol.json](../../vectors/protocol.json), written by [scripts/vectors.ts](../../scripts/vectors.ts), fixes
the hashing and pricing rules in numbers.

| Key                             | Contents                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`                      | Chain `31337` and contract `0x1111…11`, the domain of every hash below; the player `0x2222…22`, the recipient `0x5555…55` and the friend's uname `3byt9ocwnnzaxanmiz3stocj`                                                                        |
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

The operations are a deposit of `1000000000`; a casino bet on red in the published game
`0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b`, a stake of `100000000` that pays `200000000` on 18 of 37 pockets (a chance of
`18 × floor(2^64 / 37)`, the seed `0x7272…72`, and as its secret the first `keccak256("HOOKEDIN/VECTOR/SECRET/<n>")`
whose outcome wins); a developer bet in the same game, with a group and a layout of chips as its meta; the credit that
collects what the developer paid for it, naming its `hash` as the counterparty; a deposit of `500000000`; a credit of
`5000000` collecting that deposit's network fee, naming `DEPOSIT_FEE_ID`, its `id` standing for the deposit
transaction's hash; a withdrawal of `700000000` to `identity.recipient` with a fee of `1000000`; a lock-in of
`100000000` with the same fee; and a transfer of `50000000` to `identity.friend`, a debit naming `~` and the friend's
uname, leaving a balance of `813000000` and `withdrawn` at `800000000`.

An implementation built from this page reproduces the file with the domain of `identity`: both protocol hashes; the
channel's [ID](#channel-ids), the [base](#the-base) and `baseHash`; each operation's `canonical` details, their hash as
its `memo`, and its `hash`; each `next`, the operation applied with its `seed` and `secret` to the checkpoint before it,
whose `transitionHash` is `keccak256(abi.encode(hash, secret))`, and its `nextHash`; the casino bet's `round`,
`seedHash` and [outcome](#the-outcome); the [rejection checkpoint](#rejection-checkpoints) and its hash; the
[quote](#quotes)'s hash and whether its virtual bankroll admits the casino bet; the [offer](#collateral-offers)'s price
and hash; and each case's `risk` from the [admission rule](economics.md#a-casino-bet-is-one-wager).

`node scripts/vectors.ts --check`, part of `npm test`, fails when the file differs from what the code computes, and
`npm run vectors` writes it again. [test/derivation.test.ts](../../test/derivation.test.ts) runs the contract's
`supported` beside `deriveState` for every kind and every invalid encoding and requires the same verdict.
