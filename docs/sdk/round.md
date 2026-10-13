---
title: RoundClient
description: Reference for @hookedin/play/sdk/round, which plays a multi-step game as a sequence of casino bets through the wallet.
sidebar:
  order: 2
---

`import { RoundClient } from '@hookedin/play/sdk/round';` plays a game of several steps, such as a hand of blackjack, as
a sequence of casino bets priced by the [engine](engine.md): each step is one casino bet, a payment or nothing. The
module is Node-safe: it reaches `localStorage` only through its default store, and holds its round with
`navigator.locks`, which Node has too, so a test runs it in Node with a store of its own. [Multi-step games](../games/multi-step-games.md) is the guide, and
[pricing and collapsing](../games/collapsing-bets.md) the method.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import { createMines } from '@hookedin/play/sdk/engine';

const round = new RoundClient(HookedIn, setup =>
  createMines({ tiles: 5, mines: 1, cashouts: [120n, 156n, 228n].map(n => (setup.stake * n) / 100n) }),
);
await round.restore();
let state = await round.start({ stake: HookedIn.METH });
state = await round.action('reveal'); // state.actions lists what is legal next
if (state.actions.includes('cash-out')) state = await round.action('cash-out');
await round.end(state); // once the page has shown how it ended: kept in the player's history, which round.past() reads
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

