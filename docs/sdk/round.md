---
title: RoundClient
description: Reference for @hookedin/play/sdk/round, which plays a multi-step game as a sequence of casino bets through the wallet.
sidebar:
  order: 2
---

`import { RoundClient } from '@hookedin/play/sdk/round';` plays a game of several steps, such as a hand of blackjack, as
a sequence of casino bets priced by the [engine](engine.md): each step is one casino bet, a payment or nothing. The
module is Node-safe: it reaches `localStorage` only through its default store and `window` only in `watch`, so a test
runs it in Node with a store of its own. [Multi-step games](../games/multi-step-games.md) is the guide, and
[pricing and collapsing](../games/collapsing-bets.md) the method.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import { createMines } from '@hookedin/play/sdk/engine';

const round = new RoundClient(HookedIn, setup =>
  createMines({ tiles: 5, mines: 1, cashouts: [120n, 156n, 228n].map(n => (BigInt(setup.stake) * n) / 100n) }),
);
await round.restore();
let state = await round.start({ stake: HookedIn.parseAmount('0.000001') });
state = await round.action('reveal'); // state.actions lists what is legal next
if (state.actions.includes('cash-out')) state = await round.action('cash-out');
```

## The helper

### `RoundClient`

`new RoundClient(bridge, graph, funding?, { store?, name? })`:

| Parameter | Meaning                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `bridge`  | How it reaches the wallet, a [`RoundBridge`](#roundbridge): `HookedIn` in a page, a test bridge in a test     |
| `graph`   | Builds the game's graph for a setup, the object `start` is given. Called once per distinct setup in a page    |
| `funding` | Precomputed action prices, a [`FundingTable`](engine.md#fundingtable), such as blackjack's                    |
| `store`   | Where the round is saved, a [`RoundStore`](#roundstore). `localStorage` by default                            |
| `name`    | Tells games on one host origin apart. `location.pathname` by default, or `round` where there is no `location` |

Each step is at most one operation, whose group is the round's `id`. The round asks the player for more when the
game's allowance is short of what the step needs, draws the step's branch with the page's own randomness
([`prepareAction`](engine.md#prepareaction)) and saves it with a fresh operation ID before it sends anything, and then
sends a bet as one `game.casinoBet`, a payment as `game.payment`, or nothing. A bet wins when the receipt's outcome is
below its chance, which fixes the class of states it reaches, and the outcome draws the state within it; the verified
payout must be the prize when the bet won and `0` otherwise, or the step throws. A declined step stays saved under a
fresh operation ID, the same bet, never drawn again. A step whose reply was lost stays saved under its own, and the
wallet answers it with the same receipt.

**Saving.** The store key is `hookedin:round:<name>:<chainId>:<uname>`. A saved round records its format,
`HOOKEDIN/ROUND/5`, and its rules: the SHA-256 hash of the graph its setup builds, as JSON. A page cannot finish a round
saved in another format or under other rules, a setup its rules refuse included: the next `restore`, `start` or
`action` removes it and throws
`This round was started under rules this game does not play. What it held is in your balance.`

**Pricing.** `start` prices the graph against the bankroll `wallet.info` reports. It reuses the saved round's plan when
the setup is the same and the bankroll still covers the plan's `conservativeBankroll`. With `funding`, when the stake is
a whole multiple `k` of `funding.initialCash` and the bankroll covers `k` times `funding.conservativeBankroll`, it loads
the table at scale `k` ([`loadFundedGame`](engine.md#loadfundedgame)). Otherwise it compiles the graph in the page with
a planning floor of half the bankroll and a cash grid of the stake divided by 10^9, at least 1. When pricing fails, or
the bankroll is below the plan's `conservativeBankroll`, `start` throws
`The casino can only back about <amount> ETH of payouts right now. Lower your stake and try again.`

#### `restore`

Reads the saved round for this game and player, and applies any result the wallet settled meanwhile: for a pending step
it asks `game.receipt` by the step's operation ID and applies the receipt it finds. It is the only method that looks a
result up; `start` and `action` take the saved round as it stands. It resolves with the round's state, or `null` when
none is saved, and throws for a round saved under other rules, for a receipt that does not match the saved step, and
with the bridge's errors.

#### `start`

Starts a round at the graph's root with `setup.stake`, a decimal string of wei, as its cash; the setup goes to `graph`
and is saved with the round. It throws `Recover the pending action first` while a step is pending, which `restore`
resolves. It makes sure the game's allowance covers the stake, prices the graph, and saves the round under a fresh
`id`, replacing a saved unfinished round, whose cash is in the game's allowance already. It places no bet; the first
`action` does. It throws the pricing error above, `Increase your game allowance to continue.` when the player does not
allow the game enough, and the bridge's errors.

#### `action`

Plays one step, `action` being one of `state().actions`, and resolves with the state it leads to. With a step pending,
only that step's action is accepted, and the step is sent again under its saved operation ID: the wallet answers an
operation it has carried out with its receipt, so a step whose reply was lost is played once. A finished round resolves
with its state unchanged.

| Throws                                                                                         | When                                                                          | The step afterwards                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Wait for the action under way`                                                                | `action` is running already, as when a button is pressed twice                | The running action's                                                          |
| `Start a round first`                                                                          | No round is saved                                                             | –                                                                             |
| `Illegal game action`                                                                          | The node does not offer the action                                            | –                                                                             |
| `Retry the pending action first`                                                               | Another step is pending                                                       | Pending                                                                       |
| A `RangeError` from [`prepareAction`](engine.md#prepareaction)                                 | The live bankroll is below the planning floor or does not admit the bet drawn | –                                                                             |
| `Increase your game allowance to continue.`                                                    | The player did not allow the game enough                                      | –                                                                             |
| The receipt's `reason`, or `The casino declined this step; retry this action or stop the game` | The casino declined the step                                                  | Pending, under a fresh operation ID                                           |
| The bridge's [error](../reference/bridge.md#errors)                                            | The step's request failed or timed out                                        | Pending, under the same operation ID, so sending it again is the same request |

After an error, `restore()` gives the state to show: a pending step shows `pending: true`, with its action alone in
`actions`.

#### `state`

The round as last read, without asking the wallet: `null` before the first `restore` or `start`, and when no round is
saved.

#### `watch`

Follows other tabs of the game: when another tab writes this round's key in `localStorage`, it restores the round and
calls the listener, ignoring a failed restore. It does nothing where there is no `window`, and a listener cannot be
removed.

#### `inHand`

The cash inside an unfinished round, or `0n`: part of the game's allowance, and the player's to keep if they stop.

#### `ensureAllowance`

Makes sure the game's allowance, as the last `restore`, `start` or `action` read it, covers `required`. When it does
not, it asks the player for the shortfall plus four times `stake`, so one authorization lasts a few rounds, and throws
`Increase your game allowance to continue.` if the allowance is still short.

#### `busy`

`true` while `action` runs: the wallet's balance holds the step's result before the round does.

#### `onChange`

Calls a listener after every `restore`, `start` and `action`, whether it resolved or threw: whenever the round's cash or
`busy` may have changed. Returns a function that stops it. [`mountAllowance`](allowance-and-synth.md#mountallowance)
redraws the strip with it.

## Types

### `RoundState`

| Field         | Meaning                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | The round's own ID, a UUID fixed at `start`. It is the group of each step, and lets a game apply a finished round to its own state exactly once |
| `setup`       | The setup `start` was given, as JSON: its `stake`, and whatever else the game's graph is built from, such as Samson's `mode`                    |
| `nodeId`      | The graph node the round is at                                                                                                                  |
| `cash`        | The round's cash at this node, a decimal string of wei. At a terminal node, what the round paid                                                 |
| `contributed` | The stake plus the `additionalCash` of every step taken                                                                                         |
| `terminal`    | The round is finished                                                                                                                           |
| `actions`     | The actions the node offers: only the pending step's while one is pending, none at a terminal node                                              |
| `actionCosts` | The `additionalCash` of each of the node's actions, as decimal strings                                                                          |
| `events`      | Every step taken, in order                                                                                                                      |
| `pending`     | A step is saved and its result not applied                                                                                                      |
| `settlement`  | The last step's result, or `null` before the first                                                                                              |

A settled step's `settlement` is `{ kind, won?, chance?, payout, outcome, draw }`. `kind` is `casino-bet`, `payment` or
`noop`. A casino bet's `won` says whether its outcome was below its `chance`, and its `payout` and `outcome` are the
receipt's decimal strings; a payment's or a no-op's `payout` and `outcome` are `null`. `draw` is a 64-bit value, as a
decimal string, to show the result with, such as which reel stops or which path a ball takes: drawn from the round's
outcome for a bet, apart from which state the step reached, and by the page for a step without one.
[`seededRandom(BigInt(draw))`](engine.md#seededrandom) reads it. A declined step's `settlement` is
`{ kind: 'rejected', reason }`.

### `RoundEvent`

One step taken: its `action`, and the `label` of the outcome it led to when the graph gives one, such as blackjack's
`player:0:12:3`.

### `RoundBridge`

What the helper needs of the SDK: `call`, a bridge request, and `allowance`, the game's allowance as the wallet last
pushed it. `HookedIn` and a [test bridge](../games/testing.md#testbridge) are both round bridges.

### `RoundStore`

Where rounds live between reloads: `get`, `set` and `remove` over the game's own origin storage. `localStorage` fits
it, and a test passes a [`memoryStore()`](../games/testing.md#memorystore).
