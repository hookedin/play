---
title: Testing
description: Test a game against the real wallet and an in-memory casino that holds every bet to the casino's own rules, and the reference for @hookedin/play/testing/game-wallet.ts.
sidebar:
  order: 7
---

Game tests do not mock the wallet. `import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';` builds the
real wallet, in memory, with an open channel, wired to a casino stub that derives and signs every state exactly as the
protocol says. A bet your test places is a real signed bet, sent through the same checks the wallet's bridge makes. The
module is Node-safe and made for Node tests.

## Running tests

In a game made from the template:

```sh
npm test
```

This type-checks, then runs `node --import tsx --test test/*.test.ts`. `tsx` is there because `@hookedin/play` ships
TypeScript and Node does not strip types from files inside `node_modules`. In play itself Node runs the sources
directly: `node --test games/<id>/test/*.test.ts` from play's root runs one game's tests, and `npm test` every suite.

## A first test

```ts title="test/flip.test.ts"
import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { HEADS, flipBet, wire } from '../src/flip.ts';

test('a flip settles through the real wallet and moves the allowance by its own terms', async () => {
  const f = await gameWallet();
  f.wallet.openGame(f.identity('flip'));
  await f.wallet.setGameAllowance('200000');
  const receipt = await f.bridge.call('game.casinoBet', { id: 'first', ...wire(flipBet(1000n)) });
  assert.equal(receipt.status, 'settled');
  assert.equal(receipt.payout, BigInt(receipt.outcome) < HEADS ? '2000' : '0');
  assert.equal(f.wallet.gameAllowance().allowance, String(200000n - 1000n + BigInt(receipt.payout)));
});
```

