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
import { doubleUp } from './rules.ts';

const round = new RoundClient(HookedIn, doubleUp);

// On startup: the saved round, with any step the wallet settled while the page was away.
let state = await round.restore().catch(error => {
  message(error.message); // a round saved under rules this page does not build: it is let go
  return null;
});
render(state);

async function play(action: string) {
  if (!state || state.terminal) state = await round.start({ stake: HookedIn.parseAmount('100') });
  state = await round.action(action); // 'flip' or 'take'
  render(state); // state.nodeId, state.cash, state.actions, state.events
  if (state.terminal) await HookedIn.end(state.id); // the round is over on the page
}
round.watch(() => render(round.state())); // another tab moved the round
```

`render` and `message` are your page's own.

- `restore()` loads the player's saved round and resolves a step whose reply was lost. Call it on startup.
- `start(setup)` starts a round. `setup.stake` is the stake in wei, and any other field is yours for the graph
  function, such as Dice's `chanceBps`. It asks the wallet for more if the allowance is short, prices the graph and
  saves the round; no money moves until the first action.
- `action(id)` plays one step: at most one casino bet or payment, drawn and saved with a fresh operation ID before
  anything is signed, and checked against the wallet's verified payout.
- The state says where the round stands ([`RoundState`](../sdk/round.md#roundstate)): `cash` is what the round holds,
  which the player keeps if they stop, and `events` are each step's action and label, to redraw the round after a
  reload.
- Each step's bet is in the round's group, `state.id`, so the allowance in the wallet's top bar drops by the stake on
  the first step and then stands still, while the round's cash stays with the round.
  [`HookedIn.end(state.id)`](../sdk/hookedin.md#end), once the page has shown how the round ended, adds what it paid
  ([groups](how-a-game-works.md#groups)).

## One step is one bet

When the player acts, the engine groups the step's successors by the cash they need into cash classes. A step with one
class places no bet, and any cash above that class's is paid to the bankroll as a payment. Any other step places at
most one casino bet, between a lower class and a higher one: it stakes the current cash less the lower class's, and its
prize is the difference between the two, so whatever the outcome, the player's cash after it is exactly the reached
class's. A step of more than two classes is collapsed: the page draws which pair to bet between, in proportions that
reach every class exactly as often as the rules say ([pricing and collapsing](collapsing-bets.md)).

In Double up, `flip` from `start` stakes the stake for a prize of 1.9 stakes that wins on half the outcomes, and `take`
moves no money: the 1.9 stakes are already in the player's balance.

## Pricing

The engine works backward from the terminal payouts and gives every state its cash: the least that finances each of its
actions with bets the casino's rule admits. That is more than the state's expected value, by a
[risk premium](collapsing-bets.md#why-the-price-exceeds-the-expected-value) that shrinks as the bankroll grows, and
every step needs an edge of its own at its state's cash.

`RoundClient` prices against half the virtual bankroll `wallet.info` reports, on a grid of a billionth of the stake, and
starts the round with the stake as its cash. A stake the casino cannot back is refused before anything is signed, with
an error naming about how much it can back. The next round with the same setup reuses the prices while the virtual
bankroll still covers their conservative starting requirement.

## Extra wagers

An action can commit more of the player's money, such as a double, a split or insurance: give it `additionalCash`.
`state.actionCosts` says what each action adds, and `state.contributed` what the player has put in so far. When the
allowance is short, `RoundClient` asks the wallet for the shortfall plus four stakes, so one authorization lasts a few
rounds.

## Precomputed prices

Pricing a large graph in the page takes time. The constructor's third argument is a
[`FundingTable`](../sdk/engine.md#fundingtable): each action's required cash at one stake, which `RoundClient` uses,
scaled by an exact integer, when the stake is a multiple of the table's `initialCash` and the bankroll covers its
`conservativeBankroll` times that multiple. [Blackjack](https://github.com/hookedin/game-blackjack) commits its table and
passes it:

```ts
const round = new RoundClient(HookedIn, setup => createBlackjack({ stake: BigInt(setup.stake) }), blackjackFunding);
```

A table is right only for the rules it was generated from: blackjack's `npm run generate` compiles its rules with
`compileGame` and writes every action's `requiredCash`, and its `npm test` fails when the table does not match.

## Changing the rules

A saved round carries a hash of its rules: the graph the page builds for its setup. Once you change the graph, a round
saved under the old one cannot be finished here: `restore()` throws once, with a message telling the player that what
the round held is in their balance, and returns `null` after. Every step it took had already settled in the wallet.
