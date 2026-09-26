---
title: HookedIn
description: Reference for @hookedin/play/sdk/sdk, the HookedIn object a game page talks to its wallet with, its error class and its types.
sidebar:
  order: 1
---

`import { HookedIn, HookedInError } from '@hookedin/play/sdk/sdk';` gives a game page its wallet. The module is
browser-only: as it loads it listens for messages on `window`, and inside a wallet's frame it greets the wallet with
`wallet.hello` at once. Each method below is one request of the [game bridge](../reference/bridge.md), which says what
the wallet checks and answers.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

const shown = document.querySelector('#balance')!;
HookedIn.onBalance(({ balance }) => (shown.textContent = HookedIn.formatAmount(balance)));
const { asset } = await HookedIn.hello(); // asset.symbol names what this wallet plays with

const stake = HookedIn.parseAmount('0.000001'); // '1000000000000' in the asset's smallest units
const funding = await HookedIn.requestFunds({ amount: stake });
if (funding.funded) {
  const id = crypto.randomUUID(); // save it before sending: a lost reply is recovered by this id
  const receipt = await HookedIn.casinoBet({
    id,
    stake,
    // Half the outcome space pays 1.98 times the stake: a 99% return.
    prizes: [{ rangeStart: '0', rangeEnd: String(1n << 63n), payout: String((BigInt(stake) * 198n) / 100n) }],
  });
  // receipt.outcome is the round's 64-bit outcome; receipt.payout is what the prizes paid.
}
```

## The bridge

### `HookedIn`

```ts
export const HookedIn: Readonly<{
  call: (method: string, params?: Record<string, unknown>) => Promise<any>;
  hello: () => Promise<WalletHello>;
  limits: () => Promise<WalletLimits>;
  info: () => Promise<WalletInfo>;
  balance: () => Promise<GameBalance>;
  onBalance: (listener: (balance: GameBalance) => void) => () => void;
  requestFunds: (options?: { amount?: bigint | string }) => Promise<
    GameBalance & {
      funded: boolean;
      amount: string | null;
    }
  >;
  receipt: (id: string) => Promise<GameReceipt | null>;
  casinoBet: (request: CasinoBetRequest) => Promise<GameReceipt>;
  developerBet: (request: DeveloperBetRequest) => Promise<GameReceipt>;
  onReceipt: (listener: (receipt: GameReceipt) => void) => () => void;
  payment: (id: string, amount: string, group?: string) => Promise<GameReceipt>;
  storageScope: (wallet: WalletInfo | null | undefined) => string;
  showName: (names: PlayerNames | null | undefined) => string;
  parseAmount: (value: string) => string;
  formatAmount: (value: string | number | bigint, places?: number) => string;
  exactAmount: (value: string | number | bigint) => string;
  stepStake: (input: HTMLInputElement, up: boolean) => void;
  initializeGame: ({
    stakeInput,
    assetLabels,
  }: {
    stakeInput: HTMLInputElement;
    assetLabels?: Iterable<Element>;
  }) => Promise<{
    wallet: WalletInfo;
    state: GameBalance;
    asset: string;
    assetId: 'eth' | 'test';
    scope: string;
  }>;
}>;
```

One frozen object per page. A member that talks to the wallet sends one request envelope to `window.parent` and resolves
with the reply to it; envelope IDs count up from 1 for the life of the page. Replies from any window other than
`window.parent` are ignored.

#### `call`

```ts
call: (method: string, params?: Record<string, unknown>) => Promise<any>;
```

Sends any bridge request and resolves with the reply's `result`. `params` defaults to `{}`. It rejects with:

- a `HookedInError` carrying the wallet's `code` and `message` when the wallet refuses (`failed` if the reply names no
  code);
- `HookedInError('no-wallet')` at once when the page is not inside a frame;
- `HookedInError('timeout')` when no reply arrives within 180,000 ms. The request is forgotten and a late reply ignored;
  the wallet may still have carried it out, which `receipt` tells;
- a plain `Error` for a reply with neither `result` nor `error`.

```ts
const receipt = await HookedIn.call('game.receipt', { id: 'coin-17' });
```

#### `hello`

```ts
hello: () => Promise<WalletHello>;
```

The wallet's greeting, [`wallet.hello`](../reference/bridge.md#wallethello): the methods it offers, its asset, its
chain and its limits. The module sends it as it loads inside a frame, and every call returns that one promise while it
is pending or once it has resolved. A greeting that failed is forgotten, so the next call asks the wallet again. It
rejects as [`call`](#call) does.

#### `limits`

```ts
limits: () => Promise<WalletLimits>;
```

The bounds the wallet holds a bet to: `(await hello()).limits`.

#### `info`

```ts
info: () => Promise<WalletInfo>;
```

[`wallet.info`](../reference/bridge.md#walletinfo), asked afresh on every call: the player's names, the casino's
bankroll and a recommended stake.

#### `balance`

```ts
balance: () => Promise<GameBalance>;
```

The game's balance as the wallet last pushed it. It greets the wallet first, with [`hello`](#hello), and rejects as
that does: with `HookedInError('no-wallet')` outside a frame, for one. When nothing has been pushed yet, it waits for the
first push, and rejects with `HookedInError('timeout')` if none arrives within 180,000 ms.

#### `onBalance`

```ts
onBalance: (listener: (balance: GameBalance) => void) => () => void;
```

Calls `listener` with every [`game.balance`](../reference/bridge.md#gamebalance) push and returns a function that stops
it. Pushes wait for the greeting: one that arrives before it is delivered when the greeting does, so a listener can
always format the amount in the wallet's asset. A listener added later hears only later pushes; `balance()` reads the
current one.

#### `requestFunds`

```ts
requestFunds: (options?: { amount?: bigint | string }) =>
  Promise<
    GameBalance & {
      funded: boolean;
      amount: string | null;
    }
  >;
