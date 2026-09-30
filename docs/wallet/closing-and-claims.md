---
title: Closing and claims
description: Locking in your balance, how a withdrawal is paid, closing without the casino, the 24-hour challenge window and collecting a claim.
sidebar:
  order: 3
---

Your balance is a channel in the HookedIn contract. Withdrawing takes part or all of it out while the channel stays
open. Without the casino you close the channel alone, with your latest evidence and a 24-hour window, and then collect
what it is owed. The **Wallet** page, `/wallet`, shows your balance with any money still arriving, what the contract
still owes you under **Waiting to be paid**, your [developer bets](bets-and-receipts.md#developer-bets), and
**Recovery**.

## Recovery

**Recovery**, at the foot of the Wallet page, shows the channel behind your balance and any older one whose close is
under way: the deposits the contract holds for it and the sequence of your latest evidence; for a closing one, the
sequence the close proposes beside yours, how much less it holds, any challenge on its way and the deadline; and when
the wallet last read the chain. Its actions are the rest of this page and
[recovery bundles](backups-and-recovery.md#recovery-bundles). Locking in needs the casino; the rest do not. A balance
played in another browser needs that browser's backup, or its recovery bundle.

## Lock in your balance

What your balance holds above your deposits is winnings, a claim on the shared bankroll. **Lock in my balance**, under
Recovery, makes all of your balance deposits: your account signs a [withdrawal](#withdraw) of the whole balance to the
contract itself, which the casino signs at once and sends to the contract, paying its fee. Your deposits pay back what
they cover and house cash the rest, and all of it goes into your channel as deposits the contract holds.

Locking in closes the open game first, and your balance is empty until it has taken those deposits in:
[Activity](bets-and-receipts.md#activity) shows **Locking in**, then **Balance locked in**. The button works while the
channel is open and your balance holds more than the deposits the contract holds for it. The casino declines a lock-in
that house cash cannot pay now, like any withdrawal, and your balance is as it was. Once it is in, a close pays all of
that balance as protected principal, and withdrawing it needs no house cash, until you win more.

## Withdraw

A [withdrawal](getting-started.md#withdraw) is an operation your account signs that names the address it pays as its
`recipient`. The casino signs the checkpoint after it at once, so your balance is lower from then on, and sends the
operation with that signature, the evidence your receipt holds, to the contract's `withdraw`
([functions that change state](../reference/contract.md#functions-that-change-state)); anyone may send it. The contract
records each withdrawal once, under its ID, the hash of its operation, and in the order you made them.

The contract pays out of your channel's deposits first, so what you have at risk stays as it was. The rest, the
winnings, joins the queue of every claim's winnings: what house cash reaches is paid at once, and the rest stays owed
under **Waiting to be paid** ([claims and collection](#claims-and-collection)). A recipient that refuses the payment
leaves all of it owed. Anyone can check the chain: `claims(id)` says what the contract still owes of a withdrawal, and
the `Withdrawal` event to whom, how much and in which transaction it was recorded.

The casino takes a withdrawal on only when the contract can pay all of it now: out of the deposits your channel will
still hold once the withdrawals it owes from it are paid, and house cash that no claim counts on, less what the
withdrawals it owes will take from it. A withdrawal your deposits cover needs no house cash. It declines the rest like
any declined debit, with a signed rejection that says _At most … ETH can be withdrawn now_. It also declines a
withdrawal to an address that would refuse a payment from the contract, which it tries first with the contract's
100,000 gas: _That address does not accept a payment from the contract_. Withdrawing everything leaves the channel open
with an empty balance.

The casino sends each withdrawal it takes on at once, so the contract normally pays all of it the moment it is sent. One
not sent yet offers **Send it now** in Activity once every withdrawal you made before it from that balance is sent. A
withdrawal can be sent until its channel's close is finished; one nobody sent by then comes back to you with the close,
not to its address: what your deposits cover as protected principal, and the rest as winnings.

## Close without the casino

1. Press **Close without the casino** under Recovery, or in the banner of a pending operation. Your account sends
   `startClose` with your latest evidence, paying its network fee from the deposit address
   ([fees and gas](#fees-and-gas)). Only your account, or the casino's owner, can start a close.
2. The contract sets the deadline 24 hours after the block that started the close (`CHALLENGE_PERIOD`, 86,400 seconds).
   Recovery shows it.
3. Once the deadline has passed, press **Finish the close**. Anyone can send `finalizeClose`, and the claim is recorded
   at the state the close ended with.
4. [Collect the claim](#claims-and-collection).

The evidence is your latest countersigned checkpoint, or the channel's base while nothing has been signed since it
began, either alone or followed by the last operation the casino signed;
[finalization](../reference/contract.md#finalization) says what it is owed. A close moves your account to its next
channel at once, whoever started it: your next deposit opens a new balance while the old channel closes. The close pays
your account, at your deposit address, and until your next balance opens the wallet puts nothing there into a balance
by itself ([deposit](getting-started.md#deposit)).

## Idle channels

When nobody has played on your channel for 7 days, it holds more deposits than it is owed and no withdrawal from it is
owed, the casino closes it on its latest state, so what you lost comes back to house cash. Once the close's 24 hours are
up, the casino finishes it and collects what it pays you, to your deposit address. Your next deposit opens your next
channel.

## Challenges

A close can be started with a state older than yours, by the casino or from an old copy of your evidence. When the
contract holds a close at a lower sequence than the evidence the wallet saved, the wallet warns you and offers
**Challenge the close**, which sends `challengeClose` with your newer evidence in place of the proposed state.

- A challenge must carry a strictly higher sequence than the proposed state.
- It must be mined before the deadline, and it does not move the deadline.
- Anyone holding the evidence can send it: you, your [watchtower](backups-and-recovery.md#the-watchtower), or the
  casino's own watcher.

The wallet sends a challenge only when you press the button. Once the deadline has passed, the proposed state is final
and the wallet says so.

## Claims and collection

Finalizing records a claim for what the close is owed, in two parts:

- **Protected principal**, `min(owed, principal)`, where `principal` is the deposits the contract holds for the channel:
  paid in full whenever the claim is collected.
- **Winnings**, whatever is above it: they join the queue of every claim's winnings, first in, first out.

A withdrawal is a claim too, under its ID, with its principal and winnings worked out the same way when it is recorded.

**Waiting to be paid**, on the Wallet page, lists every claim of this account that is still owed something, a closed
balance's or a withdrawal's, 20 at a time, those of older channels included, with where it pays, what it is owed and
what can be collected now:

- **Collect** sends `claim(id)`, which anyone may send. It pays the claim's protected principal and whatever of its
  winnings house cash reaches to the claim's recipient: your account for a closed balance and the withdrawal's address
  for a withdrawal, unless you have redirected it.
- **Collect there**, with an address and your wallet passphrase, sends `claimTo(id, recipient)`, which only your
  account may send. It makes `recipient` the claim's recipient, for this collection and every later one, and pays. The
  contract's own address puts what it pays into your balance's channel as deposits.
- **Export evidence**, beside a closed balance's claim, saves the recovery bundle of its channel.

Winnings are paid as the contract has cash for them, oldest first
([the winnings queue](../reference/contract.md#the-winnings-queue)): a claim collects what of its winnings house cash
covers in one call, however far back it waits, and can be collected again as more cash arrives. The owner can never
withdraw protected principal or unpaid winnings. A payment to an address is sent with 100,000 gas; a recipient that
rejects it, or needs more gas to accept it, makes the collection revert and leaves the claim whole: collect to another
address.

## Fees and gas

Depositing, closing, challenging, finishing a close, collecting and **Send it now** are transactions from your account;
the casino sends withdrawals and lock-ins to the contract, and pays their fees. The wallet caps each at 2,000,000 gas,
200 gwei per gas and 0.05 ETH in total fees, and stops before signing when the network's estimate is higher; the casino
cannot raise these caps. A deposit's fee comes out of what it deposits. Every other transaction needs its fee at your
deposit address, where the wallet keeps nothing back: with **Add ETH that arrives at my deposit address to my balance**
on, what arrives goes into your balance while the channel is open, within your deposit limit. Starting **Close without
the casino** turns that off, so ETH sent for its fee stays at the address even if starting the close fails. A failure
before signing leaves the balance open, and the close can be tried again; a signed close keeps its saved transaction to
retry. Recovery shows the ETH the address holds for fees. You can also turn it off under **Deposits** in Settings and
send ETH to the address, or have somebody relay the transaction: anyone can send `withdraw`, `challengeClose`,
`finalizeClose` and `claim`, and only your account or the casino can send `startClose`. A pending transaction shows
**Retry** and **Speed up** ([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)).
