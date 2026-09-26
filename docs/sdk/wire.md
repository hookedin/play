---
title: Player names
description: Reference for @hookedin/play/sdk/wire, how a game page and its server write a player's names and scope saved state to one player.
sidebar:
  order: 8
---

`import { showName, playerScope } from '@hookedin/play/sdk/wire';` is what a game page and its own server share about a
player. The module is Node-safe. A player answers to two names: a **uname**, derived from their address and theirs for
good, written `~3byt9ocwnnzaxanmiz3stocj`; and, if they took one, an **alias**, what they are called today, written
`@Bob`. A game learns both from [`wallet.info`](../reference/bridge.md#walletinfo) and nothing else of the player;
[names and publishing](../wallet/names-and-publishing.md) gives their rules.

## Names and scope

### `PlayerNames`

```ts
export interface PlayerNames {
  uname?: string | null;
  alias?: string | null;
}
```

The two names a player answers to. [`WalletInfo`](hookedin.md#walletinfo) and
[`PublicDeveloperBet`](developer.md#publicdeveloperbet) both carry them.

### `showName`

```ts
export const showName: (names: PlayerNames | null | undefined) => string;
```

How a player is written: `@` and the alias when there is one, otherwise `~` and the uname, otherwise `—`.

```ts
showName({ uname: '3byt9ocwnnzaxanmiz3stocj', alias: 'Bob' }); // '@Bob'
showName({ uname: '3byt9ocwnnzaxanmiz3stocj', alias: null }); // '~3byt9ocwnnzaxanmiz3stocj'
```

### `playerScope`

```ts
export const playerScope: (
  names:
    | (PlayerNames & {
        chainId?: string;
      })
    | null
    | undefined,
  asset: string,
) => string;
```

What tells one player's saved state from another's: `<chainId>:<asset>:<uname>`, with `chain` for a missing chain ID
and `anonymous` for a missing uname, the uname in lower case. Games that share a host, accounts that share a browser,
and one player's ETH and test-coin play must not read each other's state, and an alias never changes the scope.
[`HookedIn.storageScope`](hookedin.md#storagescope) and [`RoundClient`](round.md#roundclient) key their storage with it.

```ts
playerScope({ uname: '3byt9ocwnnzaxanmiz3stocj', chainId: '11155111' }, 'eth'); // '11155111:eth:3byt9ocwnnzaxanmiz3stocj'
playerScope(null, 'test'); // 'chain:test:anonymous'
```
