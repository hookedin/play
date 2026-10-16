---
title: HookedIn
description: Reference for @hookedin/play/sdk/sdk, the HookedIn object a game page talks to its wallet with, its error class and its types.
sidebar:
  order: 1
---

`import { HookedIn, HookedInError } from '@hookedin/play/sdk/sdk';` gives a game page its wallet. The module is
browser-only: as it loads, it listens for messages on `window`. Every amount is a bigint of wei.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

const stake = HookedIn.METH; // 1 METH, 10n ** 12n wei
const { allowance } = await HookedIn.allowance(); // the player sets it in the wallet's top bar
if (allowance >= stake) {
  const id = crypto.randomUUID(); // save it before sending: a lost reply is recovered by this id
  const receipt = await HookedIn.casinoBet({
    id,
    cash: stake,
    // One bet: 1.98 times the stake or nothing, as likely as each other, a 99% return.
    results: [
      { weight: 1n, cash: (stake * 198n) / 100n, label: 'Win' },
      { weight: 1n, cash: 0n, label: 'Lose' },
    ],
    group: id, // what it wins stays out of the allowance the wallet shows until the page has shown the result
  });
  // receipt.result is the result the wallet landed on, 0n or 1n, and receipt.payout what the bet paid.
  await HookedIn.end(id); // once the page has shown it
  await HookedIn.showBet(id); // the player's proof of it, in the wallet
}
```

## The bridge

### `HookedIn`

One frozen object per page. Each request member sends one [bridge](../reference/bridge.md) request to `window.parent`
and resolves with its reply; envelope IDs count up from 1 for the page's life, and other windows' replies are ignored:

| Member                        | Bridge request                                                                       | Resolves with                                     |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `hello()`                     | [`wallet.hello`](../reference/bridge.md#wallethello)                                 | `{ bounds }`, the [`WalletBounds`](#walletbounds) |
| `info()`                      | [`wallet.info`](../reference/bridge.md#walletinfo)                                   | A [`WalletInfo`](#walletinfo)                     |
| `round(id)`                   | [`wallet.round`](../reference/bridge.md#walletround)                                 | A [`Round`](developer.md#round), open or revealed |
| `allowance(group?)`           | [`game.allowance`](../reference/bridge.md#gameallowance)                             | A [`GameAllowance`](#gameallowance)               |
| `placesDeveloperBets()`       | [`game.placesDeveloperBets`](../reference/bridge.md#gameplacesdeveloperbets)         | `null`                                            |
| `end(group, meta?)`           | [`game.end`](../reference/bridge.md#gameend)                                         | `null`                                            |
| `history({ after?, limit? })` | [`game.history`](../reference/bridge.md#gamehistory)                                 | A [`GameHistory`](#gamehistory)                   |
| `receipt(id)`                 | [`game.receipt`](../reference/bridge.md#gamereceipt)                                 | A [`GameReceipt`](#gamereceipt), or `null`        |
| `showBet(id)`                 | [`wallet.showBet`](../reference/bridge.md#walletshowbet)                             | `null`                                            |
| `casinoBet(request)`          | [`game.casinoBet`](../reference/bridge.md#gamecasinobet)                             | A `GameReceipt`: `settled`, `kept` or `rejected`  |
| `developerBet(request)`       | [`game.developerBet`](../reference/bridge.md#gamedeveloperbet)                       | A `GameReceipt`: `open` or `rejected`             |
| `onReceipt(listener)`         | Each [`game.receipt`](../reference/bridge.md#gamereceipt-1) event, to `listener`     | A function that stops the listener                |
| `onAllowance(listener)`       | Each [`game.allowance`](../reference/bridge.md#gameallowance-1) event, to `listener` | A function that stops the listener                |

What the SDK adds to the bridge:

- The module sends `hello` as it loads inside a frame. Every call returns that one promise while it is pending or once
  it has resolved; a greeting that failed is forgotten, so the next call asks again.
- `info()` asks afresh on every call.
- `round(id)` passes the round on unchecked: check it as [checking a round](outcome.md#checking-a-round) shows.
- A page opened with no allowance says so before the first bet, and takes that word, or a refusal for want of allowance,
  down once `onAllowance` hears the player has set one:

```ts
if (!(await HookedIn.allowance()).allowance) status.textContent = HookedIn.NO_ALLOWANCE;
HookedIn.onAllowance(({ allowance }) => {
  const shown = status.textContent;
  if (allowance && (shown === HookedIn.NO_ALLOWANCE || shown === HookedIn.NOT_ENOUGH_ALLOWANCE))
    status.textContent = '';
});
```

#### `call`

Sends any bridge request, with `params` `{}` by default, and resolves with the reply's `result`. It rejects with a
`HookedInError` carrying the wallet's `code` and `message` when it refuses (`failed` if the reply names no code),
`no-wallet` at once outside a frame, or `timeout` after 180,000 ms without a reply, when it forgets the request
([errors](../reference/bridge.md#errors)); with a plain `Error`, for a reply with neither `result` nor `error`.

#### `storageScope`

A storage key for this page, chain and player, from a `wallet.info` result: `hookedin:<pathname>:<chainId>:<uname>`,
with `anonymous` for a guest's `null` uname ([storage](../games/how-a-game-works.md#storage)).

```ts
HookedIn.storageScope(await HookedIn.info()); // 'hookedin:/dice/:1:3byt9ocwnnzaxanmiz3stocj'
```

#### `METH`

A METH in wei, `10n ** 12n`. **1 METH is a millionth of an ETH (0.000001 ETH).** 5 METH is `5n * HookedIn.METH`.

#### `NO_ALLOWANCE`

What a game says before its first bet while it has no allowance:
`Set an allowance in the top bar to play, creating a wallet or depositing first if it asks.`

#### `NOT_ENOUGH_ALLOWANCE`

The message the wallet and `RoundClient` refuse a bet with, under `insufficient-allowance`, when the allowance does not
cover it:
`Not enough allowance for this bet: it is what you let this game play with. Set it in the top bar, creating a wallet or depositing first if it asks.`
A page that checks the allowance itself says the same.

#### `NO_DEVELOPER_BETS`

The message the wallet refuses a developer bet with, under `developer-bets-not-allowed`, until the player allows them:
`Allow developer bets with the allowance in the top bar.` A page that checks `developerBets` itself says the same.

#### `parseAmount`

What the player typed into a stake field, a whole number of METH, as a bigint of wei: digits only, without a leading
zero, spaces trimmed. It throws an `Error` whose message is for the player, `Enter a whole number of METH.` or, for
zero, `Enter an amount greater than zero.` A page parses only what a person typed: its own amounts are bigints already.

#### `formatAmount`

Wei in METH, as the wallet shows them: thousands grouped, truncated (never rounded) to `places` decimal places, 3 by
default, a gwei, or 0 for a balance in whole METH, with trailing zeros dropped. A positive amount that truncates to
nothing reads `<0.001`, or `<1` with no places, a negative one keeps its sign, and anything but a bigint returns `—`.
Write the unit after it, `METH`.

```ts
HookedIn.formatAmount(1234567891999999999999n); // '1,234,567,891.999'
HookedIn.formatAmount(1n); // '<0.001'
HookedIn.formatAmount(48710895123456789n, 0); // '48,710'
```

#### `exactAmount`

Every digit of an amount in METH, `formatAmount` to 12 places ungrouped: what belongs in a field the player edits.

#### `wholeStake`

`wholeStake(wei)`: the stake a player can choose at or below `wei`, in wei: whole METH, and at least one. A page halves
a stake with it.

```ts
HookedIn.wholeStake(1500000000000n); // 1000000000000n, 1 METH
HookedIn.wholeStake(1n); // 1000000000000n, 1 METH
```

#### `initializeGame`

A page's start, which signs nothing: it waits for `wallet.info` and fills `stakeInput` with the recommended stake unless
the player edited it meanwhile, then resolves with `wallet`, the player's `wallet.info`, and `scope`, the page's
[`storageScope`](#storagescope).

## Error class

### `HookedInError`

A refusal a game can act on: `code` is stable, the message is for people, and `name` is `'HookedInError'`. The [bridge's
errors](../reference/bridge.md#errors) list its codes, the wallet's, the casino's and the SDK's own, and what a game
does with each. `RoundClient` refuses with it too.

```ts
import { HookedIn, HookedInError } from '@hookedin/play/sdk/sdk';
import type { CasinoBetRequest } from '@hookedin/play/sdk/sdk';

