---
title: Getting started
description: Open the wallet, practice with play money, deposit ETH, give a game a limit, withdraw and send.
sidebar:
  order: 1
---

The wallet at https://play.hookedin.com holds your keys and your money, and every game is played inside it. This page
takes you from a first visit to a withdrawal.

## Open the wallet

On your first visit the wallet makes a **funding account**, an Ethereum key it keeps in this browser. Until you deposit,
the wallet practices: every game plays at once with play money it keeps itself ([practice](#practice)). Practice and
the game library need nothing from the chain, so they work at once; everything with ETH waits until the wallet has
checked the casino's contract on-chain, and a banner says so if that check fails
([what the wallet checks](verify-a-release.md#what-the-wallet-checks-on-start)). Your first deposit gives the account a
**uname** such as `~3byt9ocwnnzaxanmiz3stocj` ([names](names-and-publishing.md)).

Your money is in two places:

| Place   | What it is                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance | What games play with: your channel's signed balance, backed by the ETH you deposited into the contract                                      |
| Vault   | The ETH at your funding account's address, which only your key moves. Deposits come from it, withdrawals go to it, and it pays network fees |

The top bar holds the HookedIn mark, which leads home, **Games**, **Bets**, the network, the wallet button and your
account. The wallet button shows your balance, truncated rather than rounded, and **Wallet**, or **Deposit** while you
have none; it opens [the wallet](#deposit). While a game is open it leaves the figure out, because the game shows its
own money ([practice or ETH](#practice-or-eth)). The account button opens a menu of every page: Games, Wallet, Bets,
Activity, My games, Bankroll, Settings and your Public profile.

**Settings** holds your name, your keys and the connection:

| Section          | What it holds                                                                                                                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your name        | Your uname, and an alias with **Save alias** and **Give up my alias** ([an alias](names-and-publishing.md#an-alias))                                                                                                                                                                                                         |
| Keys and backups | **Show this wallet's private key**, for a key the wallet holds; the backup passphrase, **Download encrypted backup** and **Restore a backup** ([encrypted backups](backups-and-recovery.md#encrypted-backups))                                                                                                               |
| Accounts         | Every key this browser made or imported stays saved, and **Switch** goes back to one. **Import a private key** makes that key the funding account. **Connect a browser wallet** makes an injected wallet, such as a browser extension, the funding account: it keeps its own key and approves each transaction and signature |
| Casino           | The network (Sepolia, or a local Anvil chain) and the casino API this browser uses, with **Connect**                                                                                                                                                                                                                         |

Switching accounts closes the open game. Back up every account you fund
([backups and recovery](backups-and-recovery.md)).

## Practice

1. Pick a game's tile in the library: its icon above its name.
2. Play. The strip above the game reads **Practice**, "Play money: nothing real is won or lost.", and the game shows
   each result as it would with money.

Play money is the wallet's own, kept in this tab's memory in amounts the size of the network's ETH. It starts at 10,000
of the network's recommended stakes, 0.01 ETH on Sepolia, and never runs out: a bet bigger than what is left tops it
back up first, and a game that asks for money gets it at once, without the wallet's dialog. The wallet settles a game's
casino bets and payments itself, by the casino's own rules, and signs nothing and sends the casino nothing. Nothing real
is won or lost, practice bets are in no history or record, and a reload starts again. Developer bets are placed with ETH
only, so a game built on them, such as roulette, can be watched in practice and played with ETH.

## Deposit

The **Wallet** dialog moves your money. It opens from the wallet button, from **Deposit ETH** in the library and
**Deposit** on the Wallet page, and from the ETH switch above a game while you have no balance. It shows your Balance
and your Vault, and has three tabs: **Deposit**, **Withdraw** and [**Send**](#send). **Deposit** takes two steps:

1. **Add ETH to your vault**: copy your vault's address and send ETH to it on Sepolia, from another wallet or a faucet,
   such as Google Cloud's, which the tab links to. The tab shows what has arrived, checking every 4 seconds while the
   page is visible.
2. **From your vault to your balance**: enter an amount and press **Deposit**. **Max** fills in everything except the
   0.001 ETH your vault keeps for network fees, and this deposit's fee.

Once your vault holds more than the 0.001 ETH it keeps, the tab shows the second step first.

Your first deposit is one transaction, `openChannel`, which deposits the amount and registers a fresh channel key the
wallet makes. After two confirmations on Sepolia the wallet checks the channel the contract registered and activates it
at the casino. From then on games play with ETH, a game you were practicing included, and bets need no transactions:
every bet is signed and settled off-chain, and the game shows the result the wallet checked.

A later deposit is one transaction too, `deposit`, into the open channel. Once it has its confirmations, the wallet asks
the casino to sign a deposit operation, which takes the money into your balance. Until the casino has seen the deposit
confirmed, the Wallet page shows the money as arriving, and the wallet asks again at its next check, every few seconds.
The money is yours meanwhile: a close adds whatever the balance has not taken in to what the channel is owed.

On a local Anvil chain, a wallet made in this browser offers **Add demo ETH** under **Add ETH to your vault**, which
fetches demo ETH from the local casino and deposits 1 ETH.

## Practice or ETH

While a game is open, the strip above it says what the game plays with, and switches it: **Practice** or **ETH**.
Practicing, it is amber and says "Play money: nothing real is won or lost." With ETH it says that the game plays with
your ETH up to the limit you set, or before you set one, that the game asks first, with **Set a limit** or
**Change limit** ([a game's limit](#a-games-limit)).

Without a balance you always practice, and **ETH** opens the wallet's Deposit tab ([deposit](#deposit)). An account
with a balance opens every game with ETH: **Practice** switches the game at hand to play money, and **ETH** switches it
back. Either way the game restarts to greet the other money, and its ETH limit goes back.

## A game's limit

With ETH, a game plays only with the limit you give it in the wallet's own dialog, which opens when the game asks or
when you press **Set a limit** or **Change limit**. The limit is the most the game may put at risk, out of what your
balance has taken in: money still arriving is not part of it. The money stays in your balance, a win raises the limit
and a loss lowers it, and leaving the game, reloading or closing the tab takes back whatever is left.
[Games and limits](games-and-limits.md#giving-a-game-money) explains the dialog.

## Withdraw

On the **Withdraw** tab, press **Withdraw … ETH to your vault**: your whole balance goes to your vault in one
transaction. The open game closes first. Your funding account signs the latest balance, the casino countersigns it, and
`cooperativeClose` closes the channel and pays at once: everything up to what you deposited, and your winnings as far as
the bankroll has the cash. What it cannot pay yet waits on the Wallet page under **Waiting to be paid**
([claims and collection](closing-and-claims.md#claims-and-collection)). Your balance is then 0, and your next deposit
opens a new channel.

A withdrawal needs the casino, and no operation in flight
([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)); without the casino, close from **Recovery** on
the Wallet page ([closing and claims](closing-and-claims.md)). Play money is never withdrawn: it exists only in the tab.

## Send

**Send** moves ETH from your vault to any address: enter it under **To**, an amount or **Max**, and press **Send**.
While a balance is open, your vault keeps 0.001 ETH for the fees closing it may need. Only a wallet made in this browser
has **Send**: a connected browser wallet sends by itself.

## Next

- [Games and limits](games-and-limits.md): the library, opening games, and what a game can see.
- [Bets and receipts](bets-and-receipts.md): every bet you signed, and what it paid back.
- [Backups and recovery](backups-and-recovery.md): what to keep so you can settle without the casino.
- [Trust model](../overview/trust-model.md): what the contract enforces, and what it does not.
