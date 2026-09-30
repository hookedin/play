---
title: Trust model
description: What the contract enforces, what you trust the casino and game developers for, and what you do yourself.
sidebar:
  order: 2
---

The contract enforces how a channel settles and pays its withdrawals. The casino is trusted for its bankroll, its
accounting and its availability. You keep your evidence, take out or lock in what you win and watch your channel. A
game, its developer and a bankroll fund share each carry trust of their own, set out below.

## What the contract enforces

- **Your deposits are protected up to your final balance.** The contract holds every deposit as it arrives, as your
  channel's principal, and the owner cannot withdraw it. Withdrawals are paid out of it first, and a close pays
  `min(owed, principal)` out of it in full. Only winnings above your deposits depend on the shared bankroll.
- **Withdrawals are paid by the contract.** A withdrawal is an operation your account signs. With the casino's signature
  of the balance after it, which your receipt keeps, anyone can have the contract record it as a claim, once, until the
  channel's close is final, and only after every withdrawal you made before it, so nobody can make a lock-in take less
  of your deposits than it should. The contract pays at once what your deposits and house cash cover and owes the rest;
  a recipient that refuses the payment leaves all of it owed. One never recorded comes back to you with the close.
- **Losses are real.** A close is owed your final balance, and the deposits above it return to house cash. Nothing
  refunds what you lost.
