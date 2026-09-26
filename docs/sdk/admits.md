---
title: Admission and return
description: Reference for @hookedin/play/sdk/admits, the casino's admission rule for a casino bet and the return the wallet measures of every bet it signs.
sidebar:
  order: 6
---

`import { admits, betReturn } from '@hookedin/play/sdk/admits';` is the casino's admission rule and what the wallet
measures of every casino bet it signs. The module is Node-safe. `admits` runs the casino's own code,
[protocol/risk.ts](../../protocol/risk.ts), so a price computed with it is a price the casino honours: a game checks its
bets with it, the [engine](engine.md) checks every bet it builds with it, and [binary steps](steps.md) price each level
with it. [Pricing and commission](../reference/economics.md) explains the rule.

Every function here takes a bet in bigints: `{ stake: bigint; chance: bigint; prize: bigint }`, the engine's
[`Bet`](engine.md#bet). The bet pays `prize` when the round's outcome is below `chance`, which counts winning outcomes
out of 2^64. It is well formed when its stake and prize are positive uint256 values and its chance lies from 1 to
2^64 − 1.

```ts
import { admits, betReturn } from '@hookedin/play/sdk/admits';

const bet = { stake: 1000n, chance: 1n << 63n, prize: 1980n };
admits(10n ** 12n, bet); // true: a 99% return leaves the casino an edge
admits(10n ** 12n, { stake: 1000n, chance: 1n << 63n, prize: 2000n }); // false
betReturn(bet); // 990000n: 99.0000% of the stake
```

## The rule

### `admits`

```ts
export const admits: Admits;
```

`(bankroll: bigint, bet: Bet) => boolean`: whether a casino with `bankroll` would take `bet`. With the bankroll B and the
net win W = prize − stake, the casino takes a bet when W < B and it meets the Kelly criterion against the bankroll:
`(B − W) × stake × 2^64 ≥ B × chance × prize`. A bet that risks the bankroll without an edge fails it. The commission the
casino charges on a bet it takes is the most that keeps the criterion. `admits` is `false` for a malformed bet or a
bankroll that is not a positive bigint, and rethrows any error other than a `RangeError`.

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

What a player signs, exactly: `maxPayout`, the most the bet pays, its `prize`; and `expectedPayout`,
`prize × chance`, which is the expected payout times 2^64. `BetTerms` is the bet shape above. Throws a `RangeError` for
a malformed bet.

```ts
describeBet(bet); // { maxPayout: 1980n, expectedPayout: 18262276632972456099840n }
```

### `betReturn`

```ts
export const betReturn: (bet: BetTerms) => bigint;
```

The bet's return in millionths of its stake, rounded to the nearest: `returnParts(bet.stake,
describeBet(bet).expectedPayout)`, which is `prize × chance / (stake × 2^64)`. It is the return the wallet shows for
every casino bet it signs, from the `expectedPayout` it records, and the casino publishes that `expectedPayout` for every
casino bet of a game ([`GET /api/games/:key`](../casino-api/public.md#get-apigameskey)). A chance is whole outcomes and
a prize whole units, so a bet returns a little off its arithmetic, and far less at dust stakes; a game's tests prove its
floor over every bet it can place ([casino bets](../games/casino-bets.md)). Throws a `RangeError` for a malformed bet.

It measures one bet on its own stake. A step of a game stakes only what it can lose, and the bets for its largest prizes
carry more of its edge, so a collapsed game's bets return less of their stakes than the game does of its own
([`collapse`](engine.md#collapse)).

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
if (betReturn(bet) < floor) throw new Error('This bet returns less than 98.5%');
```
