---
title: Closing and claims
description: What the Wallet page shows, withdrawing, closing without the casino, the 24-hour challenge window and collecting a claim.
sidebar:
  order: 5
---

Your balance is a channel in the HookedIn contract. Withdrawing closes it with the casino's signature and pays you in
the same transaction. Without the casino you close it alone, with your latest evidence and a 24-hour window, and then
collect what it is owed.

## What the Wallet page shows

**Wallet**, `/wallet`, shows:

| Part                    | What it is                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance                 | Your channel's signed balance while it is open, the limits of games included, and money you deposited that the balance has not taken in yet, which the line under it counts as arriving |
| Vault                   | The ETH at your funding account's address. It pays deposits and network fees, and withdrawals and collected claims arrive in it unless you send them elsewhere                          |
| Deposit, Withdraw, Send | The [Wallet dialog](getting-started.md#deposit) on that tab; **All activity** opens [Activity](bets-and-receipts.md#activity)                                                           |
| Commission              | Shown once your games have earned some: what they earned, and how much of it is collected into your balance ([earnings](../games/earnings.md))                                          |
| Waiting to be paid      | Shown while a closed balance is still owed something: each claim, what it is still owed, and what can be collected now ([claims and collection](#claims-and-collection))                |
| Developer bets          | Shown when there are some: stakes with developers, and payouts not yet collected, which are outside the signed balance ([developer bets](bets-and-receipts.md#developer-bets))          |
| Recovery                | Collapsed: the channel behind your balance, and what you can do without the casino ([recovery](#recovery))                                                                              |

When the channel closes, what it is owed up to what you deposited is protected principal. The part above it is
**winnings**: a signed balance, owed from the shared bankroll.

## Recovery

**Recovery**, at the foot of the Wallet page, shows the channel's state (opening, open or closing), what you deposited,
which the contract protects, when the wallet last read the chain and the sequence of your latest evidence. While a close
is under way it adds the sequence the close proposes, how much less than yours it holds, whether a challenge is on its
way, and until when the close can be challenged. Its buttons are **Export recovery bundle**,
**Close without the casino**, **Challenge the close** and **Finish the close**, and **Import a recovery bundle** reads a
bundle back ([recovery bundles](backups-and-recovery.md#recovery-bundles)).

## Withdraw

1. On the **Withdraw** tab, press **Withdraw … ETH to your vault**.
2. The wallet stops play on the channel, and your funding account signs `Close(channelId, stateHash)` over the latest
   checkpoint.
3. The casino countersigns it, and the wallet sends `cooperativeClose` with both signatures and the evidence. The
   contract finalizes the channel, records the claim and pays it at once, as far as it can
   ([claims and collection](#claims-and-collection)).

A withdrawal needs the casino, and a channel with no pending operation. The contract checks the `Close` signature as a
signature of an externally owned account, so a funding account that is a contract closes without the casino. So does
one that refuses ETH: the payment is part of the close, and a refused payment reverts it.

## Close without the casino

1. Press **Close without the casino** under Recovery, or in the banner of a pending operation. Your funding account
   sends `startClose` with your latest evidence. Only the funding account, or the casino's owner, can start a close.
2. The contract sets the deadline 24 hours after the block that started the close (`CHALLENGE_PERIOD`, 86,400 seconds).
   Recovery shows it.
3. Once the deadline has passed, press **Finish the close**. Anyone can send `finalizeClose`, and the claim is recorded
   at the state the close ended with.
4. [Collect the claim](#claims-and-collection).

The evidence is your latest countersigned checkpoint, or that checkpoint plus the last operation the casino signed. A
close is owed that state's balance, plus any deposit the balance has not taken in. The wallet needs no casino for any of
this, and neither does the [recovery CLI](backups-and-recovery.md#the-recovery-cli).

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

- **Protected principal**, `min(owed, deposit)`, where `deposit` is everything you deposited into the channel: paid in
  full whenever the claim is collected.
- **Winnings**, whatever is above it: they join a queue of finalized winnings, first in, first out.

A withdrawal collects in the same transaction: the principal, and whatever winnings the contract reserves for the claim
then. **Waiting to be paid**, on the Wallet page, lists every claim of this account that is still owed something, 20 at
a time, those of older channels included, with what it is owed and what can be collected now:

- **Collect** sends `claim(channelId)`, which anyone may send. It pays the claim's protected principal and the winnings
  reserved for it to the claim's recipient: your funding account, unless you have redirected it.
- **Collect there**, with an address beside it, sends `claimTo(channelId, recipient)`, which only the funding account
  may send. It makes `recipient` the claim's recipient, for this collection and every later one, and pays.
- **Export evidence** saves the recovery bundle of its channel.

Winnings are paid as the contract has cash for them. Its house cash is its balance less protected principal and the
winnings it has already reserved, and it reserves that cash for the oldest unpaid winnings first. Each collection, a
withdrawal's included, and each payment into the bankroll through `fundBankroll`, reserves for up to 8 claims in the
queue; anyone can call `allocateWinnings` for up to 64. Cash reserved for a claim stays with that claim, and a claim can
be collected again as more is reserved for it. The owner can never withdraw protected principal or finalized winnings.

The payment is sent with 100,000 gas. A recipient that rejects it, or needs more gas to accept it, makes the collection
revert and leaves the claim whole. A withdrawal then reverts whole, and that account closes without the casino instead.

## Fees and gas

Depositing, withdrawing, sending, closing, challenging, finishing a close and collecting are transactions from your
funding account. The wallet caps each at 2,000,000 gas, 200 gwei per gas and 0.05 ETH in total fees, and stops before
signing when the network's estimate is higher; the casino cannot raise these caps. A deposit leaves at least 0.001 ETH
in your vault for later fees, and so does a send while a balance is open; a withdrawal, a close, a challenge, finishing
a close or collecting may spend it. That reserve is a floor, not a guaranteed budget. A pending transaction shows
**Retry** and **Speed up** ([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)).
