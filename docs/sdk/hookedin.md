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

const stake = HookedIn.parseAmount('1'); // 1 METH, '1000000000000' wei
const { allowance } = await HookedIn.allowance(); // the player sets it in the wallet's top bar
if (BigInt(allowance) >= BigInt(stake)) {
  const id = crypto.randomUUID(); // save it before sending: a lost reply is recovered by this id
  const receipt = await HookedIn.casinoBet({
    id,
    stake,
    // Half the outcomes win 1.98 times the stake: a 99% return.
    chance: String(1n << 63n),
    prize: String((BigInt(stake) * 198n) / 100n),
    group: id, // what it wins stays out of the allowance the wallet shows until the page has shown the result
  });
  // receipt.payout is the prize when receipt.outcome, the round's 64-bit outcome, is below the chance, or '0'.
  await HookedIn.end(id); // once the page has shown it
}
```

The wallet's top bar names the game and shows its allowance, so a page holds only the game.

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

[`wallet.hello`](../reference/bridge.md#wallethello), `{ bounds }`: the page's first message, which the module sends as
it loads inside a frame. Every call returns that one promise while it is pending or once it has resolved; a greeting
that failed is forgotten, so the next call asks again.

#### `info`

[`wallet.info`](../reference/bridge.md#walletinfo), asked afresh on every call.

#### `round`

A game's round as the casino shows it to anyone, read through the player's wallet with
[`wallet.round`](../reference/bridge.md#walletround), since a game page talks to nobody but its own origin: a
[`Round`](developer.md#round), open or revealed. The wallet passes the casino's answer on as it is: check it as
[checking a round](outcome.md#checking-a-round) shows.

#### `allowance`

[`game.allowance`](../reference/bridge.md#gameallowance), a [`GameAllowance`](#gameallowance): what the game may stake
now, or with `group`, what a bet in that group may stake.

#### `placesDeveloperBets`

[`game.placesDeveloperBets`](../reference/bridge.md#gameplacesdeveloperbets): the game places developer bets, so the
allowance dialog the player opens from the wallet's top bar asks them to allow those too. Call it as the page loads. It
resolves with `null`, and nothing opens: a game never asks the player for anything
([the allowance](../games/how-a-game-works.md#the-allowance)).

#### `end`

[`game.end`](../reference/bridge.md#gameend): the player has seen how `group` ended, so what its bets won joins the
allowance the wallet shows. Call it once the result is on the page, such as when a ball lands: until then the wallet's
figures give nothing away, and stand still while a round is played
([groups](../reference/bridge.md#groups-and-the-allowance-the-player-sees)). `end(group, meta)` also keeps `meta`, your
own JSON saying how the group went, in the player's history of your game, which `history` lists; a
[`RoundClient`](round.md#end) round ends with its state as its meta.

#### `history`

[`game.history`](../reference/bridge.md#gamehistory), a [`GameHistory`](#gamehistory): a page of the player's history
of your game, newest first, from whichever channel and device they played it on. `history({ after, limit })` reads the
page older than the `cursor` of the one before.

```ts
const { entries } = await HookedIn.history({ limit: 20 });
// Each past roll, as its receipt said.
for (const entry of entries) if (entry.kind === 'casino-bet') showRoll(entry.outcome!, entry.payout!);
```

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
dropping a Discord username keeps what the player had ([storage](../games/how-a-game-works.md#storage)).

```ts
HookedIn.storageScope(await HookedIn.info()); // 'hookedin:/dice/:11155111:3byt9ocwnnzaxanmiz3stocj'
```

#### `parseAmount`

What the player typed, a whole number of METH, as wei in a decimal string: digits only, spaces trimmed.
**1 METH is a millionth of an ETH (0.000001 ETH), or 10^12 wei; 1 ETH = 1,000,000 METH.**
Every stake a player chooses is whole METH. It throws an `Error` whose message is for the player,
`Enter a whole number of METH.` or, for zero, `Enter an amount greater than zero.`

#### `formatAmount`

Wei in METH as the player reads them, as the wallet shows them: thousands grouped, truncated (never rounded) to
`places` decimal places, 3 by default, a gwei, with trailing zeros dropped; the wallet shows a balance with 0, in whole
METH. A positive amount that truncates to nothing reads `<0.001`, or `<1` with no places, a negative one keeps its sign,
and a value `BigInt` cannot read returns `—`. Write the unit after it, `METH`.

```ts
HookedIn.formatAmount('1234567891999999999999'); // '1,234,567,891.999'
HookedIn.formatAmount('1'); // '<0.001'
HookedIn.formatAmount('48710895123456789', 0); // '48,710'
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
[bridge's error table](../reference/bridge.md#errors) says what each means and what a game does.

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

Every bound the wallet holds a bet to, `{ outcomeSpace, meta, group }`, as `hello` reports them
([bounds](../reference/bridge.md#bounds)).

### `WalletInfo`

The result of [`wallet.info`](../reference/bridge.md#walletinfo):
`{ uname, discordUsername, chainId, virtualBankroll, recommendedStake }`.

### `CasinoBetRequest`

The parameters of [`game.casinoBet`](../reference/bridge.md#gamecasinobet): `{ id, stake, chance, prize, group? }`.

### `DeveloperBetRequest`

The parameters of [`game.developerBet`](../reference/bridge.md#gamedeveloperbet): `{ id, stake, meta, group? }`.

### `GameReceipt`

What a game learns about an operation, under its own `id`: how it ended, never the signed evidence
([receipt](../reference/bridge.md#receipt)).

### `GameHistory`

`{ entries, cursor, more }`, what [`game.history`](../reference/bridge.md#gamehistory) answers: a page of
[`PastOperation`](#pastoperation) and [`EndedGroup`](#endedgroup) entries, newest first. Pass `cursor` back as `after` while
`more` is `true`.

### `PastOperation`

An earlier operation of the game, on any channel or device of the player's: its [`GameReceipt`](#gamereceipt) as the
wallet checked it, without `id`, and `at`, when the casino recorded it, in milliseconds.

### `EndedGroup`

`{ kind: 'end', group, meta, at }`: a group the game ended with the `meta` it gave `end`.