```

Asks the player for money with [`game.requestFunds`](../reference/bridge.md#gamerequestfunds). `amount` is how much more
than the game holds, in smallest units: a suggestion the wallet's own dialog shows. It resolves once the player has
decided: `funded` says whether they set a limit, `amount` is the limit they chose (`null` if they declined), and
`balance` and `pending` are the game's state after it.

#### `receipt`

```ts
receipt: (id: string) => Promise<GameReceipt | null>;
```

The [receipt](../reference/bridge.md#receipt) of an earlier operation by the game's own `id`, or `null` if this wallet
has none. For an open developer bet the wallet also asks the casino about it; once its developer has settled it, the
wallet collects what it pays and `onReceipt` hears the settled receipt.

#### `casinoBet`

```ts
casinoBet: (request: CasinoBetRequest) => Promise<GameReceipt>;
```

Places a casino bet with [`game.casinoBet`](../reference/bridge.md#gamecasinobet): settled against the casino's bankroll
in the one request, on the player's own round. Resolves with its receipt, `settled` or `rejected`. The same request again
returns the saved receipt.

#### `developerBet`

```ts
developerBet: (request: DeveloperBetRequest) => Promise<GameReceipt>;
```

Places a developer bet with [`game.developerBet`](../reference/bridge.md#gamedeveloperbet): its stake goes into the bank
of the game's developer at once, and the developer settles it. Resolves with its receipt, `open` or `rejected`. Once the
developer has settled it and the wallet has collected what it pays, `onReceipt` hears the settled receipt.

```ts
const placed = await HookedIn.developerBet({
  id: 'match-812-home',
  stake: '1000000000000',
  meta: { pick: 'home', odds: '2.1' }, // the game's own JSON; its numbers are whole, so odds go as strings
  group: 'match-812',
});
```

#### `onReceipt`

```ts
onReceipt: (listener: (receipt: GameReceipt) => void) => () => void;
```

Calls `listener` with every [`game.receipt`](../reference/bridge.md#gamereceipt-1) push: a developer bet this game
placed, settled by its developer and collected by the wallet. Returns a function that stops it. Receipts are not held for
the greeting.

#### `payment`

```ts
payment: (id: string, amount: string, group?: string) => Promise<GameReceipt>;
```

Pays `amount` to the bankroll with [`game.payment`](../reference/bridge.md#gamepayment). Its arguments are positional.
Resolves with the receipt, `settled` or `rejected`; a payment's receipt carries no amount.

#### `storageScope`

```ts
storageScope: (wallet: WalletInfo | null | undefined) => string;
```

A storage key for this page, chain, asset and player: `hookedin:<pathname>:<chainId>:<asset>:<uname>`, from
`location.pathname`, a `wallet.info` result and the greeted asset (`eth` before the greeting). A missing chain reads
`chain` and a missing uname `anonymous`. It keys on the uname, so taking or dropping an alias keeps what the player had.
[`playerScope`](wire.md#playerscope) builds the part after the path.

```ts
HookedIn.storageScope(await HookedIn.info()); // 'hookedin:/dice/:11155111:eth:3byt9ocwnnzaxanmiz3stocj'
```

#### `showName`

```ts
showName: (names: PlayerNames | null | undefined) => string;
```

How a player is written: `@alias`, or `~uname` without an alias, or `—` for neither. The same function as
[`showName`](wire.md#showname).

#### `parseAmount`

```ts
parseAmount: (value: string) => string;
```

What the player typed, as whole smallest units of the wallet's asset in a decimal string. It trims spaces and accepts
digits with at most `decimals` places after the point, using the greeted asset's decimals (18 before the greeting). It
throws an `Error` with a message for the player: `Enter a positive stake with up to 18 decimal places.` for anything
else, and `Your stake must be greater than zero.` for zero.

```ts
HookedIn.parseAmount('0.000001'); // '1000000000000'
```

#### `formatAmount`

```ts
formatAmount: (value: string | number | bigint, places?: number) => string;
```

Smallest units as the player reads them, truncated (never rounded) to `places` decimal places, 6 by default, with
trailing zeros dropped. A positive amount that truncates to nothing reads `<0.000001`, a negative one keeps its sign, and
a value `BigInt` cannot read returns `—`.

```ts
HookedIn.formatAmount('1500000000000000000'); // '1.5'
HookedIn.formatAmount('1', 2); // '<0.01'
```

#### `exactAmount`

```ts
exactAmount: (value: string | number | bigint) => string;
```

Every digit of an amount: `formatAmount` to the asset's full `decimals`. It is what belongs in a field the player edits.

#### `stepStake`

```ts
stepStake: (input: HTMLInputElement, up: boolean) => void;
```

Moves a stake field to the next value up or down the ladder 1, 2, 5, 10, 20, 50 and on, in smallest units. It writes the
result back with `exactAmount` and leaves an unreadable value alone. From `0.000001`, up is `0.000002` and down
`0.0000005`.

#### `initializeGame`

```ts
initializeGame: ({ stakeInput, assetLabels }: { stakeInput: HTMLInputElement; assetLabels?: Iterable<Element> }) =>
  Promise<{
    wallet: WalletInfo;
    state: GameBalance;
    asset: string;
    assetId: 'eth' | 'test';
    scope: string;
  }>;
