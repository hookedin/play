---
title: Testing
description: Test a game against the real wallet and an in-memory casino that holds every bet to the casino's own rules.
sidebar:
  order: 9
---

Game tests do not mock the wallet. [`gameWallet()`](../sdk/game-wallet.md#gamewallet) from
`@hookedin/play/testing/game-wallet.ts` builds the real wallet, in memory, with an open channel, wired to a casino stub
that derives and signs every state exactly as the protocol says. A bet your test places is a real signed bet, sent
through the same checks the wallet's bridge makes.

## Running tests

In a game made from the template:

```sh
npm test
```

This type-checks, then runs `node --import tsx --test test/*.test.ts`. `tsx` is there because `@hookedin/play` ships
TypeScript and Node does not strip types from files inside `node_modules`. In play itself Node runs the sources
directly, so one game's tests run with `node --test games/<id>/test/*.test.ts` from play's root, and `npm test` runs
every suite.

## A first test

```ts title="test/flip.test.ts"
import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { HEADS, flipBet, wire } from '../src/flip.ts';

test('a flip settles through the real wallet and moves the balance by its own terms', async () => {
  const f = await gameWallet();
  f.wallet.openGame(f.identity('flip'));
  await f.wallet.setGameLimit('200000');
  const receipt = await f.bridge.call('game.casinoBet', { id: 'first', ...wire(flipBet(1000n)) });
  assert.equal(receipt.status, 'settled');
  assert.equal(receipt.payout, BigInt(receipt.outcome) < HEADS ? '2000' : '0');
  assert.equal(f.wallet.gameLimit().balance, String(200000n - 1000n + BigInt(receipt.payout)));
});
```

`src/flip.ts` is the [coin flip](casino-bets.md#a-coin-flip). The template's
[test/casino-bet.test.ts](https://github.com/hookedin/game-template/blob/main/test/casino-bet.test.ts) is the same
start: a bet that settles, the same bet sent twice and placed once, and a bet with no edge declined.

## The fixture

`const f = await gameWallet({ bankroll?, bank? })` gives you:

- `f.wallet`, the real wallet, with a channel of 1,000,000 wei open. Open a game with
  `f.wallet.openGame(f.identity(name))` and set its spending limit with `f.wallet.setGameLimit(amount)`;
  `f.wallet.gameLimit()` reads the limit, and `await f.wallet.balance()` the channel's balance.
- `f.bridge`, the game's side of the bridge, to hand to `RoundClient` or your own client. The player agrees to every
  request for funds, as far as the balance goes, and `f.bridge.onReceipt` hears the receipts the wallet pushes.
- `f.identity(name)`, a game as its developer published it. Every name you give is published.
- `f.developer`, a stub shaped like the `Developer` that `createDeveloper` returns, serving the game `f.identity()`
  names, `test`.
- `bankroll`, what the stub covers casino bets with, and `bank`, what the developer's bank holds: 10^12 each by
  default. `f.bankroll()` and `f.bank()` read them as play goes on.

Every member is in [`gameWallet`](../sdk/game-wallet.md#gamewallet).

## What the stub holds you to

- Every casino bet passes the casino's own admission rule against `bankroll`, and the stub charges its commission. A
  table it declines, a zero-edge one for instance, the casino declines too. A declined bet comes back `rejected` with
  its round revealed and the balance unchanged.
- Operation IDs behave as the casino's do: the same `id` returns the same receipt, on the player's next channel too,
  and a wallet that has lost the receipt is refused with `id-used`.
- Only a published game takes developer bets. Settlements are paid whole from the bank or refused with `bank-short`,
  and the developer's casino bet is admitted like any other and reveals its round.
- The stub's `developer.bets()` returns 50 bets a page by default and the casino 100; page with `after` and `more` and
  the size never matters.

## Testing a multi-step game

```ts title="test/double-up.test.ts"
import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { RoundClient } from '@hookedin/play/sdk/round';
import type { RoundStore } from '@hookedin/play/sdk/round';
import { doubleUp } from '../src/rules.ts';

/** The game's origin storage, in memory. */
const memory = (): RoundStore => {
  const map = new Map<string, string>();
  return {
    get: key => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: key => void map.delete(key),
  };
};

test('a round of Double up settles one step at a time', async () => {
  const f = await gameWallet();
  f.wallet.openGame(f.identity('double-up'));
  const round = new RoundClient(f.bridge, doubleUp, undefined, { store: memory(), name: 'double-up' });
  await round.start({ stake: '1000' });
  const state = await round.action('flip');
  assert.equal(state.cash, state.nodeId === 'won' ? '1900' : '0');
});
```

`src/rules.ts` is [Double up](multi-step-games.md#describe-the-game-as-a-graph). Give `RoundClient` a `store` and a
`name`: a test has no page origin and no page path. Two clients over one store are one game in two tabs, or before and
after a reload.

## Testing recovery

- **A lost reply.** Wrap `f.bridge.call` so that one bet's reply throws after the wallet has answered, then recover as
  the page would: `game.receipt` finds the receipt, and sending the same request again places nothing.
  [Plinko's test](../../games/plinko/test/plinko.test.ts) does this through its own client.
- **A reload.** `await f.reload()` starts another wallet from what this one saved. Open the game in it again, and give
  your client `f.bridgeFor(wallet)`.
- **Another channel.** `await f.replaceChannel()` closes the player's channel and opens another. Operation IDs carry
  over: the same request finds the operation instead of placing another.
- **Lost receipts.** `await f.forget()` returns a wallet without the receipts this one kept, as one restored from an
  older backup. After `f.replaceChannel()`, an operation it sends again fails with `id-used`.

## Testing a server

Hand `f.developer` to your server's code in place of the one `createDeveloper` makes: it opens rounds, derives seed
hashes, places the developer's casino bet and settles bets, against the stub's bankroll and bank. `f.secretOf(round)` is
a round's secret, which the stub reveals only with the casino bet. The template's
[test/developer-bet.test.ts](https://github.com/hookedin/game-template/blob/main/test/developer-bet.test.ts) backs a
developer bet with a casino bet on a round and settles it by the outcome. Roulette's wheel takes everything outside it
as arguments, so its tests run it against a casino and a clock of their own
([test/wheel.test.ts](../../games/roulette/test/wheel.test.ts)).

## Proving a table's floor

A test is where a game proves the least it pays back, from the prize tables it signs: see
[measured return](casino-bets.md#measured-return).

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
8. A round saved under rules the game does not play is let go once, and the next one plays.

The suite is not part of the package's exports. It runs in play's `npm test`, on every push.
