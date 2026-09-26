---
title: RoundClient
description: Reference for @hookedin/play/sdk/round, which plays a multi-step game as a sequence of casino bets through the wallet.
sidebar:
  order: 2
---

`import { RoundClient } from '@hookedin/play/sdk/round';` plays a game of several steps, such as a hand of blackjack, as
one casino bet per step, priced by the [engine](engine.md). The module is Node-safe: it reaches `localStorage` only
through its default store and `window` only in `watch`, so a test runs it in Node with a store of its own.
[Multi-step games](../games/multi-step-games.md) is the guide, and [sequential games](../games/sequential-games.md)
derives the pricing.

Every step settles in the wallet on its own, so the cash inside an unfinished round is part of the game's balance, and a
player who stops keeps it: a [settled trade-off](../overview/architecture.md#settled-trade-offs).

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

```ts
export class RoundClient {
  constructor(
    bridge: RoundBridge,
    graph: (setup: any) => GameGraph,
    funding?: FundingTable,
    {
      store,
      name,
    }?: {
      store?: RoundStore;
      name?: string;
    },
  );
}
```

| Parameter | Type                        | Meaning                                                                                                       |
| --------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `bridge`  | `RoundBridge`               | How it reaches the wallet: `HookedIn` in a page, a [test bridge](game-wallet.md#testbridge) in a test         |
| `graph`   | `(setup: any) => GameGraph` | Builds the game's graph for a setup, the object `start` is given. Called once per distinct setup in a page    |
| `funding` | `FundingTable`              | Precomputed action prices, such as [`blackjackFunding`](engine.md#blackjackfunding)                           |
| `store`   | `RoundStore`                | Where the round is saved. `localStorage` by default                                                           |
| `name`    | `string`                    | Tells games on one host origin apart. `location.pathname` by default, or `round` where there is no `location` |

Each action of a round is one operation, whose [group](../reference/bridge.md#gamecasinobet) is the round's `id`:

1. The round saves the step it chose and a fresh operation ID in its store before it sends anything.
2. If the game's balance is short of the step's cash, it asks the player for the shortfall plus four stakes.
3. It sends the step as one `game.casinoBet` (a stake, and a prize for every better successor), as a `game.payment`,
   or not at all when the step moves no money.
4. The receipt's outcome names the next state. The verified payout must equal that state's cash less the cash the step
   retained, or the step throws.

A declined step stays saved under a fresh operation ID, for the player to retry or leave, and a lost reply is resolved
through `game.receipt` by the saved ID.

**Saving.** The store key is `hookedin:round:<name>:<chainId>:<asset>:<uname>`, from [`playerScope`](wire.md#playerscope).
A saved round records its format, `HOOKEDIN/ROUND/4`, and its rules: the SHA-256 hash of the graph its setup builds, as
JSON. A page cannot finish a round saved in another format or under other rules. The next `restore`, `start` or `action`
removes it and throws `This round was started under rules this game does not play. What it held is in your balance.`

**Pricing.** `start` prices the graph against the bankroll `wallet.info` reports. It reuses the saved round's plan when
the setup is the same and the bankroll still covers the plan's `conservativeBankroll`. With `funding`, when the stake is
a whole multiple `k` of `funding.initialCash` and the bankroll covers `k` times `funding.conservativeBankroll`, it loads
the table at scale `k` ([`loadFundedGame`](engine.md#loadfundedgame)). Otherwise it compiles the graph in the page
([`compileGameAsync`](engine.md#compilegameasync)) with a planning floor of half the bankroll and a cash grid of the stake
divided by 10^9, at least 1. When pricing fails, or the bankroll is below the plan's `conservativeBankroll`, `start`
throws `The casino can only back about <amount> of payouts right now. Lower your stake and try again.`

#### `restore`

```ts
restore(): Promise<RoundState | null>;
```

Reads the saved round for this game, player and asset, and applies any result the wallet settled meanwhile: for a
pending step it asks `game.receipt` by the step's operation ID and applies the receipt it finds. It resolves with the
round's state, or `null` when none is saved. It asks the wallet for `wallet.info`, `wallet.hello` (once per helper)
and the game's balance. It throws for a round saved under other rules (see saving above), when a receipt does not
match the saved step, and with the bridge's errors. It calls `changed` when it ends, whether or not it threw.

#### `start`

```ts
start(setup: {
  stake: string;
  [key: string]: unknown;
}): Promise<RoundState>;
```

Starts a round at the graph's root, with `setup.stake`, a decimal string of smallest units, as its cash. The setup goes
to `graph` and is saved, as JSON, with the round. `start` reads the saved round first and throws
`Recover the pending action first` while a step is pending. It makes sure the game's balance covers the stake, prices the
graph, and saves the round under a fresh `id`. It places no bet; the first `action` does. A saved unfinished round is
replaced, and its cash is in the game's balance already.

It throws the pricing error above, `Add enough money to this game to continue` when the player does not give the game
enough, and the bridge's errors. It calls `changed` when it ends.

#### `action`

```ts
action(action: string): Promise<RoundState>;
```

Plays one step, `action` being one of `state().actions`, and resolves with the state it leads to. It reads the round
first, as `restore` does, so a pending step the wallet already settled is applied before the action is taken, from the
state that follows. With no step pending, it makes sure the balance covers the round's cash plus the action's
`additionalCash`, prepares the step at the bankroll `wallet.info` reports, saves it and sends it. With a step pending,
only that step's action is accepted, and the step is sent again. A finished round resolves with its state unchanged.
`busy` is `true` while it runs, and `changed` is called when it ends.

| Throws                                                                                         | When                                                                     | The step afterwards                                                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `Start a round first`                                                                          | No round is saved                                                        | –                                                                             |
| `Illegal game action`                                                                          | The node does not offer the action                                       | –                                                                             |
| `Retry the pending action first`                                                               | Another step is pending                                                  | Pending                                                                       |
| A `RangeError` from [`prepareAction`](engine.md#prepareaction)                                 | The live bankroll is below the planning floor or does not admit the step | –                                                                             |
| `Add enough money to this game to continue`                                                    | The player did not give the game enough                                  | –                                                                             |
| The receipt's `reason`, or `The casino declined this step; retry this action or stop the game` | The casino declined the step                                             | Pending, under a fresh operation ID                                           |
| The bridge's [error](../reference/bridge.md#errors)                                            | The step's request failed or timed out                                   | Pending, under the same operation ID, so sending it again is the same request |

After an error, `restore()` gives the state to show: a pending step shows `pending: true`, with its action alone in
`actions`.

#### `state`

```ts
state(): RoundState | null;
```

The round as last read, without asking the wallet: `null` before the first `restore` or `start`, and when no round is
saved.

#### `watch`

```ts
watch(listener: () => void): void;
```

Follows other tabs of the game. When another tab writes this round's key in `localStorage`, it restores the round and
calls `listener`; a failed restore is ignored. The key is known once `restore` or `start` has run. It does nothing
where there is no `window`. Each call adds a listener, and none can be removed.

#### `inHand`

```ts
inHand(): bigint;
```

The cash inside an unfinished round, or `0n`. It is part of the game's balance and the player's to keep if they stop;
[`mountBank`](bank-and-synth.md#mountbank) leaves it out of the figure it shows.

#### `ensureFunds`

```ts
ensureFunds(required: bigint, stake: bigint): Promise<void>;
```

Makes sure the game's balance covers `required`. When it does not, it asks the player through `game.requestFunds` for
the shortfall plus four times `stake`, so one authorization lasts a few rounds, and throws
`Add enough money to this game to continue` if the balance is still short. `start` and `action` call it. It works from
the balance the last `restore`, `start` or `action` read, so one of them runs before it.

#### `busy`

```ts
busy: boolean;
```

`true` while `action` runs: the wallet's balance holds the step's result before the round does.

#### `changed`

```ts
changed: () => void;
```

Called after every `restore`, `start` and `action`, whether it resolved or threw. It does nothing by default;
`mountBank(root, { round })` sets it to redraw the strip.

#### `name`

```ts
readonly name: string;
```

The name the constructor was given, or its default: part of the storage key.

#### `units`

```ts
units: string;
```

The wallet's asset symbol from `wallet.hello`, used in the sentences the helper writes to the player. It is `''` until
the first `restore`, `start` or `action`.

## Types

### `RoundState`

```ts
export interface RoundState {
  id: string;
  nodeId: string;
  cash: string;
  initialCash: string;
  contributed: string;
  balance: string;
  terminal: boolean;
  actions: string[];
  actionCosts: Record<string, string>;
  events: RoundEvent[];
  pending: boolean;
  settlement: any;
}
```

| Field         | Meaning                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | The round's own ID, a UUID fixed at `start`. It is the group of each step, and lets a game apply a finished round to its own state exactly once |
| `nodeId`      | The graph node the round is at                                                                                                                  |
| `cash`        | The round's cash at this node, a decimal string of smallest units. At a terminal node, what the round paid                                      |
| `initialCash` | The setup's stake                                                                                                                               |
| `contributed` | The stake plus the `additionalCash` of every step taken                                                                                         |
| `balance`     | The game's balance as last read from the wallet                                                                                                 |
| `terminal`    | The round is finished                                                                                                                           |
| `actions`     | The actions the node offers: only the pending step's while one is pending, none at a terminal node                                              |
| `actionCosts` | The `additionalCash` of each of the node's actions, as decimal strings                                                                          |
| `events`      | Every step taken, in order                                                                                                                      |
| `pending`     | A step is saved and its result not applied                                                                                                      |
| `settlement`  | The last step's result, or `null` before the first                                                                                              |

A settled step's `settlement` is `{ kind, payout, outcome, rangeStart?, rangeEnd? }`. `kind` is `casino-bet`, `payment`
or `noop`. A casino bet's `payout` and `outcome` are the receipt's decimal strings, and `rangeStart` and `rangeEnd` bound
the stretch of the outcome space that led to this node: where the outcome fell inside it is verifiable entropy for
choosing among equivalent presentations, such as which reel stops or which of several equal cards. A payment's or a
no-op's `payout` and `outcome` are `null`. A declined step's `settlement` is `{ kind: 'rejected', reason }`.

### `RoundEvent`

```ts
export interface RoundEvent {
  action: string;
  label?: string;
}
```

One step taken: its action, and the label of the outcome it led to when the graph gives one, such as blackjack's
`player:0:12:3`.

### `Bridge`

```ts
export type Bridge = (method: string, params?: any) => Promise<any>;
```

One bridge request, as [`HookedIn.call`](hookedin.md#call) sends it.

### `RoundBridge`

```ts
export interface RoundBridge {
  call: Bridge;
  balance: () => Promise<GameLimit>;
}
```

What the helper needs of the SDK: requests, and the game's balance as the wallet last pushed it, a `GameLimit`
`{ balance: string; pending: boolean }` of the same shape as [`GameBalance`](hookedin.md#gamebalance). `HookedIn` and
[`TestBridge`](game-wallet.md#testbridge) are both round bridges.

### `RoundStore`

```ts
export interface RoundStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
```

Where rounds live between reloads: the game's own origin storage. `localStorage` fits it, and a test passes a map:

```ts
import type { RoundStore } from '@hookedin/play/sdk/round';

const saved = new Map<string, string>();
const store: RoundStore = {
  get: key => saved.get(key) ?? null,
  set: (key, value) => void saved.set(key, value),
  remove: key => void saved.delete(key),
};
```