- **Only signed states settle.** A close settles a balance both sides signed, or the channel's base, which needs no
  signature, either alone or followed by one operation your account authorized and the casino signed, settled by the
  secret and seed that hash to what the bet named. [Finalization](../reference/contract.md#finalization) says what such
  a state is owed. Every signature is bound to the chain and to this contract.
- **You can leave alone.** With your latest evidence you can start a close, and anyone can finalize it and collect the
  claim, with no casino server involved. The challenge window is a fixed 24 hours, and a challenge never extends it.
- **Winnings are recorded, and paid in order.** Finalizing a close, or recording a withdrawal, records its unpaid
  winnings permanently. The contract pays them first in, first out as cash arrives, no later claim can take cash ahead
  of an earlier one, and the owner cannot withdraw them.
- **The contract is fixed.** It cannot be upgraded or paused, and its owner is set once, by deploying it.

[The contract reference](../reference/contract.md) has every function and the conditions it checks.

## What you trust the casino for

- **One operator signs and holds the bankroll.** The account that deployed the contract is its owner and the only
  settlement signer. It controls the house bankroll, including through signed winning balances for accounts it controls:
  the bankroll is trusted to it, not protected from it.
- **Paying winnings.** What your balance holds above your deposits, your winnings, is an unsecured claim on the shared
  bankroll: a withdrawal's winnings and a close's wait in the queue for house cash. Neither replenishment nor a payout
  deadline is guaranteed, and the ETH visible in the contract does not prove that every signed balance is covered. This
  is a deliberate choice of capital efficiency.
- **Sending withdrawals.** The casino takes on a withdrawal only when your deposits and the house cash it can count on
  cover all of it, and declines it otherwise, so a withdrawal is normally paid in full the moment it is sent. It sends
  each it takes on to the contract once, oldest first and one transaction at a time, and owes it until a confirmed block
  shows it recorded, whoever sent it, or its channel's close final without it. One it cannot send yet waits while the
  next is sent, and its public status says why. Play never waits for a withdrawal.
- **Admitting bets.** The casino sizes each casino bet against its bankroll with a Kelly rule and sets its commission.
  That is its own risk management: the contract does not enforce it and the wallet does not check it.
- **Completing bets.** The casino can decline a casino bet, go offline or never answer, with no protocol penalty. A
  rejection is a signed checkpoint that leaves the balance unchanged, and an unanswered operation settles at the latest
  completed state. A declined casino bet's round is revealed with the rejection, so selective rejection shows on your
  receipts; it is not prevented. What the casino has signed, it cannot change.
- **Keeping its record.** It records every response it signs durably before the response leaves it, so retrying an
  operation ID returns the same accepted or rejected receipt, also after a restart, and a game's operation its player
  already carried out on another channel is declined, never carried out twice. It signs at most one outcome for a
  channel position and settles on each round's secret at most once; a round whose secret was lost settles nothing. A
  persistence failure stops all further signing, and play pauses while its view of the chain is stale or while it
  reconciles after a restart or a reorg. It runs the exact protocol revision it pins from this repository.
- **Watching channels.** It closes a channel nobody has played on for 7 days
  ([idle channels](../wallet/closing-and-claims.md#idle-channels)), and challenges stale closes of the channels it
  knows, in its own interest: its watcher does not protect you against the casino.
- **What it reports.** Commission, the bankroll figure it reports, the fund's share price and each developer's earnings
  tally are the casino's word.

These are an operator's promises. The contract enforces none of them, and the wallet is built not to need them: it
verifies every signature, preimage and balance change itself, keeps the evidence, can send a withdrawal to the contract
itself and can settle on-chain alone, by closing. What it cannot verify is availability, liquidity and whether every
requested casino bet is completed.

## What you do yourself

- **Watch your channel.** Either side can start a unilateral close, and the casino could close with an older signed
  state. A challenge with your newer evidence must be mined within 24 hours of the close starting, or the older, lower
  balance becomes final. Opening the wallet does not send a challenge: you press **Challenge the close**, or run a
  [watchtower](../wallet/backups-and-recovery.md#the-watchtower).
- **Keep your evidence.** Your latest signed state is your proof. Export recovery bundles, and keep an encrypted backup
  of every account you fund: a key alone cannot rebuild an off-chain balance
  ([backups and recovery](../wallet/backups-and-recovery.md)).
- **Take out or lock in what you win.** What your balance holds above your deposits is a claim on the shared bankroll
  until the contract pays it: withdraw it, or [lock it in](../wallet/closing-and-claims.md#lock-in-your-balance).
- **Keep ETH for the exit.** Closing, challenging, finalizing and collecting are transactions, and your account pays
  their fees from the deposit address, where the wallet keeps nothing back
  ([fees and gas](../wallet/closing-and-claims.md#fees-and-gas)). Anyone can send a challenge, a finalization or a
  collection for you.
- **Set each game's allowance.** You choose how much each game may play with, and the wallet holds it to that.

## What a game can and cannot do

A game can:

- ask for casino bets, developer bets and payments, up to the allowance you give it;
- lose its whole allowance, winnings included, on bets that pay back little;
- show you whatever it likes.

A game cannot:

- see your keys, your address, your channels or your balances;
- see the secret of your round, or the seed your wallet picked, before the result;
- ask the wallet for any signature but its own bets and payments;
- spend a wei beyond its allowance, or change who earns its commission.

The wallet verifies each casino bet completely (its odds, its outcome and what it pays) and records its return, but it
does not refuse a bet for paying back little. It does not check a game's advertised rules, how a game's steps combine,
which bet a collapsed step draws, or the files a game serves. Playing a game trusts its developer for its tables
([games and their allowances](../wallet/getting-started.md#games-and-their-allowances)).

## Developer bets trust their developer

A developer bet is a bet against the game's developer, not the bankroll. Its stake goes into the developer's bank at
the casino as it is placed, and it is paid what the developer settles, from that bank, with no escrow, no deadline and
no refund. The wallet checks that the developer signed the settlement, and nothing about what the bet should have paid.
A developer can keep a stake by never settling; the game's public record then shows the bet as open.

A game can make its developer bets provably fair with a scheme of its own, which anyone can check against what the
casino publishes; [roulette](https://github.com/hookedin/game-roulette#fairness-and-trust) does. What a developer bet
is paid is the casino's promise until your wallet collects it, and until then it is outside the principal the contract
protects. A developer's bank reserves nothing: whether a developer can pay its bets is between the developer and its
players ([settled trade-offs](architecture.md#settled-trade-offs)).

## Fund shares are the casino's promise

The [bankroll fund](../wallet/bankroll-fund.md) is a trust arrangement. A share is a statement the casino signs: no
contract holds it, the casino alone states the price, the bankroll can lose, and the casino could take the money. What
the design gives a holder is proof of what they hold, which the casino cannot deny, and a public record of the owner
taking more than the house owns.

## What the wallet checks

The wallet checks:

- the deployment: the contract's code, owner, chain and address, and the casino's protocol revision
  ([how the wallet pins its deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment));
- the chain, through two independent RPCs on Sepolia, at blocks both agree on;
- every result: that the operation is the one it signed, that it follows the saved checkpoint, the revealed secret and
  seed, the outcome and what the bet pays on it, the balance arithmetic, and the casino's signature;
- every rejection, and the round it reveals;
- developer settlements, share statements, bank statements and the fund's quote, by their signatures and what
  they refer to;
- whether the contract has recorded each withdrawal, by its ID, and what it still owes of it;
- game URLs and every bridge request.

It takes on the casino's word: commission, the bankroll figure, the fund's equity and total shares, the developer
earnings tally and a developer bank's balance. It takes on the developer's word what a developer bet pays and which bet
a collapsed step draws, and on the game's word everything a game shows.
