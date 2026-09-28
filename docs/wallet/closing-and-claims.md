---
title: Closing and claims
description: What the Wallet page shows, locking in your balance, withdrawing, closing without the casino, the 24-hour challenge window and collecting a claim.
sidebar:
  order: 5
---

Your balance is a channel in the HookedIn contract. Withdrawing takes part or all of it out: your balance pays it at
once, the contract pays the address you name, and the channel stays open. Without the casino you close the channel
alone, with your latest evidence and a 24-hour window, and then collect what it is owed.

## What the Wallet page shows

**Wallet**, `/wallet`, shows:

| Part               | What it is                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance            | Your channel's signed balance while it is open, the limits of games included, and money you deposited that the balance has not taken in yet, which the line under it counts as arriving |
| Deposit, Withdraw  | The [Wallet dialog](getting-started.md#deposit) on that tab; **All activity** opens [Activity](bets-and-receipts.md#activity)                                                           |
| Commission         | Shown once your games have earned some: what they earned, and how much of it is collected into your balance ([earnings](../games/earnings.md))                                          |
| Waiting to be paid | Shown while a closed balance is still owed something: each claim, what it is still owed, and what can be collected now ([claims and collection](#claims-and-collection))                |
| Developer bets     | Shown when there are some: stakes with developers, and payouts not yet collected, which are outside the signed balance ([developer bets](bets-and-receipts.md#developer-bets))          |
| Recovery           | Collapsed: the channel behind your balance and any whose close is under way, and what you can do without the casino ([recovery](#recovery))                                             |

The contract holds your deposits for the channel, less what it has paid out of them: that is protected principal, which
pays withdrawals first and a close up to what it is owed. What the channel is owed above it is **winnings**: a signed
balance, owed from the shared bankroll until you [lock it in](#lock-in-your-balance).

## Recovery

**Recovery**, at the foot of the Wallet page, shows the channel behind your balance and any older one whose close is
under way. For the open channel it shows the deposits the contract holds for it and the sequence of your latest
evidence; for a closing one, the sequence the close proposes beside the one you saved, how much less than yours it
holds, whether a challenge is on its way, and until when the close can be challenged; and when the wallet last read the
chain. Its buttons are **Export recovery bundle**, **Lock in my balance**, **Close without the casino**,
**Challenge the close** and **Finish the close**, and **Import a recovery bundle** reads a bundle back
([recovery bundles](backups-and-recovery.md#recovery-bundles)). Locking in needs the casino; the rest do not. A balance
played in another browser needs that browser's backup, or its recovery bundle, and Recovery says so.

## Lock in your balance

What your balance holds above your deposits is winnings, a claim on the shared bankroll. **Lock in my balance**, under
Recovery, makes all of your balance deposits. Your account signs a transfer of the whole balance into its own
([withdraw](#withdraw)), which the casino signs at once and has the contract pay: out of your deposits, which pay back
what they cover, and house cash for the rest, the winnings. All of it comes back into your channel as deposits the
contract holds, and the wallet says _Locking in: all of your balance comes back in as deposits, which the contract
holds._

Locking in closes the open game first, and your balance is empty until the contract has paid it in:
[Activity](bets-and-receipts.md#activity) shows **Locking in** until then, and **Balance locked in** after. The button
works while the channel is open and your balance holds more than the deposits the contract holds for it. The casino
declines a lock-in that house cash cannot pay now, like any withdrawal, and your balance is as it was.

Once it is paid, a close pays all of that balance as protected principal, and withdrawing it needs no house cash, until
you win more.

## Withdraw

1. On the **Withdraw** tab, enter how much under **Amount (ETH)**, or leave it empty for all of it, enter the address to
   pay under **To**, and press **Withdraw … ETH**.
2. Your account signs a withdrawal: a debit whose operation names the address, as its `recipient`. The casino signs the
   checkpoint after it at once, like any debit: your balance is lower from then on, and play goes on.
3. The contract pays the amount to the address when anyone sends it the operation and the casino's signature after it,
   the evidence your receipt holds, with `withdraw`
   ([the contract](../reference/contract.md#functions-that-change-state)). The casino sends it straight away. The
   contract pays each withdrawal once, under its ID: the hash of its operation.

With **Put it into that account's HookedIn balance** ticked, the button reads **Put … ETH into their balance**, and your
account signs a transfer instead: the contract deposits the amount into that account's balance, opening one if it has
none. That is how you fund someone else's balance: to bring a friend in, enter their deposit address under **To**, and
they can play with no ETH of their own.

[Activity](bets-and-receipts.md#activity) shows a withdrawal as **Withdrawal on its way** until the wallet sees it paid
on-chain, and then as **Withdrawn**, with the transaction that paid it; a transfer as **Transfer on its way**, then
**Put into a balance**.

The contract pays out of your channel's deposits first and house cash for the rest, all or nothing, which leaves what
you have at risk as it was: what your balance holds above your deposits is a claim on the shared bankroll before and
after. Short of house cash, it pays nothing, and the withdrawal waits: the casino sends it again on every check of the
chain, and **Pay it now**, in its Activity entry, sends it from your account, paying the network fee from your deposit
address ([fees and gas](#fees-and-gas)). Anyone can check the chain for the payment: `withdrawals(id)` says whether it
was paid, and the `Withdrawal` event to whom, how much and in which transaction.

The casino takes a withdrawal or a transfer on only when the contract can pay it now: out of the deposits your channel
will still hold once the withdrawals it owes from it are paid, and house cash that no finalized claim counts on, less
what the withdrawals it owes will take from it. A withdrawal your deposits cover needs no house cash. It declines the
rest like any declined debit, with a signed rejection that says _At most … ETH can be withdrawn now_: your balance is as
it was, and nothing is paid in part. It also declines a withdrawal to an address that refuses a plain payment from the
contract, which it tries first: _That address does not accept a payment from the contract_. Withdrawing everything
leaves the channel open with an empty balance.

A withdrawal that waits for house cash waits whole, the part your deposits cover included. It can be paid until its
channel's close is finished, which anyone can do 24 hours after the close starts. One still unpaid then comes back to
you with the close, not to its address: what your deposits cover is protected principal, and the rest winnings
([claims and collection](#claims-and-collection)).

A withdrawal needs the casino, and a channel with no pending operation.

## Close without the casino

1. Press **Close without the casino** under Recovery, or in the banner of a pending operation. Your account sends
   `startClose` with your latest evidence, paying its network fee from the deposit address
   ([fees and gas](#fees-and-gas)). Only your account, or the casino's owner, can start a close.
2. The contract sets the deadline 24 hours after the block that started the close (`CHALLENGE_PERIOD`, 86,400 seconds).
   Recovery shows it.
3. Once the deadline has passed, press **Finish the close**. Anyone can send `finalizeClose`, and the claim is recorded
   at the state the close ended with.
4. [Collect the claim](#claims-and-collection).

A close moves your account to its next channel at once, whoever started it. Your balance is then that channel's, empty
until a deposit, and the Wallet page says _Your last balance is closing: finish the close under Recovery once its 24
hours are up, and collect it. A deposit opens your next balance._ Your next deposit, or a transfer to you, opens it
while the old channel closes. The close pays your account, at your deposit address. Until your next balance opens, the
wallet puts nothing at that address into a balance by itself: what the close pays and anything sent since waits for
**Add to balance** or **Withdraw** ([deposit](getting-started.md#deposit)).

The evidence is your latest countersigned checkpoint, or the channel's base while nothing has been signed since it
began, either alone or followed by the last operation the casino signed. A close is owed that state's balance, plus any
deposit the balance has not taken in and any withdrawal or transfer it made that the contract has not paid, less any
the contract paid that it did not make. The wallet needs no casino for any of this, and neither does the
[recovery CLI](backups-and-recovery.md#the-recovery-cli).

## Idle channels

When nobody has played on your channel for 7 days, it holds more deposits than it is owed and no withdrawal from it is
owed, the casino closes it on its latest state, so what you lost comes back to house cash. Once the close's 24 hours are
up, the casino finishes it and collects what it pays you, to your deposit address. Your next deposit opens your next
channel.

## Challenges

A close can be started with a state older than yours, by the casino or from an old copy of your evidence. When the
contract holds a close at a lower sequence than the evidence the wallet saved, the wallet shows _The casino is closing
your balance with an older state. Challenge it before …_ with **Challenge the close**; **Challenge the close** under
Recovery does the same. The challenge sends `challengeClose` with your newer evidence, which replaces the proposed
state.

- A challenge must carry a strictly higher sequence than the proposed state.
- It must be mined before the deadline, and it does not move the deadline.
- Anyone holding the evidence can send it: you, your watchtower, or the casino's own watcher.

The wallet sends a challenge only when you press the button. Once the deadline has passed, the proposed state is final
and the wallet says so. A [watchtower](backups-and-recovery.md#the-watchtower) challenges for you from a machine of your
own.

## Claims and collection

Finalizing records a claim for what the close is owed, in two parts:

- **Protected principal**, `min(owed, principal)`, where `principal` is the deposits the contract holds for the channel:
  paid in full whenever the claim is collected.
- **Winnings**, whatever is above it: they join a queue of finalized winnings, first in, first out.

**Waiting to be paid**, on the Wallet page, lists every claim of this account that is still owed something, 20 at a
time, those of older channels included, with what it is owed and what can be collected now:

- **Collect** sends `claim(channelId)`, which anyone may send. It pays the claim's protected principal and the winnings
  reserved for it to the claim's recipient: your account, unless you have redirected it.
- **Collect there**, with an address beside it, sends `claimTo(channelId, recipient)`, which only your account may send.
  It makes `recipient` the claim's recipient, for this collection and every later one, and pays.
- **Export evidence** saves the recovery bundle of its channel.

Winnings are paid as the contract has cash for them. Its house cash is its balance less protected principal and the
winnings it has already reserved, and it reserves that cash for the oldest unpaid winnings first. Each collection, and
each payment into the bankroll through `fundBankroll`, reserves for up to 8 claims in the queue; anyone can call
`allocateWinnings` for up to 64. The owner's `withdrawHouse`, and a withdrawal beyond its channel's deposits, pay only
out of cash beyond every finalized claim's winnings, so neither takes cash ahead of the queue. Cash reserved for a claim
stays with that claim, and a claim can be collected again as more is reserved for it. The owner can never withdraw
protected principal or finalized winnings.

The payment is sent with 100,000 gas. A recipient that rejects it, or needs more gas to accept it, makes the collection
revert and leaves the claim whole: collect to another address.

## Fees and gas

Depositing, closing, challenging, finishing a close, collecting and **Pay it now** are transactions from your account;
the casino has the contract pay withdrawals, transfers and lock-ins, and pays their fees. The wallet caps each at
2,000,000 gas, 200 gwei per gas and 0.05 ETH in total fees, and stops before signing when the network's estimate is
higher; the casino cannot raise these caps. A deposit's fee comes out of what it deposits. Every other transaction needs
its fee at your deposit address, where the wallet keeps nothing back: with
**Add ETH that arrives at my deposit address to my balance** on, what arrives goes into your balance while the channel
is open. Turn it off under **Deposits** in Settings and send ETH to the address, or have somebody relay the transaction:
anyone can send `withdraw`, `challengeClose`, `finalizeClose` and `claim`, and only your account or the casino can send
`startClose`. A pending transaction shows **Retry** and **Speed up**
([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)).
