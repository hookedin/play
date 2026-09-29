---
title: Getting started
description: Open the wallet, deposit ETH, give a game a limit and withdraw.
sidebar:
  order: 1
---

The wallet at https://play.hookedin.com holds your keys and your money, and every game is played inside it. This page
takes you from a first visit to a withdrawal.

## Open the wallet

On your first visit, choose and confirm a wallet passphrase of 12 to 1,024 characters. The wallet makes your
**account**, an Ethereum key encrypted with that passphrase in this browser, which signs everything you do with your
money. Its address is your **deposit address**. Unlock the wallet with the passphrase whenever the page loads; **Lock
wallet** in the account menu locks every open wallet tab. The wallet also locks after five minutes without activity.
Support cannot recover a lost key or reset your passphrase: keep a
[checked encrypted backup](backups-and-recovery.md#encrypted-backups).

This deployment uses **test ETH only**, on Sepolia or a local Anvil chain. Send only ETH on the network the wallet
names. It accepts no other assets or networks and offers no fiat conversion or card purchase. To play,
[deposit](#deposit) free test ETH from a faucet the wallet links to, or have a player withdraw some from their balance
to your deposit address ([withdraw](#withdraw)). The game library needs nothing from the chain, so it works at once;
everything with ETH waits until the wallet has checked the casino's contract on-chain, and a banner says so if that
check fails
([what the wallet checks](verify-a-release.md#what-the-wallet-checks-on-start)). Your first deposit gives the account a
**uname** such as `~3byt9ocwnnzaxanmiz3stocj` ([names](names-and-publishing.md)).

Your money is your **balance**: what games play with, your channel's signed balance. The contract holds your deposits
for it; what you win above them is a claim on the shared bankroll, which **Lock in my balance** makes deposits too
([lock in your balance](closing-and-claims.md#lock-in-your-balance)).

The top bar holds the HookedIn mark, which leads home, **Games**, **Bets**, the network, the wallet button and your
account. The wallet button shows your balance, truncated rather than rounded, and **Wallet**, or **Deposit** while you
have none; it opens [the wallet](#deposit). This total stays visible during play. The game's **Game allowance** is
what that game may spend from the total ([a game's limit](#a-games-limit)). The account menu holds Games, Wallet, Bets,
Activity, Settings, Contact support, Lock wallet and your Public profile. **Developer and bankroll** folds My games
and Bankroll away until you need them.

**Settings** holds your play controls, name, deposit preferences, keys and connection:

| Section                | What it holds                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play limits and breaks | Daily deposit and loss limits, session length and timed breaks ([account controls](games-and-limits.md#play-limits-and-breaks))                                                     |
| Your name              | Your uname, and an alias with **Save alias** and **Give up my alias** ([an alias](names-and-publishing.md#an-alias))                                                                |
| Deposits               | **Add ETH that arrives at my deposit address to my balance**, on unless you turn it off ([deposit](#deposit))                                                                       |
| Keys and backups       | **Show this wallet's private key**; **Download encrypted backup**, **Check saved backup** and **Restore a backup** ([encrypted backups](backups-and-recovery.md#encrypted-backups)) |
| Accounts               | Every key this browser made or imported stays saved, and **Switch** goes back to one. **Import a private key** makes that key your account, and its address your deposit address    |
| Casino                 | The network (Sepolia, or a local Anvil chain) and the casino API this browser uses, with **Connect**                                                                                |

Switching accounts closes the open game. Back up every account you fund
([backups and recovery](backups-and-recovery.md)).

## Deposit

The **Wallet** dialog moves your money. It opens from the wallet button, from **Deposit ETH** in the library and
**Deposit** on the Wallet page, and when a game asks for money while your balance has nothing to allow. It shows your
balance and has two tabs, **Deposit** and [**Withdraw**](#withdraw).

Before the Deposit tab reveals its receiving controls, download an encrypted account backup in Settings and reopen
that saved file with **Check saved backup**. This checks that it decrypts and contains the current account and
recovery evidence. Keep fresh copies after playing or moving ETH; the Wallet page and Settings say when the checked
copy needs updating. Recovery requires current evidence, watching for a stale close within its 24-hour challenge
window, and ETH at the deposit address for transaction fees.

Send test ETH on the named network using the shown address, its QR code or **Open in an Ethereum wallet**. **Copy**
copies the address. Sepolia also links to a faucet. The wallet checks the address every 4 seconds while the page is
visible and adds incoming ETH to your balance, less the network fee and within your daily deposit limit. The tab shows
confirmation progress and, when estimated, the maximum network fee and amount available to add. The final fee is in
Activity. ETH too small to cover its deposit fee waits at the address until more arrives.

Each deposit is one transaction, `deposit`, into your account's channel, and your first opens it. After two
confirmations on Sepolia the wallet registers the channel with the casino. From then on bets need no transactions: every
bet is signed and settled off-chain, and the game shows the result the wallet checked. A game you have open loads again,
to save its state under your new uname.

Once a deposit has its confirmations, the wallet asks the casino to sign a deposit operation, which takes the money into
your balance. Until the casino has seen the deposit confirmed, the Wallet page shows the money as arriving, and the
wallet asks again at its next check, every few seconds. The money is yours meanwhile: a close adds whatever the balance
has not taken in to what the channel is owed. Anyone can deposit into your channel through the contract, naming your
deposit address, and the wallet takes it in the same way; another player's withdrawal to your deposit address
([withdraw](#withdraw)) goes in like any ETH sent there.

Under **Deposits** in Settings, **Add ETH that arrives at my deposit address to my balance** is on unless you turn it
off. Off, what arrives stays at the address, to pay for transactions your account sends itself, such as closing without
the casino, and the Deposit tab offers **Add to balance**, which adds what your deposit limit permits, less the network
fee.

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

On the **Withdraw** tab, choose **Game balance** under **Withdraw from**, enter how much under **Amount (ETH)** or
choose **Max**, enter the address to pay under **To**, enter your wallet passphrase and press **Withdraw … ETH**. Blank,
zero, negative and over-balance amounts cannot be submitted, and the destination must be a valid address other than the
zero address or your own deposit address. Your account signs a withdrawal of that amount to that address, and the casino
signs your balance after it at once: your balance pays it now, and you play on with the rest. The casino then has the
contract pay the address, out of your deposits first and the bankroll for the rest. Withdrawing all of it closes the
open game first; withdrawing part lowers the open game's limit to what stays, if it held more.

To give the amount to another player, enter their deposit address: their wallet puts it into their balance. A friend
you bring in this way can play with no ETH of their own.

[Activity](bets-and-receipts.md#activity) shows the withdrawal as **Withdrawal on its way** until the contract has paid
it, and then as **Withdrawn**. Your wallet keeps the proof the contract pays on, anyone can look the withdrawal up
on-chain by its ID, and one the casino has not sent yet you can send yourself with **Send it now**
([withdraw](closing-and-claims.md#withdraw)).

The casino takes a withdrawal on only when the contract can pay all of it now, beside the other withdrawals it owes.
Otherwise it declines it and says how much can be withdrawn now, and your balance is as it was. It also declines a
withdrawal to an address that does not accept a payment from the contract.

Choose **Deposit address · less network fee** under **Withdraw from** to send the ETH held at your deposit address.
This sends everything there, less the network fee, and leaves your signed game balance unchanged. It is available
during a play break or after reaching a deposit limit, including while a balance is open. With no balance open, the
Withdraw tab uses the deposit address automatically. Address withdrawals also require your wallet passphrase.

A withdrawal needs the casino, and no operation in flight
([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)); without the casino, close from **Recovery** on
the Wallet page ([closing and claims](closing-and-claims.md)).

## Help

**Contact support** in the account menu and Wallet dialog opens an email to support@hookedin.com. Include the network,
transaction hash or operation ID and the error you see. Never send a private key, passphrase or backup file.

## Next

- [Games and limits](games-and-limits.md): the library, opening games, and what a game can see.
- [Bets and receipts](bets-and-receipts.md): every bet you signed, and what it paid back.
- [Backups and recovery](backups-and-recovery.md): what to keep so you can settle without the casino.
- [Trust model](../overview/trust-model.md): what the contract enforces, and what it does not.
