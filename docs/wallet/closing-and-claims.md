---
title: Closing and claims
description: Cooperative and unilateral closes, the 24-hour challenge window, finalizing, collecting a claim, and what each balance on My wallet means.
sidebar:
  order: 5
---

Closing a channel turns its signed balance into a claim on the contract, and collecting the claim pays it out. You close
with the casino's signature in one transaction, or alone with your latest evidence and a 24-hour window.

## What My wallet shows

| Figure                     | What it is                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet funds               | The ETH at your funding account's address. It pays deposits and network fees, and collected claims arrive here unless you send them elsewhere |
| ETH balance                | Your channel's signed balance while it is open, the limits of games included. The top bar shows it while you play with ETH                    |
| Test coins                 | What this tab practices with, kept in its memory and never sent to the casino                                                                 |
| Original protected deposit | What you deposited. The contract keeps all of it aside while the channel is open, whatever the balance                                        |
| Developer bets             | Stakes with developers, and payouts not yet collected, which are outside the signed balance                                                   |
| Claims                     | What each finalized channel is owed, and what has been paid                                                                                   |

When the channel closes, the part of its balance up to the deposit is protected principal. The part above it is
**winnings**: a signed balance, owed from the shared bankroll.

Under the channel, the wallet shows its state (Opening, Open or Closing) and its latest observation: **Last verified**,
when it last read the chain; **Saved sequence**, the sequence of your latest evidence; **Proposed sequence**, the state
a close has put forward; **Balance at risk**, how much more your evidence holds than that state; and whether a
challenge transaction is pending.

## Close cooperatively

1. On **My wallet**, open the **Close channel** section and press **Close channel**.
2. The wallet stops play on the channel, and your funding account signs `Close(channelId, stateHash)` over the latest
   checkpoint.
3. The casino countersigns it, and the wallet sends `cooperativeClose` with both signatures and the evidence. The
   contract finalizes the channel at once and records the claim.
4. [Collect the claim](#claims-and-collection).

A cooperative close needs the casino, and a channel with no pending operation. The contract checks the `Close`
signature as a signature of an externally owned account, so a funding account that is a contract closes unilaterally.

## Close unilaterally

1. Press **Start unilateral close** on My wallet, or in the banner of a pending operation. Your funding account sends
   `startClose` with your latest evidence. Only the funding account, or the casino's owner, can start a close.
2. The contract sets the deadline 24 hours after the block that started the close (`CHALLENGE_PERIOD`, 86,400 seconds).
   My wallet shows it as the **Challenge deadline**.
3. Once the deadline has passed, press **Finalize withdrawal claim**. Anyone can send `finalizeClose`, and the claim is
   recorded at the state the close ended with.
4. [Collect the claim](#claims-and-collection).

The evidence is your latest countersigned checkpoint, or that checkpoint plus the last operation the casino signed. The
wallet needs no casino for any of this, and neither does the
[recovery CLI](backups-and-recovery.md#the-recovery-cli).

## Challenges

A close can be started with a state older than yours, by the casino or from an old copy of your evidence. When the
contract holds a close at a lower sequence than the evidence the wallet saved, the wallet shows _The casino is closing
with an older balance. Submit your saved evidence before …_ with **Challenge stale close**; **Challenge stale balance**
on My wallet does the same. The challenge sends `challengeClose` with your newer evidence, which replaces the proposed
state.

- A challenge must carry a strictly higher sequence than the proposed state.
- It must be mined before the deadline, and it does not move the deadline.
- Anyone holding the evidence can send it: you, your watchtower, or the casino's own watcher.

The wallet sends a challenge only when you press the button. Once the deadline has passed, the proposed state is final
and the wallet says so. A [watchtower](backups-and-recovery.md#the-watchtower) challenges for you from a machine of your
own.

## Claims and collection

Finalizing records a claim for the closing balance, in two parts:

- **Protected principal**, `min(balance, deposit)`: paid in full whenever the claim is collected.
- **Winnings**, whatever is above the deposit: they join a queue of finalized winnings, first in, first out.

Two buttons collect:

- **Collect available funds** sends `claim(channelId)`, which anyone may send. It pays the claim's protected principal
  and the winnings reserved for it to the claim's recipient: your funding account, unless you have redirected it.
- **Collect to another address** sends `claimTo(channelId, recipient)`, which only the funding account may send. It
  makes `recipient` the claim's recipient, for this collection and every later one, and pays.

Winnings are paid as the contract has cash for them. Its house cash is its balance less protected principal and the
winnings it has already reserved, and it reserves that cash for the oldest unpaid winnings first. Each collection, and
each payment into the bankroll through `fundBankroll`, reserves for up to 8 claims in the queue; anyone can call
`allocateWinnings` for up to 64. Cash reserved for a claim stays with that claim, and a claim can be collected again as
more is reserved for it. The owner can never withdraw protected principal or finalized winnings.

The payment is sent with 100,000 gas. A recipient that rejects it, or needs more gas to accept it, makes the collection
revert and leaves the claim whole.

My wallet lists every claim of this account, unpaid first and 20 at a time, also after you open another channel. Each
shows **Due**, **Received**, **Unpaid**, **Protected principal**, **Unpaid winnings** and **Winnings allocated**, and
**Export claim evidence** saves the recovery bundle of its channel.

## Fees and gas

Opening, closing, challenging, finalizing and collecting are transactions from your funding account. The wallet caps
each at 2,000,000 gas, 200 gwei per gas and 0.05 ETH in total fees, and stops before signing when the network's estimate
is higher; the casino cannot raise these caps. A deposit leaves at least 0.001 ETH in the funding account for later
fees, and a close, a challenge, finalizing or collecting may spend it. That reserve is a floor, not a guaranteed budget.
A pending transaction shows **Retry same request** and **Speed up transaction**
([when a reply is lost](backups-and-recovery.md#when-a-reply-is-lost)).
