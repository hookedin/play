---
title: Getting started
description: Open the wallet, deposit ETH, give a game an allowance, withdraw, and the names you are known by.
sidebar:
  order: 1
---

The wallet at https://play.hookedin.com holds your keys and your money, and every game is played inside it.

## Open the wallet

On your first visit the wallet makes your **account**: an Ethereum key in this browser, which signs everything you do
with your money. Its address is your **deposit address**. Nothing needs setting up to open games; before your first
deposit you [save your key](keys-and-recovery.md#your-key).

**Wallet** in the top bar opens the wallet over the page you are on, a game going on under it: your balance, what the
contract still owes you, and three tabs, **Deposit** at `/wallet`, **Withdraw** at `/wallet/withdraw` and **Activity**
at `/wallet/activity`. **Settings**, in the account menu, opens the same way at `/settings`, with a tab for each thing
it is for: **Profile** at `/settings` for your name, **Keys** at `/settings/keys`, **Deposits** at
`/settings/deposits`, **Transfer** at `/settings/transfer`, **Protection** at `/settings/protection` and **Recovery** at
`/settings/recovery`. Each address
opens its tab, over the library when it is a link. Closing it, or Back, brings the page under it back.

The wallet, its games and hookedin.com count money in **µETH**, millionths of an ETH: 0.01 ETH is 10,000 µETH. Amounts
are cut off, never rounded: a balance in whole µETH, and a stake, a payout or a fee at a thousandth of a µETH, a gwei,
with every digit on hover or in full.

This deployment uses **test ETH only**, on Sepolia. Send it nothing else: it accepts no other asset or network, and
offers no fiat conversion or card purchase. The game library works at once; everything with ETH waits until the wallet
has checked the casino's contract on-chain, and a banner says so if that check fails
([how the wallet pins its deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment)).

**Backup and keys**, under **Keys** in Settings, keeps every key this browser made or imported, and **Import a private key** makes one
your account. A game you have open opens again under the account you switch to. **Start over** deletes them all and
opens a new account ([your key](keys-and-recovery.md#your-key)).

## Deposit

Before the Deposit tab shows your deposit address, it asks you to save your wallet: **Save with a passkey**, **I have
a passkey** to open the account of one you made before, or **Save a key file instead**
([your key](keys-and-recovery.md#your-key)). A passkey's account takes over from the one this browser made, and a game
you have open opens again under it.

Then send Sepolia ETH to the address: free test ETH from the Sepolia faucet the tab links to, or a withdrawal from
another player's balance. While the Deposit tab is open and the page visible, the wallet checks the address every 20 seconds and
adds what arrives to your balance; otherwise it checks every 10 minutes, or at once when you press ↻ beside the
wallet's title. ETH too small to cover its fee waits for more.

Each deposit is one transaction, `deposit`, into your account's channel, and your first opens it. After two
confirmations the wallet registers the channel with the casino and asks it to sign a deposit operation, which takes the
money into your balance; until then the wallet shows it as arriving, and a close would pay it back all the same.
From then on bets need no transactions. Anyone can deposit into your channel through the contract, naming your deposit
address, and the wallet takes it in the same way.

A deposit of everything at the address keeps back the most its transaction can cost, its gas limit at its fee cap. Once
your balance has taken the deposit in, the wallet asks the casino to lend it that, so your balance holds all the address
had. The casino lends no more than the rule the wallet prices transactions by allows for the block before the
deposit's: 20% over an estimate of the gas the deposit used, which a node makes up to 1.5% high, at twice that block's
base fee plus the deposit's tip, and at most 1% of the deposit. A deposit that waited for a later block while the base fee fell is lent a little less. The wallet shows the loan under your balance. Bets can stake it, but an investment or a bank deposit
leaves it in the balance, and your next withdrawal, transfer or close pays it back first.

### Free µETH

Verify your Discord account in the HookedIn Discord ([your name](#your-name)) and you can borrow 10 µETH to play with
from the casino's faucet: ask `/faucet` there, then **Get 10 µETH** on your profile within the hour, while your balance
holds less than that. The faucet lends to each member once an hour, whichever HookedIn account they verify, and only as
long as its budget lasts. An
account with no balance has one opened for it, with a deposit of nothing the casino sends; it needs no ETH of its own,
nor a saved wallet, though what you win there is lost with an unsaved wallet. What the faucet lends is a loan, like a
deposit's network fee: bets stake it, and your next withdrawal, transfer or close pays it back first, so what you win
above it is yours to take out ([the faucet](../casino-api/channels.md#post-apichannelsidfaucet)).

### When ETH waits at the address

ETH stays at the deposit address instead, for fees or to withdraw elsewhere, while **Add ETH that arrives at my deposit
address to my balance** is off under **Deposits** in Settings, while the casino is unavailable, and from the start of a close until your
next balance opens ([closing and claims](closing-and-claims.md)). **Add to balance**, on the Deposit tab, adds it when
you choose.

## Games and their allowances

The library at `/` lists the games `@playhookedin` publishes and the games your own account publishes, each by its
[icon](../games/publishing.md#the-icon); **Open a game by its URL** opens any other.

| URL                       | Opens                                               |
| ------------------------- | --------------------------------------------------- |
| `/@alias/game`            | The game published as `game` by the player `@alias` |
| `/~uname/game`            | The same, for a player named by their uname         |
| `/games/custom?url=<url>` | The game whose page is at `<url>`, as nobody's game |

A published game's developer is the account that published it: it earns half of each casino bet's commission in the
game, and takes and settles its developer bets. A game opened by its URL alone is published by nobody: the house keeps
all of its commission, and it takes no developer bets.

While a game is open, the top bar names it and shows its allowance in place of your balance; until you set one,
**Set allowance** is all it offers. The allowance opens the wallet's own dialog, which also opens when the game asks.
Every word in it is the wallet's. When your balance has nothing to allow, the wallet opens its Deposit tab instead. The allowance caps what the
game may risk, and moves no money:

- The money stays in your balance. The allowance is the most the game may put at risk, out of what your balance has
  taken in: a deposit still arriving cannot raise it.
- It lives only in this tab's memory. Leaving the game, reloading or closing the tab takes it back: every time you open
  a game it starts with nothing, and asks again. The dialog deals in whole µETH, and starts at what the game holds now,
  nothing for a game just opened, unless the game asked for an amount: then at that, in whole µETH that cover it. The
  wallet gives a game nothing without your word in its dialog.
- Every verified result of the game's own operations moves it: a stake lowers it as it is bet, and a win raises it once
  the game has shown it, so the figure gives no result away before the game does, and stands still while a round is
  played. Until then the wallet's window says how much of your balance is in play. A game can lose everything it
  holds, its winnings included, and not a wei more.
- Casino bets need nothing more: your wallet checks their odds and their results. A developer bet is a bet against the
  game's developer, who takes the stake and decides what it pays, so the dialog asks you to allow developer bets apart,
  and warns you first. Taking the whole allowance back takes that leave back too.
- A withdrawal lowers it to what stays in your balance, if it was more; taking out everything, or locking in, closes
  the game.
- It signs nothing, so you can change it while an operation is pending, up to your balance less what that operation
  has already committed.
- One game per account holds an allowance at a time, across every tab of the browser: a game in another tab is refused
  at the dialog until you leave the first.

The wallet does not refuse a bet for paying back little: a game can spend its whole allowance on poor bets, and your
[bets](bets-and-receipts.md) show what each game really paid back.

## Withdraw

On the wallet's **Withdraw** tab, enter an amount in µETH, or in ETH by switching its unit, or choose **Max**, and the
address to pay; the tab says what the address receives in both units. The address must be
a valid one other than the zero address, your own deposit address and the casino's contract. Your account signs a
withdrawal of that amount to that address and the casino signs your balance after it at once: your balance pays it now,
and you play on with the rest. The contract then pays the address, out of your deposits first, then your
[collateral](closing-and-claims.md#collateral), and the bankroll for the rest
([withdraw](closing-and-claims.md#withdraw)). Your balance also pays the casino a fee for sending the withdrawal to the
contract, which the tab shows, and pays back what the casino lent it: **Max** is your balance less both.

The casino takes a withdrawal on only when the contract can pay all of it now; otherwise it declines it and says how
much can be withdrawn now, and your balance is as it was. A withdrawal needs the casino and no operation in flight
([when a reply is lost](keys-and-recovery.md#when-a-reply-is-lost)); without the casino,
[close without the casino](closing-and-claims.md#close-without-the-casino).

## Transfer

**Transfer**, in Settings, moves part of your balance into another HookedIn account's balance: enter an amount in µETH or
choose **Max**, and that account's deposit address. It is a withdrawal the contract puts into the balance of the account
at that address, as deposits, instead of paying the address, with the same fee and checks; it is how you give a friend
ETH to play with. The casino declines a transfer to an address with no HookedIn balance.

**Send ETH out of my deposit address**, under **Deposits** in Settings, sends everything held at your deposit address to
the address you name, less the network fee, and leaves your balance as it is. It is for ETH that stays at the address:
it works with **Add ETH that arrives at my deposit address to my balance** off and while no balance is open.

## Your name

Every account has a **uname**: 24 characters of `23456789abcdefghijkmnopqrstvwxyz`, written with a tilde, such as
`~3byt9ocwnnzaxanmiz3stocj`. The casino derives it from your address with a keyed hash whose key it keeps secret, so the
uname does not reveal the address; it is the same for every channel of your account and never changes. The wallet asks
the casino for it as soon as it loads your account, with a request only your key can sign, so you have it before your
first deposit. It is what games, developers and other players learn about you.

An **alias** is the name you go by instead: the username of your Discord account, written with an at sign, such as
`@bob`. Verifying your Discord account in the HookedIn Discord is the only way to one, and needs no balance: **Verify
with Discord**, under **Profile** in Settings, gives you a code, and you type `/verify` with it in the server within 10
minutes. Discord tells the casino your username as you run it, and at no other time: verify again after you change it.
A Discord account is one HookedIn account's: verifying it on another takes it from the first. A username of more than
23 characters is refused, and so is one that reads like another player's alias, with `l` and `1` read as `i` and `0` as
`o`, and the casino's own names, such as `@playhookedin`, the house's; the same username as another player's, whose
Discord account it no longer is, passes to you. **Unlink Discord** goes back to your uname. Your uname stays yours
either way, and both names find you ([verifying a Discord account](../casino-api/channels.md#verifying-a-discord-account)).

`/@alias` or `/~uname` is a player's public page: their names, when the casino first knew them, how many bets they
have played with what they won or lost, and the games they publish ([publishing](../games/publishing.md#publish-it)).
Others see your page from your first deposit, when the casino first registers your account, or from when you first
verify your Discord account. Your name, at the top of the account menu, opens your own page, from the start, with the
way to your name in Settings and the faucet ([free µETH](#free-µeth)).
Anyone can read it, from [`GET /api/players/:name`](../casino-api/public.md#get-apiplayersname), and the casino's list
of players is at https://hookedin.com/players/. Publishing a game makes your address public: your page names it as the
game's developer.

## Help

**Contact support** in the account menu opens an email to support@hookedin.com. Include the transaction hash or
operation ID and the error you see. Never send a private key or key file.
