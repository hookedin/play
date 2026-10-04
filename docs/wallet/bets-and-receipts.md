---
title: Bets and receipts
description: Your bet history, the return measured from each bet's own chance and prize, rejected bets, a game's public record, developer bets and Activity.
sidebar:
  order: 2
---

The wallet keeps a receipt of everything it signs, and shows your bets from those receipts. No game states what it pays
back: every figure here is measured from bets that really happened.

## Bets

**Bets**, `/bets`, lists every settled bet this wallet signed, newest first: each casino bet, each developer bet once
what it was paid has been collected, and each payment a game made within a [group](#groups), with its game, time, what
it put at risk, payout, result and return. **At risk** is what a casino bet staked, which can be less than the stake the
game shows when the game keeps part of it back ([what is given up](../games/collapsing-bets.md#what-is-given-up)); a
payment shows what it paid the house, and pays nothing back. It is read from the receipts the wallet keeps
([Activity](#activity)); rejected requests, and payments outside a group, are not listed. Choose a game to see its bets
alone, at `/bets?game=<key>`. While you play, the game's name in the top bar opens **Your bets in** the game, over it,
and **Everyone's bets in** it, its [public record](#a-games-public-record).

Opening a casino bet shows everything its receipt holds: where the round's outcome landed against the bet's chance; the
prize and chance you signed and the return they make; your seed and the casino's secret, checked again against the
hashes your bet signed, and the outcome worked out from the two; and the signed record itself, with its commission,
both signatures and the whole receipt as JSON. A developer bet shows instead its developer, the meta you signed, what
the developer's signed settlement paid you and gave the casino, and the developer's signature.

## Measured return

A casino bet's **return** is what it pays back on average, as a share of its stake:

```text
expected payout = prize × chance / 2^64
return          = expected payout / stake
```

The wallet works it out from the chance and prize it signs, before signing, and never from anything a game says. It
shows the return in millionths of the stake, rounded to the nearest, as a percentage with four decimals: a hundredth of
a basis point. The coin flip in [how it works](../overview/how-it-works.md#casino-bets) returns 98.0000%. A developer
bet has no odds, and so no return.

**My games**, `/games`, adds up your bets, overall and game by game, two ways:

- **Expected**: what the bets were worth, the sum of their expected payouts over the sum of what they put at risk,
  counting casino bets and a group's payments.
- **Paid back**: what the bets paid, the sum of their payouts over the sum of what they put at risk.

Over a handful of bets the second figure is luck, and over many it follows the first. These figures measure the bets a
game placed, not the game: a game that collapses a step with many outcomes into one bet stakes only what the step can
lose, so its bets pay back less of what they stake than the game does of its stake
([what is given up](../games/collapsing-bets.md#what-is-given-up)).

## Groups

A game can give its bets and payments a **group**, a label of up to 64 characters that ties them together: the steps of
one hand, the bets of one spin, one match. **Bets** shows the bets and payments of one group in one game as a single
row, a round, with what you **put in**, how many bets it holds and their net result, so a round comes to what the game
showed: a cash-out that pays the house part of what its bet won is that round's payment. Opening the row says what the
round came to, then lists each bet. A round's stakes and payouts are not added up: a multi-step game stakes again what
its last step paid, so they would count the same money more than once. What you put in is the most the round was ever
down, and the counts of bets here, in My games, on your profile and in a game's public record count a round once.

## Rejected bets

A declined request costs nothing. The casino proposes a checkpoint that leaves your balance unchanged. The wallet
checks and signs it, then the casino completes it with its signature and the wallet keeps the receipt in Activity.

The casino declines only a casino bet its [quote](../overview/how-it-works.md#quotes) does not cover, and the wallet
sends the seed only with a covered one, so a declined bet reveals nothing: its round stays secret and takes your next
bet. A covered bet the casino declines is not countersigned: it stays saved, for you to
[dispute](closing-and-claims.md#dispute-a-casino-bet).

A game's operation that its player already carried out on another channel is declined too, marked `used`; a covered
casino bet only with the operation your account signed there, which the wallet checks. The wallet then answers the game
with `id-used`, so that it does not place the same bet again under another ID
([how a game works](../games/how-a-game-works.md)).

## A game's public record

`/games/<key>` shows every settled bet anyone has placed in one game, as the casino recorded it, from
[`GET /api/games/:key`](../casino-api/public.md#get-apigameskey); `key` is the game's
[key](../reference/signed-messages.md#game-keys). **Every bet in it** on a game's line under My games opens it, and so
does **Every bet in this game** in one of your bets. The page shows:

- the totals, expected and paid back, as on My games;
- how many of the game's developer bets are open, and how many its developer has settled;
- the latest 200 bets, newest first, each naming its player by Discord username or uname and never by address or channel, with
  its stake, payout, result and return.

Anyone can judge a game by what it has paid, without taking the game's word for anything.

## Developer bets

A developer bet's stake is with the game's developer from the moment it is placed. The wallet's Activity tab lists your
developer bets under **Developer bets** until what each was paid has been collected:

| Status                    | Meaning                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| Waiting for the developer | Open: the stake is in the developer's bank, and the developer has not settled |
| Payout ready              | Settled, and the payout is not yet in your balance                            |
| Payout collected          | The payout is in your balance                                                 |
| Settled · no payout       | Settled for nothing: there is nothing to collect                              |

The wallet asks the casino for your settled bets every 10 minutes while its tab is visible, when you press ↻ beside
its title, and at once when the game asks about the bet. For each, it checks the
developer's signed `Settlement` against the bet you signed (its hash, its stake and its developer) and signs a credit
for exactly what the settlement pays you, into your balance; the game that placed the bet hears of it while open, and
the payout joins its allowance once the game has shown the result. Stakes with developers and payouts not yet collected are apart from your signed
balance: the contract protects neither ([trust model](../overview/trust-model.md#developer-bets-trust-their-developer)).

## Activity

**Activity**, the wallet's tab at `/wallet/activity`, lists every receipt the wallet keeps, newest first: ETH arriving at your deposit address
(**Received at your address**), your balance opening (**Balance opened**), your deposits and what they add to your
balance (**Added to your balance**, whoever deposited it), the network fees of deposits the casino lent (**Network fee
lent**) and the faucet's loans (**Free µETH lent**), bets, payments, rejections, bankroll and bank movements, withdrawals
and transfers, closes, challenges and collections, each with its operation ID or its transaction and the raw JSON
behind it.
The wallet keeps the latest 100 receipts, and beyond them every receipt still to be settled: a developer bet still open,
and a withdrawal, transfer or lock-in not yet paid or returned.

A withdrawal is **Withdrawal on its way** until the contract has paid it, and **Withdrawn** after; a transfer is
**Transfer on its way**, then **Transferred**. Its **Network fee** is what your balance paid the casino for sending it.
What the contract recorded without the cash to pay it waits under **Waiting to be paid** in the wallet
([claims and collection](closing-and-claims.md#claims-and-collection)), and one nobody sent before its channel's close
was final is **Withdrawal returned**: the close was owed it back. Each shows its **Withdrawal ID**, the hash of its
operation, and once recorded the transaction that recorded it. One the casino has not sent offers **Send it now** once
every earlier withdrawal from that balance is sent, and sends it from your account
([fees and gas](closing-and-claims.md#fees-and-gas)). The wallet asks the contract how each withdrawal not yet paid or
returned stands, and looks for the transaction that recorded it among the last 10,000 blocks.
