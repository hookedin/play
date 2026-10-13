---
title: Admission and return
description: Reference for @hookedin/play/sdk/admits, the casino's admission rule for a casino bet and the return the wallet measures of every bet it signs.
sidebar:
  order: 6
---

`import { admits, betReturn } from '@hookedin/play/sdk/admits';` is the casino's admission rule and what the wallet
measures of every casino bet it signs. The module is Node-safe. It is the casino's own code,
[protocol/risk.ts](../../protocol/risk.ts), so a price computed with it is a price the casino honours: a game checks its
bets with it, the [engine](engine.md) checks every bet it builds with it, and [binary steps](steps.md) price each level
with it. [Pricing and commission](../reference/economics.md) explains the rule.

Every function here takes a bet in bigints, `{ stake, chance, prize }`, which pays `prize` when the round's outcome is
below `chance`, counted in outcomes out of 2^64. It is well formed when its stake and prize are positive uint256 values
and its chance lies from 1 to 2^64 − 1.

```ts
import { admits, betReturn } from '@hookedin/play/sdk/admits';

const bet = { stake: 1000n, chance: 1n << 63n, prize: 1980n };
admits(10n ** 12n, bet); // true: a 99% return leaves the casino an edge
admits(10n ** 12n, { stake: 1000n, chance: 1n << 63n, prize: 2000n }); // false
betReturn(bet); // 990000n: 99.0000% of the stake
```

## The rule

### `admits`

`admits(bankroll, bet)`: whether a casino with `bankroll` would take `bet`, by the Kelly criterion against the
bankroll with no commission at all. It is `false` for a bet the casino declines, a malformed bet or a bankroll that is
not a nonnegative bigint, and rethrows any error other than a `RangeError`. The casino settles every casino bet the
virtual bankroll of its [quote](../overview/how-it-works.md#quotes) admits, and the contract checks the same rule for a
disputed bet: a bet admitted at the virtual bankroll `wallet.info` reports is covered by the quote that named it, and a
later quote, which each reply brings, names the virtual bankroll as it is then.

### `assessBet`

`assessBet({ bankroll, bet })`: the casino's assessment of a bet, which `admits` runs. `maxFee` is the most commission
that keeps the criterion, the smaller root of the quadratic in
[extracting and splitting the excess](../reference/economics.md#extracting-and-splitting-the-excess); `fee` is the
commission charged, `maxFee` rounded down to an even number of wei, so that it splits equally between the game's
developer and the casino; `liability` is what the bankroll can lose on the bet, its net win when that is positive, plus
`fee`; and `bankroll` is the one given. Throws a `RangeError` for a malformed bet, a bankroll that is not a uint256, a
net win not below the bankroll, or a bet that fails the criterion with no commission at all.

```ts
assessBet({ bankroll: 10n ** 12n, bet }); // { bankroll: 1000000000000n, maxFee: 9n, fee: 8n, liability: 988n }
```

## Measured return

### `betReturn`

A bet's return in millionths of its stake, rounded to the nearest: `prize × chance / (stake × 2^64)`. It is the return
the wallet shows for every casino bet it signs, and the casino publishes the same for every casino bet of a game
([`GET /api/games/:id`](../casino-api/public.md#get-apigamesid)). A chance is whole outcomes and a prize whole units,
so a bet returns a little off its arithmetic, and far less at dust stakes: a game's tests prove its floor
([proving a game's floor](../games/testing.md#proving-a-games-floor)). It measures one bet on its own stake, which for a
collapsed step is less than the step's return ([what is given up](../games/collapsing-bets.md#what-is-given-up)).
Throws a `RangeError` for a malformed bet.

### `RETURN_SCALE`

What a return is measured in: `1_000_000n`, millionths of the stake, a percentage with four decimals. 98.5% is
`985000n`.
