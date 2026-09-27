---
title: Getting started
description: Open the wallet, practice with play money, play with ETH, give a game money and withdraw.
sidebar:
  order: 1
---

The wallet at https://play.hookedin.com holds your keys and your channels, and every game is played inside it. This page
takes you from a first visit to a withdrawal.

## Open the wallet

On your first visit the wallet generates a **funding account**, an Ethereum key it keeps in this browser. Until you open
a funded channel, the wallet practices: every game plays at once with play money it keeps itself
([practice](#practice)). Practice and the game library need nothing from the chain, so they work at once; everything
with ETH waits until the wallet has checked the casino's contract on-chain, and a banner says so if that check fails
([what the wallet checks](verify-a-release.md#what-the-wallet-checks-on-start)). Once you open a funded channel, the
casino gives the account a **uname** such as `~3byt9ocwnnzaxanmiz3stocj` ([names](names-and-publishing.md)).

The top bar holds the library (**Games**), your **Bets** and your **Activity**, your money, and **My account**, which
leads to every other page: My wallet, My games, Bet history, Bankroll, Activity and Settings. The money there is real
money only: your channel's ETH balance, truncated rather than rounded, which opens My wallet, or **Play with ETH** until
you have a channel ([play with ETH](#play-with-eth)). While a game is open the top bar shows neither, and the strip
above the game shows the game's money ([practice or ETH](#practice-or-eth)).

**Settings** holds the keys and the connection:

| Control                         | What it does                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect browser wallet          | Makes an injected wallet, such as a browser extension, the funding account. It keeps its own key and approves each transaction and signature |
| Import a private key            | Makes that key the funding account                                                                                                           |
| Saved browser wallets           | Every key this browser generated or imported stays saved; **Select** switches back to one                                                    |
| Show browser wallet private key | Shows the key of a generated or imported account                                                                                             |
| Connected services              | The network (Sepolia, or a local Anvil chain) and the casino API this browser uses                                                           |

Changing accounts closes the open game. Back up every account you fund
([backups and recovery](backups-and-recovery.md)).

## Practice

1. Pick a game's tile in the library: its icon above its name.
2. Play. The strip above the game reads **Practice** and shows your play money, and the game shows each result as it
   would with money.

Play money is the wallet's own, kept in this tab's memory in amounts the size of the network's ETH. It starts at 10,000
of the network's recommended stakes, 0.01 ETH on Sepolia, and never runs out: a bet bigger than what is left tops it
back up first, and a game that asks for money gets it at once, without the wallet's dialog. The wallet settles a game's
casino bets and payments itself, by the casino's own rules, and signs nothing and sends the casino nothing. Nothing real
is won or lost, practice bets are in no history or record, and a reload starts again. Developer bets are placed with ETH
only, so a game built on them, such as roulette, can be watched in practice and played with ETH.

## Play with ETH

Until you have a funded channel, **Play with ETH**, in the top bar or in the strip above a game, opens a sheet of two
steps, and so does **Add ETH** on My wallet:

1. **Receive ETH**: copy your wallet's address and send Sepolia ETH to it from another wallet or a faucet, such as
   Google Cloud's, which the sheet links to. The sheet shows what has arrived, checking every 4 seconds while the tab is
   visible, or at once with **Check now**.
2. **Open a funded channel**: enter an amount and press **Open a funded channel**. **Max** fills in everything except
   0.001 ETH, which stays for future network fees, and this deposit's fee.

The wallet generates a fresh channel key and sends one transaction, `openChannel`, which deposits the amount and
registers the key. After two confirmations on Sepolia it checks the channel the contract registered, then activates it
at the casino, and the sheet closes. From then on games play with ETH, a game you were practicing included, and bets
need no transactions: every bet is signed and settled off-chain, and the game shows the result the wallet checked. A
funding account has one open channel at a time: to add money, close the channel and open another.

On a local Anvil chain, a generated browser wallet's sheet shows **Set up demo wallet** in step 1, which fetches demo
ETH from the local casino and opens a channel of 1 ETH.

## Practice or ETH

While a game is open, the strip above it is the one place its money shows. Practicing, it is amber: **Practice**, "Play
money: nothing real is won or lost", your play money and **Play with ETH**. With ETH it reads **Playing with ETH** and
how much the game may risk (before you allow any, that the game asks first), with **Change limit**
([give a game money](#give-a-game-money)) and **Practice**.

Without a funded channel you always practice, and **Play with ETH** opens the sheet ([play with ETH](#play-with-eth)).
An account with a funded channel opens every game with ETH: **Practice** switches the game at hand to play money, and
**Play with ETH** switches it back. Either way the game restarts to greet the other money, and its ETH limit goes back.

## Give a game money

With ETH, a game plays only with the limit you give it in the wallet's own dialog, which opens when the game asks or
when you press **Change limit**. The limit is the most the game may put at risk. The money stays in your channel, a win
raises the limit and a loss lowers it, and leaving the game, reloading or closing the tab takes back whatever is left.
[Games and limits](games-and-limits.md#giving-a-game-money) explains the dialog.

## Withdraw

1. On **My wallet**, open the **Close channel** section and press **Close channel**. Your funding account signs the
   latest balance, the casino countersigns it, and one transaction closes the channel: the balance becomes a **claim**.
   No ETH moves yet.
2. Under **Channel and withdrawal claims**, press **Collect available funds**. The claim's protected principal, and
   whatever winnings the contract has cash for, are paid to your funding account.

To be paid at another address, enter it beside the claim and press **Collect to another address**. A pending operation
must be resolved before a cooperative close ([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)), and
a cooperative close needs the casino; without it, close unilaterally ([closing and claims](closing-and-claims.md)). Play
money is never withdrawn: it exists only in the tab.

## Next

- [Games and limits](games-and-limits.md): the library, opening games, and what a game can see.
- [Bets and receipts](bets-and-receipts.md): every bet you signed, and what it paid back.
- [Backups and recovery](backups-and-recovery.md): what to keep so you can settle without the casino.
- [Trust model](../overview/trust-model.md): what the contract enforces, and what it does not.
