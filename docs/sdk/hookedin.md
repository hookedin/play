---
title: HookedIn
description: Reference for @hookedin/play/sdk/sdk, the HookedIn object a game page talks to its wallet with, its error class and its types.
sidebar:
  order: 1
---

`import { HookedIn, HookedInError } from '@hookedin/play/sdk/sdk';` gives a game page its wallet. The module is
browser-only: as it loads it listens for messages on `window`, and inside a wallet's frame it greets the wallet with
`wallet.hello` at once. Each request member below is one request of the [game bridge](../reference/bridge.md), which
says what the wallet checks and answers. Every amount, in a request and in a reply, is a bigint of wei.

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

The wallet's top bar names the game and shows its allowance, so a page holds only the game.

## The bridge

### `HookedIn`

One frozen object per page. A member that talks to the wallet sends one request envelope to `window.parent` and
resolves with the reply to it; envelope IDs count up from 1 for the life of the page, and replies from any other window
are ignored. Each request member is one request of the [game bridge](../reference/bridge.md), which says what it takes,
what the wallet checks and what it answers:

| Member                        | Bridge request                                                                       | Resolves with                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `hello()`                     | [`wallet.hello`](../reference/bridge.md#wallethello)                                 | `{ bounds }`, the [`WalletBounds`](#walletbounds)                                                                      |
| `info()`                      | [`wallet.info`](../reference/bridge.md#walletinfo)                                   | A [`WalletInfo`](#walletinfo)                                                                                          |
| `round(id)`                   | [`wallet.round`](../reference/bridge.md#walletround)                                 | A [`Round`](developer.md#round), open or revealed                                                                      |
| `allowance(group?)`           | [`game.allowance`](../reference/bridge.md#gameallowance)                             | A [`GameAllowance`](#gameallowance)                                                                                    |
| `placesDeveloperBets()`       | [`game.placesDeveloperBets`](../reference/bridge.md#gameplacesdeveloperbets)         | `null`                                                                                                                 |
| `end(group, meta?)`           | [`game.end`](../reference/bridge.md#gameend)                                         | `null`                                                                                                                 |
| `history({ after?, limit? })` | [`game.history`](../reference/bridge.md#gamehistory)                                 | A [`GameHistory`](#gamehistory)                                                                                        |
| `receipt(id)`                 | [`game.receipt`](../reference/bridge.md#gamereceipt)                                 | A [`GameReceipt`](#gamereceipt), or `null` when this wallet has none; `id-used` for one carried out on another channel |
| `showBet(id)`                 | [`wallet.showBet`](../reference/bridge.md#walletshowbet)                             | `null`                                                                                                                 |
| `casinoBet(request)`          | [`game.casinoBet`](../reference/bridge.md#gamecasinobet)                             | A `GameReceipt`: `settled`, `kept` or `rejected`                                                                       |
| `developerBet(request)`       | [`game.developerBet`](../reference/bridge.md#gamedeveloperbet)                       | A `GameReceipt`: `open` or `rejected`                                                                                  |
| `onReceipt(listener)`         | Each [`game.receipt`](../reference/bridge.md#gamereceipt-1) event, to `listener`     | A function that stops the listener                                                                                     |
| `onAllowance(listener)`       | Each [`game.allowance`](../reference/bridge.md#gameallowance-1) event, to `listener` | A function that stops the listener                                                                                     |

What the SDK adds to the bridge:

- The module sends `hello` as it loads inside a frame. Every call returns that one promise while it is pending or once
  it has resolved; a greeting that failed is forgotten, so the next call asks again.
- `info()` asks afresh on every call.
- `round(id)` passes the casino's answer on as the wallet read it, its numbers bigints, without checking it: check it as
  [checking a round](outcome.md#checking-a-round) shows.
- A page opened with no allowance says so before the first bet, and takes that word, or a refusal for want of
  allowance, down once `onAllowance` hears the player has set one:

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
`HookedInError` carrying the wallet's `code` and `message` when the wallet refuses (`failed` if the reply names no
code); with `HookedInError('no-wallet')` at once when the page is not inside a frame; with `HookedInError('timeout')`
when no reply arrives within 180,000 ms, after which the request is forgotten, although the wallet may still have
carried it out, which `receipt` tells; and with a plain `Error` for a reply with neither `result` nor `error`.

#### `storageScope`

A storage key for this page, chain and player, from a `wallet.info` result: `hookedin:<pathname>:<chainId>:<uname>`,
with `anonymous` for a guest's uname, which is `null`. It keys on the uname, so taking or dropping a Discord username
keeps what the player had ([storage](../games/how-a-game-works.md#storage)).

```ts
HookedIn.storageScope(await HookedIn.info()); // 'hookedin:/dice/:1:3byt9ocwnnzaxanmiz3stocj'
```

#### `METH`

A METH in wei, `10n ** 12n`. **1 METH is a millionth of an ETH (0.000001 ETH); 1 ETH = 1,000,000 METH.** A stake of
5 METH is `5n * HookedIn.METH`.

#### `NO_ALLOWANCE`

What a game says before its first bet while it has no allowance:
`Set an allowance in the top bar to play, creating a wallet or depositing first if it asks.` Every game opens with none.

#### `NOT_ENOUGH_ALLOWANCE`

The message the wallet and `RoundClient` refuse a bet with, under `insufficient-allowance`, when the allowance does not
cover it:
`Not enough allowance for this bet: it is what you let this game play with. Set it in the top bar, creating a wallet or depositing first if it asks.`
A page that checks the allowance itself says the same.

#### `NO_DEVELOPER_BETS`

The message the wallet refuses a developer bet with, under `developer-bets-not-allowed`, while the player has not
allowed them: `Allow developer bets with the allowance in the top bar.` A page that checks `developerBets` itself says
the same.

#### `parseAmount`

What the player typed into a stake field, a whole number of METH, as a bigint of wei: digits only, without a leading
zero, spaces trimmed. Every stake a player chooses is whole METH. It throws an `Error` whose message is for the player,
`Enter a whole number of METH.` or, for zero, `Enter an amount greater than zero.` A page's own amounts are bigints
already: it parses only what a person typed.

#### `formatAmount`

Wei in METH as the player reads them, as the wallet shows them: thousands grouped, truncated (never rounded) to
`places` decimal places, 3 by default, a gwei, with trailing zeros dropped; the wallet shows a balance with 0, in whole
METH. A positive amount that truncates to nothing reads `<0.001`, or `<1` with no places, a negative one keeps its sign,
and anything but a bigint returns `—`. Write the unit after it, `METH`.

```ts
HookedIn.formatAmount(1234567891999999999999n); // '1,234,567,891.999'
HookedIn.formatAmount(1n); // '<0.001'
HookedIn.formatAmount(48710895123456789n, 0); // '48,710'
```

#### `exactAmount`

Every digit of an amount in METH, `formatAmount` to 12 places without grouping: what belongs in a field the player
edits.

#### `wholeStake`

`wholeStake(wei)`: the stake a player can choose at or below `wei`, in wei: whole METH, and at least one. A page halves
a stake with it.

```ts
HookedIn.wholeStake(1500000000000n); // 1000000000000n, 1 METH
HookedIn.wholeStake(1n); // 1000000000000n, 1 METH
```

#### `initializeGame`

A page's start: it waits for `wallet.info`, and fills `stakeInput` with the recommended stake unless the player edited
it meanwhile. It resolves with the player's `wallet.info` as `wallet`, and `scope`, the page's
[`storageScope`](#storagescope). It signs nothing.

## Error class

### `HookedInError`

A refusal a game can act on. `code` is stable and the message is for people; `name` is `'HookedInError'`. The codes are
the wallet's, the casino's passed through, and the SDK's own `no-wallet` and `timeout`: the
[bridge's error table](../reference/bridge.md#errors) says what each means and what a game does. `RoundClient` refuses
with it too, as the wallet would.

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

`{ allowance, pending, developerBets }`, what [`game.allowance`](../reference/bridge.md#gameallowance) answers: what the
game may stake in this tab, in wei, whether a signed operation awaits recovery in the wallet, and whether the player
allows the game's developer bets.

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

One way a step can end: `{ weight, cash, label? }`, reached with the probability its whole-number `weight` gives it over
the step's total, leaving the player `cash`, and called `label` in the wallet.

### `DeveloperBetRequest`

The parameters of [`game.developerBet`](../reference/bridge.md#gamedeveloperbet): `{ id, stake, meta, round?, group? }`.

### `GameReceipt`

What a game learns about an operation, under its own `id`: how it ended, never the signed evidence, and for a step the
`result` the wallet landed on and the `draw` to show it with ([receipt](../reference/bridge.md#receipt)).

### `GameHistory`

`{ entries, cursor, more }`, what [`game.history`](../reference/bridge.md#gamehistory) answers: a page of
[`PastOperation`](#pastoperation) and [`EndedGroup`](#endedgroup) entries, newest first. Pass `cursor` back as `after` while
`more` is `true`.

### `PastOperation`

An earlier operation of the game, on any channel or device of the player's: its [`GameReceipt`](#gamereceipt) as the
wallet checked it, without `id` and `reason`, and `at`, when the casino recorded it, in milliseconds.

### `EndedGroup`

`{ kind: 'end', group, meta, at }`: a group the game ended with the `meta` it gave `end`.
