---
title: Getting started
description: Open the wallet, deposit ETH, give a game a limit and withdraw.
sidebar:
  order: 1
---

The wallet at https://play.hookedin.com holds your keys and your money, and every game is played inside it. This page
takes you from a first visit to a withdrawal.

## Open the wallet

On your first visit the wallet makes a **funding account**, an Ethereum key it keeps in this browser. Its address is
your **deposit address**. To play, [deposit](#deposit) ETH: on Sepolia, free test ETH from a faucet the wallet links to. The game library needs nothing
from the chain, so it works at once; everything with ETH waits until the wallet has checked the casino's contract
on-chain, and a banner says so if that check fails
([what the wallet checks](verify-a-release.md#what-the-wallet-checks-on-start)). Your first deposit gives the account a
**uname** such as `~3byt9ocwnnzaxanmiz3stocj` ([names](names-and-publishing.md)).

Your money is your **balance**: what games play with, your channel's signed balance, backed by the ETH you deposited into
the contract. The deposit address keeps 0.001 ETH besides, for the network fees of closing your balance.

The top bar holds the HookedIn mark, which leads home, **Games**, **Bets**, the network, the wallet button and your
account. The wallet button shows your balance, truncated rather than rounded, and **Wallet**, or **Deposit** while you
have none; it opens [the wallet](#deposit). While a game is open it leaves the figure out, because the game shows its
own money ([a game's limit](#a-games-limit)). The account button opens a menu of every page: Games, Wallet, Bets,
Activity, My games, Bankroll, Settings and your Public profile.

**Settings** holds your name, your keys and the connection:

| Section          | What it holds                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your name        | Your uname, and an alias with **Save alias** and **Give up my alias** ([an alias](names-and-publishing.md#an-alias))                                                                    |
| Keys and backups | **Show this wallet's private key**; the backup passphrase, **Download encrypted backup** and **Restore a backup** ([encrypted backups](backups-and-recovery.md#encrypted-backups))      |
| Accounts         | Every key this browser made or imported stays saved, and **Switch** goes back to one. **Import a private key** makes that key the funding account, and its address your deposit address |
| Casino           | The network (Sepolia, or a local Anvil chain) and the casino API this browser uses, with **Connect**                                                                                    |

Switching accounts closes the open game. Back up every account you fund
([backups and recovery](backups-and-recovery.md)).

## Deposit

The **Wallet** dialog moves your money. It opens from the wallet button, from **Deposit ETH** in the library and
**Deposit** on the Wallet page, and when a game asks for money while your balance has nothing to allow. It shows your
balance and has two tabs, **Deposit** and [**Withdraw**](#withdraw).

To deposit, send ETH on Sepolia to the address the **Deposit** tab shows, from another wallet or a faucet, such as
Google Cloud's, which the tab links to. ETH sent on another network does not arrive. The wallet checks the address every
4 seconds while the page is visible and puts what arrives into your balance by itself, keeping 0.001 ETH at the address
for network fees; the tab says what it is doing. An amount smaller than the fee of depositing it waits at the address
until more arrives.

Your first deposit is one transaction, `openChannel`, which deposits the amount and registers a fresh channel key the
wallet makes. After two confirmations on Sepolia the wallet checks the channel the contract registered and activates it at the
casino. From then on bets need no transactions: every bet is signed and settled off-chain, and the game shows the
result the wallet checked. A game you have open loads again, to save its state under your new uname.

A later deposit is one transaction too, `deposit`, into the open channel. Once it has its confirmations, the wallet asks
the casino to sign a deposit operation, which takes the money into your balance. Until the casino has seen the deposit
confirmed, the Wallet page shows the money as arriving, and the wallet asks again at its next check, every few seconds.
The money is yours meanwhile: a close adds whatever the balance has not taken in to what the channel is owed.

ETH stays at the deposit address, and the tab says so, while the casino is unavailable, while your balance is closing,
and after your last balance was closed without the casino, by you or by it
([closing and claims](closing-and-claims.md)). After such a close, what the close pays and anything sent since waits
for you to decide: **Add to balance** deposits it and opens a new balance, from which deposits go in by themselves
again, and [**Withdraw**](#withdraw) sends it elsewhere.

On a local Anvil chain the tab offers **Add demo ETH**, which fetches demo ETH from the local casino into the deposit
address.

## A game's limit

Pick a game's tile in the library to open it. A game plays only with the limit you give it in the wallet's own dialog,
which opens when the game asks. The limit is the most the game may put at risk, out of what your balance has taken in:
money still arriving is not part of it. The money stays in your balance, a win raises the limit and a loss lowers it,
and leaving the game, reloading or closing the tab takes back whatever is left.
[Games and limits](games-and-limits.md#giving-a-game-money) explains the dialog.

## Withdraw

On the **Withdraw** tab, enter the address to pay under **To** and press **Withdraw … ETH**: your whole balance goes
there in one transaction. The open game closes first. Your funding account signs the latest balance and the address,
the casino countersigns both, and `cooperativeClose` closes the channel and pays that address at once: everything up
to what you deposited, and your winnings as far as the bankroll has the cash. What it cannot pay yet is paid to the
same address later, and waits on the Wallet page under **Waiting to be paid**
([claims and collection](closing-and-claims.md#claims-and-collection)). Your balance is then 0, and your next deposit
opens a new channel. A close always pays the whole balance: to play on with part of it, deposit that part again.

With no balance open, **Withdraw** sends everything at the deposit address instead, less the network fee.

A withdrawal needs the casino, and no operation in flight
([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)); without the casino, close from **Recovery** on
the Wallet page ([closing and claims](closing-and-claims.md)).

## Next

- [Games and limits](games-and-limits.md): the library, opening games, and what a game can see.
- [Bets and receipts](bets-and-receipts.md): every bet you signed, and what it paid back.
- [Backups and recovery](backups-and-recovery.md): what to keep so you can settle without the casino.
- [Trust model](../overview/trust-model.md): what the contract enforces, and what it does not.
