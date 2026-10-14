---
title: Bets and receipts
description: Your bet history, each bet's house edge, rounds, rejected bets, a game's public record, developer bets and Activity.
sidebar:
  order: 2
---

The wallet keeps a receipt of everything it signs, and shows your bets from those receipts and from the casino's record
of your account. No game states what it pays back: every figure here is worked out from bets that really happened.

## Bets

**Bets**, `/bets`, lists your settled bets, newest first:

- each casino bet;
- each developer bet, once what it was paid has been collected;
- each payment a game made within a [group](#groups), which reads **Paid to the house** and pays nothing back.

Each row has its game, time, what it put in, what it paid, its result and its **House edge**, what it was expected to
cost ([below](#house-edge)). Rejected requests, and payments outside a group, are not listed. Choose a game to see its
bets alone, at `/bets?game=<id>`.

**Put in** is all the cash the game's step held. The bet it drew stakes part of it when the game keeps the rest back
([what is given up](../games/collapsing-bets.md#what-is-given-up)), and the part kept comes back with what the bet paid,
so a row reads as the game showed it.

Bets and [My games](#house-edge) show your latest bets from this browser's receipts ([Activity](#activity)) and
the casino's record of the signed-in account, so your bets from another device appear too. The wallet reads a page of
the account's latest 100 operations when the page opens, at most once a minute, and again on **Refresh ↻**, and checks
each as it checks a reply. A developer bet from the casino's record shows only for a game whose developer the wallet
knows.

### The game's menu

While you play, the game's name in the top bar opens a menu:

- **Verify your last bet** opens the game's latest bet: the newer of the last whose result the game has shown in this
  browser, and the last the casino keeps for your account in the game, played on any device. A step that drew no bet
  counts, and so does a developer bet once its payout is collected. While a round is in play it says so, and verifies
  the round once it ends, so it never gives a result away before the game shows it.
- **Next round**, before you bet, shows the round of your next casino bet, in any game: the hash of the secret the
  casino has already fixed for it. Copy it or write it down; once you have bet, the bet's proof shows the same round
  and the secret that hashes to it. A game that places developer bets rides them on its own rounds, so its menu shows
  Next round only once this browser holds a casino bet of the game.
- **Your bets in** the game lists this browser's bets in it and those the casino keeps for your account from your
  other devices, each checked as the wallet checks a reply.
- **Everyone's bets in** it opens its [public record](#a-games-public-record).

A game can also open any of its bets from its own page, as Dice does from each roll in its strip
([`wallet.showBet`](../reference/bridge.md#walletshowbet)).

### A bet in full

Opening a bet shows everything its receipt holds, each figure worked out again by your wallet. A bet of a round says so
first, with what the round came to and the whole round a click away. Then, for a casino bet:

- **House edge**, beside what it put in, what it paid and its result ([below](#house-edge)).
- **What the game offered**, for a step of a game: the table the game gave your wallet, each result with its label,
  what it leaves you and how likely it is, and what the step held. **Landed on** marks the result.
  The bet's round decides what the step leaves, and your seed only which of the results that leave it, so when several
  do it adds _which your seed chose among the 3 results that leave 40 METH_. A step that drew no bet reads **Landed
  on, drawn from your seed**.
- **Where the round landed**: the bet's **roll**, the round's outcome as a share of 2^64 on a scale of 0 to 100,
  against the line it wins under, its chance on the same scale, so that a dice roll reads as the game showed it.
- **The bet you signed**, for a casino bet not drawn from a step: its prize, its chance and its house edge as a share
  of its stake.
- **How your wallet drew it**, for a step: your wallet split the table into bets the casino's quote covered, with a
  chance of no bet when a result keeps what the step held, and drew one with your seed before it signed anything.
  - **The bets pay out as the table says**: each amount the table leaves, reached exactly as often as its weights say.
  - **Drawn from your seed**: _Bet 2 of 3_ or _No bet_, drawn again and checked against what your wallet signed.
  - **The bet it signed**: what it stakes and pays, the line it wins under, its chance in outcomes of 2^64, and its
    house edge.
  - **Every bet it could draw**, folded away, lists them all, with the bankroll the casino's quote named, which the
    split is weighed against.

  A table whose results all keep the cash it holds placed no bet, and the wallet signed nothing.

- **How the outcome was fixed**: your seed and the casino's secret, each checked against the hash your bet signed, the
  outcome worked out from the two, and [**Check it yourself**](#check-a-bet-yourself).
- **The record you both signed**: its operation, channel and sequence, its game, memo and commission, both signatures
  and the whole receipt as JSON.

The bet signs its table, so a bet from the casino's record shows all of it too. A payment says what it paid the house,
and what its round kept when it signed that; it has no odds and no round.

A developer bet shows instead its developer, the meta you signed, what the developer's signed settlement paid you and
gave the casino, and the server's signature. One that named a round shows **Fixed before you bet**: the round it named
and the secret its settlement revealed, checked to hash to it
([a round of your own](../games/developer-bets.md#a-round-of-your-own)).

## Check a bet yourself

Every figure a bet's detail shows is worked out by your wallet. To check one with nothing of the wallet's, **Check it
yourself** in the detail opens [the verifier](https://hookedin.com/verify/): a page apart from the wallet with nothing
but the arithmetic, filled in after `#`, which a browser never sends to a server. Its source is one file,
[docs/verify.html](../verify.html), short enough to read, which you can save and open offline.

Or work a bet out with any Ethereum tool, from what its receipt keeps:

| What        | How                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The round   | `keccak256(secret)`: the round your bet signed, fixed before your wallet picked its seed                                                 |
| A seed hash | `keccak256(seed)`: the seed hash your bet signed, before the secret was out                                                              |
| The outcome | The lowest 64 bits of `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`                                               |
| The roll    | The outcome ÷ 2^64 × 100. The bet pays its prize when the outcome is below its chance                                                    |
| The bet     | [The wallet's draw](../games/collapsing-bets.md#the-wallet-draws-the-step) from the seed, among the bets it split the step into, or none |
| The result  | The wallet's draw from the seed, among the results that leave what the bet left                                                          |

With Foundry's `cast`, the outcome is:

```bash
cast to-dec 0x$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32)" $(cast keccak "HOOKEDIN/OUTCOME") $SEED $SECRET) | cut -c 51-)
```

These are keccak256, Ethereum's hash, which the contract settles a disputed bet with: Python's `hashlib.sha3_256` is a
different hash and gives another answer ([why keccak256](../overview/architecture.md#settled-trade-offs)).

The check proves that the casino fixed the outcome before it saw your seed, that your seed was fixed before the secret
was out, that the bets pay out exactly as the game's table says, and that neither the game nor the casino chose which
of them you placed or which result it landed on. It cannot prove that your wallet picked the seed at random: the
wallet you run does that, and [your own build](keys-and-recovery.md#your-own-build) is the one you need not trust.

## House edge

A bet's **house edge** is what it was expected to cost you: what it staked, less what it was expected to pay. The
wallet works it out from the bet it signed, and never from anything a game says:

- **A casino bet** has its own odds:

  ```text
  house edge = stake − prize × chance / 2^64
  ```

  A step of a round puts in all the cash it held. The bet your wallet drew from it stakes part of that and keeps the
  rest back, which comes back whatever happens, so the step's house edge is its bet's, and a step that drew no bet has
  none.

- **A payment** a round made to the house is all house edge: the round paid it and got nothing back.
- **A developer bet** has no odds anyone prices, and shows no house edge.

Each bet's edge is its own, so the bets of a round add up to what the round was expected to cost, however many steps it
took. Which bet your wallet drew from a step is luck, and so is how far a round went, so one round's edge is luck too;
over many rounds it comes to the game's. Lists show it in METH to a millionth, and a bet opened in full every digit. The
coin flip in [how it works](../overview/how-it-works.md#casino-bets) stakes 1,000 METH at a house edge of 20 METH.

**My games**, `/games`, adds up your bets, overall and game by game:

- **Put in**: what your rounds took from your balance, each the most it was ever down.
- **House edge**: what the bets with odds were expected to cost, as a share of what they put in.
- **Paid back**: what came back, against what went in.

Over a handful of rounds what came back is luck, and over many it follows the house edge.

Each game also says what the house edge of each of its steps was, as a share of what the step held: a bet drawn or not,
and a round's payments included. A draw from a table whose results all keep the cash it holds is left out. A game whose
steps follow its rules has one edge, or a few: _Each of its 40 steps had a house edge of 1% of what it held._ One that
draws its results in its own page before it asks the wallet has a different one almost every step: _Its 40 steps had
house edges from 2% to 59% of what each held._

A game's [public record](#a-games-public-record) counts its bets the same way, from the bets the casino recorded.

## Groups

A game can give its bets and payments a **group**, a label of up to 64 characters that ties them together: the steps of
one hand, the bets of one spin, one match.

**Bets** shows the bets and payments of one group in one game as a single row, a round, with how many bets it holds,
what you **put in**, what it paid back, its result and its house edge, so a round comes to what the game showed: a
cash-out that pays the house part of what its bet won is that round's payment. Opening the row says what the round came
to, what each step landed on, as the game labelled its results, and its figures. **How it was settled** lists its steps,
folded away: what each landed on, what the round was worth before and after it, and its house edge, each opening in
full. A step that drew no bet signed nothing, so only the browser that drew it lists it.

A round's stakes and payouts are not added up: a multi-step game stakes again what its last step paid, so they would
count the same money more than once. What you put in is the most the round was ever down, and the counts of bets here,
in My games, on your profile and in a game's public record count a round once.

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

`/games/<id>` shows every settled bet anyone has placed in one game, as the casino recorded it, from
[`GET /api/games/:id`](../casino-api/public.md#get-apigamesid), by the game's [ID](../reference/signed-messages.md#game-ids).
**Every bet in it** on a game's line under My games or Developer opens it, and so does **Every bet in this game** in one
of your bets. The page shows:

- the game's name, and while it is published, **Play**;
- the totals, house edge and paid back, as on My games;
- how many of the game's developer bets are open, and how many its developer has settled;
- the latest 200 bets and payments, newest first, each naming its player by Discord username or uname and never by
  address or channel, with what it put in or paid to the house, what it paid, its result and its house edge.

Anyone can judge a game by what it has paid, without taking the game's word for anything.

## Developer bets

A developer bet's stake is with the game's developer from the moment it is placed. The wallet's Activity tab lists your
developer bets under **Developer bets** until what each was paid has been collected:

| Status                    | Meaning                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| Waiting for the developer | Open: the stake is in the game's bank, and the developer has not settled |
| Payout ready              | Settled, and the payout is not yet in your balance                       |
| Payout collected          | The payout is in your balance                                            |
| Settled · no payout       | Settled for nothing: there is nothing to collect                         |

The wallet asks the casino for your settled bets every 10 minutes while its tab is visible, when you press ↻ beside
its title, and at once when the game asks about the bet. For each, it checks the developer's signed `Settlement`
against the bet you signed: its hash, its stake, its developer and, for a bet that named a round, the secret that hashes
to it. It then signs a credit for exactly what the settlement pays you, into your balance. The game that placed the bet
hears of it while open, and the payout joins its allowance once the game has shown the result.

Stakes with developers and payouts not yet collected are apart from your signed balance: the contract protects neither
([trust model](../overview/trust-model.md#developer-bets-trust-their-developer)).

## Activity

**Activity**, the wallet's tab at `/wallet/activity`, lists every receipt the wallet keeps, newest first, each with its
operation ID or its transaction and the raw JSON behind it:

- ETH arriving at your deposit address (**Received at your address**), your deposits and what they add to your balance
  (**Added to your balance**, whoever deposited it), and the network fees of deposits the casino paid (**Network fee
  paid**);
- bets, payments and rejections;
- bankroll and bank movements, and transfers to and from other players (**Transferred** and **Transfer received**,
  naming the other player);
- withdrawals and lock-ins, closes, challenges and collections.

**Bets**, **Deposits** and **Withdrawals** above the list show one kind at a time: bets, payments and developer bet
payouts; ETH received at your address, deposits, what they added to your balance and their network fees; withdrawals,
lock-ins, closes and challenges. **All** shows every receipt, transfers and the bankroll's and banks' movements among
them.

The wallet keeps the latest 100 receipts, and beyond them every receipt still to be settled: a developer bet still
open, and a withdrawal or lock-in not yet paid or returned.

A withdrawal is **Withdrawal on its way** until the contract has paid it, and **Withdrawn** after; a lock-in is
**Locking in**, then **Balance locked in**. Its **Network fee** is what your balance paid the casino for sending it.
What the contract recorded without the cash to pay it waits under **Waiting to be paid** in the wallet
([claims and collection](closing-and-claims.md#claims-and-collection)), and one nobody sent before its channel's close
was final is **Withdrawal returned**: the close was owed it back.

Each shows its **Withdrawal ID**, the hash of its operation, and once recorded the transaction that recorded it. One the
casino has not sent holds the transaction that sends it under **Send it yourself**, once every earlier withdrawal from
that balance is sent: its data, to the contract, which anyone can send from any wallet, paying its gas. The wallet asks
the contract how each withdrawal not yet paid or returned stands, and looks for the transaction that recorded it among
the last 10,000 blocks.
