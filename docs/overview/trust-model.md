---
title: Trust model
description: What the contract enforces, what you trust the casino and game developers for, and what you do yourself.
sidebar:
  order: 2
---

The contract protects what it owes: your deposits, the collateral locked into your channel and your recorded winnings,
from everyone, the owner included, while your key is yours alone. Everything else depends on the casino: house cash,
winnings not yet recorded and the wallet play.hookedin.com serves, which holds your key unless you [build your
own](../wallet/keys-and-recovery.md#your-own-build). You protect a win by recording it, with a withdrawal or a lock-in,
or before you win it by buying collateral, keep your evidence and watch your channel. A game, its developer and a
bankroll fund share each carry trust of their own, set out below. To trust the casino with none of it,
[play with zero trust](zero-trust.md).

## What the contract enforces

- **Your deposits are protected up to your final balance.** The contract holds every deposit as it arrives, as your
  channel's principal, and the owner cannot withdraw it. Withdrawals and a close are paid out of it first, a withdrawal
  only out of the deposits its balance had taken in ([withdrawals](../reference/contract.md#withdrawals),
  [finalization](../reference/contract.md#finalization)). Only winnings above your deposits and collateral depend on the
  shared bankroll.
- **Collateral protects winnings before they are won.** [Collateral](../wallet/closing-and-claims.md#collateral) bought
  for your channel is house cash the contract holds for it, where the owner cannot withdraw it, until withdrawals use it
  up or the channel closes.
- **Withdrawals are paid by the contract.** With the casino's signature of the balance after a withdrawal, which your
  receipt keeps, anyone can have the contract record it as a claim, once and in the order you made them, until the
  channel's close is final; the contract pays at once what is covered and owes the rest
  ([withdrawals](../reference/contract.md#withdrawals)). One never recorded comes back to you with the close. A lock-in
  is a withdrawal into your own channel, paid into it as deposits.
- **Losses are real.** A close is owed your final balance, and the deposits above that return to house cash. Nothing refunds what you lost.
- **Only signed states settle.** A close settles a balance both sides signed, or the channel's base, which needs no
  signature, either alone or followed by one operation your account authorized and the casino signed, settled by the
  secret and seed that hash to what the bet named, or by a casino bet the casino's quote covers, disputed.
  [Finalization](../reference/contract.md#finalization) says what such a state is owed. Every signature is bound to the
  chain and to this contract.
- **A casino bet its quote covers is settled.** Every reply brings the casino's signed
  [quote](../reference/signed-messages.md#quotes) for your next casino bet, and the casino must settle every bet it
  covers. One it leaves unsettled, anyone with your evidence disputes before the quote expires, which closes your
  channel with it: it counts as won unless the casino settles it on-chain with the round's secret before the close ends,
  and what it would win is held out of house cash meanwhile, as far as it is free
  ([disputes](../reference/contract.md#disputes)).
- **You can leave alone.** With your latest evidence you can start a close, and anyone can finalize it after its 7-day
  window and collect the claim, with no casino server involved ([close without the
  casino](../wallet/closing-and-claims.md#close-without-the-casino)), whether the contract holds anything for your
  channel or not: there is nothing to open.
- **Recorded winnings come before the owner.** Finalizing a close, or recording a withdrawal, records its unpaid
  winnings permanently in [the winnings queue](../reference/contract.md#the-winnings-queue): no later claim can take
  cash ahead of them, and the owner cannot withdraw the cash they are owed. Winnings not yet recorded have none of this.
- **The contract is fixed.** It cannot be upgraded or paused, and its owner is set once, by deploying it.

[The contract reference](../reference/contract.md) has every function and the conditions it checks.

## What you trust the casino for

- **One operator signs and holds the bankroll.** The account that deployed the contract is its owner and the only
  settlement signer. It controls the house bankroll, including through signed winning balances for accounts it controls:
  the bankroll is trusted to it, not protected from it.
- **Serving the wallet.** play.hookedin.com serves the wallet, which holds your key: a wallet served to take it could
  take everything your account holds, deposits included. It publishes each commit to this repository's `main` that
  passes its tests, which anyone can [rebuild and compare](../reference/deployment.md#verify-a-release), but your
  browser runs whatever it is sent. [Your own build](../wallet/keys-and-recovery.md#your-own-build), with a key you
  never use at play.hookedin.com, needs no such trust.
- **Paying winnings.** What your balance holds above your deposits and collateral, your winnings, is an unsecured claim
  on the shared bankroll: a withdrawal's winnings and a close's wait in the queue for house cash. Neither replenishment nor a payout
  deadline is guaranteed, and the ETH visible in the contract does not prove that every signed balance is covered. This
  is a deliberate choice of capital efficiency. Until a win is recorded, the cash that would pay it is house cash, which
  the owner can withdraw. A dispute locks a disputed bet's win only out of house cash that is free when it is mined: an
  owner that withdraws first, or keeps no house cash, leaves the win to the queue.
- **The bankroll overcommits.** Each quote admits bets against the whole virtual bankroll for a day, so the bets on many
  quotes can together win more than the bankroll holds; what it cannot pay waits in the winnings queue
  ([limitations](architecture.md#limitations)).
- **Sending withdrawals.** The casino takes on a withdrawal only when your deposits, your collateral and the house cash
  it can count on cover all of it, and declines it otherwise, so a withdrawal is normally paid in full the moment it is
  sent. It sends each it takes on to the contract once, oldest first and one transaction at a time, and owes it until a
  confirmed block shows it recorded, whoever sent it, or its channel's close final without it. One it cannot send yet
  waits while the next is sent, and its public status says why. Play never waits for a withdrawal. It pays the gas, and
  charges a [fee](../casino-api/public.md#get-apiwithdrawal-fee) for it.
- **Transfers between players.** A [transfer](../wallet/getting-started.md#transfer) is off-chain, so the contract never
  sees it: the casino owes it to the player you named until their wallet collects it. The casino alone knows which
  account a name belongs to, so you trust it to pay the player you named, and that player trusts it to pay what waits
  for them; nothing signed says who goes by a uname. Once collected, it is winnings like any balance above their own
  deposits and collateral.
- **Admitting bets.** The casino admits each casino bet against its quote's virtual bankroll with a Kelly rule, and
  sets its commission against the same figure. It names the virtual bankroll it quotes: half its bankroll, by its own
  books.
- **Completing bets.** The casino settles every casino bet its quote covers; the wallet sends a bet's seed only then.
  It can decline any other operation, go offline or never answer, with no protocol penalty. A rejection is a signed
  checkpoint that leaves the balance unchanged, and an unanswered operation settles at the latest completed state, but a
  covered casino bet, which you dispute. A declined casino bet reveals nothing: its round stays secret and takes your
  next bet. The casino declines a covered bet only as a game's operation you carried out on another channel, with the
  operation your account signed there as proof. A completed result cannot change.
- **Keeping its record.** It records every response it signs durably before the response leaves it, so retrying an
  operation ID returns the same accepted or rejected receipt, also after a restart, and a game's operation its player
  already carried out on another channel is declined, never carried out twice. It discloses at most one signed outcome
  for a channel position, which the contract does not check: a casino that also signed a withdrawal it declined could
  have that recorded, and the withdrawals you made after it then only come back to you with the close. It settles on
  each round's secret at most once; a round whose secret was lost settles nothing, so a covered bet on it, disputed, is
  paid as won. Every reply on a channel brings its signature of where that record ends, which the wallet holds it to, so
  a record rewritten up to there shows ([the casino's history](../wallet/keys-and-recovery.md#the-casinos-history)). A
  persistence failure stops all further signing, and play pauses while its view of the chain is stale or while it
  reconciles after a restart or a reorg. It runs the exact protocol revision it pins from this repository.
- **Watching channels.** It closes a channel nobody has played on for 7 days
  ([idle channels](../wallet/closing-and-claims.md#idle-channels)), challenges stale closes of the channels it knows and
  settles the casino bets disputed on them, in its own interest: its watcher does not protect you against the casino.
- **What it reports.** Commission, the bankroll figure it reports, the fund's share price and each developer's earnings
  tally are the casino's word.

These are an operator's promises, but for settling a covered casino bet, which the contract enforces. The wallet is
built not to need them: it verifies every signature, preimage and balance change itself, keeps the evidence, can send a
withdrawal to the contract without the casino and can settle on-chain alone, by closing and by disputing. What it cannot
verify is availability, liquidity and the code play.hookedin.com serves.

## What you do yourself

- **Watch your channel.** Either side can start a unilateral close, and the casino could close with an older signed
  state. A challenge with your newer evidence must be mined within 7 days of the close starting, or the older, lower
  balance becomes final. Opening the wallet does not send a challenge: you press **Challenge the close**, or run a
  [watchtower](../wallet/keys-and-recovery.md#the-watchtower).
- **Dispute a covered bet the casino leaves unsettled.** A casino bet its quote covers that the casino declines or does
  not answer stays saved in the wallet, which disputes it when you press **Close without the casino**, or **Challenge
  the close** when the casino closes short of it. Its recovery bundle carries it, so a
  [watchtower](../wallet/keys-and-recovery.md#the-watchtower) disputes it for you. The dispute must be mined before the
  quote expires.
- **Keep your key, and your evidence.** Your key is your account, and its passkey or key file is the only copy outside this browser. Your latest
  signed state is your proof. The wallet keeps it, and on another device takes up the casino's copy, which is the
  casino's word; export recovery bundles to settle without trusting it
  ([keys and recovery](../wallet/keys-and-recovery.md)).
- **Record what you win.** What your balance holds above your deposits and collateral is the casino's to pay until it
  is recorded: withdraw it, or [lock it in](../wallet/closing-and-claims.md#lock-in-your-balance), which records it and
  pays what house cash covers into your channel as deposits. [Collateral](../wallet/closing-and-claims.md#collateral)
  protects what you win next before you win it.
- **Keep ETH for the exit.** Closing, challenging, finalizing and collecting are transactions, and your account pays
  their fees from the deposit address, where the wallet keeps nothing back
  ([fees and gas](../wallet/closing-and-claims.md#fees-and-gas)). Anyone can send a challenge, a dispute, a
  finalization or a collection for you.
- **Set each game's allowance.** You choose how much each game may play with, and the wallet holds it to that. A game
  places developer bets only once you have allowed them too, after a warning that its developer decides what they pay.

## What a game can and cannot do

A game can:

- ask for casino bets and payments up to the allowance you give it, and developer bets once you allow them;
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

A developer bet is a bet against the game's developer, not the bankroll. Its stake goes into the game's bank at the
casino as it is placed, and it is paid what the game's server settles, from that bank, with no escrow, no deadline and
no refund. The wallet checks that the settlement is signed by the developer's key or by a server key the developer
named for the game in a signed `GameServer`, and nothing about what the bet should have paid. A developer can keep a
stake by never settling; the game's public record then shows the bet as open.

A game can make its developer bets provably fair with a scheme of its own, which anyone can check against what the
casino publishes; [roulette](https://github.com/hookedin/game-roulette#fairness-and-trust) does. What a developer bet
is paid is the casino's promise until your wallet collects it, and until then it is outside what the contract
protects. A game's bank reserves nothing: whether a developer can pay its bets is between the developer and its
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
- every quote: the casino's signature, the checkpoint and round it names, and whether it covers a casino bet, before the
  bet's seed goes;
- every collateral offer: the casino's signature, the channel and amount it names, and that its price is the casino's
  rate, before buying it;
- every rejection, and that it declines no casino bet a quote covers but one the account signed on another channel;
- developer settlements and the developer's naming of the key that signed them, share statements, bank statements and
  the fund's quote, by their signatures and what they refer to;
- whether the contract has recorded each withdrawal, by its ID, and what it still owes of it;
- the casino's history, against the newest [head](../reference/signed-messages.md#history-heads) of it the casino
  signed;
- game URLs and every bridge request.

It takes on the casino's word: commission, the virtual bankroll a quote names, the withdrawal fee up to [the wallet's
cap](../wallet/closing-and-claims.md#fees-and-gas), the fund's equity and total shares, a game's bank and the commission
that went into it, and, on a device without your evidence, that the state it holds of your balance is the latest.
It takes on the developer's word what a developer bet pays and which bet a collapsed step draws, and on the game's word
everything a game shows.
