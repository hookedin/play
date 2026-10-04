---
title: Bankroll fund
description: Investing in the casino's bankroll, how shares are priced, the statements your wallet checks, selling shares and the public quote.
sidebar:
  order: 5
---

The bankroll that backs casino bets is open to investors. You move money from your balance into the bankroll and hold
shares of it: when players lose, every share is worth more, and when they win, less. Live figures are at
https://hookedin.com/bankroll/. Your shares are the casino's promise
([trust model](../overview/trust-model.md#fund-shares-are-the-casinos-promise)).

## Investing

On **Bankroll**, `/bankroll`, **Buy shares** signs a debit from your balance whose details name the fund,
`FUND_ID = keccak256("HOOKEDIN/BANKROLL")`. No ETH moves on-chain: your signed balance falls, and the casino's bankroll
rises by the same amount, which widens what it can admit. The casino prices the investment when it takes it:

```text
shares = amount × totalShares / equity    rounded down
```

`equity` is the bankroll before reservations for casino bets being decided and disputed closes, and `totalShares` every
share in issue. The first investment made the bankroll the house built before it the house's own shares, one per wei,
and the wallet shows shares with 12 decimals, like METH, so a whole share began at 1 METH. Your holding belongs to your
account's address, not to a channel, so it outlives each of your account's channels; buying and selling need an open
balance. An amount too small to buy a share, or a bankroll with nothing left, is declined with a signed rejection, and
your balance is unchanged.

## The statements your wallet checks

The casino answers every investment and every sale with a `ShareStatement` of your holding, signed ([bankroll fund
messages](../reference/signed-messages.md#bankroll-fund-messages)): the shares you hold afterwards, the amount paid in
or out, the fund's `equity` and `totalShares` immediately before, which fixed the price, and as its `cause` the hash of
the investment or the `Redeem` you signed. The wallet keeps the latest statement and checks its signature, that it
follows your last one, that its cause is what you signed, and that its shares and amount match that at its own price. It
cannot check `equity` and `totalShares` themselves: players' balances are private, so the price is the casino's word. A
statement that fails a check is not adopted, and the Bankroll page says why. A wallet whose account plays on another
device too, or that lost its browser's data, has missed statements: when the Bankroll page opens and before every sale, it asks the
casino for its latest one and every `Redeem` your account signed, and takes the later statement up only if every share
it takes away is one of those redemptions, each checked for your signature, the casino's and its price. What they sold
for is owed to you. It waits while an operation or a sale is pending, whose own reply brings its statement.

## Selling shares

**Sell shares** converts the amount you enter to shares at the quoted price and signs a `Redeem` of them with your
account's key. Its `sequence` is the number of the statement it will produce, so it works once; the wallet saves it
before sending, and asking again returns the recorded statement. The casino burns the shares at the price of that
moment:

```text
amount = shares × equity / totalShares    rounded down
```

That amount leaves the bankroll at once and is owed to you. The wallet collects it into your balance with a credit that
names the fund, and signs such a credit only for an amount one of its own statements priced. A sale larger than the
bankroll not reserved for casino bets in progress is refused until those bets settle. Buying and selling at the going
price leave every other share worth what it was.

## The public quote

[`GET /api/fund`](../casino-api/public.md#get-apifund) returns the fund as the casino states it, a signed and
timestamped `Fund`, which is a quote the casino can be held to: the shares in issue, the house's own shares, the equity,
`overdrawn`, and the time in Unix seconds. The wallet checks the signature and shows what your shares are worth at that
price, the **Share price**, the **Bankroll** (the equity) and **The house's own part**, `houseShares` as a share of
`totalShares`.

## The owner's capital and `overdrawn`

The owner adds to the bankroll and withdraws from it on-chain. At each observation of the chain, the casino issues house
shares for any such addition and has the house give up shares for any withdrawal, at the price immediately before, so
the price does not move. The house cannot give up shares it does not have: what the owner withdraws beyond them is a
loss every holder bears, and the quote reports it as `overdrawn` from then on. The Bankroll page then says how much
more the owner has withdrawn than its own shares covered.

A dispute reserves only what its proposed payout adds to obligations already in the books. Reserving and releasing
that money changes neither equity nor shares. A close that finalizes at a different balance from the signed state,
including an unsettled dispute paid as won, changes equity as a profit or loss shared by every holder.
