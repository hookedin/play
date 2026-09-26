---
title: Bankroll fund
description: Investing in the casino's bankroll, how shares are priced, the statements your wallet checks, selling shares and the public quote.
sidebar:
  order: 7
---

The bankroll that backs casino bets is open to investors. You move money from your ETH channel into the bankroll and
hold shares of it: when players lose, every share is worth more, and when they win, less. Live figures are at
https://hookedin.com/bankroll/.

## Investing

On **Bankroll**, `/bankroll`, enter an amount under **Invest** and press **Buy shares**. The wallet signs a debit from
your ETH channel whose details name the fund, `FUND_ID = keccak256("HOOKEDIN/BANKROLL")`. No ETH moves on-chain: your
signed balance falls, and the casino's bankroll rises by the same amount, which widens what it can admit.

The casino prices the investment when it takes it:

```text
shares = amount × totalShares / equity    rounded down
```

`equity` is the bankroll before the worst cases of the casino bets being decided, and `totalShares` every share in
issue. With the very first investment, the bankroll the house built before it becomes the house's own shares, one per
wei. The wallet shows shares with 18 decimals, like ETH, so a whole share began at 1 ETH, and its price is what the
bankroll has made or lost since.

Your holding belongs to your funding account's address, not to a channel, so it outlives every channel you open. The
fund takes ETH only, so buy and sell while the tab plays with ETH. An amount too small to buy a share, or a bankroll
with nothing left, is declined with a signed rejection, and your balance is unchanged.

## The statements your wallet checks

The casino answers every investment and every sale with a `ShareStatement` of your holding, signed
([bankroll fund messages](../reference/signed-messages.md#bankroll-fund-messages)): the shares you hold afterwards, the
amount paid in or out, the fund's `equity` and `totalShares` immediately before, which fixed the price, and as its
`cause` the hash of the investment or the `Redeem` you signed. The wallet keeps the latest statement and checks that:

- the casino signed it;
- it is for your address, and its `sequence` follows your last statement's;
- its `cause` is the exact operation or `Redeem` you signed;
- its `shares` and `amount` match what you signed, at the price its own `equity` and `totalShares` state.

It cannot check `equity` and `totalShares` themselves: players' balances are private, so the price is the casino's
word. A statement that fails a check is not adopted. For an investment, the Bankroll page then says _Your wallet
refused a share statement_ with the reason, and the investment's checkpoint stands either way. A wallet restored from
an older backup accepts the casino's later statement as it stands, unless it states fewer shares than the wallet can
prove.

## Selling shares

Under **Sell shares worth**, enter an amount, or press **All**, and press **Sell shares**. The wallet converts the
amount to shares at the quoted price and signs a `Redeem` of them with your channel key. Its `sequence` is the number of
the statement it will produce, so it works once; the wallet saves it before sending, and asking again returns the
recorded statement. The casino burns the shares at the price of that moment:

```text
amount = shares × equity / totalShares    rounded down
```

That amount leaves the bankroll at once and is owed to you. The wallet collects it into your channel with a credit that
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

While your channel is open, the contract still protects your whole original deposit, so the owner cannot withdraw it.
That protection ends when the channel closes, and your shares remain the casino's promise
([trust model](../overview/trust-model.md#fund-shares-are-the-casinos-promise)).
