---
title: Testing
description: Test a game against the real wallet and an in-memory casino that holds every bet to the casino's own rules, and the reference for @hookedin/play/testing/game-wallet.ts.
sidebar:
  order: 4
---

Game tests do not mock the wallet. `import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';` builds the real
wallet, in memory, with an active channel, wired to a stub casino that derives and signs every state exactly as the
protocol says, so a bet your test places is a real signed bet, through the same checks the wallet's bridge makes. The
module is made for Node tests.

## Running tests

In a game made from the template, `npm test` type-checks, then runs `node --import tsx --test test/*.test.ts`: `tsx` is
there because `@hookedin/play` ships TypeScript and Node does not strip types from files inside `node_modules`. In play
itself, `node --test games/<id>/test/*.test.ts` from play's root runs one game's tests, and `npm test` every suite.

## A first test

```ts title="test/flip.test.ts"
import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { HEADS, flipStep } from '../src/flip.ts';

test('a flip settles through the real wallet and moves the allowance by its own terms', async () => {
  const f = await gameWallet();
  f.wallet.openGame(f.identity('flip'));
  await f.wallet.setGameAllowance(200000n);
  const receipt = await f.bridge.call('game.casinoBet', { id: 'first', ...flipStep(1000n) });
  assert.equal(receipt.status, 'settled');
  assert.equal(receipt.payout, receipt.outcome < HEADS ? 2000n : 0n);
  assert.equal(receipt.result, receipt.outcome < HEADS ? 0n : 1n); // Heads, or Tails
  assert.equal(f.wallet.gameAllowance().allowance, 200000n - 1000n + receipt.payout);
});
```