`src/flip.ts` is the [coin flip](casino-bets.md#a-coin-flip). The template's
[test/casino-bet.test.ts](https://github.com/hookedin/game-template/blob/main/test/casino-bet.test.ts) is the same
start: a bet that settles, the same bet sent twice and placed once, and a bet with no edge declined.

## The fixture

### `gameWallet`

`gameWallet({ bankroll?, bank?, deposit? })` resolves with a real `CasinoWallet` from play's client, with an in-memory
store, a random player and one open channel on the local chain, 31337, wired to a stub casino in place of the network.
`bankroll` is what the stub covers casino bets with, whose half its quotes name as the virtual bankroll, and `bank` what
the developer's bank holds before any developer bet pays its stake in: 10^12 wei each by default. `deposit` is the channel's balance, 1,000,000 wei by default.

| Member                       | What it is                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet`                     | The player's wallet. Open a game with `openGame(identity)` and give it an allowance with `setGameAllowance(amount)` before it bets                |
| `bridge`                     | The game's side of the bridge to `wallet`, a [`TestBridge`](#testbridge), to hand to `RoundClient` or your own client                             |
| `identity(name?, declared?)` | A game as the fixture's developer published it, named `test` by default; `declared` is anything else about it. Every name given here is published |
| `developer`                  | A stub [`Developer`](../sdk/developer.md#developer) with the fixture's key, serving the game named `test`, to hand to your server's code          |
| `storage`, `owner`, `player` | What the wallet saves, the stub casino's signing key, and the player's key                                                                        |
| `settlements()`, `bank()`    | How many channel operations the stub has signed a result for, and what the developer's bank holds                                                 |
| `secretOf(round)`            | A round's secret, which only the casino knows until it reveals the round                                                                          |
| `reload()`                   | A wallet started afresh from what this one saved, as a reload of the page starts one                                                              |
| `replaceChannel()`           | The player closes their channel and opens another of 1,000,000 wei. A game's operation IDs stay the player's across both                          |
| `forget()`                   | A wallet that has lost every receipt, as the same account on another device has                                                                   |

The wallet methods a test calls are `openGame(identity)`, `setGameAllowance(amount)` (a decimal string of wei, as the
player sets it in the wallet's dialog), `gameAllowance()` (the open game's `{ allowance, pending }`), `closeGame()`,
`balance()` (the channel's signed balance, a bigint) and `playableBalance()` (that balance less what a pending operation
commits), from [client/wallet-games.ts](../../client/wallet-games.ts) and
[client/wallet-channel.ts](../../client/wallet-channel.ts).

What the stub holds a game to:

- Every casino bet the stub's quote covers is settled: the casino's own admission rule against the quote's virtual
  bankroll, half of `bankroll`, and the stub charges its commission. A bet it does not cover, a zero-edge one for
  instance, the casino declines too: it comes back `rejected`, revealing nothing, with the balance unchanged.
- Operation IDs behave as the casino's do: the same `id` returns the same receipt, on the player's next channel too,
  and a wallet that has lost the receipt is refused with `id-used`.
- Only a published game takes developer bets. Settlements are paid whole from the bank or refused with `bank-short`.
- The developer's casino bet names a group, is admitted against the virtual bankroll and reveals its round, once: the same bet again
  gets the same answer, and another is refused with `round-revealed`. A reveal bets nothing and moves no money.
- `developer.bets()` pages as the casino does, 100 bets at a time: page with `after` and `more`, and the size never
  matters.

### `bridgeTo`

`bridgeTo(wallet)` is a game's side of the bridge to any wallet, such as one `reload()` returns. Every request goes
through the checks the wallet's bridge makes, with an envelope ID above the last, and on to the wallet's own methods.
The player agrees to every `game.requestAllowance`: the allowance rises by the amount asked, or by the whole playable
balance when none is, up to the playable balance. Every receipt the wallet pushes reaches the `onReceipt` listeners of
every bridge to that wallet. It leaves out what only a wallet page does: the queue, the player's dialog and the `busy`
refusal.

### `TestBridge`

What `bridgeTo` returns, and what [`RoundClient`](../sdk/round.md#roundbridge) and a game's own client take: `call`
sends a request as [`HookedIn.call`](../sdk/hookedin.md#call) does, `allowance` is the open game's
`{ allowance, pending }`, and `onReceipt` hears pushed receipts and returns a function that stops the listener.

## Testing a multi-step game

```ts title="test/double-up.test.ts"
import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet, memoryStore } from '@hookedin/play/testing/game-wallet.ts';
import { RoundClient } from '@hookedin/play/sdk/round';
import { doubleUp } from '../src/rules.ts';

test('a round of Double up settles one step at a time', async () => {
  const f = await gameWallet();
  f.wallet.openGame(f.identity('double-up'));
  const round = new RoundClient(f.bridge, doubleUp, undefined, { store: memoryStore(), name: 'double-up' });
  await round.start({ stake: '1000' });
  const state = await round.action('flip');
  assert.equal(state.cash, state.nodeId === 'won' ? '1900' : '0');
});
```

`src/rules.ts` is [Double up](multi-step-games.md#describe-the-game-as-a-graph). Give `RoundClient` a `store` and a
`name`: a test has no page origin and no page path.

### `memoryStore`

`memoryStore()` is a game's origin storage in memory, as `RoundClient` takes it: what `localStorage` is to a page. Two
clients over one store are one game in two tabs, or before and after a reload. `map` holds what it saved.

## Testing recovery

- **A lost reply.** Wrap `f.bridge.call` so that one bet's reply throws after the wallet has answered, then recover as
  the page would: `game.receipt` finds the receipt, and sending the same request again places nothing.
  [Plinko's test](../../games/plinko/test/plinko.test.ts) does this through its own client.
- **A reload.** `await f.reload()` starts another wallet from what this one saved. Open the game in it again, and give
  your client `bridgeTo(wallet)`.
- **Another channel.** `await f.replaceChannel()` closes the player's channel and opens another. Operation IDs carry
  over: the same request finds the operation instead of placing another.
- **Lost receipts.** `await f.forget()` returns a wallet without the receipts this one kept. After
  `f.replaceChannel()`, an operation it sends again fails with `id-used`.

## Testing a server

Hand `f.developer` to your server's code in place of the one `createDeveloper` makes: it opens rounds, derives seed
hashes, places the developer's casino bets and reveals, and settles bets, against the stub's bankroll and bank. The
template's [test/developer-bet.test.ts](https://github.com/hookedin/game-template/blob/main/test/developer-bet.test.ts)
backs a developer bet with a casino bet on a round and settles it by the outcome. Roulette's wheel takes everything
outside it as arguments, so its tests run it against a casino and a clock of their own
([test/wheel.test.ts](https://github.com/hookedin/game-roulette/blob/main/test/wheel.test.ts)).

## Proving a game's floor

A game states no floor to its players: a promise nobody can verify is worth nothing, because no game bounds how often
it wagers what it holds. It holds its own table to one in a test instead, and every player sees the
[measured return](casino-bets.md#measured-return) of each bet they signed. The house games pin theirs as `FLOOR`, over
every step of every graph they build, at stakes from 1,000 wei to 10^18.

### `worstReturn`

`worstReturn(plan)` is the least any bet a priced game can place pays back, in millionths of its stake: every branch
of every step of a [`GamePlan`](../sdk/engine.md#gameplan).

```ts
import { worstReturn } from '@hookedin/play/testing/game-wallet.ts';

assert.ok(worstReturn(compileGame(graph, { admits, bankrollFloor, cashQuantum, initialCash: stake })) >= FLOOR);
```

## The conformance suite

[testing/conformance.ts](../../testing/conformance.ts) is what a game can count on from any casino, as one behaviour
suite. play runs it against the stub ([test/conformance.test.ts](../../test/conformance.test.ts)) and the casino
service runs it against itself, so the stub behaves as the casino does wherever a game depends on it:

1. A reply lost on the way is found by its ID, and the casino bet is charged once.
2. An operation ID is the player's, so on the player's next channel it finds the bet instead of placing another.
3. A wallet that lost its receipts is told an operation was carried out, with `id-used`, and plays on.
4. A casino bet the bankroll cannot back is declined with the balance unchanged, and declined the same way again.
5. A developer bet is paid what its developer signs, and the game hears.
6. A developer that restarts places the same casino bet, on the seed it published before the bet.
7. A developer's casino bet the bankroll declines reveals its round and moves no money.
8. A round revealed without a bet shows its outcome in its group and moves no money.
9. A round saved under rules the game does not play is let go once, and the next one plays.

The suite is not part of the package's exports. It runs in play's `npm test`, on every push.
