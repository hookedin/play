---
title: JSON
description: Reference for @hookedin/play/sdk/json, which writes a game's own JSON with every bigint as a decimal string and reads it back strictly.
sidebar:
  order: 9
---

`import { json, plain, read } from '@hookedin/play/sdk/json';` is the JSON layer the wallet and the casino use, for a
game's own JSON: what a page saves in its storage, and what its server stores, sends and receives. Code holds every
whole number as a bigint; JSON holds it as a decimal string, and reads it back into a bigint in that one form or not at
all. The module is Node-safe. The bridge needs none of it: `postMessage` carries bigints as they are.

```ts
import { json, read } from '@hookedin/play/sdk/json';

localStorage.setItem(key, json({ id, stake })); // {"id":"…","stake":"100000000000000"}
const saved = read.object<{ id: string; stake: bigint }>({ id: read.text, stake: read.whole })(
  JSON.parse(localStorage.getItem(key)!),
); // saved.stake === 100000000000000n, or it throws
```

## Writing

### `json`

`json(value)`: `value` as JSON text, every bigint written as its decimal string. `JSON.stringify` throws on a bigint.

### `plain`

`plain(value)`: `value` as JSON holds it, every bigint a decimal string: `JSON.parse(json(value))`.

## Reading

### `read`

The readers. Each takes a value as `JSON.parse` gives it and returns it as code holds it, every whole number a bigint,
or throws an `Error` with `code` `invalid`: a value in any other form is refused, never read as something it might
mean.

| Reader                                                             | Takes                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `read.whole`                                                       | A whole number: a decimal string without a sign, a space or a leading zero, as a bigint          |
| `read.integer`                                                     | A whole number that may be below zero: the same, with a minus sign before any but zero           |
| `read.count`                                                       | A count, which JSON holds as a number: a safe integer, at least 0                                |
| `read.text`, `read.flag`, `read.time`                              | Well-formed text without a NUL; `true` or `false`; a time in Unix milliseconds                   |
| `read.hash`, `read.address`, `read.signature`                      | 32 bytes of lowercase hex; a checksummed address; a signature in the form the contract takes     |
| `read.uname`, `read.discordUsername`, `read.gameId`, `read.group`  | A uname, a Discord username, a game's ID, a group label                                          |
| `read.meta`                                                        | A developer bet's meta: a game's own JSON, within the [bounds](../reference/bridge.md#bounds)    |
| `read.exactly(test)`, `read.oneOf(...values)`                      | What `test` takes, as it is; one of `values`, exactly                                            |
| `read.optional(r)`, `read.nullable(r)`, `read.list(r, max)`        | `undefined`, `null` or what `r` reads; an array of at most `max`, each read by `r`               |
| `read.object({ field: r, ... })`                                   | An object of no field but those, each read by its reader, one that reads as `undefined` left out |
| `read.firstOf(...readers)`                                         | What the first of `readers` that takes it reads                                                  |
| `read.message(TYPES)`, `read.signed(TYPES)`                        | A message of an EIP-712 structure, every `uint` a bigint; it with its signature                  |
| `read.round`, `read.developerCasinoBet`, `read.publicDeveloperBet` | The casino's [`Round`](developer.md#round), a game's casino bet on it, a developer bet           |

[protocol/read.ts](../../protocol/read.ts) holds every reader, those of the protocol's own structures among them.