async function place(bet: CasinoBetRequest) {
  try {
    return await HookedIn.casinoBet(bet);
  } catch (error) {
    // Refused before anything was signed: the message tells the player to set the allowance in the top bar.
    if (error instanceof HookedInError && error.code === 'insufficient-allowance') return show(error.message);
    throw error;
  }
}
```

## Types

### `GameAllowance`

`{ allowance, pending, developerBets }`, what [`game.allowance`](../reference/bridge.md#gameallowance) answers.

### `WalletBounds`

Every bound the wallet holds a bet to, `{ outcomeSpace, meta, group, results, pairs, weight, label }`, as `hello`
reports them ([bounds](../reference/bridge.md#bounds)).

### `WalletInfo`

The result of [`wallet.info`](../reference/bridge.md#walletinfo):
`{ uname, discordUsername, chainId, virtualBankroll, recommendedStake }`.

### `CasinoBetRequest`

The parameters of [`game.casinoBet`](../reference/bridge.md#gamecasinobet): `{ id, cash, results, group? }`, a step of
[`StepResult`](#stepresult)s.

### `StepResult`

A step's result, `{ weight, cash, label? }`, as [`game.casinoBet`](../reference/bridge.md#gamecasinobet) takes it.

### `DeveloperBetRequest`

The parameters of [`game.developerBet`](../reference/bridge.md#gamedeveloperbet): `{ id, stake, meta, round?, group? }`.

### `GameReceipt`

What a game learns about an operation, under its own `id` ([receipt](../reference/bridge.md#receipt)).

### `GameHistory`

`{ entries, cursor, more }`, what [`game.history`](../reference/bridge.md#gamehistory) answers: a page of
[`PastOperation`](#pastoperation) and [`EndedGroup`](#endedgroup) entries, newest first.

### `PastOperation`

An earlier operation of the game, from any channel or device of the player's: its [`GameReceipt`](#gamereceipt) as the
wallet checked it, without `id` and `reason`, with `at`, when the casino recorded it, in milliseconds.

### `EndedGroup`

`{ kind: 'end', group, meta, at }`: a group the game ended with the `meta` it gave `end`.
