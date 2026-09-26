---
title: Multi-step games
description: Games with decisions, described as a graph and played as one casino bet per step with RoundClient.
sidebar:
  order: 4
---

A game with decisions, such as blackjack or Mines, is played as a sequence of casino bets, one per step, each settled
on its own. A player can walk away after any settled step with the cash that step left them: that is a
[settled trade-off](../overview/architecture.md#settled-trade-offs), and it is what lets every step settle at once. You
describe the game as a graph; the engine prices every state with the casino's own admission rule, and
[`RoundClient`](../sdk/round.md#roundclient) plays it through the wallet.

## Describe the game as a graph

A [`GameGraph`](../sdk/engine.md#gamegraph) is a finite, acyclic graph of public states: `root`, the first node's ID,
and `nodes`.

- A **decision** node lists `actions`. Each action lists its `outcomes`: the `next` node, an exact `probability` made
  with [`fraction`](../sdk/engine.md#fraction), and an optional `label` saying what happened, such as the card drawn.
  An action's probabilities sum to one.
- A **terminal** node has a `payout`: the gross cash the player ends with, as a bigint.

Double up, a game of two flips:

```ts title="src/rules.ts"
import { fraction } from '@hookedin/play/sdk/engine';
import type { GameGraph } from '@hookedin/play/sdk/engine';

/** Double up: flip for 1.9 times the stake, then keep it or flip it for 1.9 times again. */
export function doubleUp(setup: { stake: string }): GameGraph {
  const stake = BigInt(setup.stake),
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
import { mountBank } from '@hookedin/play/sdk/bank';
import { doubleUp } from './rules.ts';

const round = new RoundClient(HookedIn, doubleUp);
mountBank(document.getElementById('bank')!, { round });

// On startup: the saved round, with any step the wallet settled while the page was away.
let state = await round.restore().catch(error => {
  message(error.message); // a round saved under rules this page does not build: it is let go
  return null;
});
render(state);

async function play(action: string) {
  if (!state || state.terminal) state = await round.start({ stake: HookedIn.parseAmount('0.0001') });
  state = await round.action(action); // 'flip' or 'take'
  render(state); // state.nodeId, state.cash, state.actions, state.events
}
round.watch(() => render(round.state())); // another tab moved the round
```

`render` and `message` are your page's own.

- `new RoundClient(bridge, graph, funding?, { store?, name? })` takes the bridge (`HookedIn` in a page), the function
  that builds the graph for a setup, an optional [precomputed price table](#precomputed-prices), and where the round
  is saved: `localStorage` and the page's path unless you say otherwise.
- `restore()` loads the player's saved round and resolves a step whose reply was lost
  ([state and recovery](state-and-recovery.md)). Call it on startup.
- `start(setup)` starts a round. `setup.stake` is the stake as a decimal string, and any other field is yours for the
  graph function, such as Dice's `chanceBps`. It asks the wallet for money if the limit is short, prices the graph and
  saves the round; no money moves until the first action.
- `action(id)` plays one step. It asks for money if the step needs more than the limit holds, draws which bet the step
  places with the page's own randomness and saves it with a fresh operation ID before anything is signed, places it as
  one `game.casinoBet` (or a `game.payment`, or nothing), checks the wallet's verified payout against the bet, and
  advances to the state the outcome reaches.
- The state says where the round stands: `nodeId`, `cash` (what the round holds, which the player keeps if they stop),
  `terminal`, `actions` (what is legal from here), `events` (each step's action and label, to redraw the round after a
  reload) and `settlement` (the last step's result: whether its bet won and at what chance, its payout and outcome, and
  `draw`, the value to show it with). Every field is in [`RoundState`](../sdk/round.md#roundstate).

## One step is one bet

When the player acts, the engine groups the step's successors by the cash they need into **cash classes**. A step with
one class places no bet, and any cash above that class's is paid to the bankroll as a `game.payment`. Any other step
places at most one casino bet, between a lower class and a higher one:

```text
stake  = current cash − the lower class's cash
prize  = the higher class's cash − the lower class's cash
```

Whatever the outcome, the player's cash after the bet is exactly the reached class's. A step of two classes, one on
each side of the current cash, is always that one bet. A step of more is collapsed: the page draws, with its own
randomness and before anything is signed, which pair of classes to bet between, in proportions that reach every class
exactly as often as the rules say, and a class at exactly the current cash is reached with no bet
([collapsing bets](collapsing-bets.md)). Which state of a class, when several need its cash, is drawn from the round's
outcome, so the verified outcome names the card as well as the money.

In Double up, `flip` from `start` stakes the stake for a prize of 1.9 stakes that wins on half the outcomes, and `take`
moves no money: the 1.9 stakes are already in the player's balance. [Sequential games](sequential-games.md) derives all
of it.

## Pricing

The engine works backward from the terminal payouts and gives every state its **cash**: the least that finances each
of its actions with bets the casino's rule admits. That is more than the state's expected value, by a
[risk premium](sequential-games.md#why-the-price-exceeds-the-expected-value) that shrinks as the bankroll grows.

`RoundClient` prices against half the bankroll `wallet.info` reports, on a grid of a billionth of the stake, and starts
the round with the stake as its cash. A stake the casino cannot back is refused before anything is signed, with an
error naming about how much it can back. The next round with the same setup reuses the prices while the bankroll still
covers their conservative starting requirement. Every step needs an edge of its own: a step with none is never
admitted, which is why a Mines ladder pays back less the deeper it goes.

## Extra wagers

An action can commit more of the player's money, such as a double, a split or insurance: give it `additionalCash`.
`state.actionCosts` says what each action adds, and `state.contributed` what the player has put in so far. When the
limit is short, `RoundClient` asks the wallet for the shortfall plus four stakes, so one authorization lasts a few
rounds.

## Precomputed prices

Pricing a large graph in the page takes time. The constructor's third argument is a
[`FundingTable`](../sdk/engine.md#fundingtable): each action's required cash at one stake. `RoundClient` uses it,
scaled by an exact integer, when the stake is a multiple of the table's `initialCash` and the bankroll covers its
`conservativeBankroll` times that multiple; otherwise it prices in the page with `compileGameAsync`. Blackjack passes
the committed table:

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import { createBlackjack } from '@hookedin/play/sdk/engine';
import { blackjackFunding } from '@hookedin/play/sdk/generated/blackjack-funding';

const round = new RoundClient(HookedIn, setup => createBlackjack({ stake: BigInt(setup.stake) }), blackjackFunding);
```

A table is right only for the rules it was generated from;
[sdk/scripts/blackjack-funding.ts](../../sdk/scripts/blackjack-funding.ts) generates blackjack's.

## Changing the rules

A saved round carries a hash of its rules: the graph the page builds for its setup. Once you change the graph, a round
saved under the old one cannot be finished here: `restore()` throws once, with a message telling the player that what
the round held is in their balance, and returns `null` after. Every step it took had already settled in the wallet.

## The balance strip

`mountBank(element, { round })` shows the game's limit less the cash inside an unfinished round, and stands still while
a step settles, so the figure moves once a round: down by what the player put in, up by what the round finally pays.
The cash it leaves out is the player's all the same ([`mountBank`](../sdk/bank-and-synth.md#mountbank)).

## Examples

- [Mines](../../games/mines/): `createMines({ tiles, mines, cashouts })`, reveal or cash out. The simplest graph where
  the player decides when to stop.
- [Blackjack](../../games/blackjack/): `createBlackjack({ stake })` with the precomputed table; doubles, splits and
  insurance through `additionalCash`, and the cards redrawn from `state.events`.
- [Dice](../../games/dice/): one decision with two outcomes, [src/rules.ts](../../games/dice/src/rules.ts).
- [Plinko](../../games/plinko/): one decision whose outcomes are the buckets,
  [src/tables.ts](../../games/plinko/src/tables.ts), with the ball's path drawn from `state.settlement.draw`.
- [Samson's Gold](../../games/samson/): one decision with dozens of outcomes, reel stops drawn from
  `state.settlement.draw`, and a bonus counter that applies each finished round once, by `state.id`.
