---
title: Trust model
description: What the contract enforces, what you trust the casino and game developers for, and what you do yourself.
sidebar:
  order: 2
---

The contract protects your deposits, the collateral locked into your channel and your recorded winnings from everyone,
the casino's keys included, and your key is yours alone. Everything else depends on the casino: house cash, winnings not
yet recorded, and the wallet play.hookedin.com serves, which holds your key unless you [build your
own](../wallet/keys-and-recovery.md#your-own-build). A game, its developer and a bankroll fund share carry trust of
their own, below. To trust the casino with none of it, [play with zero trust](zero-trust.md).

## What the contract enforces

- **Your deposits are protected up to your final balance.** Every deposit is your channel's principal, which the
  treasury cannot withdraw. Withdrawals and a close are paid out of it first, a withdrawal only out of the deposits its
  balance had taken in ([withdrawals](../reference/contract.md#withdrawals),
  [finalization](../reference/contract.md#finalization)).
- **Collateral protects winnings before they are won.** [Collateral](../wallet/closing-and-claims.md#collateral) is
  house cash the contract holds for your channel, out of the treasury's reach, until withdrawals use it up or the
  channel closes.
- **Withdrawals are paid by the contract.** With the casino's signature of the balance after a withdrawal, which your
  receipt keeps, anyone can have the contract record it as a claim, once and in the order you made them, until the
  channel's close is final; the contract pays at once what is covered and owes the rest. One never recorded comes back
  to you with the close. A lock-in is a withdrawal paid into your own channel as deposits.
- **Recorded winnings come before the treasury.** A recorded withdrawal's or a finalized close's unpaid winnings join
  [the winnings queue](../reference/contract.md#the-winnings-queue): no later claim takes cash ahead of them, and the
  treasury cannot withdraw the cash they are owed. Winnings not yet recorded have none of this.
- **Losses are real.** A close is owed your final balance, and the deposits above it return to house cash.
- **Only signed states settle.** A close settles a balance both sides signed, or the channel's base, which needs no
  signature, alone or followed by one operation your account authorized and the casino signed, settled by the secret and
  seed that hash to what the bet named, or by a covered casino bet, disputed
  ([finalization](../reference/contract.md#finalization)). Every signature is bound to the chain and to this contract.
- **A casino bet its quote covers is settled.** The casino must settle every bet its signed
  [quote](../reference/signed-messages.md#quotes) covers. One it leaves unsettled, anyone with your evidence disputes
  before the quote expires, closing your channel with it: it counts as won unless the casino settles it on-chain with
  the round's secret before the close ends. Meanwhile its win is held out of the house cash free when the dispute is
  mined, as far as the [payout limit](../reference/contract.md#the-payout-limit) allows; the rest waits in the queue
  ([disputes](../reference/contract.md#disputes)).
- **You can leave alone.** With your latest evidence you can start a close, and anyone can finalize it after its 7-day
  window and collect the claim, with no casino server involved, whatever the contract holds for your channel ([close
  without the casino](../wallet/closing-and-claims.md#close-without-the-casino)).
- **The contract is fixed.** It cannot be upgraded or paused, its signer and treasury are set when it is deployed, and
  only the treasury changes its payout limit ([the contract reference](../reference/contract.md)).

## What you trust the casino for

- **Its two keys.** The signer, on the casino's server, is the only settlement signer; the treasury, kept off that
  server, alone withdraws house cash and sets the payout limit. The bankroll is trusted to them, not protected from
  them: a stolen or misused signer key can sign winning balances for accounts it controls, which nothing tells from real
  ones. The [payout limit](../reference/contract.md#the-payout-limit) bounds how much house cash that takes in a day,
  and the treasury can set it to 0. Deposits and collateral stay protected from both keys.
- **Serving the wallet.** The wallet play.hookedin.com serves holds your key: one served to take it could take
  everything your account holds. It publishes each commit to `main` that passes its tests, which anyone can [rebuild and
  compare](../reference/deployment.md#verify-a-release), but your browser runs whatever it is sent. [Your own
  build](../wallet/keys-and-recovery.md#your-own-build), with a key you never use at play.hookedin.com, needs no such
  trust.
- **Paying winnings.** Your winnings, what your balance holds above your deposits and collateral, are an unsecured claim
  on the shared bankroll, a deliberate choice of capital efficiency. They wait in the queue for house cash, paid no
  faster than the payout limit allows, with neither replenishment nor a deadline guaranteed, and the ETH in the contract
  does not prove every signed balance covered. Until a win is recorded, the cash that would pay it is house cash, which
  the treasury can withdraw. The bankroll [overcommits](architecture.md#limitations), and counts house money the
  treasury holds off the contract ([`reserve`](../casino-api/public.md#get-apistatus)), which pays no winnings until the
  treasury puts it in.
- **Sending withdrawals.** The casino takes on a withdrawal only when your deposits, your collateral and the house cash
  it can count on cover all of it, so a withdrawal is normally paid in full the moment it is sent. It sends each to the
  contract once, oldest first, and owes it until a confirmed block shows it recorded, whoever sent it, or its channel's
  close final without it; one it cannot send yet waits, and its public status says why. It pays the gas, for a
  [fee](../casino-api/public.md#get-apiwithdrawal-fee). Play never waits for a withdrawal.
- **Transfers between players.** A [transfer](../wallet/getting-started.md#transfer) is off-chain: the casino owes it to
  the player you named until their wallet collects it. Only the casino knows which account a name belongs to, and
  nothing signed says who goes by a uname, so you trust it to pay the player you named, and they trust it to pay them.
  Once collected it is winnings, like any balance above their own deposits and collateral.
- **Admitting and completing bets.** The casino admits each casino bet with a Kelly rule against its quote's virtual
  bankroll, half its bankroll by its own books, and sets its commission against the same figure. It can decline any
  operation but a covered casino bet, go offline or never answer, with no protocol penalty: a rejection is a signed
  checkpoint that leaves the balance unchanged, and an unanswered operation settles at the latest completed state, but a
  covered casino bet, which you dispute. A declined casino bet reveals nothing, and its round takes your next bet. The
  casino declines a covered bet only as a game's operation you carried out on another channel, with the operation your
  account signed there as proof. A completed result cannot change.
- **Keeping its record.** It records every response it signs before the response leaves it, so retrying an operation ID
  returns the same receipt, after a restart too, and a game's operation is never carried out twice. It discloses at most
  one signed outcome per channel position, which the contract does not check: had it also signed a withdrawal it
  declined, that could be recorded, and your later withdrawals would come back to you only with the close. It settles on
  each round's secret at most once, and a covered bet on a round whose secret it lost, disputed, is paid as won. Every
  reply brings its signature of where its record ends, which the wallet holds it to, so a rewritten record shows ([the
  casino's history](../wallet/keys-and-recovery.md#the-casinos-history)). A persistence failure stops all signing, and
  so does a dispute on a checkpoint its history lost; play pauses while its view of the chain is stale or reconciling.
  It runs the exact protocol revision it pins from this repository.
- **Watching channels.** It closes a channel nobody has played on for 7 days ([idle
  channels](../wallet/closing-and-claims.md#idle-channels)), and challenges stale closes and settles disputed casino
  bets on the channels it knows, in its own interest: its watcher does not protect you against the casino.
- **Keeping a published game up.** It can take a published game down, as its developer can: the game leaves its
  developer's profile and earns nothing, but keeps its bank, the developer bets placed on it and its record.
- **What it reports.** Commission, the bankroll figure, the fund's share price and each developer's earnings are the
  casino's word.

These are an operator's promises but settling a covered casino bet, which the contract enforces. The wallet is built not
to need them: it verifies every signature, preimage and balance change, keeps the evidence, and can withdraw, close and
dispute without the casino. It cannot verify availability, liquidity or the code play.hookedin.com serves.

## What you do yourself

- **Watch your channel.** The casino could close on an older state, which becomes final unless a challenge with your
  newer evidence is mined within 7 days of the close starting. Opening the wallet sends none: press **Challenge the
  close**, or run a [watchtower](../wallet/keys-and-recovery.md#the-watchtower).
- **Dispute a covered bet the casino leaves unsettled**, before its quote expires, with **Close without the casino** or
  a watchtower holding your recovery bundle ([dispute a casino
  bet](../wallet/closing-and-claims.md#dispute-a-casino-bet)).
- **Keep your key, and your evidence.** Your passkey or key file is the only copy of your key outside this browser, and
  your latest signed state is your proof. Another device takes up the casino's copy of it on the casino's word, so
  export recovery bundles ([keys and recovery](../wallet/keys-and-recovery.md)).
- **Record what you win.** Withdraw it, or [lock it in](../wallet/closing-and-claims.md#lock-in-your-balance) as
  deposits, and buy [collateral](../wallet/closing-and-claims.md#collateral) for what you win next.
- **Keep ETH for the exit.** Closing, challenging, finalizing and collecting are transactions paid from your deposit
  address, where the wallet keeps nothing back ([fees and gas](../wallet/closing-and-claims.md#fees-and-gas)). Anyone
  can send a challenge, a dispute, a finalization or a collection for you.
- **Set each game's allowance.** The wallet holds each game to it, and a game places developer bets only once you allow
  them too, after a warning that its developer decides what they pay.

## What a game can and cannot do

A game can ask for casino bets and payments up to the allowance you give it, and developer bets once you allow them,
lose its whole allowance, winnings included, on bets that pay back little, and show you whatever it likes. It cannot see
your keys, your address, your channels or your balances, see your round's secret or your wallet's seed before the
result, ask for any signature but its own bets and payments, spend a wei beyond its allowance, or change who earns its
commission.

The wallet verifies each casino bet completely, its odds, its outcome and what it pays, and records its house edge, but
does not refuse a bet for paying back little ([settled trade-offs](architecture.md#settled-trade-offs)). It does not
check a game's advertised rules, the tables its steps offer or the files it serves; it splits each table and draws the
bet itself. Playing a game trusts its developer for its tables.

## Developer bets trust their developer

A developer bet's stake goes into the game's bank at the casino as it is placed, and it is paid what the game's server
settles, from that bank, with no escrow, no deadline and no refund. The wallet checks that the settlement is signed by
the developer's key or a server key the developer named for the game in a signed `GameServer`, and nothing about what
the bet should have paid. A developer can keep a stake by never settling, and the game's public record then shows the
bet open. Until your wallet collects it, a developer bet's payout is the casino's promise, outside what the contract
protects. A game can make its developer bets provably fair with a scheme of its own, as
[roulette](https://github.com/hookedin/game-roulette#fairness-and-trust) does. A game's bank reserves nothing: whether a
developer can pay is between it and its players ([settled trade-offs](architecture.md#settled-trade-offs)).

## Fund shares are the casino's promise

A [bankroll fund](../wallet/bankroll-fund.md) share is a statement the casino signs: no contract holds it, the casino
alone states the price, the bankroll can lose, and the casino could take the money. A holder gets proof of what they
hold, which the casino cannot deny, and a public record of the treasury taking more than the house owns.

## What the wallet checks

The wallet checks:

- the deployment: the contract's code, signer, chain and address, and the casino's protocol revision ([how the wallet
  pins its deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment));
- the chain, through two independent RPCs on Ethereum, at blocks both agree on;
- every result: that the operation is the one it signed and follows the saved checkpoint, the revealed secret and seed,
  the outcome and what the bet pays on it, the balance arithmetic, and the casino's signature;
- every quote, by its signature, checkpoint and round, and that it covers every bet a step splits into before the step's
  bet is drawn and its seed sent;
- every collateral offer, by its signature, channel and amount, and that its price is the casino's rate;
- every rejection, and that it declines no covered casino bet but one the account signed on another channel;
- developer settlements and the developer's naming of the key that signed them, the secret a settlement reveals, share
  statements, bank statements and the fund's quote, by their signatures and what they refer to;
- whether the contract has recorded each withdrawal, and what it still owes of it;
- the casino's history, against the newest [head](../reference/signed-messages.md#history-heads) of it the casino
  signed;
- game URLs and every bridge request.

It takes on the casino's word commission, the virtual bankroll a quote names, the withdrawal fee up to [the wallet's
cap](../wallet/closing-and-claims.md#fees-and-gas), the fund's equity and total shares, a game's bank and the commission
that went into it, and, on a device without your evidence, that the state it holds of your balance is the latest; on the
developer's word what a developer bet pays and that a step's table is its game's rules, which each bet's detail shows;
and on the game's word everything a game shows.
