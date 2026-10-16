---
title: Getting started
description: Open the wallet, deposit ETH, give a game an allowance, withdraw, and the names you are known by.
sidebar:
  order: 1
---

The wallet at https://play.hookedin.com holds your keys and your money, and every game is played inside it. Your first
bet takes four steps:

1. Open https://play.hookedin.com and pick a game.
2. Press **Create wallet** in the top bar, create it with a passkey, and send ETH on Ethereum to the address it shows.
3. Press **Set allowance** in the top bar and allow the game part of your balance.
4. Play. **Wallet**, in the top bar, withdraws what is left to any address.

## Open the wallet

Your first visit is a guest's: games open, and nothing needs setting up. **Create wallet** makes your **account**, an
Ethereum key held by a passkey or a key file, which signs everything you do with your money ([your
key](keys-and-recovery.md#your-key)); its address is your **deposit address**. **Sign in** opens an account you made
before.

**Wallet** opens over the page you are on, a game going on under it: your balance, what the contract still owes you, and
the **Deposit**, **Withdraw**, **Transfer** and **Activity** tabs. **Settings**, in the account menu, has **Keys**,
**Deposits**, **Protection**, **Recovery** and **Advanced**.

Money is counted in **METH**: **1 METH is a millionth of an ETH (0.000001 ETH)**, so 1 ETH = 1,000,000 METH. Amounts are
cut off, never rounded: a balance in whole METH, a stake, a payout or a fee to a thousandth of a METH, and every digit
on hover.

The wallet takes **ETH on Ethereum mainnet only**, and offers no fiat conversion or card purchase. Everything with ETH
waits until the wallet has checked the casino's contract on-chain, and a banner says so if that check fails ([how the
wallet pins its deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment)).

## Deposit

The Deposit tab shows your deposit address. Send ETH on Ethereum to it, or have another player withdraw some to it, and
the wallet adds it to your balance: within 20 seconds while the tab is open, within 10 minutes otherwise, or at once
when you press ↻. Each deposit is one `deposit` transaction into your account's current channel; after two confirmations
the casino signs it into your balance, and from then on bets need no transactions. Until then the wallet shows it as
arriving, and a close would pay it back all the same.

