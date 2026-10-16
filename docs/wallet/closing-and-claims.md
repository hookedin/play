---
title: Closing and claims
description: Collateral, locking in your balance, how a withdrawal is paid, closing without the casino, the 7-day challenge window and collecting a claim.
sidebar:
  order: 3
---

Your balance is your account's current channel in the HookedIn contract. Withdrawing takes part or all of it out while
the channel stays active; without the casino, you close the channel alone, with your latest evidence and a 7-day window,
and then collect what it is owed. **Waiting to be paid**, in the wallet, lists what the contract still owes you, and
Settings shows what protects your balance under **Protection** and, under **Recovery**, the channel behind your balance
and any older one still closing, with the ways to close and collect, which all but locking in work without the casino.

## Collateral

**Protection** shows what the contract holds for your balance once it has recorded every withdrawal it owes: your
deposits, and your collateral, the casino's cash locked into your channel. (A withdrawal made on another device, whose
proof this browser lacks, counts as paid out of all your deposits.) Beside them is how much of your balance they protect
and how much more you could win and have protected: the rest of your balance is winnings, which only house cash pays. A
deposit a reorganisation of the chain undid is shown apart: a close is owed it only once it lands again.

Collateral protects what you win before you win it. The casino offers it at its rate, a share of the amount paid once.
Enter an amount and **Buy for … METH**: the wallet asks the casino for an offer, checks its signature and price, and
buys it on-chain from your deposit address, which pays the price and the network fee
([contract](../reference/contract.md#collateral)). In that one transaction the contract moves that much house cash into
your channel, out of the casino's reach, or the purchase reverts and only the fee is spent. An offer holds for an hour,
for as much as house cash and the [payout limit](../reference/contract.md#the-payout-limit) allow. When your deposit
address holds too little, Protection says how much to send and by when, and the wallet buys as soon as it arrives; once
your balance has started closing it buys nothing.

Withdrawals and a close are paid out of your deposits first, then your collateral, and only then house cash, so
withdrawing uses collateral up, and nothing tops it up. Collateral adds nothing to what you are owed and lasts until
your channel closes, when what the close is not owed returns to house cash. It has no minimum term, since the casino can
close a channel at any time, as it does an [idle](#idle-channels) one, and its price is never refunded.

## Lock in your balance

**Lock in my balance**, under Recovery, turns your winnings into deposits: your account signs a lock-in, a
[withdrawal](#withdraw) into your own channel of all your balance but the fee, which the contract pays like any
withdrawal, but as deposits. It closes the open game first, and your balance is empty until it has taken those deposits
in ([Activity](bets-and-receipts.md#activity) shows **Locking in**, then **Balance locked in**). It works while the
channel is active and part of your balance is unprotected, and the casino declines one house cash cannot pay now. Once
it is in, a close pays all of that balance out of deposits, until you win more.

## Withdraw

A [withdrawal](getting-started.md#withdraw) is an operation your account signs that names the address it pays as its
`recipient`; your balance pays it and the casino's fee for sending it ([fees and gas](#fees-and-gas)). The casino signs
the checkpoint after it at once and sends the operation, with that signature, to the contract's `withdraw` ([functions
that change state](../reference/contract.md#functions-that-change-state)). Your receipt holds that evidence, and anyone
may send it. The contract records each withdrawal once, under its ID, the hash of its operation, in the order you made
them, and pays it out of the deposits your balance had taken in when you made it, then your [collateral](#collateral).
The rest, the winnings, joins the queue of every claim's winnings, paid at once as far as house cash and the payout
limit allow and otherwise owed under **Waiting to be paid** ([claims and collection](#claims-and-collection)). A
recipient that refuses the payment leaves all of it owed. On-chain, `claims(id)` says what the contract still owes of a
withdrawal, and its `Withdrawal` [event](../reference/contract.md#events) to whom, how much and in which transaction it
was recorded.

The casino takes a withdrawal on only when the contract can pay all of it now, out of your deposits, your collateral and
house cash no claim counts on, so it is normally paid in full when sent. It declines the rest, _At most … METH can be
withdrawn now_, and one to a contract that would refuse the payment or needs more gas to take it than the contract
gives, _That address does not accept a payment from the contract_; an address without code takes any payment. Anyone can
send a withdrawal the casino has not, from its entry in [Activity](bets-and-receipts.md#activity), until its channel's
close is finished; one nobody sent by then comes back to you with the close, not to its address.

## Close without the casino

1. Press **Close without the casino** under Recovery, or in the banner of a pending operation. Your account sends
   `startClose` with your latest evidence, paying its fee from the deposit address ([fees and gas](#fees-and-gas)), or
   `dispute` with a pending covered casino bet ([dispute a casino bet](#dispute-a-casino-bet)). Only your account or the
   casino's signer can start a close.
2. The deadline is 7 days after the block that started the close
   ([`CHALLENGE_PERIOD`](../reference/contract.md#constants)); Recovery shows it.
3. Once it has passed, press **Finish the close**: anyone can send `finalizeClose`, which records the claim at the state
   the close ended with.
4. [Collect the claim](#claims-and-collection).

The evidence is your latest countersigned checkpoint, or the channel's base while nothing has been signed, alone or
followed by the last operation the casino signed ([finalization](../reference/contract.md#finalization)). A close,
whoever starts it, moves your account to its next channel at once. It pays your deposit address, where the wallet adds
nothing to a balance by itself until your next balance has a deposit ([when ETH waits at the
address](getting-started.md#when-eth-waits-at-the-address)).

## Dispute a casino bet

A casino bet its [quote](../overview/how-it-works.md#quotes) covers that the casino declines or leaves unanswered stays
saved in the wallet, which countersigns no rejection of it unless the casino proves it a game's operation your account
carried out on another channel. Its banner says until when the quote covers it.

**Close without the casino** then sends `dispute` with your latest evidence, the bet, its seed and the quote, which the
contract checks ([disputes](../reference/contract.md#disputes)). The close counts the bet as won, and its deadline is 7
days after the dispute, the time the casino has to settle the bet with the round's secret; should it not, the close
finishes with the bet won. Meanwhile the dispute locks what winning the bet adds above your deposits and collateral into
your collateral, out of the house cash free when it is mined and as far as the payout limit allows: it pays the close if
the bet stays won, and once the casino settles it, returns to house cash but for what the close is then owed above your
deposits and other collateral. Recovery shows it. Anyone can send the dispute, from the channel's [recovery
bundle](keys-and-recovery.md#recovery-bundles), as a [watchtower](keys-and-recovery.md#the-watchtower) does.

A dispute must be mined before the quote expires. The wallet sends a bet's seed only on a quote with at least half its
day left, so an unanswered bet has at least 12 hours to be disputed. After the quote expires the wallet still takes no
decline of the bet, and sends it again without its seed: it cannot be disputed then, and **Close without the casino**
ends the balance with the bet void. On **Retry** the wallet takes up no later state of the casino's in place of the bet
unless your account signed past it, from another device.

## Idle channels

When nobody has played on your channel for 7 days, it holds more deposits and collateral than it is owed by more than
the gas of closing it, and no withdrawal from it is owed, the casino closes it on its latest state, so what you lost,
and the collateral it holds, returns to house cash. After the close's 7 days the casino finishes it and collects what it
pays you to your deposit address. Your next deposit goes into your next channel.

## Challenges

A close can be started on a state older than yours, by the casino or from an old copy of your evidence. The wallet then
warns you and offers **Challenge the close**, which sends `challengeClose` with your newer evidence: it must carry a
strictly higher sequence and be mined before the deadline, which it never extends, and anyone holding the evidence can
send it, such as your [watchtower](keys-and-recovery.md#the-watchtower) or the casino's own watcher. A close that stops
short of a pending covered casino bet, such as one the casino starts on the checkpoint before it, is challenged by
disputing the bet. The wallet sends a challenge only when you press the button; after the deadline, the proposed state
is final.

## Claims and collection

Finalizing records a claim for what the close is owed ([finalization](../reference/contract.md#finalization)) in two
parts: the **protected amount**, what the deposits and collateral the contract holds for the channel cover, paid in full
whenever the claim is collected, and the **winnings**, the rest, which join [the winnings
queue](../reference/contract.md#the-winnings-queue), first in, first out. A withdrawal or a lock-in is a claim too,
under its ID, split the same way. **Waiting to be paid**, above the wallet's tabs, lists every claim of the account
still owed something, older channels' included, with where it pays, what it is owed and what can be collected now:

- **Collect** sends `claim(id)`, which anyone may send: it pays the protected amount, and whatever of the winnings house
  cash and the payout limit allow, to the claim's recipient, your account for a closed balance and the withdrawal's
  address for a withdrawal, unless you have redirected it.
- **Collect there**, with an address, sends `claimTo(id, recipient)`, which only your account may send: it makes
  `recipient` the claim's recipient from then on, and pays. The contract's own address pays into your balance's channel
  as deposits.
- **Export evidence**, beside a closed balance's claim, saves its channel's recovery bundle.

A claim can be collected again as more cash arrives or the payout limit refills, and the treasury can never withdraw a
protected amount or unpaid winnings. A recipient that rejects the payment makes the collection revert and leaves the
claim whole: collect to another address.

## Fees and gas

Depositing, closing, challenging, finishing a close and collecting are transactions from your account. The wallet caps
each at 2,000,000 gas, 200 gwei per gas and 50,000 METH in total fees, and stops before signing when the network's
estimate is higher; the casino cannot raise these caps. The casino sends withdrawals and lock-ins and pays their gas,
for a fee out of your balance set from the gas price
([`GET /api/withdrawal-fee`](../casino-api/public.md#get-apiwithdrawal-fee)), and the wallet signs none above 350,000
gas at the gas price it reads itself, or above the fee it showed you. A deposit's fee comes out of what it deposits
([deposit](getting-started.md#deposit)).

Every other transaction needs its fee at your deposit address, where the wallet keeps nothing back. Starting **Close
without the casino** turns off **Add ETH that arrives at my deposit address to my balance**, so ETH sent for its fee
stays there even if starting the close fails; Recovery shows what the address holds. Or have somebody relay the
transaction: anyone can send all of them but `startClose` and `claimTo`
([callers](../reference/contract.md#functions-that-change-state)). A failure before signing can be tried again, a signed
close keeps its saved transaction to retry, and a pending transaction shows **Retry** and **Speed up** ([when a reply is
lost](keys-and-recovery.md#when-a-reply-is-lost)).
