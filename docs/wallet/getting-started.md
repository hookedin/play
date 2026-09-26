---
title: Getting started
description: Open the wallet, practice with test coins, deposit ETH, give a game money and withdraw.
sidebar:
  order: 1
---

The wallet at https://play.hookedin.com holds your keys and your channels, and every game is played inside it. This page
takes you from a first visit to a withdrawal.

## Open the wallet

On your first visit the wallet generates a **funding account**, an Ethereum key it keeps in this browser. Until you
deposit, the wallet practices: you can play at once with 100 TEST, test coins it keeps itself ([practice](#practice)).
Once you open a funded channel, the casino gives the account a **uname** such as `~3byt9ocwnnzaxanmiz3stocj`
([names](names-and-publishing.md)).

The top bar holds the library (**Games**), your **Bets** and your **Activity**, the balance this tab plays with, the
**ETH** and **TEST** switch, and **My account**, which leads to every other page: My wallet, My games, Bet history,
Bankroll, Activity and Settings.

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

1. Pick a game in the library.
2. The game asks for money, and the wallet's own dialog opens. It names the game, the host serving it and its
   developer. Choose how much the game may play with and press **Allow**.
3. Play. The game shows each result as it would with money.

Test coins are the wallet's own, kept in this tab's memory: the wallet settles a game's casino bets and payments itself,
by the casino's own rules, and signs nothing and sends the casino nothing. Nothing real is won or lost, practice bets
are in no history or record, and reloading starts again at 100 TEST. When you hold fewer than 10, **Add 100 test
coins**, on **My wallet** or in the dialog, tops them up. Developer bets are placed with ETH only, so a game built on
them, such as roulette, can be watched in practice and played once you have deposited.

## Deposit ETH

1. On **My wallet**, under **Receive ETH**, copy your deposit address and send Sepolia ETH to it from another wallet or
   a faucet. **Wallet funds** shows what has arrived. It updates every 4 seconds, or at once with **Check now**.
2. Under **Open a funded channel**, enter an amount and press **Open a funded channel**. **Max** fills in everything
   except 0.001 ETH, which stays for future network fees, and this deposit's fee.

The wallet generates a fresh channel key and sends one transaction, `openChannel`, which deposits the amount and
registers the key. After two confirmations on Sepolia it checks the channel the contract registered, then activates it
at the casino. From then on the tab plays with ETH, and bets need no transactions: every bet is signed and settled
off-chain, and the game shows the result the wallet checked. A funding account has one open channel at a time: to add
money, close the channel and open another.

On a local Anvil chain, a generated browser wallet also shows **Set up demo wallet**, which fetches demo ETH from the
local casino and opens a channel of 1 ETH.

## Switch between ETH and TEST

The top bar shows the balance this tab plays with, truncated rather than rounded, and beside it **ETH** and **TEST**. An
account with an open channel plays with ETH unless you choose TEST, to practice, in this tab; reloading returns to ETH.
ETH is available once your channel is open. While a game holds money the choice is fixed: take the money back first, and
switching then reloads the game with the other money.

## Give a game money

While a game is open, the top bar shows **Give this game money** or **Take money back** in place of your balance, and
both open the wallet's dialog. The limit you set is the most the game may put at risk. The money stays in your channel,
a win raises the limit and a loss lowers it, and leaving the game, reloading or closing the tab takes back whatever is
left. [Games and limits](games-and-limits.md#giving-a-game-money) explains the dialog.

## Withdraw

1. On **My wallet**, open the **Close channel** section and press **Close channel**. Your funding account signs the
   latest balance, the casino countersigns it, and one transaction closes the channel: the balance becomes a **claim**.
   No ETH moves yet.
2. Under **Channel and withdrawal claims**, press **Collect available funds**. The claim's protected principal, and
   whatever winnings the contract has cash for, are paid to your funding account.

To be paid at another address, enter it beside the claim and press **Collect to another address**. A pending operation
must be resolved before a cooperative close ([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)), and
a cooperative close needs the casino; without it, close unilaterally ([closing and claims](closing-and-claims.md)). Test
coins are never withdrawn: they exist only in the tab.

## Next

- [Games and limits](games-and-limits.md): the library, opening games, and what a game can see.
- [Bets and receipts](bets-and-receipts.md): every bet you signed, and what it paid back.
- [Backups and recovery](backups-and-recovery.md): what to keep so you can settle without the casino.
- [Trust model](../overview/trust-model.md): what the contract enforces, and what it does not.
