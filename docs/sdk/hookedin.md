---
title: HookedIn
description: Reference for @hookedin/play/sdk/sdk, the HookedIn object a game page talks to its wallet with, its error class and its types.
sidebar:
  order: 1
---

`import { HookedIn, HookedInError } from '@hookedin/play/sdk/sdk';` gives a game page its wallet. The module is
browser-only: as it loads it listens for messages on `window`, and inside a wallet's frame it greets the wallet with
`wallet.hello` at once. Each request member below is one request of the [game bridge](../reference/bridge.md), which says
what the wallet checks and answers.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

const shown = document.querySelector('#allowance')!;
HookedIn.onAllowance(({ allowance }) => (shown.textContent = `${HookedIn.formatAmount(allowance)} ETH`));

const stake = HookedIn.parseAmount('0.000001'); // '1000000000000' wei
const answer = await HookedIn.requestAllowance({ amount: stake });
if (answer.allowed) {
  const id = crypto.randomUUID(); // save it before sending: a lost reply is recovered by this id
  const receipt = await HookedIn.casinoBet({
    id,
    stake,
    // Half the outcomes win 1.98 times the stake: a 99% return.
    chance: String(1n << 63n),
    prize: String((BigInt(stake) * 198n) / 100n),
  });
  // receipt.payout is the prize when receipt.outcome, the round's 64-bit outcome, is below the chance, or '0'.
}
```

## The bridge

### `HookedIn`

One frozen object per page. A member that talks to the wallet sends one request envelope to `window.parent` and
resolves with the reply to it; envelope IDs count up from 1 for the life of the page, and replies from any other window
are ignored.

#### `call`

Sends any bridge request, with `params` `{}` by default, and resolves with the reply's `result`. It rejects with a
`HookedInError` carrying the wallet's `code` and `message` when the wallet refuses (`failed` if the reply names no
code); with `HookedInError('no-wallet')` at once when the page is not inside a frame; with `HookedInError('timeout')`
when no reply arrives within 180,000 ms, after which the request is forgotten, although the wallet may still have
carried it out, which `receipt` tells; and with a plain `Error` for a reply with neither `result` nor `error`.

#### `hello`

[`wallet.hello`](../reference/bridge.md#wallethello), `{ limits }`: the page's first message, which the module sends as
it loads inside a frame. Every call returns that one promise while it is pending or once it has resolved; a greeting
that failed is forgotten, so the next call asks again.

#### `info`

[`wallet.info`](../reference/bridge.md#walletinfo), asked afresh on every call.

#### `round`

A developer's round as the casino shows it to anyone, read through the player's wallet with
[`wallet.round`](../reference/bridge.md#walletround), since a game page talks to nobody but its own origin: a
[`Round`](developer.md#round), open or revealed. The wallet passes the casino's answer on as it is: check it as
[checking a round](outcome.md#checking-a-round) shows.

#### `allowance`

The game's allowance as the wallet last pushed it, a [`GameAllowance`](#gameallowance). It greets the wallet first and
rejects as [`hello`](#hello) does, with `no-wallet` outside a frame; when nothing has been pushed yet, it waits for the
first push, and rejects with `timeout` if none arrives within 180,000 ms.

#### `onAllowance`

Calls a listener with every [`game.allowance`](../reference/bridge.md#gameallowance) push, and returns a function that
stops it. A listener added later hears only later pushes; `allowance()` reads the current one.

#### `requestAllowance`

[`game.requestAllowance`](../reference/bridge.md#gamerequestallowance): asks the player for `amount` more than the game
holds, a suggestion the wallet's own dialog shows, and resolves once they have decided with `allowed`, and the game's
`allowance` and `pending` after it.

#### `receipt`

[`game.receipt`](../reference/bridge.md#gamereceipt): an earlier operation's receipt by the game's own `id`, or `null`
if this wallet has none. For an open developer bet the wallet also asks the casino, and once its developer has settled
it, collects it, and `onReceipt` hears.

#### `casinoBet`

[`game.casinoBet`](../reference/bridge.md#gamecasinobet): resolves with the bet's receipt, `settled` or `rejected`.

#### `developerBet`

[`game.developerBet`](../reference/bridge.md#gamedeveloperbet): resolves with the bet's receipt, `open` or `rejected`;
once the developer has settled it and the wallet has collected what it pays, `onReceipt` hears.

#### `onReceipt`

Calls a listener with every [`game.receipt`](../reference/bridge.md#gamereceipt-1) push, a developer bet of this game
settled by its developer and collected by the wallet, and returns a function that stops it.

#### `storageScope`

A storage key for this page, chain and player, from a `wallet.info` result: `hookedin:<pathname>:<chainId>:<uname>`,
with `chain` for a missing chain and `anonymous` for a missing uname, in lower case. It keys on the uname, so taking or
dropping an alias keeps what the player had ([storage](../games/how-a-game-works.md#storage)).

```ts
HookedIn.storageScope(await HookedIn.info()); // 'hookedin:/dice/:11155111:3byt9ocwnnzaxanmiz3stocj'
```

#### `parseAmount`

What the player typed, in ETH, as whole wei in a decimal string: digits with at most 18 places after the point, spaces
trimmed. It throws an `Error` whose message is for the player, `Enter a positive stake with up to 18 decimal places.`
or, for zero, `Your stake must be greater than zero.`

#### `formatAmount`

Wei in ETH as the player reads them, truncated (never rounded) to `places` decimal places, 6 by default, with trailing
zeros dropped. A positive amount that truncates to nothing reads `<0.000001`, a negative one keeps its sign, and a
value `BigInt` cannot read returns `—`.

```ts
HookedIn.formatAmount('1500000000000000000'); // '1.5'
HookedIn.formatAmount('1', 2); // '<0.01'
```

#### `exactAmount`

Every digit of an amount, `formatAmount` to 18 places: what belongs in a field the player edits.

#### `initializeGame`

A page's start: it waits for `wallet.info` and the first allowance, and fills `stakeInput` with the recommended stake
unless the player edited it meanwhile. It resolves with the player's `wallet.info` as `wallet`, the game's `allowance`,
and `scope`, the page's [`storageScope`](#storagescope). It signs nothing and asks the player nothing.

## Error class

### `HookedInError`

A refusal a game can act on. `code` is stable and the message is for people; `name` is `'HookedInError'`. The codes are
the wallet's, the casino's passed through, and the SDK's own `no-wallet` and `timeout`: the
[bridge's error table](../reference/bridge.md#errors) says what each means and what a game does.

```ts
import { HookedIn, HookedInError } from '@hookedin/play/sdk/sdk';
import type { CasinoBetRequest } from '@hookedin/play/sdk/sdk';

