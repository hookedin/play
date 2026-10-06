---
title: Closing and claims
description: Collateral, locking in your balance, how a withdrawal is paid, closing without the casino, the 7-day challenge window and collecting a claim.
sidebar:
  order: 3
---

Your balance is a channel in the HookedIn contract, your account's current one, which is active from the start: there
is nothing to open, whether the contract holds anything for it yet or not. Withdrawing takes part or all of it out while
the channel stays active. Without the casino you close the channel alone, with your latest evidence and a 7-day window, and then collect
what it is owed. The wallet shows your balance with any money still arriving, and what the contract still owes you
under **Waiting to be paid**; Settings shows what protects your balance under **Protection**, at
`/settings/protection`, and the ways to close and collect under **Recovery**, at `/settings/recovery`.

## Collateral

**Protection**, in the wallet's Settings, shows what the contract holds for your balance: your deposits, and collateral, the
casino's cash locked into your channel. They are shown as the contract leaves them once it has recorded every
withdrawal it still owes, which it pays out of them by [its rule](#withdraw); a withdrawal made on another device, whose
proof this browser does not hold, is counted as paid out of all your deposits. How much of your balance they protect,
and how much more you could win and have protected, is beside them. What your balance holds above them is winnings,
which only house cash pays, and a deposit it took in that a reorganisation of the chain undid is shown apart: a close
is owed it only once it lands again.

Collateral protects what you win before you win it. The casino offers it at its rate, a share of the amount paid once,
which Protection shows. Enter an amount and **Buy for … ETH**: the wallet asks the casino for an offer, checks its
signature and that its price is the rate, and buys it on-chain from your deposit address, the price and the network fee
both paid there ([contract](../reference/contract.md#collateral)). In that one transaction the contract moves that much
house cash into your channel, where the casino can no longer take it, or the purchase reverts and only the fee is spent.
The casino offers as much as its house cash allows, and an offer holds for an hour.

When your deposit address holds too little, Protection says how much to send there and by when: the wallet buys the
collateral with it as soon as it arrives, before it adds anything to your balance, and the rest goes in after. Once
your balance has started closing it buys nothing: what arrives then stays for the close's fees. Activity
shows **Collateral bought**.

A withdrawal is paid out of your deposits first, then out of your collateral, and only then out of house cash; a close
the same. So withdrawing uses collateral up, and nothing tops it up. Collateral adds nothing to what you are owed, and
it lasts only until your channel closes: what the close is not owed, collateral included, returns to house cash. It has
no minimum term: the casino's owner can start a close at any time, as it does for an [idle](#idle-channels) channel,
and the price is never refunded.

## Recovery

**Recovery**, in the wallet's Settings, shows the channel behind your balance and any older one whose close is
under way: the deposits and collateral the contract holds for it and the sequence of your latest evidence; for a closing
one, the sequence the close proposes and, when it falls short of yours, how much less it holds and any challenge on its
way, and the deadline; and when the wallet last read the chain. Its actions are the rest of this page and
[recovery bundles](keys-and-recovery.md#recovery-bundles). Locking in needs the casino; the rest do not.

## Lock in your balance

What your balance holds above your deposits and collateral is winnings, a claim on the shared bankroll. **Lock in my
balance**, under Recovery, makes your balance deposits: your account signs a lock-in, a [withdrawal](#withdraw) into
your own channel, of all of it but the fee for sending it, which it pays as well. The casino signs it at
once and sends it to the contract, which pays it like any withdrawal, but into your channel, as deposits the contract
holds.

Locking in closes the open game first, and your balance is empty until it has taken those deposits in:
[Activity](bets-and-receipts.md#activity) shows **Locking in**, then **Balance locked in**. The button works while the
channel is active and Protection shows part of your balance unprotected. The casino declines a lock-in that house cash
cannot pay now, like any withdrawal, and your balance is as it was. Once it is in, a close pays all of that balance out
of deposits, and withdrawing it needs no house cash, until you win more.

## Withdraw

A [withdrawal](getting-started.md#withdraw) is an operation your account signs that names the address it pays as its
`recipient`. Your balance pays it and the casino's fee for sending it to the contract
([fees and gas](#fees-and-gas)). The casino signs the checkpoint after
it at once, so your balance is lower from then on, and sends the operation with that signature, the evidence your
receipt holds, to the contract's `withdraw`
([functions that change state](../reference/contract.md#functions-that-change-state)); anyone may send it. The contract
records each withdrawal once, under its ID, the hash of its operation, and in the order you made them.

The contract pays it first out of the deposits your balance had taken in when you made it, so what you have at risk
stays as it was; a deposit that arrives later stays in your channel. Your [collateral](#collateral) pays the next part.
The rest, the winnings, joins the queue of every claim's winnings: what house cash reaches is paid at once, and the rest
stays owed under **Waiting to be paid** ([claims and collection](#claims-and-collection)). A recipient that refuses the
payment leaves all of it owed. Anyone can check the chain: `claims(id)` says what the contract still owes of a
withdrawal, and its `Withdrawal` [event](../reference/contract.md#events) to whom, how much and in which transaction it
was recorded.

The casino takes a withdrawal on only when the contract can pay all of it now: out of the deposits your balance has
taken in and the collateral that the withdrawals it owes from it leave, and house cash that no claim counts on, less
what the withdrawals it owes will take from it. A withdrawal your deposits and collateral cover needs no house cash. It
declines the rest like any declined debit, with a signed rejection that says _At most … ETH can be withdrawn now_. It
also declines a withdrawal to an address that would refuse a payment from the contract, which it tries first with the
gas the contract sends: _That address does not accept a payment from the contract_. Withdrawing everything leaves the
channel active with an empty balance.

The casino sends each withdrawal it takes on at once, so the contract normally pays all of it the moment it is sent.
Anyone can send one it has not, from any wallet: its entry in [Activity](bets-and-receipts.md#activity) holds the
transaction under **Send it yourself**. A withdrawal can be sent until its
channel's close is finished; one nobody sent by then comes back to you with the close, not to its address: what your
deposits and collateral cover as its protected amount, and the rest as winnings.

## Close without the casino

1. Press **Close without the casino** under Recovery, or in the banner of a pending operation. Your account sends
   `startClose` with your latest evidence, paying its network fee from the deposit address
   ([fees and gas](#fees-and-gas)); with a pending casino bet its quote covers, it sends `dispute` instead
   ([dispute a casino bet](#dispute-a-casino-bet)). Only your account, or the casino's owner, can start a close.
2. The contract sets the deadline 7 days after the block that started the close
   ([`CHALLENGE_PERIOD`](../reference/contract.md#constants)). Recovery shows it.
3. Once the deadline has passed, press **Finish the close**. Anyone can send `finalizeClose`, and the claim is recorded
   at the state the close ended with.
4. [Collect the claim](#claims-and-collection).

The evidence is your latest countersigned checkpoint, or the channel's base while nothing has been signed since it
began, either alone or followed by the last operation the casino signed;
[finalization](../reference/contract.md#finalization) says what it is owed. A close moves your account to its next channel at once, whoever started it: your next balance plays there
while the old channel closes. The close pays your account, at your deposit address, and until your next balance has a
deposit the wallet puts nothing there into a balance by itself ([when ETH waits at the
address](getting-started.md#when-eth-waits-at-the-address)).

## Dispute a casino bet

The casino must settle every casino bet its [quote](../overview/how-it-works.md#quotes) covers. One it declines, or
leaves unanswered, stays saved in the wallet: the wallet countersigns no rejection of it, unless the casino proves it a
game's operation your account carried out on another channel. Its banner says until when the quote covers it.

**Close without the casino** then sends `dispute` with your latest evidence, the bet your account signed, its seed and
the casino's quote, which the contract checks ([disputes](../reference/contract.md#disputes)). The close counts the bet
as won. The deadline is 7 days after the dispute, which is the time the casino has to replace it with its result: the
bet settled on the round's secret, the outcome it would have had. Should it not, the close finishes with the bet won,
and its winnings are recorded with the close's claim. Meanwhile the dispute locks what winning the bet adds above your
deposits and collateral into your [collateral](#collateral), out of the house cash that is free when it is mined, so the
owner cannot take it: it pays the close if the bet stays won, and returns to house cash once the casino settles it lost.
Recovery says which the close holds, and the house cash held for it.

Anyone can send the dispute: the bet and its quote are in the channel's [recovery
bundle](keys-and-recovery.md#recovery-bundles), from which a [watchtower](keys-and-recovery.md#the-watchtower) disputes
it before the quote expires.

A dispute must be mined before the quote expires. The wallet sends a bet with its seed only on a quote with at least
half its day left, so a bet the casino leaves unanswered has at least 12 hours to be disputed. After the quote expires
the wallet still takes no decline of the bet, and sends it again without its seed; it can no longer be disputed, and
**Close without the casino** ends the balance with the bet void. On **Retry**, the wallet takes up no later state of
the casino's in place of the bet unless your account signed past it, from another device.

## Idle channels

When nobody has played on your channel for 7 days, it holds more deposits and collateral than it is owed, by more than
the gas of closing it, and no withdrawal from it is owed, the casino closes it on its latest state, so what you lost,
and the collateral you no longer need, comes back to house cash. Once the close's 7 days are
up, the casino finishes it and collects what it pays you, to your deposit address. Your next deposit goes into your
next channel.

## Challenges

A close can be started with a state older than yours, by the casino or from an old copy of your evidence. When the
contract holds a close at a lower sequence than the evidence the wallet saved, the wallet warns you and offers
**Challenge the close**, which sends `challengeClose` with your newer evidence in place of the proposed state.

- A challenge must carry a strictly higher sequence than the proposed state.
- It must be mined before the deadline, and never extends it.
- Anyone holding the evidence can send it: you, your [watchtower](keys-and-recovery.md#the-watchtower), or the
  casino's own watcher.

A close that stops short of a pending casino bet its quote covers, such as one the casino starts on the checkpoint
before it, is challenged by disputing the bet: **Challenge the close** sends `dispute`, and the casino settles the bet
as any [disputed one](#dispute-a-casino-bet).

The wallet sends a challenge only when you press the button. Once the deadline has passed, the proposed state is final
and the wallet says so.

## Claims and collection

Finalizing records a claim for what the close is owed ([finalization](../reference/contract.md#finalization)), in two
parts:

- **Protected amount**, what the deposits and collateral the contract holds for the channel cover of it: paid in full
  whenever the claim is collected.
- **Winnings**, the rest: they join [the winnings queue](../reference/contract.md#the-winnings-queue), first in, first
  out.

A withdrawal or a lock-in is a claim too, under its ID, with its protected amount and winnings worked out the same way
when it is recorded.

**Waiting to be paid**, above the wallet's tabs, lists every claim of this account that is still owed something, a closed
balance's or a withdrawal's, 20 at a time, those of older channels included, with where it pays, what it is owed and
what can be collected now:

- **Collect** sends `claim(id)`, which anyone may send. It pays the claim's protected amount and whatever of its
  winnings house cash reaches to the claim's recipient: your account for a closed balance and the withdrawal's address
  for a withdrawal, unless you have redirected it.
- **Collect there**, with an address, sends `claimTo(id, recipient)`, which only your
  account may send. It makes `recipient` the claim's recipient, for this collection and every later one, and pays. The
  contract's own address puts what it pays into your balance's channel as deposits.
- **Export evidence**, beside a closed balance's claim, saves the recovery bundle of its channel.

A claim collects what of its winnings house cash covers, however far back it waits, and can be collected again as more
cash arrives; the owner can never withdraw a protected amount or unpaid winnings. A recipient that rejects the payment,
or needs more gas to accept it than [the contract sends](../reference/contract.md#functions-that-change-state), makes
the collection revert and leaves the claim whole: collect to another address.

## Fees and gas

Depositing, closing, challenging, finishing a close and collecting are transactions from your account.
The wallet caps each at 2,000,000 gas, 200 gwei per gas and 50,000 METH in total fees, and stops before signing when the
network's estimate is higher; the casino cannot raise these caps. The casino sends withdrawals and lock-ins to the
contract and pays their gas, and each pays the casino a fee for it out of your balance, set from the network's gas price
([`GET /api/withdrawal-fee`](../casino-api/public.md#get-apiwithdrawal-fee)). The wallet asks for it when the Withdraw
tab opens and again before signing, and signs none above 300,000 gas at the gas price it reads itself, or above the fee
it showed you. A deposit's fee comes out of what it deposits, and the casino pays it into your balance when it is small
([deposit](getting-started.md#deposit)). Every other transaction needs its fee at your deposit address, where the wallet
keeps nothing back: with **Add ETH that arrives at my deposit address to my balance** on, what arrives goes into your
balance while the channel is active. Starting **Close without the casino** turns that off, so ETH sent for its fee stays
at the address even if starting the close fails. A failure before signing leaves the balance open, and the close can be
tried again; a signed close keeps its saved transaction to retry. Recovery shows the ETH the address holds for fees. You
can also turn it off under **Deposits** in Settings and send ETH to the address, or have somebody relay the transaction:
anyone can send all of them but `startClose` and `claimTo`
([callers](../reference/contract.md#functions-that-change-state)). A pending transaction shows **Retry** and **Speed
up** ([when a reply is lost](keys-and-recovery.md#when-a-reply-is-lost)).
