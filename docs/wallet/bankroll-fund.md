---
title: Bankroll fund
description: Investing in the casino's bankroll, how shares are priced, the statements your wallet checks, selling shares and the public quote.
sidebar:
  order: 5
---

The bankroll that backs casino bets is open to investors. You move money from your balance into the bankroll and hold
shares of it: when players lose, every share is worth more, and when they win, less. Live figures are at
https://hookedin.com/bankroll/. Your shares are the casino's promise ([trust
model](../overview/trust-model.md#fund-shares-are-the-casinos-promise)).

## Investing

On **Bankroll**, `/bankroll`, **Buy shares** signs a debit from your balance whose details name the fund,
`FUND_ID = keccak256("HOOKEDIN/BANKROLL")`. No ETH moves on-chain: your signed balance falls, and the bankroll rises by
as much, which widens what it can admit. The casino prices the investment as it takes it:

```text
shares = amount × totalShares / equity    rounded down
```

`equity` is the bankroll before reservations for casino bets being decided and disputed closes, less the house money the
treasury holds off the contract ([economics](../reference/economics.md#available-capital-and-concurrency)), and
`totalShares` every share in issue. The first investment made the bankroll the house had built its own shares, one per
wei; the wallet shows shares with 12 decimals, like METH, so a whole share began at 1 METH. Your holding belongs to your
account, not to a channel, so it outlives each of your channels; buying and selling need an open balance. An amount too
small to buy a share, or a bankroll with nothing left, is declined with a signed rejection.

## The statements your wallet checks

The casino answers every investment and every sale with a signed `ShareStatement` of your holding ([bankroll fund
messages](../reference/signed-messages.md#bankroll-fund-messages)): the shares you hold afterwards, the amount paid in
or out, the fund's `equity` and `totalShares` just before, which fixed the price, and as its `cause` the hash of what
you signed. The wallet keeps the latest statement and checks its signature, that it follows your last one, that its
cause is what you signed, and that its shares and amount match at its own price; it does not adopt one that fails, and
the Bankroll page says why. It cannot check `equity` and `totalShares`: players' balances are private, so the price is
the casino's word.

A wallet that missed statements, because the account plays on another device too or the browser lost its data, catches
up when the Bankroll page opens and before every sale: it asks the casino for the latest statement and the `Redeem`s
your account signed since its own, and takes up a later statement only if every share it takes away is one of those
redemptions, each checked for your signature, the casino's and its price.

## Selling shares

**Sell shares** converts the amount you enter to shares at the quoted price and signs a `Redeem` of them. Its `sequence`
is the number of the statement it will produce, so it works once; the wallet saves it before sending, and asking again
returns the recorded statement. The casino burns the shares at the price of that moment:

```text
amount = shares × equity / totalShares    rounded down
```

That amount leaves the bankroll at once and is owed to you, and the wallet collects it into your balance with a credit
naming the fund, for no amount but one its own statements priced. A sale larger than the bankroll not reserved for
casino bets in progress waits until those bets settle. Buying and selling at the going price leave every other share
worth what it was.

## The public quote

[`GET /api/fund`](../casino-api/public.md#get-apifund) returns the fund as a signed, timestamped `Fund` the casino can
be held to: the shares in issue, the house's own shares, the equity and `overdrawn`. The wallet checks the signature and
shows what your shares are worth at that price, the **Share price**, the **Bankroll** (the equity) and **The house's own
part**.

## The treasury's capital and `overdrawn`

The treasury adds to the bankroll and withdraws from it on-chain. As the casino observes each, it issues house shares
for an addition and has the house give up shares for a withdrawal, at the price just before, so the price does not move.
What the treasury withdraws beyond the house's shares is a loss every holder bears, which the quote reports as
`overdrawn` from then on, and the Bankroll page shows.

A dispute's reservation changes neither equity nor shares. A close that finalizes at another balance than the signed
state, an unsettled dispute paid as won included, is a profit or loss every holder shares.