`src/flip.ts` is the [coin flip](casino-bets.md#a-coin-flip). The template's
[test/casino-bet.test.ts](https://github.com/hookedin/game-template/blob/main/test/casino-bet.test.ts) starts the same
way: a bet that settles, the same bet sent twice and placed once, and a bet with no edge declined.

## The fixture

### `gameWallet`

`gameWallet({ bankroll?, bank?, deposit?, key? })` resolves with a real `CasinoWallet` from play's client, with an
in-memory store, a random player and one active channel on the local chain, 31337, wired to a stub casino in place of
the network. `bankroll` is what the stub covers casino bets with, whose half its quotes name as the virtual bankroll, and
`bank` what the game's bank holds before any developer bet pays its stake in: 10^12 wei each by default. `deposit` is
the channel's balance, 1,000,000 wei by default, and `key` the private key the game's server signs with, a random one by
default.

| Member                        | What it is                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet`                      | The player's wallet. Open a game with `openGame(identity)` and give it an allowance with `setGameAllowance(amount, developerBets?)` before it bets |
| `bridge`                      | The game's side of the bridge to `wallet`, a [`TestBridge`](#testbridge), to hand to `RoundClient` or your own client                              |
| `identity(name?, declared?)`  | A game as the fixture's developer published it, named `test` by default; `declared` is anything else about it. Every name given here is published  |
| `developer`                   | A stub [`Developer`](../sdk/developer.md#developer) with the fixture's key, serving the game named `test`, to hand to your server's code           |
| `storage`, `signer`, `player` | What the wallet saves, the stub casino's signing key, and the player's key                                                                         |
| `settlements()`, `bank()`     | How many channel operations the stub has signed a result for, and what the game's bank holds                                                       |
| `secretOf(round)`             | A round's secret, which only the casino knows until it reveals the round                                                                           |
| `reload()`                    | A wallet started afresh from what this one saved, as a reload of the page starts one                                                               |
| `replaceChannel()`            | The player closes their channel and opens another of 1,000,000 wei. A game's operation IDs stay the player's across both                           |
| `forget()`                    | A wallet that has lost every receipt, as the same account on another device has                                                                    |

The wallet methods a test calls, from [client/wallet-games.ts](../../client/wallet-games.ts) and
[client/wallet-channel.ts](../../client/wallet-channel.ts), are `openGame(identity)`,
`setGameAllowance(amount, developerBets?)` (a bigint of wei, as the player sets it in the wallet's dialog, and `true` to
allow developer bets too, which a game needs before its first developer bet), `gameAllowance(group?)` (what
[`game.allowance`](../reference/bridge.md#gameallowance) answers), `gameEnd(group, meta?)`,
`gameHistory(after?, limit?)` (what [`game.history`](../reference/bridge.md#gamehistory) answers), `inPlay()` (what the
open game's groups hold), `closeGame()`, `balance()` (the channel's signed balance) and `playableBalance()` (that
balance less what a pending operation commits).

The stub holds a game to what the casino does:

- It settles every casino bet its quote covers, by the casino's own admission rule against half of `bankroll`, and
  charges its commission. The wallet is the real one, so it refuses a step its quote does not cover, a zero-edge bet for
  instance, with `not-covered` before anything is drawn or signed. A bet whose signed table cannot place it at its
  quote's bankroll is refused with `invalid`.
- Operation IDs behave as the casino's do: the same `id` returns the same receipt, on the player's next channel too, and
  a wallet that has lost the receipt is refused with `id-used`.
- Only a published game takes developer bets. Settlements are paid whole from the bank or refused with `bank-short`, and
  one of a bet that names a round must reveal its secret, as only such a settlement may.
- The game's casino bet is checked as the kit and the casino check it, each field in its one form, or refused with
  `invalid`. It is admitted against the virtual bankroll and reveals its round once: the same bet again gets the same
  answer, and another is refused with `round-revealed`. A reveal bets nothing and moves no money.
- The player's history of each game is kept as the casino keeps it, on any wallet of the player's, `reload()` and
  `forget()` included. A group ends with meta once: other meta is refused with `id-conflict`.
- `developer.bets()` pages as the casino does, 100 bets at a time, open ones in the order they were placed. With `wait`,
  a page with no open bets is held until the next bet or the time is up, and the stub refuses what the casino refuses: a
  wait outside 1 to 25 seconds or on settled bets, and a cursor that names no bet.

### `bridgeTo`

`bridgeTo(wallet)` is a game's side of the bridge to any wallet, such as one `reload()` returns. Every request goes
through the checks the wallet's bridge makes, with an envelope ID above the last, and on to the wallet's own methods;
every receipt and allowance the wallet pushes reaches the listeners of every bridge to it. It leaves out what only a
wallet page does: the queue, the player's dialog and the `busy` refusal.

### `TestBridge`

What `bridgeTo` returns, and what [`RoundClient`](../sdk/round.md#roundbridge) and a game's own client take: `call`
sends a request as [`HookedIn.call`](../sdk/hookedin.md#call) does, and `onReceipt` and `onAllowance` hear pushed
receipts and allowances, each returning a function that stops the listener.

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
  await f.wallet.setGameAllowance(200000n);
  const round = new RoundClient(f.bridge, doubleUp, { store: memoryStore(), name: 'double-up' });
  await round.start({ stake: 1000n });
  const state = await round.action('flip');
  assert.equal(state.cash, state.nodeId === 'won' ? 1900n : 0n);
});
```

`src/rules.ts` is [Double up](multi-step-games.md#describe-the-game-as-a-graph). Give `RoundClient` a `store` and a
`name`: a test has no page origin and no page path.

### `memoryStore`

`memoryStore()` is a game's origin storage in memory, as `RoundClient` takes it: what `localStorage` is to a page. Two
clients over one store are one game before and after a reload. `map` holds what it saved.

## Testing recovery

- **A lost reply.** Wrap `f.bridge.call` so that one bet's reply throws after the wallet has answered, then recover as
  the page would: `game.receipt` finds the receipt, and sending the same request again places nothing ([plinko's
  test](../../games/plinko/test/plinko.test.ts)).
- **A reload.** `await f.reload()` starts another wallet from what this one saved: open the game in it again, and give
  your client `bridgeTo(wallet)`.
- **Another channel.** `await f.replaceChannel()` closes the player's channel and opens another; the same request finds
  the operation instead of placing another.
- **Lost receipts.** `await f.forget()` returns a wallet without this one's receipts; after `f.replaceChannel()`, an
  operation it sends again fails with `id-used`.

## Testing a server

Hand `f.developer` to your server's code in place of the one `createDeveloper` makes: it opens rounds, derives seed
hashes, places the game's casino bets and reveals, and settles bets, against the stub's bankroll and bank. The
template's [test/developer-bet.test.ts](https://github.com/hookedin/game-template/blob/main/test/developer-bet.test.ts)
backs a developer bet with a casino bet on a round and settles it by the outcome, and roulette's
[test/wheel.test.ts](https://github.com/hookedin/game-roulette/blob/main/test/wheel.test.ts) runs its wheel against a
casino and a clock of its own.

## Proving a game's floor

A game states no floor to its players, since no game bounds how often it wagers what it holds, and every player sees the
[house edge](casino-bets.md#measured-return) of each bet they signed. It holds its own table to one in a test instead:
the house games pin theirs as `FLOOR`, over every step of every graph they build, at stakes from 1,000 wei to 10^18.

### `worstReturn`

`worstReturn(graph, stake, bankroll)` is the least any bet of a round of `stake` can place pays back, in millionths of
its stake: every branch of every step of `graph`, priced as `RoundClient` prices it against the virtual bankroll
`bankroll` ([`pricing`](../sdk/round.md#pricing)).

```ts
import { worstReturn } from '@hookedin/play/testing/game-wallet.ts';

assert.ok(worstReturn(doubleUp({ stake }), stake, 2n * 10n ** 9n * stake) >= FLOOR);
```

## The conformance suite

[testing/conformance.ts](../../testing/conformance.ts) is what a game can count on from any casino, as one behaviour
suite. play runs it against the stub ([test/conformance.test.ts](../../test/conformance.test.ts)) and the casino service
against itself, so the stub behaves as the casino does wherever a game depends on it: a reply lost on the way is found
by its ID and charged once; an operation ID is the player's, so their next channel finds the bet, and a wallet that lost
its receipts is told so with `id-used` and plays on; a bet the bankroll cannot back is declined with the balance
unchanged, and declined the same way again; a developer bet is paid what the game's server signs, and the game hears; a
server that restarts places the same casino bet on the seed it published; a game's casino bet the bankroll declines, or
a reveal without a bet, reveals its round and moves no money; a game's history, and the rounds it ended, are read back
on any device; and a round saved under rules the game does not play is let go once.

The suite is not part of the package's exports; it runs in play's `npm test`, on every push.
