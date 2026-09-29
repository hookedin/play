---
title: Glossary
description: Every term the documentation uses, in a sentence or two, with the page that explains it.
sidebar:
  order: 8
---

### Access token

A short-lived signature that authenticates a request to the casino: `Access` by an account for its channel's routes,
`DeveloperAccess` by a developer for a developer's. See [access tokens](signed-messages.md#access-tokens).

### Account

A player's Ethereum account, whose address is their [deposit address](#deposit-address) and whose key the wallet holds.
It is its channel's `player`, and its key signs everything on the channel: operations, checkpoints and access tokens.
See [the two keys of a channel](contract.md#the-two-keys-of-a-channel).

### Acknowledgment

The player's countersignature of the latest checkpoint, carried by the channel's next request. The casino takes no new
operation until it has the last one acknowledged.

### Admission

The casino's decision to take a casino bet: the bankroll must be able to take it with no commission at all, by the exact
Kelly condition for its two outcomes. See [economics](economics.md).

### Alias

A name a player may take while they have a balance open, written `@Bob`, and be shown by instead of their uname. See
[names and publishing](../wallet/names-and-publishing.md).

### Balance

What games play with: the signed balance of a player's channel, and any deposit on its way into it. See
[getting started](../wallet/getting-started.md).

### Bank

A developer's balance at the casino that takes the stakes of its games' developer bets and pays their settlements and
its casino bets. It reserves nothing. See [developer bets](../games/developer-bets.md).

### Bankroll

The casino's money for backing casino bets, after every obligation. See
[the bankroll and commission](../overview/how-it-works.md#the-bankroll-and-commission).

### Bankroll fund

Shares of the bankroll that anyone with a balance can buy and sell back at the bankroll's own price. A share is a
statement the casino signs. See [the bankroll fund](../wallet/bankroll-fund.md).

### Base

The checkpoint a channel starts from, zero but for its channel ID. It needs no signature: every other checkpoint that
settles is signed by both sides. See [the base](signed-messages.md#the-base).

### Binary steps

How the bankroll backs a game whose players share one draw, such as roulette: its developer walks a balanced tree over
the draw's outcomes, one casino bet from its bank on each level, each on its own round. See
[developer bets](../games/developer-bets.md).

### Bridge

The `postMessage` protocol between a game's frame and the wallet. See [the game bridge](bridge.md).

### Casino bet

A stake, a chance and a prize: the bet pays its prize when its round's outcome is below its chance. It is settled
against the bankroll in the request that places it. See [casino bets](../games/casino-bets.md).

### Challenge

Replacing a closing channel's state with strictly newer evidence before the fixed 24-hour deadline. See
[closing and claims](../wallet/closing-and-claims.md).

### Chance

How many of the 2^64 outcomes win a casino bet, from 1 to 2^64 − 1: the bet wins when the outcome is below it.

### Channel

A running balance between a player's account and the casino, backed on-chain by the deposits the contract holds for it,
its [principal](#principal), and by the shared bankroll above them. An account plays on one at a time, which stays open
through every withdrawal until a close starts; its next deposit then opens the next. See
[channels](../overview/how-it-works.md#channels).

### Checkpoint

A channel's state at a sequence number: the hash of the state before it, the hash of what led to it, the balance, how
much of the channel's deposits the balance has taken in, and how much it has paid out in withdrawals. The casino signs
each; the player countersigns.

### Claim

What the contract owes on-chain: a finalized channel's close, under the channel's ID, or a withdrawal, under its own.
Its principal comes out of the channel's [principal](#principal), and its winnings above it are paid first in, first
out. See [closing and claims](../wallet/closing-and-claims.md).

### Collapse

How a single-player game plays a step with more than two outcomes: the page draws, with its own randomness, one of the
step's _branches_, a casino bet between two of its outcomes or no bet, so that every outcome is reached exactly as often
as the game's rules say. See [collapsing bets](../games/collapsing-bets.md).

### Commission

The edge a casino bet carries beyond what the bankroll needs, split equally between the game's developer and the
casino. It is accounting, never a second debit. See [earnings](../games/earnings.md).

### Counterparty

What a debit pays into or a credit collects from: the bankroll fund, a developer's bank, the developer earnings, or a
developer bet. See [counterparties](signed-messages.md#counterparties).

### Deposit

ETH paid into an account's current channel with the contract's `deposit`, by anyone: the wallet deposits by itself the
ETH that arrives at the deposit address. The account's first deposit opens its channel, and once a close starts, its
next deposit opens the next. The balance takes each deposit in with a deposit operation, kind 4, once the casino has
seen it confirmed. See [getting started](../wallet/getting-started.md#deposit).

### Deposit address

The address of a player's account, where they send ETH to play. The wallet puts all that arrives into their balance,
less the network fee of adding it; with the Deposits setting off, it stays there, to pay for transactions the account
sends itself. See [getting started](../wallet/getting-started.md#deposit).

### Details

What an operation means, `{id, game?, group?, counterparty?, meta?}`, whose hash the operation signs as its memo. See
[details and memo](signed-messages.md#details-and-memo).

### Developer

The account that publishes a game. It earns the game's commission, and its bank and key take and settle the game's
developer bets.

### Developer bet

A bet against a game's developer instead of the bankroll: its stake goes into the developer's bank at once, and it is
paid what the developer's signed settlement says. See [developer bets](../games/developer-bets.md).

### Developer earnings

The developer's half of the commission on its games' casino bets, owed to its address and collected into a channel of
its own. See [earnings](../games/earnings.md).

### Evidence

The proof of a channel's state that settles it on-chain, or records a withdrawal: the channel's [base](#base) or a
jointly signed checkpoint, alone or with a step after it. See [evidence](signed-messages.md#evidence).

### Game key

A game's identity, `keccak256(abi.encode(developer, name))`, the same wherever the game is served. See
[game keys](signed-messages.md#game-keys).

### Game URL

The page the wallet frames: a game is its URL. A published game is at the URL its profile records; a game opened by its
URL alone is published by nobody. See [game URL](game-url.md).

### Group

A label of up to 64 characters that ties a game's bets and payments together, such as the steps of one hand or the bets
of one spin. The player signs it, and bet history shows a group as one row.

### Icon

`icon.svg` beside a game's page: the square tile the wallet shows the game by. See [the icon](game-url.md#the-icon).

### Lock in

A [withdrawal](#withdraw) of the whole balance to the contract itself, which the wallet's **Lock in my balance** asks
for: the channel's [principal](#principal) pays back what it covers and house cash the rest, the winnings, and all of it
goes into the account's channel as deposits the contract holds. See [withdrawals](contract.md#withdrawals).

### Meta

A developer bet's own JSON object, saying what the bet is, or a developer's casino bet's. Whoever places the bet signs
it; the casino keeps it and never reads it.

### Operation

A signed change to a channel's balance: a casino bet, a debit, a credit, a deposit or a withdrawal. See
[channels](../overview/how-it-works.md#channels).

### Operation ID

The name an operation is known by, from which a retry finds it again; a game's is scoped to its player and game. See
[operation IDs](signed-messages.md#operation-ids).

### Outcome

A round's 64-bit number, from its secret and its seed. A casino bet on the round wins when the outcome is below its
chance. See [the outcome](signed-messages.md#the-outcome).

### Payment

A debit a game asks for to the bankroll: a fixed amount, on no round, with no commission. See
[payments](../overview/how-it-works.md#payments).

### Principal

The deposits the contract holds for a channel, its `principal`: every deposit as it arrives, less what withdrawals took
of them. The owner cannot withdraw it; withdrawals are paid out of it first, and a close's claim is protected principal
up to it. See [withdrawals](contract.md#withdrawals).

### Prize

What a casino bet pays when it wins. The stake was paid to enter, so a win gains the prize less the stake.

### Receipt

What the wallet keeps of an operation, and the one reply a game gets about it: its kind, its status and what it paid.
See [the receipt](bridge.md#receipt).

### Rejection

The casino's signed refusal of an operation: a checkpoint two above its base with the balance unchanged. A declined
casino bet's round is revealed with it. See [rejection checkpoints](signed-messages.md#rejection-checkpoints).

### Reveal

A developer's casino bet whose stake, chance and prize are all zero: it bets nothing and only reveals its round, and is
signed, grouped and kept like any other. See [developer messages](signed-messages.md#developer-messages).

### Round

What settles a casino bet: named by the hash of the casino's secret before the seed is picked, and revealed when its bet
settles or is declined. See [rounds](../overview/how-it-works.md#rounds).

### Secret

The casino's random value behind a round; the round is named by its hash.

### Seed

The random value behind a casino bet's other half: the wallet's for a player's bet, the developer's for a developer's
casino bet. The bet signs its hash and brings it, so the casino, which fixed its secret when it named the round, sees
the seed only after the round is fixed.

### Settlement

A developer's signed statement of what a developer bet pays its player and gives the casino, from the developer's bank.

### Spending limit

The ETH the open game may play with in the tab, which the player allows in the wallet's own dialog. It signs nothing and
is released when the game closes. See [games and limits](../wallet/games-and-limits.md).

### Stake

What a bet pays to enter.

### Uname

The name the casino derives for every player from an address it never publishes, written `~3byt9ocwnnzaxanmiz3stocj`.
See [names and publishing](../wallet/names-and-publishing.md).

### Watchtower

A process that watches one channel from its exported evidence and challenges a stale close. See
[backups and recovery](../wallet/backups-and-recovery.md).

### Withdraw

Moving part or all of the balance to an address the player names: an operation, kind 5, naming the address, which the
balance pays at once. Another account's address puts it into that account's balance. The contract makes it a
[claim](#claim) under the withdrawal's ID, the hash of the operation, when anyone sends the operation and the casino's
signature of the balance after it, as the casino does straight away, and pays at once what the channel's
[principal](#principal) and house cash cover. The channel stays open with the rest. See
[getting started](../wallet/getting-started.md#withdraw).
