---
title: Admission and return
description: Reference for @hookedin/play/sdk/admits, the casino's admission rule for a casino bet and the return the wallet measures of every bet it signs.
sidebar:
  order: 5
---

`import { admits, betReturn } from '@hookedin/play/sdk/admits';` is the casino's admission rule and what the wallet
measures of every casino bet it signs. The module is Node-safe. `admits` runs the casino's own code,
[protocol/risk.ts](../../protocol/risk.ts), so a price computed with it is a price the casino honours: a game checks its
tables with it, and the [engine](engine.md) prices steps against it. [Pricing and commission](../reference/economics.md)
explains the rule.

Every function here takes a bet in bigints: `{ stake: bigint; prizes: readonly { rangeStart: bigint; rangeEnd: bigint;
payout: bigint }[] }`, the engine's [`Bet`](engine.md#bet). A bet is well formed when its stake is positive, it holds 1
to 64 prizes, and each prize has a positive payout and a range with `rangeStart < rangeEnd ≤ 2^64`.

```ts
import { admits, betReturn } from '@hookedin/play/sdk/admits';

const bet = { stake: 1000n, prizes: [{ rangeStart: 0n, rangeEnd: 1n << 63n, payout: 1980n }] };
admits(10n ** 12n, bet); // true: a 99% return leaves the casino an edge
admits(10n ** 12n, { stake: 1000n, prizes: [{ rangeStart: 0n, rangeEnd: 1n << 63n, payout: 2000n }] }); // false
betReturn(bet); // 990000n: 99.0000% of the stake
```

## The rule

### `admits`

```ts
export const admits: Admits;
```

`(bankroll: bigint, bet: Bet) => boolean`: whether a casino with `bankroll` would take `bet`. The casino takes a bet
whose worst outcome leaves the bankroll positive and which satisfies the Kelly criterion against the bankroll, so a bet
that risks the bankroll without an edge fails it. `admits` is `false` for a malformed bet or a bankroll that is not a
positive bigint, and rethrows any error other than a `RangeError`.

The bankroll a game prices against is the one `wallet.info` reports, and the casino decides against its bankroll when
the bet arrives: a bet admitted here can still be declined, with a signed rejection that leaves the balance unchanged.

## Measured return

### `describeBet`

```ts
export function describeBet(bet: BetTerms): {
  maxPayout: bigint;
  expectedPayout: bigint;
};
```

What a player signs, exactly: `maxPayout`, the most one outcome pays, overlapping prizes added together; and
`expectedPayout`, the sum over the outcome space of what each outcome pays, which is the expected payout times 2^64.
`BetTerms` is the bet shape above. Throws a `RangeError` for a malformed bet.

```ts
describeBet(bet); // { maxPayout: 1980n, expectedPayout: 18262276632972456099840n }
```

### `betReturn`

```ts
export const betReturn: (bet: BetTerms) => bigint;
```

The bet's return in millionths of its stake, rounded to the nearest: `returnParts(bet.stake,
describeBet(bet).expectedPayout)`. It is the return the wallet shows for every casino bet it signs, from the
`expectedPayout` it records, and the casino publishes that `expectedPayout` for every casino bet of a game
([`GET /api/games/:key`](../casino-api/public.md#get-apigameskey)). Prize ranges are whole outcomes and payouts whole
units, so a table returns a little less than its arithmetic suggests, and far less at dust stakes; a game's tests prove
its floor over every stake it takes ([casino bets](../games/casino-bets.md)). Throws a `RangeError` for a malformed
bet.

### `returnParts`

```ts
export const returnParts: (stake: bigint, expectedPayout: bigint) => bigint;
```

A return in millionths of `stake`, from an `expectedPayout` out of 2^64 as `describeBet` gives it, rounded to the
nearest. Throws a `RangeError` unless `stake` is a positive uint256 and `expectedPayout` a uint256.

### `RETURN_SCALE`

```ts
export const RETURN_SCALE = 1_000_000n;
```

What a return is measured in: millionths of the stake, a percentage with four decimals. 98.5% is `985000n`.

```ts
import { betReturn, RETURN_SCALE } from '@hookedin/play/sdk/admits';

const floor = (985n * RETURN_SCALE) / 1000n; // 98.5%
if (betReturn(bet) < floor) throw new Error('This table returns less than 98.5%');
```
