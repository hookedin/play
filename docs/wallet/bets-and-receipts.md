---
title: Bets and receipts
description: Your bet history, the return measured from each bet's own prize table, rejected bets, a game's public record and developer bets.
sidebar:
  order: 3
---

The wallet keeps a receipt of everything it signs, and shows your bets from those receipts. No game states what it pays
back: every figure here is measured from bets that really happened.

## Bet history

**Bets** in the top bar, `/bets`, lists every settled bet this wallet signed, newest first: each casino bet, and each
developer bet once what it was paid has been collected. A row shows the game, the time, the stake, what the bet paid
(for a casino bet, of the most it could pay), the result, and the **return of this bet**. Search finds bets by game,
amount or operation ID.

The list is read from the latest 100 receipts the wallet keeps, which hold every kind of operation; the receipts of
developer bets still open are kept beyond those 100. Rejected requests and payments are not bets, and are listed in
[Activity](#activity).

## One bet in full

Opening a casino bet shows everything its receipt holds:

| Section                    | What it shows                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the round landed     | Each prize as a band across the outcome space, the outcome marked on it, and the prizes that held it                                                       |
| The prize table you signed | Every prize: what it pays, its chance, and the outcomes it holds                                                                                           |
| How the outcome was fixed  | Your seed and the casino's secret, each checked against the hash your bet signed, and the outcome worked out again from the two                            |
| The record you both signed | The operation, channel, sequence, game key, memo, expected payout, the balance after it, its commission and both signatures, and the whole receipt as JSON |

The checks under **How the outcome was fixed** are made again when you open the bet, from the receipt's own seed and
secret; a tick means the value matches what the bet signed. A developer bet shows **How it settled** instead: its
developer, the meta you signed, what the developer's signed settlement paid you and gave the casino, and the
developer's signature.

## Measured return

A casino bet's **return** is what its prize table pays back on average, as a share of its stake:

```text
expected payout = Σ payout × (rangeEnd − rangeStart) / 2^64    over every prize
return          = expected payout / stake
```

The wallet works it out from the prizes it signs, before signing, and never from anything a game says. It shows the
return in millionths of the stake, rounded to the nearest, as a percentage with four decimals: a hundredth of a basis
point. The coin flip in [how it works](../overview/how-it-works.md#casino-bets) returns 98.0000%. A developer bet has no
prize table, and so no return.

**My games**, `/games`, adds up your bets of each asset, overall and game by game, two ways:

- **Expected**: what the bets' prize tables were worth, the sum of their expected payouts over the sum of their stakes,
  counting only bets that have a prize table.
- **Paid back**: what the bets paid, the sum of their payouts over the sum of their stakes.

Over a handful of bets the second figure is luck, and over many it follows the first. ETH and TEST are separate channels
and never add up to one figure. The wallet records the return of every casino bet and does not refuse a bet that
returns little ([trust model](../overview/trust-model.md#what-a-game-can-and-cannot-do)).

My games lists the games you have played, your favourites first and then the most staked. A favourite is a note in this
browser, never signed or sent anywhere. Each game links to its public record, and **Play again** reopens a game the
library has shown.

## Groups

A game can give its bets and payments a **group**, a label of up to 64 characters such as one hand or one match. Bet
history shows the bets of one group in one game as a single row, with how many bets it holds and their net result;
opening it lists each bet. Only the net is added up: a multi-step game stakes again what its last step paid, so adding
its stakes or its payouts would count the same money more than once.

## Rejected bets

A declined request costs nothing. The casino signs a checkpoint that leaves your balance unchanged, and the wallet
checks it, countersigns it and keeps the receipt in Activity.

A casino bet the casino declines comes back with its round's secret. The wallet checks the secret against the round the
bet signed and, with its own seed, records at once what the bet would have paid: _The casino revealed the round: this
casino bet would have paid …_. The one exception is a round the casino says it has lost, and that receipt says in words
that the bet cannot be checked. The wallet countersigns no other decline of a casino bet. A run of declined bets that
would have paid well is a player's evidence of selective rejection.

A game's operation that its player already carried out on another channel is declined too, marked `used`. The wallet
then answers the game with `id-used`, so that it does not place the same bet again under another ID
([state and recovery](../games/state-and-recovery.md)).

## A game's public record

`/games/<key>` shows every settled bet anyone has placed in one game, as the casino recorded it, from
[`GET /api/games/:key`](../casino-api/public.md#get-apigameskey). `key` is the game's key
([publishing a game](names-and-publishing.md#publishing-a-game)). The page shows:

- the totals of each asset, expected and paid back, as on My games;
- how many of the game's developer bets are open, and how many its developer has settled;
- the latest 200 bets, newest first, each naming its player by alias or uname and never by address or channel, with
  its stake, payout, result and return.

Anyone can judge a game by what it has paid, without taking the game's word for anything.

## Developer bets

A developer bet's stake is with the game's developer from the moment it is placed. **My wallet** lists your developer
bets under **Developer bets** until what each was paid has been collected:

| Status                    | Meaning                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| Waiting for the developer | Open: the stake is in the developer's bank, and the developer has not settled |
| Payout ready              | Settled, and the payout is not yet in your channel                            |
| Payout collected          | The payout is in your channel                                                 |
| Settled · no payout       | Settled for nothing: there is nothing to collect                              |

Every 4 seconds while the wallet is open, and when you press **Check results and collect payouts**, the wallet asks the
casino for your settled bets. For each, it checks the developer's signed `Settlement` against the bet you signed (its
hash, its stake and its developer) and signs a credit for exactly what the settlement pays you. It collects in the asset
the tab plays with; a bet in the other asset says which to switch to. If the game that placed the bet is open, the
wallet sends it the settled receipt, and the payout raises the game's limit. A collected developer bet then appears in
bet history.

Stakes with developers and payouts not yet collected are apart from your signed balance: they are not in the channel,
and the contract protects neither ([trust model](../overview/trust-model.md#developer-bets-trust-their-developer)).

## Activity

**Activity**, `/activity`, lists every receipt the wallet keeps, newest first: bets, payments, rejections, deposits,
closes, collected claims, test coins, and bankroll and bank movements. A row expands to its operation ID, channel,
sequence and commission, and for a transaction its hash (linked to Sepolia Etherscan) and block, with the raw JSON
behind it. An off-chain result reads **Signed off-chain**; a transaction reads **Confirmed on-chain**, **Reverted**,
**Replaced** or **Unconfirmed · reorg**, as the wallet last observed it. The wallet keeps the latest 100 receipts, and
the receipt of every developer bet still open.
