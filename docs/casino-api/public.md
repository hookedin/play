---
title: Public endpoints
description: The routes anyone may call, for the deployment, health and books, the withdrawal fee, the bankroll fund, players, games' records, rounds, developer bets and demo ETH on a local stack.
sidebar:
  order: 1
---

These routes need no authentication. They say what the casino runs, how it stands, and what it has recorded in public:
players by their names, games by their keys, games' rounds and developer bets by their hashes. Nothing here names
a player's address or channel.

## The deployment and its health

### `GET /api/config`

The deployment the casino runs, the protocol revision it speaks and the bounds it holds bets to. A wallet checks
`protocol`, and a developer's server `developerProtocol`, against its own before it signs anything; the wallet takes
nothing else here on trust ([how it pins its deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment)).

| Response field       | Type           | Meaning                                                                                                                                                      |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chainId`            | string         | `"11155111"` (Sepolia) or `"31337"` (Anvil)                                                                                                                  |
| `rpcUrl`             | string         | The casino's primary RPC                                                                                                                                     |
| `witnessRpcUrl`      | string         | Its witness RPC, on another host; absent when it has none                                                                                                    |
| `contractAddress`    | address        | The HookedInCasino contract                                                                                                                                  |
| `protocol`           | bytes32        | [`PROTOCOL`](../reference/signed-messages.md#bounds-and-the-protocol-revision), the hash of everything a wallet and the casino agree on                      |
| `developerProtocol`  | bytes32        | `DEVELOPER_PROTOCOL`, the hash of what a developer's server and the casino agree on                                                                          |
| `operator`           | address        | The contract's owner: the casino's signing address                                                                                                           |
| `networkName`        | string         | `"Sepolia"` or `"Anvil test chain"`                                                                                                                          |
| `isLocalDevelopment` | boolean        | `true` only on a local stack that offers [demo ETH](#post-apidemo-eth)                                                                                       |
| `explorerUrl`        | string or null | `"https://sepolia.etherscan.io"` on Sepolia, `null` otherwise                                                                                                |
| `bounds`             | object         | `{outcomeSpace, meta, group}`: [the bounds](../reference/signed-messages.md#bounds-and-the-protocol-revision) a bet is held to                               |
| `collateralRate`     | string         | What [collateral](../reference/signed-messages.md#collateral-offers) costs, in millionths of its amount, once                                                |
| `depositFeeLimit`    | string         | The most network fee the casino [pays](channels.md#post-apichannelsidoperations) of a deposit, in millionths of the deposit, as far as its daily budget goes |
| `discord`            | string or null | The invite to the HookedIn Discord, where players [verify their Discord accounts](channels.md#verifying-a-discord-account); `null` where there is none       |

### `GET /api/status`

The casino's health, its books, the last observed block and the commit it runs.

| Response field     | Type           | Meaning                                                                                                                                 |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `status`           | string         | Chain observation: `starting`, `reconciling`, `ready` or `error`. The casino signs only when `ready`                                    |
| `lastCheck`        | number         | When the last observation finished                                                                                                      |
| `stale`            | boolean        | `true` when `status` is not `ready` or the last observation is more than 60 seconds old                                                 |
| `lastProgress`     | number         | When the chain was last seen to advance                                                                                                 |
| `observationError` | string or null | Why the last observation failed                                                                                                         |
| `alerts`           | array          | What is wrong, below                                                                                                                    |
| `ownerTransaction` | string or null | The hash of the casino's owner transaction in flight: a challenge, a withdrawal, or an idle channel's close, finalization or collection |
| `channels`         | number         | Channels active or closing                                                                                                              |
| `signingLogDigest` | bytes32        | The digest of the last record in the casino's signing history                                                                           |
| `queueDepth`       | number         | Requests waiting in the casino's queues                                                                                                 |
| `block`            | object or null | The last confirmed block the casino observed, `{number, hash, timestamp}`                                                               |
| The books          | strings        | Below                                                                                                                                   |
| `commit`           | string or null | The source commit the casino runs, when its deployment names one                                                                        |

The books. [Economics](../reference/economics.md#available-capital-and-concurrency) explains how they make the bankroll.

| Field                              | Meaning                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `cash`                             | Pool cash: the contract's balance                                                                                                             |
| `protectedFunds`, `unpaidWinnings` | The contract's [storage](../reference/contract.md#storage) of those names                                                                     |
| `activeLiabilities`                | What active and closing channels are owed: their signed balances and the deposits they have not taken in                                      |
| `openWinnings`                     | What active and closing channels are owed above the deposits and collateral the contract holds for them: winnings, which only house cash pays |
| `collateral`                       | The [collateral](../reference/contract.md#collateral) active and closing channels hold, which pays their winnings before house cash           |
| `collateralSales`                  | What collateral has sold for, the contract's `collateralSales`: the bankroll's, as commission is                                              |
| `claimLiabilities`                 | The unpaid winnings and protected amounts of claims: finalized closes' and withdrawals'                                                       |
| `escrow`                           | Payouts awarded and not yet collected                                                                                                         |
| `banks`                            | Everything in games' banks                                                                                                                    |
| `withdrawals`                      | Withdrawals the casino has taken on, until the chain records them or their channel's close returns them                                       |
| `houseFeesEarned`                  | The casino's own commission, in total                                                                                                         |
| `reserved`                         | The worst cases of casino bets being decided, plus disputed closes' possible payouts above obligations already in the books                   |
| `equity`                           | The bankroll before reservations: what fund shares are a claim on                                                                             |
| `unreservedBankroll`               | `equity − reserved`; it can be negative                                                                                                       |
| `bankroll`                         | `max(0, unreservedBankroll)`: the betting bankroll                                                                                            |
| `virtualBankroll`                  | `bankroll / 2`, rounded down: what the casino's quotes admit casino bets against, and a game's casino bet is admitted against                 |
| `withdrawableHouse`                | `max(0, cash − protectedFunds − unpaidWinnings)`, as the contract's `withdrawableHouse()`                                                     |

`alerts` lists `{severity, reason, remaining?, detail?}`: `severity` is `warning` or `critical`, `remaining` the seconds
left before a close's deadline, and `reason` one of `stale-close` (a channel is closing on an older checkpoint than the
casino holds, and the casino challenges it), `disputed-bet` (a close disputes a casino bet, and the casino settles it
with its result), `dispute-unsettled` (the casino could not settle a disputed bet; `detail` says why),
`missed-deadline`, `conflicting-sequence`, `finalized-state-differs`, `invalid-evidence`, `channel-defense-failed`,
`recovery-transaction-failed`, `winnings-exceed-cash` (active channels have
won more than house cash can pay now, [as a withdrawal counts it](channels.md#post-apichannelsidoperations), so not
every winner can withdraw now), `operator-gas-low` (the key that sends challenges and withdrawals holds less than 0.01
ETH for their gas) or `withdrawal-unsent` (a withdrawal the casino took on could not be sent yet; `detail` says why). An
alert, like `observationError`, names no channel.

### `GET /api/withdrawal-fee`

What a withdrawal or a lock-in pays the casino for sending it to the contract, `{fee}`, in wei as a decimal string:
150,000 gas (`WITHDRAWAL_GAS`), about what sending one costs, at the network's gas price, which the casino reads and
holds for a minute. The casino declines an operation whose `fee` is below what it pays
([operations](channels.md#post-apichannelsidoperations)). `paused` answers while the gas price cannot be read.

## The bankroll fund

### `GET /api/fund`

The bankroll fund's state, signed by the casino: a quote it can be held to. The reply is `{message, signature}`:
`message` is [the `Fund` message](../reference/signed-messages.md#bankroll-fund-messages),
`{sequence, totalShares, houseShares, equity, overdrawn, at}`, and `signature` the casino's EIP-712 signature of it.

## Players and games

A player is public by their names alone, a `~uname` and a Discord username, `@username`, compared as names are told
apart ([your name](../wallet/getting-started.md#your-name)): two that read alike are one name.

### `GET /api/players`

Every player's [profile](#get-apiplayersname), the most played first. `limit` is how many, 1 to 500 and 100 by default;
other values are clamped, and one that is not a number counts as 1.

### `GET /api/players/:name`

One player's profile; `:name` is `~` and a uname or `@` and a Discord username.

| Response field    | Type           | Meaning                                                                                                                                                                                                                                                                                   |
| ----------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uname`           | string         | The player's [uname](../reference/signed-messages.md#counterparties), derived from their address                                                                                                                                                                                          |
| `discordUsername` | string or null | The username of the Discord account that verified them; `null` when none did. The house's, `hookedin`, is the casino's to give                                                                                                                                                            |
| `discordVerified` | number or null | When they last verified their Discord account; `null` when none did, and for the house                                                                                                                                                                                                    |
| `stats`           | object         | `{plays, net}`: how many bets of theirs have settled (a number), their bets in one game and group counting once, as the steps of a round, and what their bets paid less what they staked, signed                                                                                          |
| `createdAt`       | number         | When the casino met them: their first channel's registration, their Discord username or their first published game                                                                                                                                                                        |
| `games`           | array          | The games they publish, by name: `{name, url, key, developer, createdAt}`, where `url` is the [game's URL](../games/publishing.md#the-games-url), `key` the [game key](../reference/signed-messages.md#game-keys), `developer` the player's address and `createdAt` when it was published |

### `GET /api/players/:name/:game`

A game a player publishes, which `@username/game` or `~uname/game` opens in the wallet: the player's names and the game's
entry in their profile, `{uname, discordUsername, name, url, key, developer, createdAt}`. `:game` is the name it is published under.

### `GET /api/games/:key`

A game's public record, by its [game key](../reference/signed-messages.md#game-keys): what its bank holds, its settled
bets, newest first, and their totals. A bet appears when it settles: a player's casino bet when the casino carries it
out, a developer bet when the game's server settles it, and the game's own casino bet from its bank when the bankroll
takes it. Declined bets and reveals do not appear. An unknown key answers with a bank and totals of zero and no bets.

| Query   | Type   | Meaning                                                                 |
| ------- | ------ | ----------------------------------------------------------------------- |
| `limit` | number | How many bets, 1 to 500; default 100, clamped as for `GET /api/players` |

| Response field  | Type    | Meaning                                                                                 |
| --------------- | ------- | --------------------------------------------------------------------------------------- |
| `key`           | bytes32 | The game, lowercase                                                                     |
| `bank`          | string  | What the game's bank holds now: nothing for a game nobody published                     |
| `developerBets` | object  | `{open, settled}`: how many of the game's developer bets are open and settled           |
| `totals`        | object  | `{bets, staked, paid, expected, priced, earned}`, below                                 |
| `bets`          | array   | `{id, kind, uname, discordUsername, group?, stake, chance?, prize?, payout, at}`, below |

The totals are the players' bets: the game's own casino bets are listed, and add up to nothing here. `bets` is a number,
the bets of one player in one group counting once, as the steps of a round; `staked` and `paid` are what every bet
staked and paid, a round's steps each on its own, so only `paid − staked` is what the players came out with. `expected` is what the casino bets were expected to pay, times
2^64 (the sum of their prizes times their chances), and `priced` is what those bets staked, so their return is
`expected / (priced × 2^64)`. A developer bet has no odds and counts in neither. `earned` is what the game's bank took
of their [commission](../games/publishing.md#earnings), its own casino bets' included.

The bets are the latest settled, newest first. A bet's `id` is a UUIDv7, the ID of the casino's record that placed it:
it says when the bet was placed and nothing of how many bets there are. `kind` is `casino`, `developer`, or `bank` for
the game's casino bet from its bank. Its player is their `uname` and `discordUsername`, the game's casino bet its
developer's. `stake` and `payout` are what it staked and paid, a casino bet's `chance` and `prize` are its odds, and
`at` is when it settled.

## Rounds and developer bets

### `GET /api/rounds/:round`

A game's round, `keccak256(secret)`, for anyone to check what its casino bet revealed
([rounds](../reference/signed-messages.md#rounds)). It is `open` until the game's casino bet reveals it. A channel's own
rounds are not shown here.

| Response field | Type    | Meaning                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | bytes32 | The round                                                                                                                                                                                                                                                                                                                 |
| `game`         | bytes32 | The game it was opened for                                                                                                                                                                                                                                                                                                |
| `createdAt`    | number  | When the game's server opened it                                                                                                                                                                                                                                                                                          |
| `status`       | string  | `open` or `revealed`                                                                                                                                                                                                                                                                                                      |
| `seed`         | bytes32 | Revealed: the seed the game's casino bet brought                                                                                                                                                                                                                                                                          |
| `secret`       | bytes32 | Revealed: the casino's secret                                                                                                                                                                                                                                                                                             |
| `outcome`      | string  | Revealed: the 64-bit [outcome](../reference/signed-messages.md#the-outcome) of the seed and the secret, a decimal string                                                                                                                                                                                                  |
| `casinoBet`    | object  | Revealed: `{game, stake, chance, prize, group, meta, signature, accepted, payout?}`, the game's casino bet as its server signed it (`signature` is its `BankCasinoBet`), whether the bankroll `accepted` it, and what it paid the game's bank when accepted. A stake, chance and prize of `0` is a reveal, never accepted |

### `GET /api/developer-bets/:bet`

One developer bet, by its hash: the hash of the operation that placed it.

| Response field             | Type                   | Meaning                                                                                                                                                                                                                                                                                    |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bet`                      | bytes32                | The bet's hash                                                                                                                                                                                                                                                                             |
| `game`                     | bytes32                | The game's key                                                                                                                                                                                                                                                                             |
| `group`                    | string                 | The group the game gave it, when it has one                                                                                                                                                                                                                                                |
| `stake`                    | string                 | What the player staked, paid into the game's bank                                                                                                                                                                                                                                          |
| `placedAt`                 | number                 | When the casino took it                                                                                                                                                                                                                                                                    |
| `status`                   | string                 | `open` or `settled`                                                                                                                                                                                                                                                                        |
| `meta`                     | object                 | The game's own JSON, as the player signed it                                                                                                                                                                                                                                               |
| `settlement`               | object                 | Settled: `{player, casino, signature, server?}`, the [`Settlement`](../reference/signed-messages.md#developer-messages) the game's server signed, and `server`, the developer's signed `GameServer` naming that server as `{message, signature}`, unless the developer's own key signed it |
| `settledAt`                | number                 | Settled: when                                                                                                                                                                                                                                                                              |
| `uname`, `discordUsername` | string, string or null | The player's names                                                                                                                                                                                                                                                                         |

### `GET /api/developer-bets`

A page of one game's developer bets, open or settled, as its server reads them to settle: `{bets, cursor, more}`
([pages](index.md#pages)), each bet as [`GET /api/developer-bets/:bet`](#get-apideveloper-betsbet) shows it.

The game's server can `wait` for open bets, with [developer access](index.md#authentication): a page with none is held
until a bet on the game is placed, the time is up, or another wait on the same game begins, and then read again. A game
has one wait at a time, a server's key at most 4, and the casino 128 ([budgets](index.md#budgets-and-queues)). Only a
published game is waited for: a server whose game is taken down reads its bets without waiting. A server follows its
game's bets by waiting again with each page's `cursor`.

| Query    | Type    | Meaning                                                                                |
| -------- | ------- | -------------------------------------------------------------------------------------- |
| `game`   | bytes32 | The game's key; required                                                               |
| `status` | string  | `open` (the default) or `settled`                                                      |
| `group`  | string  | Only the bets of this group, matched exactly                                           |
| `after`  | string  | The `cursor` of the previous page: the ID of its last bet                              |
| `limit`  | number  | How many, a whole number from 1 to 256; default 100                                    |
| `wait`   | number  | Open bets only: how many seconds to hold a page with none, a whole number from 1 to 25 |

`invalid` answers a missing or malformed key, status, cursor, limit or wait, and a cursor that names no bet, or for
settled bets no settled bet. `unauthorized` answers a wait without the access of the published game's server, and `busy` one too many.

## Local development

### `POST /api/demo-eth`

Sends 2,000,000 METH on a local Anvil chain to `address`, one payment at a time, for the wallet's demo setup, and answers
`{txHash, amount}`. The route exists only where `GET /api/config` reports `isLocalDevelopment`; elsewhere it answers
`404` `not-found`. A request while another is being paid is `refused`.
