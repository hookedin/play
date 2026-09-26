---
title: Trust model
description: What the contract enforces, what you trust the casino and game developers for, and what you do yourself.
sidebar:
  order: 2
---

The contract enforces how a channel settles. The casino is trusted for its bankroll, its accounting and its
availability. You keep your evidence and watch your channel. A game, its developer and a bankroll fund share each
carry trust of their own, set out below.

## What the contract enforces

- **Your deposit is protected while the channel is open.** The contract counts every open deposit as protected
  principal. The owner can withdraw only what the contract holds beyond protected principal and finalized winnings.
- **Losses are real.** At closure the contract protects `min(deposit, balance)`. It does not refund what you lost.
- **Only signed states settle.** A channel closes to a balance both sides signed, or to that balance plus one operation
  the channel key authorized and the casino signed, settled by the secret and seed that hash to what the bet named.
  Every signature is bound to the chain and to this contract.
- **You can leave alone.** With your latest evidence you can start a close, and anyone can finalize it and collect the
  claim, with no casino server involved. The challenge window is a fixed 24 hours, and a challenge never extends it.
- **Winnings are recorded, and paid in order.** Finalizing records unpaid winnings permanently. The contract pays them
  first in, first out as cash arrives, a later claim cannot take cash ahead of an earlier one, and the owner cannot
  withdraw them.
- **The contract is fixed.** It cannot be upgraded or paused, and its owner is set once, by deploying it.

[The contract reference](../reference/contract.md) has every function and the conditions it checks.

## What you trust the casino for

- **One operator signs and holds the bankroll.** The account that deployed the contract is its owner and the only
  settlement signer. It controls the house bankroll, including through signed winning balances for accounts it controls:
  the bankroll is trusted to it, not protected from it.
- **Paying winnings.** Anything above your deposit is an unsecured claim on the shared bankroll. Neither replenishment
  nor a payout deadline is guaranteed, and the ETH visible in the contract does not prove that every signed balance is
  covered. This is a deliberate choice of capital efficiency ([architecture](architecture.md#money-and-authority)).
- **Admitting bets.** The casino sizes each casino bet against its bankroll with a Kelly rule and sets its commission.
  That is its own risk management: the contract does not enforce it and the wallet does not check it.
- **Completing bets.** The casino can decline a casino bet, go offline or never answer, with no protocol penalty. A
  rejection is a signed checkpoint that leaves the balance unchanged, and an unanswered operation settles at the latest
  completed state. A declined casino bet's round is revealed with the rejection, so selective rejection shows on your
  receipts; it is not prevented. What the casino has signed, it cannot change.
- **What it reports.** Commission, the bankroll figure it reports, the fund's share price and each developer's earnings
  tally are the casino's word.
- **Test coins.** A test channel exists only at the casino. Its balance is the casino's record and settles nowhere.

## What you do yourself

- **Watch your channel.** Either side can start a unilateral close, and the casino could close with an older signed
  state. A challenge with your newer evidence must be mined within 24 hours of the close starting, or the older, lower
  balance becomes final. Opening the wallet does not send a challenge: you press **Challenge stale close**, or run a
  [watchtower](../wallet/backups-and-recovery.md#the-watchtower). The casino's own watcher defends channels in the
  casino's interest, not yours.
- **Keep your evidence.** Your latest signed state is your proof. Export recovery bundles, and keep an encrypted backup
  of every account you fund: a key alone cannot rebuild an off-chain balance
  ([backups and recovery](../wallet/backups-and-recovery.md)).
- **Keep ETH for the exit.** Closing, challenging, finalizing and collecting are transactions. The wallet keeps 0.001 ETH
  aside when you deposit, a floor rather than a guaranteed budget.
- **Set each game's limit.** You choose how much each game may play with, and the wallet holds it to that.

## What a game can and cannot do

A game can:

- ask for casino bets, developer bets and payments, up to the limit you give it;
- lose its whole limit, winnings included, on bets that pay back little;
- show you whatever it likes.

A game cannot:

- see your keys, your address, your channels or your balances;
- see the secret of your round, or the seed your wallet picked, before the result;
- ask the wallet for any signature but its own bets and payments;
- spend a wei beyond its limit, or change who earns its commission.

The wallet verifies each casino bet completely (its odds, its outcome and what it pays) and records its return, but it
does not refuse a bet for paying back little. It does not check a game's advertised rules, how a game's steps combine,
or the files a game serves. Playing a game trusts its developer for its tables
([games and limits](../wallet/games-and-limits.md)).

A single-player step with more than two outcomes is one casino bet that the page draws with its own randomness
([collapsing bets](../games/collapsing-bets.md)). The wallet knows nothing of the distribution it was drawn from:
which bet the page draws, and so the odds of the game, are the developer's word. A modified page could choose its bet
outright; each bet is admitted by itself, so that cannot harm the bankroll, only misrepresent the game to its player.

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

**Roulette.** Neither the casino nor the wheel alone can choose the pocket. The wheel walks to it in binary steps, each
a casino bet on its own round, and signs which side each step backs in its meta before that round is revealed. The
casino does not know the wheel's seed, and the wheel does not know the casino's secret. A step the bankroll declines
still reveals its round: it changes only whether the bankroll or the wheel's bank backs that level, never the pocket.

## Fund shares are the casino's promise

The [bankroll fund](../wallet/bankroll-fund.md) is a trust arrangement. A share is a statement the casino signs: no
contract holds it, the casino alone states the price, the bankroll can lose, and the casino could take the money. What
the design gives a holder is proof of what they hold, which the casino cannot deny, and a public record of the owner
taking more than the house owns.

## What the wallet checks

The wallet checks:

- the deployment: the contract's code, owner, chain and address, and the casino's protocol revision
  ([verify a release](../wallet/verify-a-release.md#what-the-wallet-checks-on-start));
- the chain, through two independent RPCs on Sepolia, at blocks both agree on;
- every result: that the operation is the one it signed, that it follows the saved checkpoint, the revealed secret and
  seed, the outcome and what the bet pays on it, the balance arithmetic, and the casino's signature;
- every rejection, and the round it reveals;
- developer settlements, share statements, bank statements and the fund's quote, by their signatures and what they
  refer to;
- game manifests and every bridge request.

It takes on the casino's word: commission, the bankroll figure, the fund's equity and total shares, the developer
earnings tally and a developer bank's balance. It takes on the developer's word what a developer bet pays and which bet
a collapsed step draws, and on the game's word everything a game shows.
