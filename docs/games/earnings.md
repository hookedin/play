---
title: Earnings
description: The commission a published game earns its developer, what earns it, and how an ordinary wallet collects it.
sidebar:
  order: 11
---

You earn half the commission on every casino bet placed in a game you publish. The casino keeps the tally for the
address the manifest names as `developer`, and an ordinary HookedIn wallet opened from that address collects it by
itself.

## Commission

The casino admits a casino bet when its bankroll could take the bet with no commission at all. Commission is then the
edge the bankroll does not need: the most it can take that still leaves its side of the bet Kelly-sound. It is rounded
down to an even amount and split in half, one half to the game's developer and one to the casino. Setting commission
after admission admits the largest bets and charges only the surplus: a
[settled trade-off](../overview/architecture.md#settled-trade-offs). The arithmetic, with worked figures, is in
[pricing and commission](../reference/economics.md).

- It depends on the bet's edge and on the casino's bankroll. A bet with no more edge than the bankroll needs earns
  nothing, and a bet with no edge is declined.
- It is never an extra debit to the player: the stake, chance and prize are exactly what the player signed.
- No fee protects a player from a game. A game can spend its whole spending limit on bets that pay back little, and the
  wallet records each bet's [measured return](casino-bets.md#measured-return) without refusing it: the limit the player
  sets is their protection.

## What earns it

- Every settled casino bet in a game you publish, won or lost, your own casino bets on your rounds included. It is owed
  to whoever publishes the game when the bet settles.
- A rejected bet earns nothing, nor does a reveal, which bets nothing. A game nobody publishes earns no developer
  anything: all its commission is the casino's.
- A developer bet earns no commission, because the bankroll does not back it. Its casino part is what your settlement
  gives the casino ([the casino's share](developer-bets.md#the-casinos-share)). A casino bet of yours that backs
  developer bets earns you half its commission, as any other does.

## Collecting

The tally is kept per address. Open a HookedIn wallet whose account is the `developer` address: import its key, or
connect the browser wallet that holds it ([open the wallet](../wallet/getting-started.md#open-the-wallet)). With a
channel open, the wallet collects what the tally owes by itself, as a credit its own channel key signs, into that
channel. Nobody at the casino approves or sends anything, and the wallet page shows what your games have earned and how
much of it is collected.

Nothing moves on-chain and the bankroll does not change: money the casino owed you becomes your signed balance, which
settles like any other ([closing and claims](../wallet/closing-and-claims.md)). Commission owed to an address that never
opens a channel is never collected, so name an address you can open a wallet from.

The casino also lists what each game earned, by its published name, with the tally in your channel's
[payouts](../casino-api/channels.md#get-apichannelsidpayouts).

## The public tally

Every developer's totals are public: [`GET /api/status`](../casino-api/public.md#get-apistatus) lists them under
`developers`, one entry per address with `earned`, `collected` and `outstanding`, and
[hookedin.com/bankroll](https://hookedin.com/bankroll/) shows them. The tally is the casino's word: casino bets are
private to their channels, so nobody can check that it counted every one. Each player's receipts show the commission of
their own bets.
