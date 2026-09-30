---
title: Casino bets
description: The stake, chance and prize of a casino bet, a one-shot game, the casino's edge, measured return, payments and groups.
sidebar:
  order: 3
---

A casino bet is three numbers, a stake, a chance and a prize, settled against the casino's bankroll in the one request
that places it. A coin flip is one casino bet; a game with more outcomes draws which of several such bets to place, and
a hand of blackjack is [one casino bet per step](multi-step-games.md).

## The bet

Every casino bet is on a round, whose outcome is a uniform integer in `[0, 2^64)` that the wallet checks before the game
sees it ([rounds](../overview/how-it-works.md#rounds)). The bet pays `prize` when the outcome is below `chance`.

- `chance` counts winning outcomes out of 2^64, from 1 to 2^64 − 1: a sure win or a sure loss is not a bet.
- `prize` is gross, what a winning bet pays: twice the stake is an even-money win, and a prize below the stake is a
  partial loss.
- The bet moves the balance by `−stake`, and by `+prize` when it wins. Commission is never an extra debit.
- The stake and the prize are above zero and below 2^128 ([`game.casinoBet`](../reference/bridge.md#gamecasinobet)).

## A coin flip

A one-shot game is its rules, as pure arithmetic, and a page that places them. The rules:

```ts title="src/flip.ts"
/** A coin flip: twice the stake on 49.5% of outcomes, a 99% return. */
export const SPACE = 1n << 64n;
export const HEADS = (SPACE * 495n) / 1000n;

export const flipBet = (stake: bigint) => ({ stake, chance: HEADS, prize: 2n * stake });

/** A bet as the bridge takes it: every amount a decimal string. */
export const wire = (bet: ReturnType<typeof flipBet>) => ({
  stake: String(bet.stake),
  chance: String(bet.chance),
  prize: String(bet.prize),
});
```

The page:

```ts title="src/game.ts"
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { HEADS, flipBet, wire } from './flip.ts';

const key = `${HookedIn.storageScope(await HookedIn.info())}:flip`;

/** One flip for `stake`, in wei. */
async function flip(stake: bigint) {
  // The game may risk only its spending limit, which the player sets in the wallet's own dialog.
  const { balance } = await HookedIn.balance();
  if (BigInt(balance) < stake) {
    const funding = await HookedIn.requestFunds({ amount: 10n * stake - BigInt(balance) });
    if (BigInt(funding.balance) < stake) throw new Error('Increase your game allowance to play.');
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

`show` is your page's own. A `settled` receipt carries the round's `outcome` and the `payout`, the prize or 0; a
`rejected` one is a bet the casino declined, with the balance unchanged: offer the same bet again under a fresh `id`.
The saved `id` is what finds the result after a lost reply or a reload ([lost replies](how-a-game-works.md#lost-replies)).

A game of more outcomes, such as a Plinko board or a slot, plays each step as one bet all the same: the page draws which
bet to place, so that every outcome is reached as often as the rules say ([pricing and collapsing](collapsing-bets.md)).
A game whose players share one draw walks a tree of its developer's casino bets instead
([binary steps](developer-bets.md#shared-games-binary-steps)).

## Leave the casino an edge

The casino admits a casino bet when its bankroll can take it by the Kelly criterion with no commission at all, so a bet
with no edge is never admitted, and a bigger prize needs more edge ([pricing and commission](../reference/economics.md)).
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

[`admits`](../sdk/admits.md#admits) is [protocol/risk.ts](../../protocol/risk.ts), the code the casino runs, so a bet it
admits at a bankroll is one the casino admits at that bankroll. The bankroll `wallet.info` reports reserves nothing: the
casino checks each bet against its live bankroll, and a declined bet comes back `rejected`.

## Measured return

No game states what it pays back ([measured return](../wallet/bets-and-receipts.md#measured-return)). The wallet works
out the exact return of every casino bet from its terms before it signs, `prize × chance / (2^64 × stake)`, and the
casino publishes the same figure for every casino bet in your game
([`GET /api/games/:key`](../casino-api/public.md#get-apigameskey)). [`betReturn(bet)`](../sdk/admits.md#betreturn) is
that computation, in millionths of the stake. A game whose steps are collapsed is measured by the bets it places, which
pay back less than the game does ([what is given up](collapsing-bets.md#what-is-given-up)).

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

## Draw the presentation from the outcome

A settled receipt carries `outcome`, the round's 64-bit value as a decimal string. Compute what the player sees from
it, such as which bucket, card or reel stops, and check that the receipt's `payout` is what your bet pays on it: the
picture and the money then cannot disagree. `RoundClient` keeps the value to draw from in `state.settlement.draw`, and
[`seededRandom(BigInt(draw))`](../sdk/engine.md#seededrandom) reads it as a generator, so a reload shows the same
result: [Plinko](../../games/plinko/src/tables.ts) draws its ball's path with it, and
[Samson's Gold](../../games/samson/src/math.ts) its reel stops.

## Payments

A payment is a deterministic debit to the bankroll, [`game.payment`](../reference/bridge.md#gamepayment): no round, no
outcome, no commission. `RoundClient` places one when a step leaves the player less cash with nothing to draw, such as a
cash-out from a state priced above what it pays ([one step is one bet](multi-step-games.md#one-step-is-one-bet)).

## Groups

`group`, a label of 1 to 64 characters, marks bets and payments that belong together: the steps of one hand, the bets
on one match. The player signs it with each; the wallet's bet history shows a group as one row with its net result, and
the game's public record can be read by group. `RoundClient` gives every step of a round the round's ID.