async function place(bet: CasinoBetRequest) {
  try {
    return await HookedIn.casinoBet(bet);
  } catch (error) {
    if (!(error instanceof HookedInError) || error.code !== 'insufficient-allowance') throw error;
    const answer = await HookedIn.requestAllowance({ amount: bet.stake });
    if (answer.allowed) return HookedIn.casinoBet(bet); // the same id: the same bet
    throw error;
  }
}
```

## Types

### `GameAllowance`

`{ allowance, pending }`, what the wallet pushes as [`game.allowance`](../reference/bridge.md#gameallowance): what the
game may still risk in this tab, winnings included, in wei, and whether a signed operation awaits recovery in the
wallet.

### `WalletLimits`

Every bound the wallet holds a bet to, `{ outcomeSpace, meta, group }`, as `hello` reports them
([limits](../reference/bridge.md#limits)).

### `WalletInfo`

The result of [`wallet.info`](../reference/bridge.md#walletinfo): `{ uname, alias, chainId, bankroll, recommendedStake }`.

### `CasinoBetRequest`

The parameters of [`game.casinoBet`](../reference/bridge.md#gamecasinobet): `{ id, stake, chance, prize, group? }`.

### `DeveloperBetRequest`

The parameters of [`game.developerBet`](../reference/bridge.md#gamedeveloperbet): `{ id, stake, meta, group? }`.

### `GameReceipt`

What a game learns about an operation, under its own `id`: how it ended, never the signed evidence
([receipt](../reference/bridge.md#receipt)).
