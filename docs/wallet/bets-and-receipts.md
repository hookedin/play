---
title: Bets and receipts
description: Your bet history, each bet's house edge, rounds, rejected bets, a game's public record, developer bets and Activity.
sidebar:
  order: 2
---

The wallet keeps a receipt of everything it signs, and shows your bets from those receipts and from the casino's record
of your account, so bets from your other devices appear too. No game states what it pays back: every figure here is
worked out from bets that really happened, each checked as the wallet checks a reply.

## Bets

**Bets**, `/bets`, lists your settled bets, newest first: each casino bet, each developer bet once its payout is
collected, and each payment a game made within a [group](#groups), which reads **Paid to the house**. Each row has its
game, time, what it put in, what it paid, its result and its [house edge](#house-edge); `/bets?game=<id>` shows one
game's. **Put in** is all the cash the game's step held: when the bet drawn from it stakes only part ([what is given
up](../games/collapsing-bets.md#what-is-given-up)), the rest comes back with what the bet paid, so a row reads as the
game showed it.

### The game's menu

While you play, the game's name in the top bar opens a menu:

- **Verify your last bet** opens the game's latest bet, from this browser or the casino's record of your account, or its
  whole round when it was a step of one. While a round is in play it waits for the round to end, so it never gives a
  result away.
- **Next round**, before you bet, shows the round of your next casino bet: the hash of the secret the casino has already
  fixed for it. Once you have bet, the bet's proof shows the same round and the secret that hashes to it.
- **Your bets in** the game lists your bets in it; **Everyone's bets in** it opens its [public
  record](#a-games-public-record).
- **Reload game** loads the game's page again, keeping its allowance.

A game can also open any of its bets from its own page ([`wallet.showBet`](../reference/bridge.md#walletshowbet)).

### A bet in full

Opening a bet shows everything its receipt holds, each figure worked out again by your wallet. A step of a round shows
what the round was worth before and after it, and links the whole round. A casino bet shows its **House edge**; for a
step, **What the game offered**, the table of results with what each leaves you and how likely it is, the result it
**Landed on**, and **How your wallet drew it**, the bets your wallet split the table into and the one your seed drew, or
none; **Where the round landed**, on a scale of 0 to 100 against the line the bet wins under; **How the outcome was
fixed**, your seed and the casino's secret checked against the hashes your bet signed, with [**Check it
yourself**](#check-a-bet-yourself); and **The record you both signed**, with both signatures and the whole receipt as
JSON. A developer bet shows its developer, the meta you signed, what the developer's signed settlement paid you and gave
the casino, and for a bet that named a round, **Fixed before you bet**: the round and the secret its settlement revealed
([a round of your own](../games/developer-bets.md#a-round-of-your-own)).

## Check a bet yourself

**Check it yourself**, in a bet's detail, opens [the verifier](https://hookedin.com/verify/): a page apart from the
wallet with nothing but the arithmetic, filled in after `#`, which a browser never sends to a server. Its source is one
short file, [docs/verify.html](../verify.html), which you can save and open offline. Or work a bet out with any Ethereum
tool, from what its receipt keeps:

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

These are keccak256, Ethereum's hash: Python's `hashlib.sha3_256` is a different hash ([why
keccak256](../overview/architecture.md#settled-trade-offs)).

The check proves that the casino fixed the outcome before it saw your seed, that your seed was fixed before the secret
was out, that the bets pay out exactly as the game's table says, and that neither the game nor the casino chose which of
them you placed or which result it landed on. It cannot prove that your wallet picked the seed at random: [your own
build](keys-and-recovery.md#your-own-build) is the wallet you need not trust.

## House edge

A bet's **house edge** is what it was expected to cost you, worked out from the bet it signed, never from anything a
game says:

- **A casino bet**: `stake − prize × chance / 2^64`. A step's bet stakes part of the step's cash and keeps the rest
  back, which comes back whatever happens, so the step's house edge is its bet's, and a step that drew no bet has none.
- **A payment** to the house is all house edge.
- **A developer bet** has no odds, and shows no house edge.

The bets of a round add up to what the round was expected to cost. Which bet your wallet drew, and how far a round went,
is luck, so one round's edge is luck too; over many rounds it comes to the game's. The coin flip in [how it
works](../overview/how-it-works.md#casino-bets) stakes 1,000 METH at a house edge of 20 METH.

**My games**, `/games`, adds up your bets, overall and game by game: **Put in**, what your rounds took from your
balance, each the most it was ever down; **House edge**, as a share of what the bets with odds put in; and **Paid
back**, which over a handful of rounds is luck and over many follows the house edge. Each game also says the house edge
of its steps, as a share of what each held: a game whose steps follow its rules has one edge, or a few, and one that
draws its results in its own page before it asks the wallet has a different one almost every step.

## Groups

A game can give its bets and payments a **group**, a label of up to 64 characters that ties them together: the steps of
one hand, the bets of one spin. **Bets** shows a group as one row, a round, with what you put in, what it paid back, its
result and its house edge; opening it shows what each step landed on and what the round was worth before and after it. A
round counts once, and what it put in is the most it was ever down: its stakes are not added up, since a multi-step game
stakes again what its last step paid. A step that drew no bet signed nothing, so only the browser that drew it lists it.

## Rejected bets

A declined request costs nothing: the casino proposes a checkpoint that leaves your balance unchanged, the wallet checks
and signs it, the casino completes it, and Activity keeps the receipt. The casino declines only a casino bet its
[quote](../overview/how-it-works.md#quotes) does not cover, which the wallet sends without its seed, so a declined bet
reveals nothing and its round takes your next bet. A covered bet the casino declines is not countersigned: it stays
saved, for you to [dispute](closing-and-claims.md#dispute-a-casino-bet). A game's operation you already carried out on
another channel is declined too, a covered casino bet only with the operation your account signed there as proof ([when
a wallet has lost receipts](../games/how-a-game-works.md#when-a-wallet-has-lost-receipts)).

## A game's public record

`/games/<id>` shows every settled bet anyone has placed in one game, as the casino recorded it
([`GET /api/games/:id`](../casino-api/public.md#get-apigamesid)): the totals, house edge and paid back, as on My games;
how many of its developer bets are open and settled; and the latest 200 bets and payments, each naming its player by
Discord username or uname, never by address or channel. Anyone can judge a game by what it has paid, without taking its
word for anything.

## Developer bets

A developer bet's stake is with the game's developer from the moment it is placed. Activity lists your developer bets
under **Developer bets** until each payout is collected:

| Status                    | Meaning                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| Waiting for the developer | Open: the stake is in the game's bank, and the developer has not settled |
| Payout ready              | Settled, and the payout is not yet in your balance                       |
| Payout collected          | The payout is in your balance                                            |
| Settled · no payout       | Settled for nothing: there is nothing to collect                         |

The wallet looks for your settled bets every 10 minutes while its tab is visible, when you press ↻, and when the game
asks. It checks each developer's signed `Settlement` against the bet you signed, and for a bet that named a round the
secret that hashes to it, then collects exactly what it pays into your balance. Stakes with developers and payouts not
yet collected are apart from your signed balance: the contract protects neither ([trust
model](../overview/trust-model.md#developer-bets-trust-their-developer)).

## Activity

**Activity** lists every receipt the wallet keeps, newest first, each with its operation ID or transaction and its raw
JSON: ETH arriving at your deposit address, deposits and the network fees the casino paid of them, bets, payments and
rejections, bankroll and bank movements, transfers, withdrawals, lock-ins, closes, challenges and collections. It keeps
the latest 100, and every receipt still to be settled: an open developer bet, and a withdrawal or lock-in not yet paid
or returned.

A withdrawal reads **Withdrawal on its way** until the contract has paid it, then **Withdrawn**; one the contract
recorded without the cash to pay it waits under **Waiting to be paid** ([claims and
collection](closing-and-claims.md#claims-and-collection)), and one nobody sent before its channel's close was final
reads **Withdrawal returned**, the close having been owed it back. One the casino has not sent holds the transaction
under **Send it yourself**, once every earlier withdrawal from that balance is sent: anyone can send it to the contract
from any wallet, paying its gas.