Each step's operations are in one group, the round's `id`: what the steps win stays with the round, out of the
allowance the wallet shows, until the game calls [`end(state)`](#end) once the player has seen how the round ended.
The round refuses a step when what the round may stake, the allowance and what it holds, is short of what the step
needs; otherwise it saves the action with a fresh operation ID before it sends anything, and then sends the step
([`prepareAction`](engine.md#prepareaction)) as one `game.casinoBet` whose table is every successor, with its weight,
the cash it needs and its label, for the wallet to split, draw and land
([the wallet draws the step](../games/collapsing-bets.md#the-wallet-draws-the-step)), with the step's cash, so the
round's whole stake leaves the allowance the wallet shows with its first step. A step that pays the bankroll is a
`game.payment` of what its successors do not need, with what it `kept`; when it has several successors, a
`game.casinoBet` of their table, which all leave the step's cash, follows it, under the operation ID with `:draw`
added, for the wallet to draw which. The step reaches the successor the receipt's `result` names, whose cash must be
what the bet kept and paid, or all the step held when it placed no bet, or the step throws. A declined step stays saved
under a fresh operation ID. A step whose reply was lost stays saved under its own, and the wallet answers it with the
same receipt, the same draw.

**Saving.** The store key is `hookedin:round:<name>:<chainId>:<uname>`. A saved round records its format,
`HOOKEDIN/ROUND/5`, and its rules: the SHA-256 hash of the graph its setup builds, as JSON. A page cannot finish a round
saved in another format or under other rules, a setup its rules refuse included: the next `restore`, `start` or
`action` removes it and throws
`This round was started under rules this game does not play. What it held is in your balance.`

**One step at a time.** `restore`, `start` and `action` each hold the lock `hookedin:round:<name>` from reading the
round to saving where it led. `start` and `action` throw `Wait for the action under way` while it is held, as when a
button is pressed twice; `restore` waits for it. The wallet runs in one tab at a time, so a game is open in one tab at a
time too.

**Pricing.** `start` prices the graph against the virtual bankroll `wallet.info` reports. It reuses the saved round's
plan when the setup is the same and the virtual bankroll still covers the plan's `conservativeBankroll`. With `funding`,
when the stake is a whole multiple `k` of `funding.initialCash` and the virtual bankroll covers `k` times
`funding.conservativeBankroll`, it loads the table at scale `k` ([`loadFundedGame`](engine.md#loadfundedgame)).
Otherwise it compiles the graph in the page with a planning floor of half the virtual bankroll and a cash grid of the
stake divided by 10^9, at least 1. When pricing fails, or the virtual bankroll is below the plan's
`conservativeBankroll`, `start` throws
`The casino can only back about <amount> ETH of payouts right now. Lower your stake and try again.`

#### `restore`

Reads the saved round for this game and player, and applies any result the wallet settled meanwhile: for a pending step
it asks `game.receipt` by the step's operation ID and applies the receipt it finds. It is the only method that looks a
result up; `start` and `action` take the saved round as it stands. It resolves with the round's state, or `null` when
none is saved, and throws for a round saved under other rules, for a receipt that does not match the saved step, and
with the bridge's errors. It waits while a `start` or `action` runs.

#### `start`

Starts a round at the graph's root with `setup.stake`, a bigint of wei, as its cash; the setup goes to `graph`
and is saved with the round. It throws `Recover the pending action first` while a step is pending, which `restore`
resolves, and `Wait for the action under way` while a `start` or `action` runs. It checks
that the game's allowance covers the stake, prices the graph, and saves the round under a fresh `id`, replacing a saved
unfinished round, whose cash is in the player's balance already. It places no bet; the first `action` does. It throws
the pricing error above, [`HookedIn.NOT_ENOUGH_ALLOWANCE`](hookedin.md#not_enough_allowance) when the allowance
does not cover the stake, and the bridge's errors.

#### `action`

Plays one step, `action` being one of `state().actions`, and resolves with the state it leads to. With a step pending,
only that step's action is accepted, and the step is sent again under its saved operation ID: the wallet answers an
operation it has carried out with its receipt, so a step whose reply was lost is played once. A finished round resolves
with its state unchanged.

| Throws                                                                                         | When                                                                    | The step afterwards                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Wait for the action under way`                                                                | A `start` or `action` is running, as when a button is pressed twice     | The running action's                                                          |
| `Start a round first`                                                                          | No round is saved                                                       | –                                                                             |
| `Illegal game action`                                                                          | The node does not offer the action                                      | –                                                                             |
| `Retry the pending action first`                                                               | Another step is pending                                                 | Pending                                                                       |
| A `RangeError` from [`prepareAction`](engine.md#prepareaction)                                 | The virtual bankroll `wallet.info` reports is below the planning floor  | –                                                                             |
| [`HookedIn.NOT_ENOUGH_ALLOWANCE`](hookedin.md#not_enough_allowance)                            | The allowance does not cover the step, checked before anything is drawn | –                                                                             |
| The receipt's `reason`, or `The casino declined this step; retry this action or stop the game` | The casino declined the step, as when its quote expired while it waited | Pending, under a fresh operation ID                                           |
| The bridge's [error](../reference/bridge.md#errors)                                            | The step's request failed or timed out                                  | Pending, under the same operation ID, so sending it again is the same request |

After an error, `restore()` gives the state to show: a pending step shows `pending: true`, with its action alone in
`actions`.

#### `end`

`end(state, extra?)`: the player has seen how `state`'s round ended. It calls
[`game.end`](../reference/bridge.md#gameend) for the round's group, so what the round won joins the allowance the wallet
shows, with the round as the group's meta, which the casino keeps in the player's history of the game: its format and
the hash of its rules, its `setup`, `nodeId`, `cash`, `contributed`, `events` and `settlement`, as JSON holds them,
every bigint a decimal string, and `extra`, anything else the page draws the round with, such as the tiles a player
picked. Call it with the state the page has just shown, even after the next round has started. Meta the wallet refuses,
larger than the [bounds](../reference/bridge.md#bounds) allow or with numbers that are not whole, is left out, and the
round ends without it. It resolves with `null`, and throws the bridge's errors: with `failed` the round has ended all
the same, and calling `end` again keeps its meta.

#### `past`

`past({ after, limit })` reads a page of the player's history of the game with
[`game.history`](../reference/bridge.md#gamehistory) and resolves with `{ rounds, cursor, more }`: the rounds this game
ended with `end`, newest first, each a [`PastRound`](#pastround), from any device of the player's. A round played under
rules this page does not play is left out, since it could not be drawn here, and so is everything else in the
history. Pass `cursor` back as `after` for older rounds while `more` is `true`; a page holds every entry of the history,
so it can hold fewer rounds than `limit`.

```ts
const { rounds } = await round.past({ limit: 20 });
for (const past of rounds) drawResult(past); // with the code that drew it when it was played
```

#### `state`

The round as last read, without asking the wallet: `null` before the first `restore` or `start`, and when no round is
saved.

#### `checkAllowance`

`checkAllowance(required, group?)` throws [`HookedIn.NOT_ENOUGH_ALLOWANCE`](hookedin.md#not_enough_allowance)
unless the game may stake `required`, or with `group`, unless a bet in that group may
([`game.allowance`](../reference/bridge.md#gameallowance)). Only the player sets the allowance, in the wallet's top bar.
`start` and `action` call it; a page calls it before something of its own, such as reels that spin before a resumed
step.

## Types

### `RoundState`

| Field         | Meaning                                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | The round's own ID, a UUID fixed at `start`. It is the group of each step, which the game ends once the player has seen the round end, and lets a game apply a finished round to its own state exactly once |
| `setup`       | The setup `start` was given: its `stake`, a bigint, and whatever else the game's graph is built from as JSON values, such as Samson's `mode`                                                                |
| `nodeId`      | The graph node the round is at                                                                                                                                                                              |
| `cash`        | The round's cash at this node, a bigint of wei. At a terminal node, what the round paid                                                                                                                     |
| `contributed` | The stake plus the `additionalCash` of every step taken                                                                                                                                                     |
| `terminal`    | The round is finished                                                                                                                                                                                       |
| `actions`     | The actions the node offers: only the pending step's while one is pending, none at a terminal node                                                                                                          |
| `actionCosts` | The `additionalCash` of each of the node's actions                                                                                                                                                          |
| `events`      | Every step taken, in order                                                                                                                                                                                  |
| `pending`     | A step is saved and its result not applied                                                                                                                                                                  |
| `settlement`  | The last step's result, a [`StepSettlement`](#stepsettlement), or `null` before the first                                                                                                                   |

### `StepSettlement`

How the round's last step went. A settled step's is `{ kind, id, won?, chance?, payout, outcome, draw }`. `kind` is
`casino-bet`, `payment` or `noop`, a step that drew no bet included. `id` is the operation whose receipt in the wallet
proves how the step went, for [`HookedIn.showBet`](hookedin.md#showbet) to show the player: the bet, the wallet's draw,
or the payment; `null` for a step that asked the wallet nothing. A casino bet's `won` says whether its outcome was below
its `chance`, and its `payout` and `outcome` are the receipt's; a payment's or a no-op's `payout` and `outcome` are
`null`. `draw` is a 64-bit bigint to show the result with, such as which reel stops or which path a ball takes: the
receipt's, which the wallet drew after the result, apart from which state the step reached, and the page's own for a
step with one successor. [`seededRandom(draw)`](engine.md#seededrandom) reads it. A declined step's is
`{ kind: 'rejected', reason }`.

### `PastRound`

A round the game ended with [`end`](#end), as [`past`](#past) reads it back: its `id`, `setup`, `nodeId`, `cash`,
`contributed`, `events` and `settlement` as its [`RoundState`](#roundstate) had them, `at`, when it ended, in
milliseconds, and `extra`, what the page added to it.

### `RoundEvent`

One step taken: its `action`, and the `label` of the outcome it led to when the graph gives one, such as blackjack's
`Your hand · K♠`.

### `RoundBridge`

What the helper needs of the SDK: `call`, a bridge request. `HookedIn` and a [test bridge](../games/testing.md#testbridge)
are both round bridges.

### `RoundStore`

Where rounds live between reloads: `get`, `set` and `remove` over the game's own origin storage. `localStorage` fits
it, and a test passes a [`memoryStore()`](../games/testing.md#memorystore).
