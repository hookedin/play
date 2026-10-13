---
title: Casino bets
description: The stake, chance and prize of a casino bet, a one-shot game, the casino's edge, measured return, payments and groups.
sidebar:
  order: 3
---

A casino bet is three numbers, a stake, a chance and a prize, settled against the casino's bankroll in the one request
that places it. A game asks for one as a step: the cash the step holds, and the table of results it can end in, which
the wallet turns into the bet. A coin flip is a table of two results, one casino bet; the wallet splits a table of more
results into several such bets and draws which to place, and a hand of blackjack is
[one casino bet per step](multi-step-games.md).

## The bet

Every casino bet is on a round, whose outcome is a uniform integer in `[0, 2^64)` that the wallet checks before the game
sees it ([how it works](../overview/how-it-works.md)). The bet pays `prize` when the outcome is below `chance`.

- `chance` counts winning outcomes out of 2^64, from 1 to 2^64 − 1: a sure win or a sure loss is not a bet.
- `prize` is gross, what a winning bet pays: twice the stake is an even-money win, and a prize below the stake is a
  partial loss.
- The bet moves the balance by `−stake`, and by `+prize` when it wins. Commission is never an extra debit.
- The stake and the prize are above zero and below 2^96.

A game never names these: it offers a step ([`game.casinoBet`](../reference/bridge.md#gamecasinobet)), and the bet a
step of two results, its prize with weight `chance` and nothing with weight `2^64 − chance`, splits into is exactly
this one.

## A coin flip

A one-shot game is its rules, as pure arithmetic, and a page that places them. The rules:

```ts title="src/flip.ts"
/** A coin flip: twice the stake on 49.5% of outcomes, a 99% return. */
export const SPACE = 1n << 64n;
export const HEADS = (SPACE * 495n) / 1000n;

export const flipBet = (stake: bigint) => ({ stake, chance: HEADS, prize: 2n * stake });
/** The flip as a step: heads leaves twice the stake, tails nothing, as often as the bet's chance says. */
export const flipStep = (stake: bigint) => ({
  cash: stake,
  results: [
    { weight: HEADS, cash: 2n * stake, label: 'Heads' },
    { weight: SPACE - HEADS, cash: 0n, label: 'Tails' },
  ],
});
```

The page:

```ts title="src/game.ts"
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { json } from '@hookedin/play/sdk/json';
import { flipStep } from './flip.ts';

const key = `${HookedIn.storageScope(await HookedIn.info())}:flip`;

/** One flip for `stake`, in wei. */
async function flip(stake: bigint) {
  // The game may risk only its allowance, which the player sets in the wallet's top bar.
  const { allowance } = await HookedIn.allowance();
  if (allowance < stake) throw new Error(HookedIn.NOT_ENOUGH_ALLOWANCE);
  // Name the operation and save it before the wallet signs anything.
  const id = crypto.randomUUID();
  localStorage.setItem(key, json({ id, stake }));
  // A step of one bet, in a group of its own, so what it wins shows in the wallet's top bar only once the page has
  // shown the flip.
  const receipt = await HookedIn.casinoBet({ id, ...flipStep(stake), group: id });
  localStorage.removeItem(key);
  return receipt;
}

const receipt = await flip(100n * HookedIn.METH);
if (receipt.status === 'settled') show(receipt.result === 0n ? 'Heads' : 'Tails', receipt.payout);
else show(`Declined: ${receipt.reason}`); // the balance is unchanged
await HookedIn.end(receipt.id); // the flip is on the page
```

`show` is your page's own. Every amount is a bigint of wei, as the bridge carries it. A `settled` receipt carries the
bet the wallet placed, the round's `outcome`, the `payout`, the prize or 0, and `result`, the place in the table of the
result the step landed on; a `rejected` one is a bet the casino declined, as when its quote expired while it waited,
with the balance unchanged: offer the same step again under a fresh `id`. The saved `id` is
what finds the result after a lost reply or a reload ([lost replies](how-a-game-works.md#lost-replies)), and what
[`HookedIn.showBet(id)`](../sdk/hookedin.md#showbet) shows the player the proof of, in the wallet.

A game of more outcomes, such as a Plinko board or a slot, plays each step as one bet all the same: the page offers
every result with its weight, and the wallet splits the table into bets and draws which to place, so that every result
is reached as often as the table says and neither the page nor the casino chooses which
([pricing and collapsing](collapsing-bets.md)).
A game whose players share one draw walks a tree of its own casino bets instead
([binary steps](developer-bets.md#shared-games-binary-steps)).

## Leave the casino an edge

The casino settles a casino bet when the virtual bankroll of its [quote](../overview/how-it-works.md#quotes), half the
casino's bankroll, can take it by the Kelly criterion with no commission at all, so a bet with no edge is never
admitted, and a bigger prize needs more edge ([pricing and commission](../reference/economics.md)). Check a bet before
offering it, with the casino's own rule:

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { admits } from '@hookedin/play/sdk/admits';
import { flipBet } from './flip.ts';

const stake = 100n * HookedIn.METH;
const { virtualBankroll } = await HookedIn.info();
// Half the virtual bankroll, as the house games use, so that the quote a later reply brings still covers the bet.
if (!admits(virtualBankroll / 2n, flipBet(stake))) show('The casino cannot back this stake. Lower it.');
```

[`admits`](../sdk/admits.md#admits) is [protocol/risk.ts](../../protocol/risk.ts), the code the casino runs, so a bet it
admits at a virtual bankroll is one a quote naming that virtual bankroll covers. `wallet.info` reports the virtual
bankroll of the wallet's latest quote; the wallet splits the step at the quote it holds when it signs, and a step that
quote does not cover, in any bet of the split, is refused with `not-covered` before anything is drawn or signed.

## Measured return

No game states what it pays back ([return offered](../wallet/bets-and-receipts.md#return-offered)). The wallet works
out the exact return of every casino bet from its terms before it signs, `prize × chance / (2^64 × stake)`.
[`betReturn(bet)`](../sdk/admits.md#betreturn) is that computation, in millionths of the stake. A bet drawn from a
step pays back less than the step does ([what is given up](collapsing-bets.md#what-is-given-up)), so a step of a round
is measured by its table instead: what it was expected to leave of what it held. The wallet's My games and your game's
public record ([`GET /api/games/:id`](../casino-api/public.md#get-apigamesid)) add up what your players' bets offered
that way.

A chance rounds to whole outcomes and a prize to whole units, so at dust stakes the units can move a return far. Prove
your floor in a test ([proving a game's floor](testing.md#proving-a-games-floor)):

```ts title="test/flip.test.ts"
import test from 'node:test';
import assert from 'node:assert/strict';
import { betReturn } from '@hookedin/play/sdk/admits';
import { flipBet } from '../src/flip.ts';

test('every flip pays back at least 99%, at every stake', () => {
  for (const stake of [1n, 1000n, 10n ** 12n, 10n ** 18n]) assert.ok(betReturn(flipBet(stake)) >= 990000n);
});
```

The flip keeps its edge in its chance and pays a whole multiple of the stake, so its return is the same at every stake.

## Draw the presentation from the receipt

A receipt of a step carries `result`, the result the wallet landed on, which leaves the player what the bet paid, and
`draw`, a 64-bit value the wallet drew after it. Show the result `result` names, such as which bucket, card or pay, and
draw how it looks from `draw`, such as the ball's path or the reel stops: the picture and the money then cannot
disagree. `RoundClient` keeps the value to draw from in `state.settlement.draw`, and
[`seededRandom(draw)`](../sdk/engine.md#seededrandom) reads it as a generator, so a reload shows the same
result: [Plinko](../../games/plinko/src/tables.ts) draws its ball's path with it, and
[Samson](../../games/samson/src/math.ts) its reel stops.

## Payments

A payment is a deterministic debit to the bankroll, [`game.payment`](../reference/bridge.md#gamepayment): no round, no
outcome, no commission. `RoundClient` places one when a step leaves the player less cash with nothing to draw, such as a
cash-out from a state priced above what it pays ([one step is one bet](multi-step-games.md#one-step-is-one-bet)).

## Groups

`group`, a label of 1 to 64 characters, marks bets and payments that belong together: the steps of one hand, the bets
on one match. The player signs it with each; the wallet's bet history shows a group as one row with its net result, and
the game's public record can be read by group. `RoundClient` gives every step of a round the round's ID.
