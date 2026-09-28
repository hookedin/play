---
title: Getting started
description: Open the wallet, deposit ETH, give a game a limit and withdraw.
sidebar:
  order: 1
---

The wallet at https://play.hookedin.com holds your keys and your money, and every game is played inside it. This page
takes you from a first visit to a withdrawal.

## Open the wallet

On your first visit the wallet makes your **account**, an Ethereum key it keeps in this browser, which signs everything
you do with your money. Its address is your **deposit address**. To play, [deposit](#deposit) ETH: on Sepolia, free test
ETH from a faucet the wallet links to, or have a player put some into your balance from theirs ([withdraw](#withdraw)).
The game library needs nothing from the chain, so it works at once; everything with ETH waits until the wallet has
checked the casino's contract on-chain, and a banner says so if that check fails
([what the wallet checks](verify-a-release.md#what-the-wallet-checks-on-start)). Your first deposit gives the account a
**uname** such as `~3byt9ocwnnzaxanmiz3stocj` ([names](names-and-publishing.md)).

Your money is your **balance**: what games play with, your channel's signed balance. The contract holds your deposits
for it; what you win above them is a claim on the shared bankroll, which **Lock in my balance** makes deposits too
([lock in your balance](closing-and-claims.md#lock-in-your-balance)).

The top bar holds the HookedIn mark, which leads home, **Games**, **Bets**, the network, the wallet button and your
account. The wallet button shows your balance, truncated rather than rounded, and **Wallet**, or **Deposit** while you
have none; it opens [the wallet](#deposit). While a game is open it leaves the figure out, because the game shows its
own money ([a game's limit](#a-games-limit)). The account button opens a menu of every page: Games, Wallet, Bets,
Activity, My games, Bankroll, Settings and your Public profile.

**Settings** holds your name, how deposits go in, your keys and the connection:

| Section          | What it holds                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your name        | Your uname, and an alias with **Save alias** and **Give up my alias** ([an alias](names-and-publishing.md#an-alias))                                                               |
| Deposits         | **Add ETH that arrives at my deposit address to my balance**, on unless you turn it off ([deposit](#deposit))                                                                      |
| Keys and backups | **Show this wallet's private key**; the backup passphrase, **Download encrypted backup** and **Restore a backup** ([encrypted backups](backups-and-recovery.md#encrypted-backups)) |
| Accounts         | Every key this browser made or imported stays saved, and **Switch** goes back to one. **Import a private key** makes that key your account, and its address your deposit address   |
| Casino           | The network (Sepolia, or a local Anvil chain) and the casino API this browser uses, with **Connect**                                                                               |

Switching accounts closes the open game. Back up every account you fund
([backups and recovery](backups-and-recovery.md)).

## Deposit

The **Wallet** dialog moves your money. It opens from the wallet button, from **Deposit ETH** in the library and
**Deposit** on the Wallet page, and when a game asks for money while your balance has nothing to allow. It shows your
balance and has two tabs, **Deposit** and [**Withdraw**](#withdraw).

To deposit, send ETH on Sepolia to the address the **Deposit** tab shows, from another wallet or a faucet, such as
Google Cloud's, which the tab links to. ETH sent on another network does not arrive. The wallet checks the address every
4 seconds while the page is visible and puts everything that arrives into your balance by itself, less the network fee
of adding it; the tab says what it is doing. An amount smaller than the fee of depositing it waits at the address until
more arrives.

Each deposit is one transaction, `deposit`, into your account's channel, and your first opens it. After two
confirmations on Sepolia the wallet registers the channel with the casino. From then on bets need no transactions: every
bet is signed and settled off-chain, and the game shows the result the wallet checked. A game you have open loads again,
to save its state under your new uname.

Once a deposit has its confirmations, the wallet asks the casino to sign a deposit operation, which takes the money into
your balance. Until the casino has seen the deposit confirmed, the Wallet page shows the money as arriving, and the
wallet asks again at its next check, every few seconds. The money is yours meanwhile: a close adds whatever the balance
has not taken in to what the channel is owed. Anyone can deposit into your channel through the contract, naming your
deposit address, and another player can put money from their balance into yours ([withdraw](#withdraw)): the wallet
takes it in the same way.

Under **Deposits** in Settings, **Add ETH that arrives at my deposit address to my balance** is on unless you turn it
off. Off, what arrives stays at the address, to pay for transactions your account sends itself, such as closing without
the casino, and the Deposit tab offers **Add to balance**, which adds it all, less the network fee.

ETH also stays at the deposit address, and the tab says so, while the casino is unavailable, and from the start of a
close until your next balance opens ([closing and claims](closing-and-claims.md)). What the close pays and anything sent
since then waits for you to decide: **Add to balance** deposits it and opens your next balance, from which deposits go
in by themselves again, and [**Withdraw**](#withdraw) sends it elsewhere.

On a local Anvil chain the tab offers **Add demo ETH**, which fetches demo ETH from the local casino into the deposit
address.

## A game's limit

Pick a game's tile in the library to open it. A game plays only with the limit you give it in the wallet's own dialog,
which opens when the game asks. The limit is the most the game may put at risk, out of what your balance has taken in:
money still arriving is not part of it. The money stays in your balance, a win raises the limit and a loss lowers it,
and leaving the game, reloading or closing the tab takes back whatever is left.
[Games and limits](games-and-limits.md#giving-a-game-money) explains the dialog.

## Withdraw

On the **Withdraw** tab, enter how much under **Amount (ETH)**, or leave it empty for all of it, enter the address to
pay under **To**, and press **Withdraw … ETH**. Your account signs a withdrawal of that amount to that address, and the
casino signs your balance after it at once: your balance pays it now, and you play on with the rest. The casino then has
the contract pay the address, out of your deposits first and the bankroll for the rest. Withdrawing all of it closes the
open game first; withdrawing part lowers the open game's limit to what stays, if it held more.

Tick **Put it into that account's HookedIn balance** to give the amount to another player instead: the button reads
**Put … ETH into their balance**, and the contract deposits it into their balance, opening one if they have none. To
bring a friend in, enter their deposit address: they can play with no ETH of their own.

[Activity](bets-and-receipts.md#activity) shows the withdrawal as **Withdrawal on its way** until the contract has paid
it, and then as **Withdrawn**. Your wallet keeps the proof the contract pays on, anyone can look up the payment on-chain
by the withdrawal's ID, and one that waits for the bankroll's cash can be sent again with **Pay it now**
([withdraw](closing-and-claims.md#withdraw)).

The casino takes a withdrawal on only when the contract can pay all of it now, beside the other withdrawals it owes.
Otherwise it declines it and says how much can be withdrawn now, and your balance is as it was. It also declines a
withdrawal to an address that does not accept a payment from the contract.

With no balance open, **Withdraw** sends everything at the deposit address instead, less the network fee.

A withdrawal needs the casino, and no operation in flight
([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)); without the casino, close from **Recovery** on
the Wallet page ([closing and claims](closing-and-claims.md)).

## Next

- [Games and limits](games-and-limits.md): the library, opening games, and what a game can see.
- [Bets and receipts](bets-and-receipts.md): every bet you signed, and what it paid back.
- [Backups and recovery](backups-and-recovery.md): what to keep so you can settle without the casino.
- [Trust model](../overview/trust-model.md): what the contract enforces, and what it does not.