A deposit of everything at the address keeps back the most its transaction can cost. The casino pays that back into your
balance when it is small next to the deposit, as far as [its fee
rule](../casino-api/channels.md#post-apichannelsidoperations), its daily budget and the bankroll allow; otherwise the
fee comes out of the deposit. ETH too small to cover its fee waits for more.

### When ETH waits at the address

ETH stays at the deposit address, for fees or to withdraw elsewhere, while the casino is unavailable and while **Add ETH
that arrives at my deposit address to my balance**, under **Deposits** in Settings, is off; starting a close turns it
off. **Add to balance**, on the Deposit tab, adds it when you choose, and **Send ETH out of my deposit address**, under
**Deposits**, sends all of it to an address you name, less the network fee.

### Paying with other coins through Chainflip

**Pay with BTC, SOL, USDC or USDT through Chainflip**, at the foot of the Deposit tab, gets you a one-time address on
that coin's network from [Chainflip](https://chainflip.io), a cross-chain swap service HookedIn does not run, which
swaps what arrives there for ETH and sends it to your deposit address. Chainflip's fees and its broker's commission are
in its quote; HookedIn takes nothing. Give your own address on the coin's network for refunds, not an exchange's: a swap
that cannot fill within the quote is sent back there. A deposit below Chainflip's minimum, which the wallet shows, or
sent after the address expires a day later, is lost.

## Games and their allowances

The library at `/` lists the games `@hookedin` publishes and those your own account publishes; **Open a game by its
URL** opens any other.

| URL                       | Opens                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/@username/super-dice`   | The game the player `@username` publishes as `Super Dice`, at the [slug](../games/publishing.md#publish-it) its name makes; its name, `/@username/Super Dice`, opens it too |
| `/~uname/super-dice`      | The same, for a player named by their uname                                                                                                                                 |
| `/games/custom?url=<url>` | The game whose page is at `<url>`, as nobody's game                                                                                                                         |

A published game's developer, the account that published it, earns half of each casino bet's commission in the game, and
takes and settles its developer bets. A game opened by its URL alone is nobody's: the house keeps its commission, and it
takes no developer bets.

A game opens with nothing to play with. **Set allowance**, in the top bar, opens the wallet's own dialog, which also
adds up the visit: what you allowed and took back, what the game won or lost, and what is left. The allowance caps what
the game may risk, and moves no money:

- It is the most of your balance the game may put at risk, and lives only in this tab: leaving the game, reloading or
  closing the tab takes it back.
- A stake lowers it as it is bet, and a win raises it once the game has shown it, so it gives no result away. A game can
  lose everything it holds, its winnings included, and not a wei more.
- Casino bets need nothing more, since your wallet checks their odds and results. A developer bet's stake goes to the
  game's developer, who decides what it pays, so the dialog asks you to allow developer bets too, and warns you first.
- A withdrawal lowers it to what stays in your balance; taking out everything, or locking in, closes the game.

The wallet runs in one tab at a time: another tab shows **Use here**, which moves the wallet there and stops any game in
the tab it leaves. It does not refuse a bet for paying back little, [on
purpose](../overview/architecture.md#settled-trade-offs): your [bets](bets-and-receipts.md) show what each game really
paid back.

## Withdraw

On the **Withdraw** tab, enter an amount, or choose **Max**, and the address to pay: any valid address but the zero
address, your own deposit address and the casino's contract. Your account signs the withdrawal and the casino signs your
balance after it at once, so you play on with the rest, and the contract then pays the address ([how a withdrawal is
paid](closing-and-claims.md#withdraw)). Your balance also pays the casino a fee for sending it, which the tab shows
([fees and gas](closing-and-claims.md#fees-and-gas)). A withdrawal needs the casino and no operation in flight ([when a
reply is lost](keys-and-recovery.md#when-a-reply-is-lost)); without the casino, [close without the
casino](closing-and-claims.md#close-without-the-casino).

## Transfer

**Transfer**, in the wallet, gives part of your balance to another player, named by their Discord username, such as
`@bob`, their uname, such as `~3byt9ocwnnzaxanmiz3stocj`, or a link to their page; **Transfer METH** on their page fills
the name in. The wallet shows who the name belongs to and the uname it signs: a Discord username can pass to another
member, a uname never does.

A transfer is an off-chain debit naming their uname, with no fee, which names neither of your addresses to anyone. The
casino owes it to them until their wallet collects it, which needs no ETH or balance of theirs. Beyond their own
deposits it is winnings, paid out of the bankroll, until they [lock their balance
in](closing-and-claims.md#lock-in-your-balance). The casino declines a transfer to a name nobody goes by or to yourself,
and one your deposits would pay before the chain finalizes them, about 15 minutes after each.

## Your name

Every account has a **uname**: 24 characters, written with a tilde, such as `~3byt9ocwnnzaxanmiz3stocj` ([its
alphabet](../reference/signed-messages.md#counterparties)). The casino derives it from your address with a keyed hash
whose key it keeps secret, so it does not reveal the address; it is the same on every channel of your account, never
changes, and is yours before your first deposit. It is what games, developers and other players learn about you.

Verify your Discord account and you go by its **Discord username** instead, written `@bob`. Your own page shows how:
join the HookedIn Discord, press **Verify with Discord** for a code, and type `/verify` with it in the HookedIn Discord
within 10 minutes. Discord tells the casino your username only as you run it, so verify again after you change it. A
Discord account belongs to one HookedIn account at a time. A username that reads like a uname or another player's name
is refused, ignoring case and reading `l` and `1` as `i` and `0` as `o`, and so are the casino's own names, such as the
house's `@hookedin`. **Unlink Discord** goes back to your uname ([verifying a Discord
account](../casino-api/channels.md#verifying-a-discord-account)).

`/@username` or `/~uname` is a player's public page, there from the start: their names, how many bets they have played
with what they won or lost, and the games they publish
([`GET /api/players/:name`](../casino-api/public.md#get-apiplayersname)). Your name, at the top of the account menu,
opens yours. Publishing a game makes your address public: your page names it as the game's developer.

## Help

**Contact support** in the account menu opens an email to support@hookedin.com. Include the transaction hash or
operation ID and the error you see. Never send a private key or key file.
