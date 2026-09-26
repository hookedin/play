---
title: Casino bets
description: The stake, chance and prize of a casino bet, a one-shot game, games of more outcomes, the casino's edge, measured return and payments.
sidebar:
  order: 3
---

A casino bet is three numbers, a stake, a chance and a prize, settled against the casino's bankroll in the one request
that places it. A coin flip is one casino bet. A game with more outcomes, such as a Plinko board or a slot, draws which
of several such bets to place ([more than two outcomes](#more-than-two-outcomes)), and a hand of blackjack is
[one casino bet per step](multi-step-games.md).

## The bet

Every casino bet is on a round. Its outcome is a uniform integer in `[0, 2^64)`, fixed by a secret the casino committed
to by its hash before the bet and a seed the player's wallet picked; the wallet checks both before the game sees a
result ([rounds](../overview/how-it-works.md#rounds)).

The bet pays `prize` when the outcome is below `chance`, so it wins with probability `chance / 2^64`.

- `chance` counts winning outcomes out of 2^64, from 1 to 2^64 − 1: a sure win or a sure loss is not a bet.
- `prize` is gross, what a winning bet pays: twice the stake is an even-money win, and a prize below the stake is a
  partial loss.
- The bet moves the balance by `−stake`, and by `+prize` when it wins. Commission is never an extra debit.
- Amounts are decimal strings of whole smallest units. The stake and the prize are above zero and below 2^128.

The exact field rules are under [`game.casinoBet`](../reference/bridge.md#gamecasinobet).

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

await HookedIn.hello(); // whether the wallet practices, which the storage key below names
const key = `${HookedIn.storageScope(await HookedIn.info())}:flip`;

/** One flip for `stake`, in smallest units of what the wallet plays with. */
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

`show` is your page's own. A `settled` receipt carries the round's `outcome` and the `payout`, the prize or 0; a
`rejected` one is a bet the casino declined, with the balance unchanged: offer the same bet again under a fresh `id`.
The saved `id` is what finds the result after a lost reply or a reload ([state and recovery](state-and-recovery.md)).

## More than two outcomes

One casino bet has two outcomes. A game with more plays them as casino bets all the same:

- A game one player plays is a graph, which [`RoundClient`](../sdk/round.md#roundclient) plays step by step. For a
  step whose outcomes leave the player more than two different amounts, the page draws, with its own randomness, which
  bet to place, so that every outcome is reached exactly as often as the rules say
  ([collapsing bets](collapsing-bets.md)). Plinko and Samson's Gold are one such step each; blackjack and Mines are
  [a sequence of steps](multi-step-games.md).
- A game whose players share one draw, such as a roulette table, has its developer walk a tree of casino bets from its
  bank, one per round, each halving the outcomes left ([binary steps](developer-bets.md#shared-games-binary-steps)).

The wallet verifies the bet a page places, not the draw that chose it
([what is given up](collapsing-bets.md#what-is-given-up)).

## Leave the casino an edge

The casino admits a casino bet when its bankroll can take it by the Kelly criterion, with no commission at all
([pricing and commission](../reference/economics.md)). With net win `W = prize − stake`, bankroll `B` and the house
edge `e = 1 − chance × prize / (2^64 × stake)`, it admits the bet only if `W / B <= e`. A net win of 1% of the bankroll
needs at least a 1% edge, and a bet with no edge is never admitted. Bigger prizes need more edge.

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
works out the exact return of every casino bet from its terms before it signs, `prize × chance / (2^64 × stake)`, and
keeps the figure with the bet in the player's history. The casino publishes the same figure for every casino bet in
your game ([`GET /api/games/:key`](../casino-api/public.md#get-apigameskey)), which the wallet shows as the game's
public record ([bets and receipts](../wallet/bets-and-receipts.md)).

[`betReturn(bet)`](../sdk/admits.md#betreturn) is that computation: the expected payout in millionths of the stake,
rounded to the nearest. [`describeBet(bet)`](../sdk/admits.md#describebet) gives the most a bet can pay and its
expected payout.

A game whose steps the SDK collapses is measured by the bets it places, and together they pay back less of what they
stake than the game does of its stake ([what is given up](collapsing-bets.md#what-is-given-up)).

A chance rounds to whole outcomes and a prize to whole units; at dust stakes the units can move a return far. Prove
your floor in a test, over every bet at every stake you take:

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
[Plinko's test](../../games/plinko/test/plinko.test.ts) proves a floor for every bet a drop can place, over all nine
boards.

## Draw the presentation from the outcome

A settled receipt carries `outcome`, the round's 64-bit value as a decimal string. Compute what the player sees from
it: which bucket, which card, which reel stops. The picture and the money then cannot disagree. Check that the
receipt's `payout` is what your bet pays on that outcome, and show nothing that disagrees.

- `RoundClient` keeps the value to draw from in `state.settlement.draw`: for a bet, drawn from the round's outcome apart
  from the state the step reached, and for a step without one, drawn by the page. [`seededRandom(BigInt(draw))`](../sdk/engine.md#seededrandom) reads it as a
  deterministic generator, so a reload shows the same result.
- [Plinko](../../games/plinko/src/tables.ts) draws the ball's path inside its bucket with it.
- [Samson's Gold](../../games/samson/src/math.ts) picks reel stops with it, among exactly the stops that pay what was
  settled.

## Payments

`HookedIn.payment(id, amount, group?)` is a deterministic debit to the bankroll: no round, no outcome, no commission.
Its receipt is `settled` or `rejected` and carries no amount. `RoundClient` places one when a step leaves the player
less cash with nothing to draw, such as a cash-out from a state priced above what it pays
([multi-step games](multi-step-games.md#one-step-is-one-bet)). See [`game.payment`](../reference/bridge.md#gamepayment).

## Groups

`group`, a label of 1 to 64 characters, marks bets and payments that belong together: the steps of one hand, the bets
on one match. The player signs it with each; the wallet's bet history shows a group as one row with its net result, and
the game's public record can be read by group. `RoundClient` gives every step of a round the round's ID.
