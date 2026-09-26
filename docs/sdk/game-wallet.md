---
title: Test wallet
description: Reference for @hookedin/play/testing/game-wallet.ts, the real wallet against an in-memory casino stub that a game's tests run on.
sidebar:
  order: 9
---

`import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';` is what a game's tests run on: the real wallet,
with every check and signature it makes, against an in-memory casino stub. The module is Node-safe and made for Node
tests, which a game that installs play runs with tsx. [Testing](../games/testing.md) is the guide, with the conformance
suite that holds the stub to the casino.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';

const HALF = (1n << 64n) / 2n;

test('a casino bet settles through the real wallet', async () => {
  const f = await gameWallet();
  f.wallet.openGame(f.identity('my-game'));
  await f.wallet.setGameLimit('200000');
  const receipt = await f.bridge.call('game.casinoBet', {
    id: 'first-bet',
    stake: '1000',
    // Half the outcome space paying 1.9 times the stake: a 95% return, which the casino admits.
    prizes: [{ rangeStart: '0', rangeEnd: String(HALF), payout: '1900' }],
  });
  assert.equal(receipt.status, 'settled');
  assert.equal(receipt.payout, BigInt(receipt.outcome) < HALF ? '1900' : '0');
});
```

## The fixture

### `gameWallet`

```ts
export async function gameWallet({ bankroll, bank }?: { bankroll?: bigint; bank?: bigint }): Promise<{
  wallet: CasinoWallet;
  storage: MemoryStore;
  owner: HDNodeWallet;
  player: HDNodeWallet;
  developer: Developer;
  bridge: TestBridge;
  bridgeFor: typeof bridgeTo;
  settlements: () => number;
  bankroll: () => bigint;
  bank: () => bigint;
  secretOf: (round: string) => string;
  replaceChannel(of?: CasinoWallet): Promise<void>;
  reload: () => Promise<CasinoWallet>;
  forget(): Promise<CasinoWallet>;
  identity: (name?: string, declared?: Partial<GameIdentity>) => GameIdentity;
}>;
```

A real `CasinoWallet` from play's client, with an in-memory store, a random player, and one open channel of 1,000,000
wei on the local chain, 31337, wired to a stub casino in place of the network. `bankroll`, 10^12 by default, is what the
stub covers casino bets with; `bank`, 10^12 by default, is what the developer's bank holds before any developer bet pays
its stake in.

The stub casino signs every state as the protocol derives it, with `owner`'s key. It names each channel's rounds and
settles a casino bet on the channel's round against its bankroll, holding it to the casino's own admission rule and
charging the casino's commission; a bet the rule refuses is declined with its round revealed, as the casino declines it,
so a table the stub takes is one the casino takes. It takes a developer bet on a published game into the developer's
bank and owes the player what the developer settles until the wallet collects it. It declines an operation its player
already carried out on another channel. Its developer's `bets()` pages hold 50 bets by default, where the casino's hold 100.

| Member                       | Type                    | What it is                                                                                                                                                                                              |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet`                     | `CasinoWallet`          | The player's wallet. A test opens a game and gives it a spending limit before it bets (below)                                                                                                           |
| `storage`                    | `MemoryStore`           | What the wallet saves                                                                                                                                                                                   |
| `owner`                      | `HDNodeWallet`          | The stub casino's signing key                                                                                                                                                                           |
| `player`                     | `HDNodeWallet`          | The player's account key                                                                                                                                                                                |
| `developer`                  | `Developer`             | A stub [`Developer`](developer.md#developer) with the fixture's developer key, serving the game `identity()` names: a test hands it to a game server's code in place of the one `createDeveloper` makes |
| `bridge`                     | `TestBridge`            | The game's side of the bridge to `wallet`                                                                                                                                                               |
| `bridgeFor`                  | `typeof bridgeTo`       | [`bridgeTo`](#bridgeto): the bridge to another wallet, such as one `reload` returns                                                                                                                     |
| `settlements()`              | `number`                | How many channel operations the stub has signed a result for                                                                                                                                            |
| `bankroll()`                 | `bigint`                | What the stub has to cover casino bets with                                                                                                                                                             |
| `bank()`                     | `bigint`                | What the developer's bank holds                                                                                                                                                                         |
| `secretOf(round)`            | `string`                | A round's secret, which only the casino knows until it reveals the round                                                                                                                                |
| `replaceChannel(of?)`        | `Promise<void>`         | The player of `of`, `wallet` by default, closes their channel and opens another of 1,000,000 wei. A game's operation IDs stay the player's across both                                                  |
| `reload()`                   | `Promise<CasinoWallet>` | A wallet started afresh from what this one saved, as a reload of the page starts one                                                                                                                    |
| `forget()`                   | `Promise<CasinoWallet>` | A wallet that has lost every receipt, as one restored from an older backup has                                                                                                                          |
| `identity(name?, declared?)` | `GameIdentity`          | A game as the fixture's developer published it, named `test` by default; `declared` holds anything its manifest says otherwise. Every name given here is published                                      |

The wallet's own methods a test calls, from [client/wallet-games.ts](../../client/wallet-games.ts) and
[client/wallet-channel.ts](../../client/wallet-channel.ts):

| Method                 | What it does                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `openGame(identity)`   | Opens the game, as the wallet does when the player opens its page, and returns its key. The bridge answers only an open game |
| `setGameLimit(amount)` | Sets the open game's spending limit, a decimal string of wei, as the player does in the wallet's dialog                      |
| `gameLimit()`          | The open game's `{ balance, pending }`, as `game.balance` pushes it                                                          |
| `closeGame()`          | Closes the game and releases its limit                                                                                       |
| `balance()`            | The channel's signed balance, as a bigint                                                                                    |
| `playableBalance()`    | The signed balance less what a pending operation commits                                                                     |

### `bridgeTo`

```ts
export function bridgeTo(wallet: CasinoWallet): TestBridge;
```

A game's side of the bridge to `wallet`. Every request goes through the checks the wallet's bridge makes, with an
envelope ID above the last, and on to the wallet's own methods. The player agrees to every `game.requestFunds`: the limit
rises by the amount asked, or by the whole playable balance when none is, up to the playable balance, and the reply says
`funded: true`. Every receipt the wallet pushes reaches the `onReceipt` listeners of every bridge to that wallet.

It leaves out what only a wallet page does: the queue, the player's dialog, and the `busy` and `no-channel` refusals.
A refusal is the wallet's own `Error`, whose `code` is set wherever the wallet sets one; a page's bridge reports the rest
as `failed`.

### `TestBridge`

```ts
export interface TestBridge {
  call(method: string, params?: any): Promise<any>;
  balance(): Promise<GameLimit>;
  onReceipt(listener: (receipt: GameReceipt) => void): () => void;
}
```

A game's side of the bridge, as [`RoundClient`](round.md#roundbridge) and a game's own client take it: `call` sends a
request as [`HookedIn.call`](hookedin.md#call) does, `balance` is the open game's `{ balance, pending }`, and
`onReceipt` hears pushed receipts as [`HookedIn.onReceipt`](hookedin.md#onreceipt) does, returning a function that
stops the listener.

```ts
import type { GameReceipt } from '@hookedin/play/sdk/sdk';

test('a developer bet is paid what the server signs', async () => {
  const f = await gameWallet();
  f.wallet.openGame(f.identity());
  await f.wallet.setGameLimit('200000');
  const placed = await f.bridge.call('game.developerBet', { id: 'match', stake: '1000', meta: { pick: 'home' } });
  const heard = new Promise<GameReceipt>(resolve => {
    const stop = f.bridge.onReceipt(receipt => {
      stop();
      resolve(receipt);
    });
  });
  await f.developer.settle([{ bet: placed.bet, player: 2500n, casino: 0n }]);
  await f.bridge.call('game.receipt', { id: 'match' }); // the wallet looks at once, and collects
  assert.equal((await heard).payout, '2500');
});
```

```ts
import { RoundClient } from '@hookedin/play/sdk/round';
import type { RoundStore } from '@hookedin/play/sdk/round';
import { createMines } from '@hookedin/play/sdk/engine';

test('a round of mines settles through the wallet', async () => {
  const f = await gameWallet();
  f.wallet.openGame(f.identity('mines'));
  const saved = new Map<string, string>();
  const store: RoundStore = {
    get: key => saved.get(key) ?? null,
    set: (key, value) => void saved.set(key, value),
    remove: key => void saved.delete(key),
  };
  const graph = (setup: { stake: string }) =>
    createMines({ tiles: 5, mines: 1, cashouts: [120n, 156n, 228n].map(n => (BigInt(setup.stake) * n) / 100n) });
  const round = new RoundClient(f.bridge, graph, undefined, { store, name: 'mines' });
  await round.restore();
  await round.start({ stake: '1000' }); // the bridge agrees to the funds the round asks for
  const state = await round.action('reveal');
  assert.ok(['mines:picks:1', 'mines:loss'].includes(state.nodeId));
});
```
