---
title: Casino bets
description: The stake, chance and prize of a casino bet, a one-shot game, the casino's edge, measured return and payments.
sidebar:
  order: 3
---

A casino bet is three numbers, a stake, a chance and a prize, settled against the casino's bankroll in the one request
that places it. A game asks for one as a step: the cash it holds and the table of results it can end in, which the
wallet turns into the bet. A coin flip is a table of two results, one bet; the wallet [collapses](collapsing-bets.md) a
table of more results into one bet it draws, a game of decisions plays [one casino bet per step](multi-step-games.md),
and a draw many players share is backed in [binary steps](developer-bets.md#shared-games-binary-steps).

## The bet

The bet pays `prize` when the round's outcome, a uniform integer in `[0, 2^64)` that the wallet checks before the game
sees it, is below `chance` ([how it works](../overview/how-it-works.md)):

- `chance` counts winning outcomes out of 2^64, from 1 to 2^64 − 1: a sure win or a sure loss is not a bet.
- `prize` is gross, what a winning bet pays: twice the stake is an even-money win, and a prize below the stake is a
  partial loss.
- The bet moves the balance by `−stake`, and by `+prize` when it wins. Commission is never an extra debit.
- The stake and the prize are above zero and below 2^96.

A game never names these: it offers a step ([`game.casinoBet`](../reference/bridge.md#gamecasinobet)), and a step of two
results, the prize with weight `chance` and nothing with weight `2^64 − chance`, is exactly this bet.

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

`show` is your page's own, and every amount is a bigint of wei. A `settled` receipt carries the bet the wallet placed,
the round's `outcome`, the `payout`, the prize or 0, and `result`, the place in the table of the result the step landed
on. A `rejected` one is a bet the casino declined, as when its quote expired while it waited, with the balance
unchanged: offer the step again under a fresh `id`. The saved `id` finds the result after a lost reply or a reload
([lost replies](how-a-game-works.md#lost-replies)), and [`HookedIn.showBet(id)`](../reference/bridge.md#walletshowbet)
shows the player its proof in the wallet.

## Leave the casino an edge

The casino settles a casino bet only when the virtual bankroll of its [quote](../overview/how-it-works.md#quotes) can
take it by the Kelly criterion with no commission at all, so a bet with no edge is never admitted, and a bigger prize
needs more edge ([pricing and commission](../reference/economics.md)). Check a bet before offering it, with the casino's
own rule:

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { admits } from '@hookedin/play/sdk/admits';
import { flipBet } from './flip.ts';

const stake = 100n * HookedIn.METH;
const { virtualBankroll } = await HookedIn.info();
// Half the virtual bankroll, as the house games use, so that the quote a later reply brings still covers the bet.
if (!admits(virtualBankroll / 2n, flipBet(stake))) show('The casino cannot back this stake. Lower it.');
```

[`admits`](../sdk/admits.md#admits) is [protocol/risk.ts](../../protocol/risk.ts), the code the casino runs.
`wallet.info` reports the virtual bankroll of the wallet's latest quote, and the wallet refuses a step that quote does
not cover, in any bet of the split, with `not-covered` before anything is drawn or signed.

## Measured return

Players see each bet's [house edge](../wallet/bets-and-receipts.md#house-edge) in METH, `stake − prize × chance / 2^64`,
worked out from the bet they signed: no game states what it pays back. [`betReturn(bet)`](../sdk/admits.md#betreturn) is
a bet's return, `prize × chance / (2^64 × stake)` in millionths of the stake, for your own tests. A bet drawn from a
step pays back less of its own stake than the step does of what it held ([what is given
up](collapsing-bets.md#what-is-given-up)), but the edges of the bets drawn come, on average, to the step's, and your
game's public record ([`GET /api/games/:id`](../casino-api/public.md#get-apigamesid)) adds them up.

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

A step's receipt carries `result`, the result the wallet landed on, which leaves the player what the bet paid, and
`draw`, a 64-bit value the wallet drew after it. Show the result `result` names, such as which bucket, card or pay, and
draw how it looks from `draw`, such as the ball's path or the reel stops: the picture and the money then cannot
disagree. `RoundClient` keeps the value in `state.settlement.draw`, and
[`seededRandom(draw)`](../sdk/engine.md#seededrandom) reads it as a generator, so a reload shows the same result:
[Plinko](../../games/plinko/src/tables.ts) draws its ball's path with it, and [Samson](../../games/samson/src/math.ts)
its reel stops.

## Payments

A payment, [`game.payment`](../reference/bridge.md#gamepayment), is a fixed debit to the bankroll: no round, no outcome,
no commission. `RoundClient` places one when a step leaves the player less cash with nothing to draw, such as a cash-out
from a state priced above what it pays ([one step is one bet](collapsing-bets.md#one-step-is-one-bet)).
