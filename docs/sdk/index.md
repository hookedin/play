---
title: Packages and imports
description: How a game installs @hookedin/play, the import paths the SDK offers, and which of them run in Node.
---

The SDK is part of the `@hookedin/play` package, the repository that also holds the wallet, the contract and the
house's games. It is the wallet bridge, a helper for multi-step rounds, an exact pricing engine, a balance strip, sound,
the kit a game's server settles developer bets with, and a test wallet.

## Install

A game depends on play's `main` branch:

```json title="package.json"
{
  "dependencies": {
    "@hookedin/play": "git+https://github.com/hookedin/play.git#main"
  }
}
```

`package-lock.json` records the exact commit, so an install is reproducible, and `npm update @hookedin/play` moves the
game to the latest one. There are no versions and no tags: a push to play's `main` is the release. The
[template](https://github.com/hookedin/game-template) updates itself on a schedule; [publishing](../games/publishing.md)
describes its workflow.

- Node 24.4 or later.
- The package ships raw `.ts` files, with no compiled JavaScript and no declaration files. A game page is bundled with
  esbuild, which `hookedin-game build` runs ([CLI](../reference/cli.md)). The package's only dependencies are esbuild
  and ethers.
- TypeScript checks the SDK as source. The template's `tsconfig.json` (`module` and `moduleResolution` `NodeNext`,
  `allowImportingTsExtensions`, `noEmit`, `strict`, the `DOM` library) is a configuration that does.
- Node does not strip types from files inside `node_modules`, so a game's Node tests load the SDK through tsx:
  `node --import tsx --test test/*.test.ts`.

## Entry points

The table links each import path to its reference. A browser-only module touches `window` as it loads, so importing
it in Node throws; a Node-safe module imports anywhere.

| Import                                           | What it is                                                                         | Runs                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------- |
| `@hookedin/play/sdk/sdk`                         | [`HookedIn`](hookedin.md), the wallet bridge, and its types                        | Browser only                          |
| `@hookedin/play/sdk/round`                       | [`RoundClient`](round.md), a multi-step round as a sequence of casino bets         | Node-safe                             |
| `@hookedin/play/sdk/engine`                      | [The pricing engine](engine.md), with the blackjack and mines rules                | Node-safe                             |
| `@hookedin/play/sdk/generated/blackjack-funding` | [`blackjackFunding`](engine.md#blackjackfunding), precomputed blackjack prices     | Node-safe                             |
| `@hookedin/play/sdk/developer`                   | [`createDeveloper`](developer.md), for a game's own server                         | Node-safe; runs wherever `fetch` does |
| `@hookedin/play/sdk/admits`                      | [The casino's admission rule](admits.md), and a bet's measured return              | Node-safe                             |
| `@hookedin/play/sdk/outcome`                     | [`outcome`, `roundId`, `seedHash`](outcome.md), the rule a round's outcome follows | Node-safe                             |
| `@hookedin/play/sdk/wire`                        | [How a player is named](wire.md), shared by page and server                        | Node-safe                             |
| `@hookedin/play/sdk/bank`                        | [`mountBank`](bank-and-synth.md#mountbank), the balance strip                      | Browser only                          |
| `@hookedin/play/sdk/synth`                       | [`createSynth`](bank-and-synth.md#createsynth), synthesized sound                  | Node-safe; sound plays in a browser   |
| `@hookedin/play/sdk`                             | Everything a game page needs, in one import: see below                             | Browser only                          |
| `@hookedin/play/testing/game-wallet.ts`          | [`gameWallet`](game-wallet.md), the real wallet against a stub casino, for tests   | Node                                  |

The package maps `@hookedin/play/sdk/<path>` to `sdk/src/<path>.ts`, so a single engine file, such as
`@hookedin/play/sdk/engine/rational`, imports on its own too. Nothing else in the package can be imported; the
stylesheet [`shared.css`](bank-and-synth.md#sharedcss) reaches a game through the build.

## The barrel

`@hookedin/play/sdk` re-exports [sdk](hookedin.md), [round](round.md), [bank](bank-and-synth.md#mountbank),
[synth](bank-and-synth.md#createsynth), [admits](admits.md), [outcome](outcome.md) and [engine](engine.md). It leaves
out [developer](developer.md), [wire](wire.md) and the blackjack funding table. It is browser-only, because the bridge
is.

```ts
import { HookedIn, RoundClient, mountBank, createMines } from '@hookedin/play/sdk';
```

Code that runs in Node, such as a test or a game's server, imports the Node-safe paths on their own: the barrel loads
the bridge. The house's games and the template import every path on its own.
