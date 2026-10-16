---
title: Multi-step games
description: Games with decisions, described as a graph and played as one casino bet per step with RoundClient.
sidebar:
  order: 4
---

A game with decisions, such as blackjack or Mines, is a sequence of casino bets, one per step, each settled on its own,
so a player can walk away after any settled step with the cash it left them: a [settled
trade-off](../overview/architecture.md#settled-trade-offs). You describe the game as a graph; the engine prices every
state with the casino's own admission rule, and [`RoundClient`](../sdk/round.md#roundclient) plays it through the
wallet.

## Describe the game as a graph

A [`GameGraph`](../sdk/engine.md#gamegraph) is a finite, acyclic graph of public states: `root`, the first node's ID,
and `nodes`.

- A **decision** node lists `actions`. Each action lists its `outcomes`, whose probabilities sum to one: the `next` node, an exact
  `probability` made with [`fraction`](../sdk/engine.md#fraction), and an optional `label` saying what happened, such as
  the card drawn, which the wallet shows with the step's table.
- A **terminal** node has a `payout`: the gross cash the player ends with, as a bigint.

Double up, a game of two flips:

```ts title="src/rules.ts"
import { fraction } from '@hookedin/play/sdk/engine';
import type { GameGraph } from '@hookedin/play/sdk/engine';

/** Double up: flip for 1.9 times the stake, then keep it or flip it for 1.9 times again. */
export function doubleUp(setup: { stake: bigint }): GameGraph {
  const stake = setup.stake,
    half = fraction(1n, 2n);
  const flip = (win: string) => ({
    id: 'flip',
    outcomes: [
      { next: win, probability: half, label: 'heads' },
      { next: 'lost', probability: half, label: 'tails' },
    ],
  });
  return {
    root: 'start',
    nodes: [
      { id: 'start', kind: 'decision', actions: [flip('won')] },
      {
        id: 'won',
        kind: 'decision',
        actions: [{ id: 'take', outcomes: [{ next: 'took', probability: fraction(1n) }] }, flip('won-twice')],
      },
      { id: 'took', kind: 'terminal', payout: (stake * 19n) / 10n },
      { id: 'won-twice', kind: 'terminal', payout: (stake * 361n) / 100n },
      { id: 'lost', kind: 'terminal', payout: 0n },
    ],
  };
}
```

Each flip returns 95% of what it risks, which leaves the casino the edge it needs.

## Play it with RoundClient

```ts title="src/game.ts"
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import { doubleUp } from './rules.ts';

const round = new RoundClient(HookedIn, doubleUp);

// On startup: the saved round, with any step the wallet settled while the page was away.
let state = await round.restore().catch(error => {
  message(error.message); // a round saved under rules this page does not build: it is let go
  return null;
});
render(state);

async function play(action: string) {
  if (!state || state.terminal) state = await round.start({ stake: 100n * HookedIn.METH });
  state = await round.action(action); // 'flip' or 'take'
  render(state); // state.nodeId, state.cash, state.actions, state.events
  if (state.terminal) await round.end(state); // the round is over on the page
}
// The player's past rounds, from any device of theirs, drawn as they were played.
for (const past of (await round.past({ limit: 10 })).rounds) renderPast(past);
```

`render`, `renderPast` and `message` are your page's own.

- `restore()` loads the player's saved round and resolves a step whose reply was lost. Call it on startup.
- `start(setup)` checks that the allowance covers `setup.stake`, prices the graph and saves the round; no money moves
  until the first action. Any other field of `setup` is yours for the graph function, such as Dice's `chanceBps`.
- `action(id)` plays one step, saved under a fresh operation ID before anything is signed, and moves to the result the
  wallet landed on, checked against the verified payout.
- The state ([`RoundState`](../sdk/round.md#roundstate)) says where the round stands: `cash` is what the round holds,
  which the player keeps if they stop, and `events` each step's action and label, to redraw the round after a reload.
- Each step is in the round's group, `state.id`, so the allowance in the wallet's top bar drops by the stake on the
  first step and then stands still. [`end(state)`](../sdk/round.md#end), once the page has shown how the round ended,
  adds what it paid ([groups](how-a-game-works.md#groups)) and keeps the round in the player's history, which
  [`past()`](../sdk/round.md#past) reads back, newest first, on any device of the player's.

## One step is one bet

When the player acts, `RoundClient` sends the step's table: each successor with its weight, the cash it needs and its
label. A step whose successors all need the same cash places no bet, paying any cash above it to the bankroll first; any
other places at most one casino bet, after which the player's cash is exactly the reached successor's, and a step of
more than two amounts is collapsed: the wallet draws which bet to place, reaching every successor exactly as often as
the rules say ([pricing and collapsing](collapsing-bets.md)). In Double up, `flip` from `start` stakes the stake for a
prize of 1.9 stakes on half the outcomes, and `take` moves no money: the 1.9 stakes are already in the player's balance.

## Pricing

The engine works backward from the terminal payouts and gives every state its cash: the least that finances each of its
actions with bets the casino's rule admits. That is more than the state's expected value, by a [risk
premium](collapsing-bets.md#why-the-price-exceeds-the-expected-value) that shrinks as the bankroll grows, so every step
needs an edge of its own. `RoundClient` prices against half the virtual bankroll `wallet.info` reports
([`pricing`](../sdk/round.md#pricing)), and refuses a stake the casino cannot back before anything is signed, with an
error naming about how much it can back.

## Extra wagers

An action can commit more of the player's money, such as a double, a split or insurance: give it `additionalCash`.
`state.actionCosts` says what each action adds, and `state.contributed` what the player has put in so far. An action the
allowance and the round's cash do not cover is refused with
[`HookedIn.NOT_ENOUGH_ALLOWANCE`](../sdk/hookedin.md#not_enough_allowance) before anything is sent.

## Precomputed prices

Pricing a large graph in the page takes time. The constructor's `funding` option is a
[`FundingTable`](../sdk/engine.md#fundingtable), each action's required cash at one stake, which `RoundClient` scales by
an exact integer when the stake is a multiple of the table's `initialCash` and the bankroll covers its
`conservativeBankroll` times that multiple. [Blackjack](https://github.com/hookedin/game-blackjack) commits its table
and passes it:

```ts
const round = new RoundClient(HookedIn, setup => createBlackjack({ stake: setup.stake }), {
  funding: blackjackFunding,
});
```

A table is right only for the rules it was generated from: blackjack's `npm run generate` writes it with `compileGame`,
and its `npm test` fails when the table does not match.

## Changing the rules

A saved round carries a hash of its rules, the graph the page builds for its setup. Once you change the graph, a round
saved under the old one cannot be finished: `restore()` throws once, with a message telling the player that what the
round held is in their balance, and returns `null` after. Every step it took had already settled.
