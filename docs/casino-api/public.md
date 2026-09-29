---
title: Public endpoints
description: The routes anyone may call, for the deployment, health and books, the bankroll fund, players, games' records, rounds, developer bets and the local faucet.
sidebar:
  order: 1
---

These routes need no authentication. They say what the casino runs, how it stands, and what it has recorded in public:
players by their names, games by their keys, developers' rounds and developer bets by their hashes. Nothing here names
a player's address or channel. Conventions, budgets and error codes are on the [Casino API](index.md) page.

## The deployment and its health

### `GET /api/config`

The deployment the casino runs, the protocol revision it speaks and the limits it holds bets to.

**Auth:** none · **Idempotent:** yes

A wallet checks `protocol` and a developer's server `developerProtocol` against its own before it signs anything. The
wallet takes nothing else on trust from this reply: it checks
[the deployment it pins](../reference/deployment.md#how-the-wallet-pins-its-deployment) on-chain.

| Response field       | Type           | Meaning                                                                                                                                 |
| -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `chainId`            | string         | `"11155111"` (Sepolia) or `"31337"` (Anvil)                                                                                             |
| `rpcUrl`             | string         | The casino's primary RPC                                                                                                                |
| `witnessRpcUrl`      | string         | Its witness RPC, on another host; absent when it has none                                                                               |
| `contractAddress`    | address        | The HookedInCasino contract                                                                                                             |
| `protocol`           | bytes32        | [`PROTOCOL`](../reference/signed-messages.md#limits-and-the-protocol-revision), the hash of everything a wallet and the casino agree on |
| `developerProtocol`  | bytes32        | `DEVELOPER_PROTOCOL`, the hash of what a developer's server and the casino agree on                                                     |
| `confirmations`      | number         | The confirmations a deposit needs: 2 on Sepolia, 1 on Anvil                                                                             |
| `operator`           | address        | The contract's owner: the casino's signing address                                                                                      |
| `clientUrl`          | string         | The wallet's origin                                                                                                                     |
| `networkName`        | string         | `"Sepolia"` or `"Anvil test chain"`                                                                                                     |
| `isLocalDevelopment` | boolean        | `true` only on a local Anvil stack that offers [the faucet](#post-apifaucet)                                                            |
| `explorerUrl`        | string or null | `"https://sepolia.etherscan.io"` on Sepolia, `null` otherwise                                                                           |
| `limits`             | object         | `{outcomeSpace, meta, group}`: [the limits](../reference/signed-messages.md#limits-and-the-protocol-revision) a bet is held to          |

```json title="Response"
{
  "chainId": "31337",
  "rpcUrl": "http://127.0.0.1:57772",
  "contractAddress": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "protocol": "0xb0f1b12a797e894955d59233d3b1d300c46f394cd3cb99d121ffd5570af6f54d",
  "developerProtocol": "0xf5bd44c475a9e6e0136b45e0fb337e44a37298c63003b0c8f7fd74d6838a6d65",
  "confirmations": 1,
  "operator": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "clientUrl": "http://127.0.0.1:4184",
  "networkName": "Anvil test chain",
  "isLocalDevelopment": false,
  "explorerUrl": null,
  "limits": {
    "outcomeSpace": "18446744073709551616",
    "meta": 4096,
    "group": 64
  }
}
```

**Errors:** [`rate-limited`](index.md#errors) (429)

### `GET /api/status`

The casino's health, its books, what developers have earned, the last observed block and the commit it runs.

**Auth:** none · **Idempotent:** yes

| Response field      | Type           | Meaning                                                                                                                                                                                                                                   |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`            | string         | Chain observation: `starting`, `reconciling`, `ready` or `error`. The casino signs only when `ready`                                                                                                                                      |
| `lastCheck`         | number         | When the last observation finished, in milliseconds                                                                                                                                                                                       |
| `stale`             | boolean        | `true` when `status` is not `ready` or the last observation is more than 60 seconds old                                                                                                                                                   |
| `lastProgress`      | number         | When the chain was last seen to advance, in milliseconds                                                                                                                                                                                  |
| `observationError`  | string or null | Why the last observation failed                                                                                                                                                                                                           |
| `alerts`            | array          | What is wrong, below                                                                                                                                                                                                                      |
| `ownerTransaction`  | string or null | The hash of the casino's owner transaction in flight, or `null`: a challenge, a withdrawal, or an idle channel's close, finalization or collection                                                                                        |
| `channels`          | number         | Channels open or closing                                                                                                                                                                                                                  |
| `signingLogRecords` | number         | Records in the casino's signing history                                                                                                                                                                                                   |
| `signingLogDigest`  | string         | The digest of its last record: 64 hex digits, without `0x`                                                                                                                                                                                |
| `queueDepth`        | number         | Requests waiting in the casino's queues                                                                                                                                                                                                   |
| `chainId`           | string         | The chain                                                                                                                                                                                                                                 |
| `casino`            | address        | The contract                                                                                                                                                                                                                              |
| The books           | strings        | The books, below                                                                                                                                                                                                                          |
| `developers`        | array          | `{developer, earned, collected, outstanding}` for each developer: the commission a developer has earned, collected and still to collect                                                                                                   |
| `block`             | object or null | The last observed confirmed block: `{cash, protectedPrincipal, unpaidWinnings, operatorBalance, blockNumber, blockHash, timestamp}`, the contract's balances and the casino key's, with the block's number, hash and time in Unix seconds |
| `commit`            | string or null | The source commit the casino runs, when its deployment names one                                                                                                                                                                          |

The books. [Economics](../reference/economics.md#available-capital-and-concurrency) explains how they make the bankroll.

| Field                                  | Meaning                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `cash`                                 | Pool cash: the contract's balance                                                                                                               |
| `protectedPrincipal`, `unpaidWinnings` | The contract's [storage](../reference/contract.md#storage) of those names                                                                       |
| `activeLiabilities`                    | What open and closing channels are owed: their signed balances, and the deposits they have not taken in                                         |
| `openWinnings`                         | What open and closing channels are owed above the deposits the contract holds for them, their `principal`: winnings, which only house cash pays |
| `claimLiabilities`                     | The unpaid winnings and principal of claims: finalized closes' and withdrawals'                                                                 |
| `commissions`                          | Developer commission earned and not yet collected                                                                                               |
| `escrow`                               | Payouts awarded and not yet collected                                                                                                           |
| `banks`                                | Everything in developers' banks                                                                                                                 |
| `withdrawals`                          | Withdrawals the casino has taken on, until the chain records them or their channel's close returns them                                         |
| `houseFeesEarned`                      | The casino's own commission, in total                                                                                                           |
| `reserved`                             | The worst cases of the casino bets being decided                                                                                                |
| `equity`                               | The bankroll before reservations: what fund shares are a claim on                                                                               |
| `unreservedBankroll`                   | `equity − reserved`; it can be negative                                                                                                         |
| `bankroll`                             | `max(0, unreservedBankroll)`: what admission measures bets against                                                                              |
| `withdrawableHouse`                    | `max(0, cash − protectedPrincipal − unpaidWinnings)`, as the contract's `withdrawableHouse()`                                                   |

`alerts` lists `{severity, reason, remaining?, detail?}`: `severity` is `warning` or `critical`, `remaining` the seconds
left before a close's deadline, and `reason` one of `stale-close` (a channel is closing on an older checkpoint than the
casino holds, and the casino challenges it), `missed-deadline`, `conflicting-sequence`, `finalized-state-differs`,
`invalid-evidence`, `channel-defense-failed`, `recovery-transaction-failed`, `winnings-exceed-cash` (open channels have
won more than house cash can pay now, [as a withdrawal counts it](channels.md#post-apichannelsidoperations), so not
every winner can withdraw now), `operator-gas-low` (the key that sends challenges and withdrawals holds less than 0.01
ETH for their gas) or `withdrawal-unsent` (a withdrawal the casino took on could not be sent yet; `detail` says why). An
alert, like `observationError`, names no channel.

```json title="Response"
{
  "status": "ready",
  "lastCheck": 1790585368720,
  "stale": false,
  "lastProgress": 1790585368451,
  "observationError": null,
  "alerts": [],
  "ownerTransaction": null,
  "channels": 2,
  "signingLogRecords": 42,
  "signingLogDigest": "d882cb69589fed49bcb07553f7e002eba3a75813e49324c320cffb9562c878ad",
  "queueDepth": 0,
  "chainId": "31337",
  "casino": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "cash": "102000000000001000000",
  "protectedPrincipal": "2000000000000000000",
  "unpaidWinnings": "0",
  "activeLiabilities": "1904018503517611900",
  "openWinnings": "0",
  "claimLiabilities": "0",
  "commissions": "0",
  "escrow": "0",
  "banks": "91000000000000000",
  "withdrawals": "0",
  "houseFeesEarned": "18503517611900",
  "reserved": "0",
  "equity": "100004981496483388100",
  "unreservedBankroll": "100004981496483388100",
  "bankroll": "100004981496483388100",
  "withdrawableHouse": "100000000000001000000",
  "developers": [
    {
      "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "earned": "18503517611900",
      "collected": "18503517611900",
      "outstanding": "0"
    }
  ],
  "block": {
    "cash": "102000000000001000000",
    "protectedPrincipal": "2000000000000000000",
    "unpaidWinnings": "0",
    "operatorBalance": "9899995456193946133109",
    "blockNumber": 5,
    "blockHash": "0xbc6d2838089ec64bf4eb5d45bf46dd49a9eddc50edaa9a2c8f95e24477737b60",
    "timestamp": 1790585368
  },
  "commit": null
}
```

**Errors:** [`rate-limited`](index.md#errors) (429)

### `GET /`

The same reply as [`GET /api/status`](#get-apistatus), outside every request budget, for uptime checks.

**Auth:** none · **Idempotent:** yes

## The bankroll fund

### `GET /api/fund`

The bankroll fund's state, signed by the casino: a quote it can be held to.

**Auth:** none · **Idempotent:** yes

| Response field | Type   | Meaning                                                                                                                                                                            |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`      | Fund   | `{sequence, totalShares, houseShares, equity, overdrawn, at}`, [the `Fund` message](../reference/signed-messages.md#bankroll-fund-messages): decimal strings, `at` in Unix seconds |
| `signature`    | string | The casino's EIP-712 signature of `message`                                                                                                                                        |

```json title="Response"
{
  "message": {
    "sequence": "1",
    "totalShares": "100009981496483388100",
    "houseShares": "99999981496483388100",
    "equity": "100009981496483388100",
    "overdrawn": "0",
    "at": "1790585368"
  },
  "signature": "0x16533937683de6690ad9d7093df9b50e4d3146cf41a60ca920fd8446dcdae6ba2f2bb7b93aa6d5c46633282639fa08d8252ba8a5ce38ba1fe8eec7458d9787501b"
}
```

**Errors:** [`paused`](index.md#errors) (503), [`rate-limited`](index.md#errors) (429)

## Players and games

A player is public by their names alone: a _uname_, 24 characters the casino derives from their address and writes
`~uname`, and an _alias_ they may take, written `@alias`. A name is compared case-insensitively, with `l` and `1` read
as `i` and `0` as `o`, so no lookalike can pass for another.

### `GET /api/players`

Every player's public record, the most played first.

**Auth:** none · **Idempotent:** yes

| Query   | Type   | Meaning                                                                                             |
| ------- | ------ | --------------------------------------------------------------------------------------------------- |
| `limit` | number | How many, 1 to 500; default 100. Other values are clamped, and one that is not a number counts as 1 |

Each record is a [profile](#get-apiplayersname).

```text title="Request"
GET /api/players?limit=10
```

```json title="Response"
[
  {
    "uname": "dvfetrdww8dtgwivi4mrtrty",
    "alias": "alice",
    "since": 1790585368456,
    "stats": {
      "plays": 2,
      "staked": "2000000000000000",
      "won": "2000000000000000"
    },
    "games": []
  },
  {
    "uname": "kgs2a7nq42atyxcpifrqnw45",
    "alias": "hookedin",
    "since": 1790585368298,
    "stats": {
      "plays": 0,
      "staked": "0",
      "won": "0"
    },
    "games": [
      {
        "name": "blackjack",
        "url": "https://blackjack-game.hookedin.com/",
        "key": "0xa4a5f04dd39304e1e96cb65fe2a08306c237de7acbaa18284fc69037af1f6f4d",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "crash",
        "url": "https://crash-game.hookedin.com/",
        "key": "0x398a46cd97b5a291f9b9a9cf908b2af4cfe47d7567949f96e958d6025a12803e",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "dice",
        "url": "https://dice-game.hookedin.com/",
        "key": "0x1c610e909ab30b59687e87b9f4b639e0af4cf4e1c6250e2318d82002df54b31a",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "mines",
        "url": "https://mines-game.hookedin.com/",
        "key": "0x151243d2e0773fafed2b7c96b97191c1c4bb6b58161341339ed5680762bfd24e",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "plinko",
        "url": "https://plinko-game.hookedin.com/",
        "key": "0xde42855f3967a4d0ab4c1d07f2a4dfa587b40e591780a481734b7694db550d57",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "roulette",
        "url": "https://roulette-game.hookedin.com/",
        "key": "0xcbeeba9565065726460bfd9797d8d3b3c9b898aea88b887f10b59797b1afb185",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "samson",
        "url": "https://samson-game.hookedin.com/",
        "key": "0x8d26b589e9975e96518a3105dd2d924c645f49fad850d83e168021a0704ad6b3",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      }
    ]
  },
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
]
```

**Errors:** [`rate-limited`](index.md#errors) (429)

### `GET /api/players/:name`

One player's public record, their profile.

**Auth:** none · **Idempotent:** yes

| Path   | Type   | Meaning                              |
| ------ | ------ | ------------------------------------ |
| `name` | string | `~` and a uname, or `@` and an alias |

| Response field | Type           | Meaning                                                                                                                                                                                                                         |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`        | string         | The player's uname: 24 characters of `2`–`9` and `a`–`z` without `l` and `u`, derived from their address                                                                                                                        |
| `alias`        | string or null | The alias they took                                                                                                                                                                                                             |
| `since`        | number         | When the casino first knew them, in milliseconds                                                                                                                                                                                |
| `stats`        | object         | `{plays, staked, won}`: how many bets of theirs have settled (a number), what those bets staked and what they paid                                                                                                              |
| `games`        | array          | The games they publish, by name: `{name, url, key, developer}`, where `url` is the [game's URL](../reference/game-url.md), `key` the [game key](../reference/signed-messages.md#game-keys) and `developer` the player's address |

```json title="Response"
{
  "uname": "dvfetrdww8dtgwivi4mrtrty",
  "alias": "alice",
  "since": 1790585368456,
  "stats": {
    "plays": 2,
    "staked": "2000000000000000",
    "won": "2000000000000000"
  },
  "games": []
}
```

**Errors:** [`not-found`](index.md#errors) (404), [`rate-limited`](index.md#errors) (429)

### `GET /api/players/:name/:game`

A game a player publishes: what `@alias/game` or `~uname/game` opens in the wallet.

**Auth:** none · **Idempotent:** yes

| Path   | Type   | Meaning                                                                                                |
| ------ | ------ | ------------------------------------------------------------------------------------------------------ |
| `name` | string | `~` and a uname, or `@` and an alias                                                                   |
| `game` | string | The name the game is published under: 1 to 32 of `a-z`, `0-9` and `-`, starting with a letter or digit |

The reply is the player's names and the game's entry in their profile: `{uname, alias, name, url, key, developer}`.

```json title="Response"
{
  "uname": "8h3hh3edgejmtdp2owso4ak7",
  "alias": "studio",
  "name": "wheel",
  "url": "https://wheel.example/",
  "key": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
}
```

**Errors:** [`not-found`](index.md#errors) (404), [`rate-limited`](index.md#errors) (429)

### `GET /api/games/:key`

A game's public record: its settled bets, newest first, and their totals.

**Auth:** none · **Idempotent:** yes

A bet appears here when it settles: a player's casino bet when the casino carries it out, a developer bet when its
developer settles it, and a developer's own casino bet from its bank when the bankroll takes it. Declined bets and
reveals do not appear. Its player is their uname and alias, a developer's casino bet its developer's, never an address,
a channel or an operation ID. An unknown key answers with totals of zero and no bets.

| Path  | Type    | Meaning                                                   |
| ----- | ------- | --------------------------------------------------------- |
| `key` | bytes32 | The [game key](../reference/signed-messages.md#game-keys) |

| Query   | Type   | Meaning                                                                             |
| ------- | ------ | ----------------------------------------------------------------------------------- |
| `limit` | number | How many bets, 1 to 500; default 100, clamped as for `GET /api/players`             |
| `group` | string | Only the bets of this group, matched exactly; the totals then cover the group alone |

| Response field  | Type    | Meaning                                                                                                                           |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `key`           | bytes32 | The game, lowercase                                                                                                               |
| `developerBets` | object  | `{open, settled}`: how many of the game's developer bets, of the group if the request names one, are open and settled, as numbers |
| `totals`        | object  | `{bets, players, staked, paid, expected, priced}`, below                                                                          |
| `bets`          | array   | `{index, kind, uname, alias, group?, stake, chance?, prize?, payout, at}`, below                                                  |

The totals are the players' bets: a developer's casino bets are listed, and add up to nothing here. A total's `bets`
and `players` are numbers; `staked` and `paid` are what the bets staked and paid. `expected` is what the casino bets were
expected to pay, times 2^64 (the sum of their prizes times their chances), and `priced` is what those bets staked, so
their return is `expected / (priced × 2^64)`. A developer bet has no odds and counts in neither.

A bet's `index` is its number in the casino's record of every settled bet. `kind` is `casino`, `developer`, or `bank`
for a developer's casino bet from its bank. `stake` and `payout` are what it staked and paid, a casino bet's `chance`
and `prize` are its odds, which a developer bet has none of, and `at` is when it settled, in milliseconds.

```text title="Request"
GET /api/games/0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3?limit=10
```

```json title="Response"
{
  "key": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
  "developerBets": {
    "open": 1,
    "settled": 1
  },
  "totals": {
    "bets": 2,
    "players": 1,
    "staked": "2000000000000000",
    "paid": "2000000000000000",
    "expected": "18262276632972456098000000000000000",
    "priced": "1000000000000000"
  },
  "bets": [
    {
      "index": 2,
      "kind": "developer",
      "uname": "dvfetrdww8dtgwivi4mrtrty",
      "alias": "alice",
      "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
      "stake": "1000000000000000",
      "payout": "0",
      "at": 1790585368584
    },
    {
      "index": 1,
      "kind": "casino",
      "uname": "dvfetrdww8dtgwivi4mrtrty",
      "alias": "alice",
      "group": "hand-1",
      "stake": "1000000000000000",
      "chance": "9131138316486228049",
      "prize": "2000000000000000",
      "payout": "2000000000000000",
      "at": 1790585368499
    }
  ]
}
```

**Errors:** [`rate-limited`](index.md#errors) (429)

## Rounds and developer bets

### `GET /api/rounds/:round`

A developer's round, for anyone to check what its casino bet revealed.

**Auth:** none · **Idempotent:** yes

A round is `open` until its developer's casino bet reveals it; the revealed round shows the seed, the secret, their
outcome and the bet. A channel's own rounds are not shown here. [Rounds](../reference/signed-messages.md#rounds) says
how to check one.

| Path    | Type    | Meaning                             |
| ------- | ------- | ----------------------------------- |
| `round` | bytes32 | The round's ID, `keccak256(secret)` |

| Response field | Type    | Meaning                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | bytes32 | The round                                                                                                                                                                                                                                                                                                                   |
| `developer`    | address | The developer that opened it, lowercase                                                                                                                                                                                                                                                                                     |
| `status`       | string  | `open` or `revealed`                                                                                                                                                                                                                                                                                                        |
| `seed`         | bytes32 | Revealed: the seed the developer's casino bet brought                                                                                                                                                                                                                                                                       |
| `secret`       | bytes32 | Revealed: the casino's secret                                                                                                                                                                                                                                                                                               |
| `outcome`      | string  | Revealed: the 64-bit [outcome](../reference/signed-messages.md#the-outcome) of the seed and the secret, a decimal string                                                                                                                                                                                                    |
| `casinoBet`    | object  | Revealed: `{game, stake, chance, prize, group, meta, signature, accepted, payout?}`, the developer's casino bet as it signed it (`signature` is its `BankCasinoBet`), whether the bankroll `accepted` it, and what it paid the developer's bank when accepted. A stake, chance and prize of `0` is a reveal, never accepted |

```json title="Response"
{
  "id": "0x21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
  "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "status": "revealed",
  "seed": "0x677a5f560aadfc5627c98b34edd076d53481e76411befe62dd848cbed1fc9ed4",
  "secret": "0x54128284ebebd715b1274a0e304f9653b789d0bfeb013b428a086b1d78b0d725",
  "outcome": "12279579551977707713",
  "casinoBet": {
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "stake": "1000000000000000",
    "chance": "8974091711534376461",
    "prize": "2000000000000000",
    "group": "5b1f3d9a0c2e47f6a8d4e1b7c9f0a3d2e6b8c1f4a7d0e3b6c9f2a5d8e1b4c7f0",
    "meta": {
      "covered": "0x2b9e0f3c7a1d5e8b4f6a9c2d0e7b3f1a8c5d9e2b6f0a4c7d1e3b8f5a9c2d6e0b",
      "side": "left"
    },
    "signature": "0x4ea3a2c14eb3d6abcd9733f43d71fbac9ba458193187cae6f71427b3ca63dfab4244e9525980e79ca3ecc202e818ae0090a828e7d19bca07c271a6e832de5c971b",
    "accepted": true,
    "payout": "0"
  }
}
```

**Errors:** [`not-found`](index.md#errors) (404), [`rate-limited`](index.md#errors) (429)

### `GET /api/developer-bets/:bet`

One developer bet, by its hash.

**Auth:** none · **Idempotent:** yes

| Path  | Type    | Meaning                                                  |
| ----- | ------- | -------------------------------------------------------- |
| `bet` | bytes32 | The bet's hash: the hash of the operation that placed it |

| Response field   | Type                   | Meaning                                                                                                                           |
| ---------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bet`            | bytes32                | The bet's hash                                                                                                                    |
| `game`           | bytes32                | The game's key                                                                                                                    |
| `group`          | string                 | The group the game gave it, when it has one                                                                                       |
| `stake`          | string                 | What the player staked, paid into the developer's bank                                                                            |
| `placedAt`       | number                 | When the casino took it, in milliseconds                                                                                          |
| `developer`      | address                | The game's developer when the bet was placed, lowercase: its bank took the stake and its key settles the bet                      |
| `status`         | string                 | `open` or `settled`                                                                                                               |
| `meta`           | object                 | The game's own JSON, as the player signed it                                                                                      |
| `settlement`     | object                 | Settled: `{player, casino, signature}`, the developer's signed [`Settlement`](../reference/signed-messages.md#developer-messages) |
| `settledAt`      | number                 | Settled: when, in milliseconds                                                                                                    |
| `uname`, `alias` | string, string or null | The player's names                                                                                                                |

```json title="Response"
{
  "bet": "0x54dcdb0c1c8051ddf0b7cb98f3e2d04b97f53c2b9eaeaafdec2b7a0f198df40d",
  "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
  "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
  "stake": "1000000000000000",
  "placedAt": 1790585368544,
  "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "status": "settled",
  "meta": {
    "seedHash": "0x467bb18de40adce17a7bbde01c6cfc7ae8d1a069eae727ca981584b7869a1497",
    "pick": "red"
  },
  "settlement": {
    "player": "0",
    "casino": "0",
    "signature": "0x066e90a90dbaaa2bc844a2759a34990991530fbb6e0e5e9a31107ae1e07aaff32685d88b43d3ee09a5a61236c07bbaa192f8a845da4448ca8ae30418090272c01b"
  },
  "settledAt": 1790585368584,
  "uname": "dvfetrdww8dtgwivi4mrtrty",
  "alias": "alice"
}
```

**Errors:** [`not-found`](index.md#errors) (404), [`rate-limited`](index.md#errors) (429)

### `GET /api/developer-bets`

A page of one game's developer bets, open or settled, as its developer reads them to settle.

**Auth:** none · **Idempotent:** yes

| Query    | Type    | Meaning                                                                                                    |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `game`   | bytes32 | The game's key; required                                                                                   |
| `status` | string  | `open` (the default) or `settled`                                                                          |
| `group`  | string  | Only the bets of this group, matched exactly                                                               |
| `after`  | string  | The `cursor` of the previous page: a lowercase bet hash for open bets, a decimal position for settled ones |
| `limit`  | number  | How many, a whole number from 1 to 256; default 100                                                        |

The reply is `{bets, cursor, more}`, each bet as [`GET /api/developer-bets/:bet`](#get-apideveloper-betsbet) shows
it. Open bets come in hash order and settled ones in the order they settled; [pages](index.md#pages) says how to walk
them. A settled page's cursor is a decimal string, such as `"31000"`.

```text title="Request"
GET /api/developer-bets?game=0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3&status=open&group=21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c
```

```json title="Response"
{
  "bets": [
    {
      "bet": "0x54dcdb0c1c8051ddf0b7cb98f3e2d04b97f53c2b9eaeaafdec2b7a0f198df40d",
      "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
      "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
      "stake": "1000000000000000",
      "placedAt": 1790585368544,
      "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      "status": "open",
      "meta": {
        "seedHash": "0x467bb18de40adce17a7bbde01c6cfc7ae8d1a069eae727ca981584b7869a1497",
        "pick": "red"
      },
      "uname": "dvfetrdww8dtgwivi4mrtrty",
      "alias": "alice"
    }
  ],
  "cursor": "0x54dcdb0c1c8051ddf0b7cb98f3e2d04b97f53c2b9eaeaafdec2b7a0f198df40d",
  "more": false
}
```

**Errors:** [`invalid`](index.md#errors) (400), [`paused`](index.md#errors) (503), [`rate-limited`](index.md#errors) (429)

## Local development

### `POST /api/faucet`

Sends 2 ETH on a local Anvil chain to an address, for the wallet's demo setup.

**Auth:** none · **Idempotent:** no

The route exists only where `GET /api/config` reports `isLocalDevelopment`; elsewhere it answers `404`. It answers only
a request from the casino's own machine whose `Origin`, when there is one, is the configured wallet's (`localhost` and
`127.0.0.1` count as the same host), and takes one request a second. It pays one address at most once in 30 seconds,
and one payment at a time.

| Body field | Type    | Meaning               |
| ---------- | ------- | --------------------- |
| `address`  | address | Where to send the ETH |

| Response field | Type    | Meaning                         |
| -------------- | ------- | ------------------------------- |
| `txHash`       | bytes32 | The payment's transaction hash  |
| `amount`       | string  | `"2000000000000000000"`, in wei |

```json title="Request"
{
  "address": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
}
```

```json title="Response"
{
  "txHash": "0x00f38e8d7b196b5c7a9a522dae5089198625d45a3505e94a8fd57b42d39422e7",
  "amount": "2000000000000000000"
}
```

**Errors:** [`not-found`](index.md#errors) (404), [`unauthorized`](index.md#errors) (403), [`refused`](index.md#errors) (409), [`rate-limited`](index.md#errors) (429), [`too-large`](index.md#errors) (413)