```

A page's start: it waits for the greeting, `wallet.info` and the first balance, then writes the asset's symbol into
every element of `assetLabels`, labels `stakeInput` `Stake in <symbol>`, and fills `stakeInput` with the recommended
stake unless the player edited it meanwhile. It resolves with the player's `wallet.info`, the balance as `state`, the
symbol as `asset`, the asset's `assetId` and `scope`, the page's [`storageScope`](#storagescope). It signs nothing and
asks the player nothing.

```ts
const startup = await HookedIn.initializeGame({
  stakeInput: document.querySelector<HTMLInputElement>('#stake')!,
  assetLabels: document.querySelectorAll('[data-asset]'),
});
```

## Error class

### `HookedInError`

```ts
export class HookedInError extends Error {
  code: string;
  constructor(code: string, message: string);
}
```

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
    if (!(error instanceof HookedInError) || error.code !== 'insufficient-funds') throw error;
    const funding = await HookedIn.requestFunds({ amount: bet.stake });
    if (funding.funded) return HookedIn.casinoBet(bet); // the same id: the same bet
    throw error;
  }
}
```

## Types

### `GameBalance`

```ts
export interface GameBalance {
  balance: string;
  pending: boolean;
}
```

What the wallet pushes as [`game.balance`](../reference/bridge.md#gamebalance). `balance` is what the game may still
risk in this tab, including its winnings, in the asset's smallest units; the wallet releases it when the player leaves
the game. `pending` is `true` while a signed operation of this game awaits recovery in the wallet, and no bet or
payment is possible.

### `Asset`

```ts
export interface Asset {
  id: 'eth' | 'test';
  symbol: string;
  decimals: number;
}
```

What the wallet plays with: the network's ETH (`eth`, symbol `ETH` or `Sepolia ETH`) or the casino's test coins
(`test`, symbol `TEST`). Both count in units of 10^-18: `decimals` is 18.

### `WalletLimits`

```ts
export interface WalletLimits {
  prizes: number;
  outcomeSpace: string;
  meta: number;
  group: number;
}
```

Every bound the wallet holds a bet to. They are part of the protocol revision the wallet and its casino share; the
[bridge's limits](../reference/bridge.md#limits) give their values.

### `WalletHello`

```ts
export interface WalletHello {
  methods: string[];
  asset: Asset;
  chainId: string;
  limits: WalletLimits;
}
```

The result of [`wallet.hello`](../reference/bridge.md#wallethello).

### `WalletInfo`

```ts
export interface WalletInfo {
  uname: string | null;
  alias: string | null;
  chainId: string;
  bankroll: string;
  recommendedStake: string;
}
```

The result of [`wallet.info`](../reference/bridge.md#walletinfo): everything a game learns about the player. `uname` is
theirs for good and `null` until a casino has answered the wallet; a game keys anything of its own by it. `alias` is the
name they are shown by, `null` unless they took one. `bankroll` is the casino's bankroll as last reported, what to price bets
against rather than a promise to admit them.

### `WirePrize`

```ts
export interface WirePrize {
  rangeStart: string;
  rangeEnd: string;
  payout: string;
}
```

A prize on the wire, in decimal strings: one entry of `CasinoBetRequest.prizes` and `GameReceipt.prizes`.

### `CasinoBetRequest`

```ts
export interface CasinoBetRequest {
  id: string;
  stake: string;
  prizes: { rangeStart: string; rangeEnd: string; payout: string }[];
  group?: string;
}
```

The parameters of [`game.casinoBet`](../reference/bridge.md#gamecasinobet). `id` is the game's own name for the
operation; each prize pays `payout` when the round's 64-bit outcome falls in `[rangeStart, rangeEnd)`, and overlapping
prizes add; `group` labels bets that belong together.

### `DeveloperBetRequest`

```ts
export interface DeveloperBetRequest {
  id: string;
  stake: string;
  meta: Record<string, unknown>;
  group?: string;
}
```

The parameters of [`game.developerBet`](../reference/bridge.md#gamedeveloperbet). `meta` is the game's own JSON, saying
what the bet is: the casino keeps it and never reads it, and the developer's server settles the bet by it.

### `GameReceipt`

```ts
export interface GameReceipt {
  id: string;
  kind: 'casino-bet' | 'developer-bet' | 'payment';
  status: 'settled' | 'rejected' | 'open';
  stake?: string;
  prizes?: { rangeStart: string; rangeEnd: string; payout: string }[];
  meta?: Record<string, unknown>;
  group?: string;
  bet?: string;
  outcome?: string;
  payout?: string;
  reason?: string;
}
```

What a game learns about an operation, under its own `id`: how it ended, never the signed evidence. The
[receipt reference](../reference/bridge.md#receipt) says when each field is present.
