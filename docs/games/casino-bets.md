---
title: Casino bets
description: Prize tables, a one-shot game, the casino's edge, measured return and payments.
sidebar:
  order: 3
---

A casino bet is a stake and 1 to 64 prizes, settled against the casino's bankroll in the one request that places it.
Anything written as prize ranges over one 64-bit outcome is a game: a coin flip is one prize, a Plinko board a prize
per bucket, a slot a prize per distinct payout, and a hand of blackjack
[one casino bet per step](multi-step-games.md).

## Prizes

Every casino bet is on a round. Its outcome is a uniform integer in `[0, 2^64)`, fixed by a secret the casino committed
to by its hash before the bet and a seed the player's wallet picked; the wallet checks both before the game sees a
result ([rounds](../overview/how-it-works.md#rounds)).

A prize is `{ rangeStart, rangeEnd, payout }`. It pays `payout` when `rangeStart <= outcome < rangeEnd`, so it pays
with probability `(rangeEnd − rangeStart) / 2^64`.

- `payout` is gross: a prize of twice the stake is an even-money win. A prize below the stake is a partial loss.
- Prizes may overlap, and then they add. An outcome in no prize pays nothing.
- The bet moves the balance by `−stake` plus every payout whose range holds the outcome. Commission is never an extra
  debit.
- Amounts are decimal strings of whole smallest units, `rangeStart < rangeEnd <= 2^64`, and the stake and every payout
  are above zero. `wallet.hello` reports the most prizes a bet holds as `limits.prizes`.

The exact field rules are under [`game.casinoBet`](../reference/bridge.md#gamecasinobet).

## A coin flip

A one-shot game is its rules, as pure arithmetic, and a page that places them. The rules:

```ts title="src/flip.ts"
/** A coin flip: twice the stake on the first 49.5% of outcomes, a 99% return. */
export const SPACE = 1n << 64n;
export const HEADS = (SPACE * 495n) / 1000n;

export const flipBet = (stake: bigint) => ({
  stake,
  prizes: [{ rangeStart: 0n, rangeEnd: HEADS, payout: 2n * stake }],
});

/** A bet as the bridge takes it: every amount a decimal string. */
export const wire = (bet: ReturnType<typeof flipBet>) => ({
  stake: String(bet.stake),
  prizes: bet.prizes.map(prize => ({
    rangeStart: String(prize.rangeStart),
    rangeEnd: String(prize.rangeEnd),
    payout: String(prize.payout),
  })),
});
```

The page:

```ts title="src/game.ts"
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { HEADS, flipBet, wire } from './flip.ts';

await HookedIn.hello(); // the asset, which the storage key below names
const key = `${HookedIn.storageScope(await HookedIn.info())}:flip`;

/** One flip for `stake`, in the asset's smallest units. */
async function flip(stake: bigint) {
  // The game may risk only its spending limit. The player sets it in the wallet's own dialog.
  const { balance } = await HookedIn.balance();
  if (BigInt(balance) < stake) {
    const funding = await HookedIn.requestFunds({ amount: 10n * stake - BigInt(balance) });
    if (BigInt(funding.balance) < stake) throw new Error('Add funds to play.');
  }
  // Name the operation and save it before the wallet signs anything.
  const id = crypto.randomUUID();
  localStorage.setItem(key, JSON.stringify({ id, stake: String(stake) }));
  const receipt = await HookedIn.casinoBet({ id, ...wire(flipBet(stake)) });
  localStorage.removeItem(key);
  return receipt;
}

const receipt = await flip(BigInt(HookedIn.parseAmount('0.0001')));
if (receipt.status === 'settled') show(BigInt(receipt.outcome!) < HEADS ? 'Heads' : 'Tails', receipt.payout);
else show(`Declined: ${receipt.reason}`); // the balance is unchanged
```

`show` is your page's own. A `settled` receipt carries the round's `outcome` and the `payout`; a `rejected` one is a
bet the casino declined, with the balance unchanged: offer the same bet again under a fresh `id`. The saved `id` is
what finds the result after a lost reply or a reload ([state and recovery](state-and-recovery.md)).
[Plinko's `drop.ts`](../../games/plinko/src/drop.ts) is the complete pattern, about 150 lines.

## Leave the casino an edge

The casino admits a casino bet when its bankroll can take it as one wager by the Kelly criterion, with no commission at
all ([pricing and commission](../reference/economics.md)). For one prize, with net win `W = payout − stake`, bankroll
`B` and the house edge `e = 1 − p × payout / stake`, it admits the bet only if `W / B <= e`. A net prize of 1% of the
bankroll needs at least a 1% edge, and a bet with no edge is never admitted. Bigger prizes need more edge; prizes on
disjoint ranges hedge each other, and prizes on the same range stack.

Check a bet before offering it, with the casino's own rule:

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { admits } from '@hookedin/play/sdk/admits';
import { flipBet } from './flip.ts';

const stake = BigInt(HookedIn.parseAmount('0.0001'));
const { bankroll } = await HookedIn.info();
// Half the reported bankroll, as the house games use, so that ordinary movement does not turn the bet away.
if (!admits(BigInt(bankroll) / 2n, flipBet(stake))) show('The casino cannot back this stake. Lower it.');
```

[`admits`](../sdk/admits.md#admits) takes amounts as bigints. It is [protocol/risk.ts](../../protocol/risk.ts), the
code the casino runs, so a bet it admits at a bankroll is one the casino admits at that bankroll. The bankroll
`wallet.info` reports is a hint that reserves nothing: the casino checks each bet against its live bankroll, and a
declined bet comes back `rejected`.

## Measured return

No game states what it pays back, and the manifest has no field for it: nothing bounds how often a game wagers the
money it holds, so a stated return would read as a guarantee it is not. What a player gets is measured. The wallet
works out the exact return of every casino bet from its prize table before it signs, and keeps the figure with the bet
in the player's history. The casino publishes the same figure for every casino bet in your game
([`GET /api/games/:key`](../casino-api/public.md#get-apigameskey)), which the wallet shows as the game's public record
([bets and receipts](../wallet/bets-and-receipts.md)).

[`betReturn(bet)`](../sdk/admits.md#betreturn) is that computation: the expected payout in millionths of the stake,
rounded to the nearest. [`describeBet(bet)`](../sdk/admits.md#describebet) gives the most a bet can pay and its
expected payout.

Two things round against a table: ranges are whole outcomes and payouts are whole units. At dust stakes they dominate:
Plinko's 8-row low-risk board returns 99% at a 1,000-wei stake and 38% at 1 wei. Prove your floor in a test, over every
table at every stake you take:

```ts title="test/flip.test.ts"
import test from 'node:test';
import assert from 'node:assert/strict';
import { betReturn } from '@hookedin/play/sdk/admits';
import { flipBet } from '../src/flip.ts';

test('every flip pays back at least 99%, at every stake', () => {
  for (const stake of [1n, 1000n, 10n ** 12n, 10n ** 18n]) assert.ok(betReturn(flipBet(stake)) >= 990000n);
});
```

The flip keeps its edge in the range and pays a whole multiple of the stake, so its return is the same at every stake.
[Plinko's test](../../games/plinko/test/plinko.test.ts) proves its floor over all nine boards.

## Draw the presentation from the outcome

A settled receipt carries `outcome`, the round's 64-bit value as a decimal string. Compute what the player sees from
it: which bucket, which card, which reel stops. The picture and the money then cannot disagree, and the page draws no
randomness of its own. Check that the receipt's `payout` is what your table pays for that outcome, and show nothing
that disagrees.

- [Plinko](../../games/plinko/src/tables.ts) reads the ball's whole path from the outcome's top bits.
- [Samson's Gold](../../games/samson/src/math.ts) picks reel stops from where the outcome fell inside the winning
  prize's range, among exactly the stops that pay what was settled.
- `RoundClient` keeps the outcome and the range that led to the last step in `state.settlement`, for a game that
  shows one of several equal results.

## Payments

`HookedIn.payment(id, amount, group?)` is a deterministic debit to the bankroll: no round, no outcome, no commission.
Its receipt is `settled` or `rejected` and carries no amount. `RoundClient` places one when a step leaves the player
less cash with nothing to draw, such as a cash-out from a state priced above what it pays
([multi-step games](multi-step-games.md#one-step-is-one-bet)). See [`game.payment`](../reference/bridge.md#gamepayment).

## Groups

`group`, a label of 1 to 64 characters, marks bets and payments that belong together: the steps of one hand, the bets
on one match. The player signs it with each; the wallet's bet history shows a group as one row with its net result, and
the game's public record can be read by group. `RoundClient` gives every step of a round the round's ID.
