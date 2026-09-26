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
wallet takes nothing else on trust from this reply: it checks [the deployment it pins](../reference/deployment.md#how-the-wallet-pins-its-deployment)
on-chain and uses its own ABI.

| Response field       | Type           | Meaning                                                                                                                                 |
| -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `chainId`            | string         | `"11155111"` (Sepolia) or `"31337"` (Anvil)                                                                                             |
| `rpcUrl`             | string         | The casino's primary RPC                                                                                                                |
| `witnessRpcUrl`      | string         | Its witness RPC, on another host; absent when it has none                                                                               |
| `contractAddress`    | address        | The HookedInCasino contract                                                                                                             |
| `protocol`           | bytes32        | [`PROTOCOL`](../reference/signed-messages.md#limits-and-the-protocol-revision), the hash of everything a wallet and the casino agree on |
| `developerProtocol`  | bytes32        | `DEVELOPER_PROTOCOL`, the hash of what a developer's server and the casino agree on                                                     |
| `abi`                | array          | The contract's full ABI in ethers' JSON format (left out of the example)                                                                |
| `confirmations`      | number         | The confirmations a deposit needs: 2 on Sepolia, 1 on Anvil                                                                             |
| `operator`           | address        | The contract's owner: the casino's signing address                                                                                      |
| `clientUrl`          | string         | The wallet's origin                                                                                                                     |
| `networkName`        | string         | `"Sepolia"` or `"Anvil test chain"`                                                                                                     |
| `isLocalDevelopment` | boolean        | `true` only on a local Anvil stack that offers [the faucet](#post-apifaucet)                                                            |
| `explorerUrl`        | string or null | `"https://sepolia.etherscan.io"` on Sepolia, `null` otherwise                                                                           |
| `limits`             | object         | `{prizes, outcomeSpace, meta, group}`: [the limits](../reference/signed-messages.md#limits-and-the-protocol-revision) a bet is held to  |

```json title="Response"
{
  "chainId": "31337",
  "rpcUrl": "http://127.0.0.1:53087",
  "contractAddress": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "protocol": "0x294d7dda3e5627db5c0a15d860bba3ee061ffaac6b8ae8fb32d269c1be4ba634",
  "developerProtocol": "0x75b43323e570f68fbca2cbc10d55c441fad8a3dd0b000544def7a151a3cbbd67",
  "confirmations": 1,
  "operator": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "clientUrl": "http://127.0.0.1:4184",
  "networkName": "Anvil test chain",
  "isLocalDevelopment": false,
  "explorerUrl": null,
  "limits": {
    "prizes": 64,
    "outcomeSpace": "18446744073709551616",
    "meta": 4096,
    "group": 64
  }
}
```

**Errors:** [`rate-limited`](index.md#errors) (429)

### `GET /api/status`

The casino's health, the books of both assets, what developers have earned, the last observed block and the commit it
runs.

**Auth:** none · **Idempotent:** yes

| Response field      | Type           | Meaning                                                                                                                                                                                                              |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`            | string         | Chain observation: `starting`, `reconciling`, `ready` or `error`. The casino signs only when `ready`                                                                                                                 |
| `lastCheck`         | number         | When the last observation finished, in milliseconds                                                                                                                                                                  |
| `stale`             | boolean        | `true` when `status` is not `ready` or the last observation is more than 60 seconds old                                                                                                                              |
| `lastProgress`      | number         | When the chain was last seen to advance, in milliseconds                                                                                                                                                             |
| `observationError`  | string or null | Why the last observation failed                                                                                                                                                                                      |
| `disputes`          | object         | `{alerts, pending}`: the casino's defence of closing channels, below                                                                                                                                                 |
| `channels`          | number         | ETH channels open or closing                                                                                                                                                                                         |
| `signingLogRecords` | number         | Records in the casino's signing history                                                                                                                                                                              |
| `signingLogDigest`  | string         | The digest of its last record: 64 hex digits, without `0x`                                                                                                                                                           |
| `queueDepth`        | number         | Requests waiting in the casino's queues                                                                                                                                                                              |
| `chainId`           | string         | The chain                                                                                                                                                                                                            |
| `casino`            | address        | The contract                                                                                                                                                                                                         |
| The books           | strings        | The ETH books, below                                                                                                                                                                                                 |
| `test`              | object         | `{channels, …}`: the number of test channels and the test coins' books                                                                                                                                               |
| `developers`        | array          | `{developer, asset, earned, collected, outstanding}` for each developer and asset: the commission a developer has earned, collected and still to collect                                                             |
| `block`             | object or null | The last observed confirmed block: `{cash, protectedPrincipal, reservedWinnings, unpaidWinnings, blockNumber, blockHash, timestamp}`, the contract's balances with the block's number, hash and time in Unix seconds |
| `commit`            | string or null | The source commit the casino runs, when its deployment names one                                                                                                                                                     |

The books, in each asset. [Economics](../reference/economics.md#available-capital-and-concurrency) explains how they
make the bankroll.

| Field                                                      | Meaning                                                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cash`                                                     | Pool cash: the contract's balance; for test coins, 10,000,000 TEST plus every coin the faucet minted                                                     |
| `protectedPrincipal`, `reservedWinnings`, `unpaidWinnings` | The contract's [storage](../reference/contract.md#storage) of those names; in `test` they are `0` (`protectedPrincipal` and `unpaidWinnings` as numbers) |
| `activeLiabilities`                                        | The signed balances of open and closing channels                                                                                                         |
| `finalizedLiabilities`                                     | The unpaid winnings and principal of finalized claims                                                                                                    |
| `commissions`                                              | Developer commission earned and not yet collected                                                                                                        |
| `escrow`                                                   | Payouts awarded and not yet collected                                                                                                                    |
| `banks`                                                    | Everything in developers' banks                                                                                                                          |
| `houseFeesEarned`                                          | The casino's own commission, in total                                                                                                                    |
| `reserved`                                                 | The worst cases of the casino bets being decided                                                                                                         |
| `equity`                                                   | The bankroll before reservations: what fund shares are a claim on                                                                                        |
| `unreservedBankroll`                                       | `equity − reserved`; it can be negative                                                                                                                  |
| `bankroll`                                                 | `max(0, unreservedBankroll)`: what admission measures bets against                                                                                       |
| `houseCash`                                                | `max(0, cash − protectedPrincipal − reservedWinnings)`, as the contract's `houseCash()`                                                                  |
| `withdrawableHouse`                                        | `max(0, cash − protectedPrincipal − unpaidWinnings)`, as the contract's `withdrawableHouse()`                                                            |

`disputes.alerts` lists `{channelId?, severity, reason, remaining?, detail?}`: `severity` is `warning` or `critical`,
`remaining` the seconds left before a close's deadline, and `reason` one of `stale-close` (a channel is closing on an
older checkpoint than the casino holds, and the casino challenges it), `missed-deadline`, `conflicting-sequence`,
`finalized-state-differs`, `invalid-evidence`, `channel-defense-failed` or `recovery-transaction-failed`.
`disputes.pending` is the hash of the casino's challenge transaction in flight, or `null`.

```json title="Response"
{
  "status": "ready",
  "lastCheck": 1790384229470,
  "stale": false,
  "lastProgress": 1790384229470,
  "observationError": null,
  "disputes": {
    "alerts": [],
    "pending": null
  },
  "channels": 2,
  "signingLogRecords": 45,
  "signingLogDigest": "ea07b2f0cc5ec97a5d3753ade8cc51aaacc0624fa8307a73d0ebe390f5d15a6d",
  "queueDepth": 0,
  "chainId": "31337",
  "casino": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "cash": "102000000000001000000",
  "protectedPrincipal": "2000000000000000000",
  "reservedWinnings": "0",
  "unpaidWinnings": "0",
  "activeLiabilities": "1901918503517716823",
  "finalizedLiabilities": "0",
  "commissions": "0",
  "escrow": "0",
  "banks": "91000000000000000",
  "houseFeesEarned": "18503517716823",
  "reserved": "0",
  "equity": "100007081496483283177",
  "unreservedBankroll": "100007081496483283177",
  "bankroll": "100007081496483283177",
  "houseCash": "100000000000001000000",
  "withdrawableHouse": "100000000000001000000",
  "test": {
    "channels": 2,
    "cash": "10000200000000000000000000",
    "protectedPrincipal": 0,
    "reservedWinnings": "0",
    "unpaidWinnings": 0,
    "activeLiabilities": "200000000000000000000",
    "finalizedLiabilities": "0",
    "commissions": "0",
    "escrow": "0",
    "banks": "0",
    "houseFeesEarned": "0",
    "reserved": "0",
    "equity": "10000000000000000000000000",
    "unreservedBankroll": "10000000000000000000000000",
    "bankroll": "10000000000000000000000000",
    "houseCash": "10000200000000000000000000",
    "withdrawableHouse": "10000200000000000000000000"
  },
  "developers": [
    {
      "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "asset": "eth",
      "earned": "18503517716823",
      "collected": "18503517716823",
      "outstanding": "0"
    }
  ],
  "block": {
    "cash": "102000000000001000000",
    "protectedPrincipal": "2000000000000000000",
    "reservedWinnings": "0",
    "unpaidWinnings": "0",
    "blockNumber": 5,
    "blockHash": "0x9b42c5877f3e5b6777a69af83675786db7ca5876d479d834a7fff58c07f59724",
    "timestamp": 1790384229
  },
  "commit": null
}
```

**Errors:** [`rate-limited`](index.md#errors) (429)

### `GET /`

The same reply as [`GET /api/status`](#get-apistatus), outside every request budget, for uptime checks.

**Auth:** none · **Idempotent:** yes

### `GET /api/metrics`

The casino's health and books: the reply of [`GET /api/status`](#get-apistatus) without `developers`, `block` and
`commit`.

**Auth:** none · **Idempotent:** yes

The wallet reads `bankroll`, or `test.bankroll`, from it as a hint of what the casino can take.

```json title="Response"
{
  "status": "ready",
  "lastCheck": 1790384229470,
  "stale": false,
  "lastProgress": 1790384229470,
  "observationError": null,
  "disputes": {
    "alerts": [],
    "pending": null
  },
  "channels": 2,
  "signingLogRecords": 45,
  "signingLogDigest": "ea07b2f0cc5ec97a5d3753ade8cc51aaacc0624fa8307a73d0ebe390f5d15a6d",
  "queueDepth": 0,
  "chainId": "31337",
  "casino": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "cash": "102000000000001000000",
  "protectedPrincipal": "2000000000000000000",
  "reservedWinnings": "0",
  "unpaidWinnings": "0",
  "activeLiabilities": "1901918503517716823",
  "finalizedLiabilities": "0",
  "commissions": "0",
  "escrow": "0",
  "banks": "91000000000000000",
  "houseFeesEarned": "18503517716823",
  "reserved": "0",
  "equity": "100007081496483283177",
  "unreservedBankroll": "100007081496483283177",
  "bankroll": "100007081496483283177",
  "houseCash": "100000000000001000000",
  "withdrawableHouse": "100000000000001000000",
  "test": {
    "channels": 2,
    "cash": "10000200000000000000000000",
    "protectedPrincipal": 0,
    "reservedWinnings": "0",
    "unpaidWinnings": 0,
    "activeLiabilities": "200000000000000000000",
    "finalizedLiabilities": "0",
    "commissions": "0",
    "escrow": "0",
    "banks": "0",
    "houseFeesEarned": "0",
    "reserved": "0",
    "equity": "10000000000000000000000000",
    "unreservedBankroll": "10000000000000000000000000",
    "bankroll": "10000000000000000000000000",
    "houseCash": "10000200000000000000000000",
    "withdrawableHouse": "10000200000000000000000000"
  }
}
```

**Errors:** [`rate-limited`](index.md#errors) (429)

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
    "totalShares": "100012081496483283177",
    "houseShares": "100002081496483283177",
    "equity": "100012081496483283177",
    "overdrawn": "0",
    "at": "1790384229"
  },
  "signature": "0xab8859d0bb2978d7382b81e54c65eeccd6b4aa1b4b94a7747d8807bf3832680e307781b0e39e856f976f6d355a7296fe9ed4dc5f3d1720b75d45504adc444f161b"
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

The order counts plays in both assets together. Each record is a [profile](#get-apiplayersname).

```text title="Request"
GET /api/players?limit=10
```

```json title="Response"
[
  {
    "uname": "zi26admbshgt8yfa6xfxs97r",
    "alias": "alice",
    "since": 1790384229155,
    "stats": {
      "eth": {
        "plays": 2,
        "staked": "2000000000000000",
        "won": "0"
      },
      "test": {
        "plays": 0,
        "staked": "0",
        "won": "0"
      }
    },
    "games": []
  },
  {
    "uname": "n8n53e3qt8qrb9992eika6tv",
    "alias": "hookedin",
    "since": 1790384228471,
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
        "name": "blackjack",
        "url": "https://blackjack-game.hookedin.com/manifest.json",
        "key": "0xa4a5f04dd39304e1e96cb65fe2a08306c237de7acbaa18284fc69037af1f6f4d",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "dice",
        "url": "https://dice-game.hookedin.com/manifest.json",
        "key": "0x1c610e909ab30b59687e87b9f4b639e0af4cf4e1c6250e2318d82002df54b31a",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "mines",
        "url": "https://mines-game.hookedin.com/manifest.json",
        "key": "0x151243d2e0773fafed2b7c96b97191c1c4bb6b58161341339ed5680762bfd24e",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "plinko",
        "url": "https://plinko-game.hookedin.com/manifest.json",
        "key": "0xde42855f3967a4d0ab4c1d07f2a4dfa587b40e591780a481734b7694db550d57",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "roulette",
        "url": "https://roulette-game.hookedin.com/manifest.json",
        "key": "0xcbeeba9565065726460bfd9797d8d3b3c9b898aea88b887f10b59797b1afb185",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      },
      {
        "name": "samson",
        "url": "https://samson-game.hookedin.com/manifest.json",
        "key": "0x8d26b589e9975e96518a3105dd2d924c645f49fad850d83e168021a0704ad6b3",
        "developer": "0xcD0C778307e7D3Da6D3D23440285050f911840d4"
      }
    ]
  },
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
]
```

**Errors:** [`rate-limited`](index.md#errors) (429)

### `GET /api/players/:name`

One player's public record, their profile.

**Auth:** none · **Idempotent:** yes

| Path   | Type   | Meaning                              |
| ------ | ------ | ------------------------------------ |
| `name` | string | `~` and a uname, or `@` and an alias |

| Response field | Type           | Meaning                                                                                                                                                                                                 |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`        | string         | The player's uname: 24 characters of `2`–`9` and `a`–`z` without `l` and `u`, derived from their address                                                                                                |
| `alias`        | string or null | The alias they took                                                                                                                                                                                     |
| `since`        | number         | When the casino first knew them, in milliseconds                                                                                                                                                        |
| `stats`        | object         | `{eth, test}`, each `{plays, staked, won}`: how many bets of theirs have settled (a number), what those bets staked and what they paid                                                                  |
| `games`        | array          | The games they publish, by name: `{name, url, key, developer}`, where `url` is the manifest's URL, `key` the [game key](../reference/signed-messages.md#game-keys) and `developer` the player's address |

```json title="Response"
{
  "uname": "zi26admbshgt8yfa6xfxs97r",
  "alias": "alice",
  "since": 1790384229155,
  "stats": {
    "eth": {
      "plays": 2,
      "staked": "2000000000000000",
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
  "uname": "biop5et6ov6i5sn3c6p7vxhx",
  "alias": "studio",
  "name": "wheel",
  "url": "https://wheel.example/manifest.json",
  "key": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
  "developer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
}
```

**Errors:** [`not-found`](index.md#errors) (404), [`rate-limited`](index.md#errors) (429)

### `GET /api/games/:key`

A game's public record: its settled bets, newest first, and their totals in each asset.

**Auth:** none · **Idempotent:** yes

A bet appears here when it settles: a player's casino bet when the casino carries it out, a developer bet when its
developer settles it. Declined bets and a developer's own casino bets do not appear. Its player is their uname and
alias, never an address, a channel or an operation ID. An unknown key answers with no totals and no bets.

| Path  | Type    | Meaning                                                   |
| ----- | ------- | --------------------------------------------------------- |
| `key` | bytes32 | The [game key](../reference/signed-messages.md#game-keys) |

| Query   | Type   | Meaning                                                                             |
| ------- | ------ | ----------------------------------------------------------------------------------- |
| `limit` | number | How many bets, 1 to 500; default 100, clamped as for `GET /api/players`             |
| `group` | string | Only the bets of this group, matched exactly; the totals then cover the group alone |

| Response field  | Type    | Meaning                                                                                   |
| --------------- | ------- | ----------------------------------------------------------------------------------------- |
| `key`           | bytes32 | The game, lowercase                                                                       |
| `developerBets` | object  | `{open, settled}`: how many of the game's developer bets are open and settled, as numbers |
| `totals`        | object  | By asset, each `{bets, players, staked, paid, expected, priced}`, below                   |
| `bets`          | array   | `{index, uname, alias, group?, asset, stake, payout, expected, at}`, below                |

A total's `bets` and `players` are numbers; `staked` and `paid` are what the bets staked and paid. `expected` is what
the bets with a prize table were expected to pay, times 2^64 (the sum over their prizes of payout × range width), and
`priced` is what those bets staked, so their return is `expected / (priced × 2^64)`. A developer bet has no prize table
and counts in neither.

A bet's `index` is its number in the casino's record of every settled bet, `stake` and `payout` are what it staked and
paid, `expected` its prize table's expected payout times 2^64, or `null` for a developer bet, and `at` when it
settled, in milliseconds.

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
    "eth": {
      "bets": 2,
      "players": 1,
      "staked": "2000000000000000",
      "paid": "0",
      "expected": "18262276632972456098000000000000000",
      "priced": "1000000000000000"
    }
  },
  "bets": [
    {
      "index": 2,
      "uname": "zi26admbshgt8yfa6xfxs97r",
      "alias": "alice",
      "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
      "asset": "eth",
      "stake": "1000000000000000",
      "payout": "0",
      "expected": null,
      "at": 1790384229614
    },
    {
      "index": 1,
      "uname": "zi26admbshgt8yfa6xfxs97r",
      "alias": "alice",
      "group": "hand-1",
      "asset": "eth",
      "stake": "1000000000000000",
      "payout": "0",
      "expected": "18262276632972456098000000000000000",
      "at": 1790384229511
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

| Response field | Type    | Meaning                                                                                                                                                                                                                                         |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | bytes32 | The round                                                                                                                                                                                                                                       |
| `developer`    | address | The developer that opened it, lowercase                                                                                                                                                                                                         |
| `asset`        | string  | `eth` or `test`                                                                                                                                                                                                                                 |
| `status`       | string  | `open` or `revealed`                                                                                                                                                                                                                            |
| `seed`         | bytes32 | Revealed: the seed the developer's casino bet brought                                                                                                                                                                                           |
| `secret`       | bytes32 | Revealed: the casino's secret                                                                                                                                                                                                                   |
| `outcome`      | string  | Revealed: the 64-bit [outcome](../reference/signed-messages.md#the-outcome) of the seed and the secret, a decimal string                                                                                                                        |
| `casinoBet`    | object  | Revealed: `{game, stake, prizes, meta, signature, accepted, payout?}`, the developer's casino bet as it signed it (`signature` is its `BankCasinoBet`), whether the bankroll `accepted` it, and what it paid the developer's bank when accepted |

```json title="Response"
{
  "id": "0x21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
  "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "asset": "eth",
  "status": "revealed",
  "seed": "0x677a5f560aadfc5627c98b34edd076d53481e76411befe62dd848cbed1fc9ed4",
  "secret": "0x54128284ebebd715b1274a0e304f9653b789d0bfeb013b428a086b1d78b0d725",
  "outcome": "12279579551977707713",
  "casinoBet": {
    "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
    "stake": "1000000000000000",
    "prizes": [
      {
        "rangeStart": "0",
        "rangeEnd": "8974091711534376461",
        "payout": "2000000000000000"
      }
    ],
    "meta": {
      "covered": ["0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67"]
    },
    "signature": "0xc589853547d41893c31690f5479d2e15b6cb5ef43f5bf3e3c3de8e81cc3931d62ea510476f8041050c592144a95a4f4b99f604cee4793b0fbff84aa4261d6a491b",
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
| `asset`          | string                 | `eth` or `test`                                                                                                                   |
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
  "bet": "0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67",
  "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
  "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
  "asset": "eth",
  "stake": "1000000000000000",
  "placedAt": 1790384229582,
  "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "status": "settled",
  "meta": {
    "seedHash": "0x467bb18de40adce17a7bbde01c6cfc7ae8d1a069eae727ca981584b7869a1497",
    "pick": "red"
  },
  "settlement": {
    "player": "0",
    "casino": "0",
    "signature": "0x1c07c1a140cca0e79dbc18dd2cce9134c445d0212ac0835a49e6625ad7875d652864892203f5471e5a2b7d7dd5f91da446d010ced98da1ca878dca7ed04d91101b"
  },
  "settledAt": 1790384229614,
  "uname": "zi26admbshgt8yfa6xfxs97r",
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
them. A settled page's cursor is a decimal string, such as `"33000"`.

```text title="Request"
GET /api/developer-bets?game=0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3&status=open&group=21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c
```

```json title="Response"
{
  "bets": [
    {
      "bet": "0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67",
      "game": "0xeb732f80dafa3b2486cbd58bd5a73193b64273db4fdb48cae8b887f582fc6cf3",
      "group": "21742e7ebb87504e76dc12f5678a9d547a6639be06af6ec64e5cf010f990563c",
      "asset": "eth",
      "stake": "1000000000000000",
      "placedAt": 1790384229582,
      "developer": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      "status": "open",
      "meta": {
        "seedHash": "0x467bb18de40adce17a7bbde01c6cfc7ae8d1a069eae727ca981584b7869a1497",
        "pick": "red"
      },
      "uname": "zi26admbshgt8yfa6xfxs97r",
      "alias": "alice"
    }
  ],
  "cursor": "0x002e95e1d24b469efc1f2ac0b2b12d40c4439861bbe8200979d604cff9db8c67",
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
| `txHash`       | bytes32 | The transfer's transaction hash |
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
