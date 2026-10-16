---
title: Packages and imports
description: How a game installs @hookedin/play, and the import paths the SDK offers.
sidebar:
  order: 0
---

The SDK is part of the `@hookedin/play` package, which also holds the wallet, the contract and the house's games. It
ships as TypeScript source, so your editor shows every signature and doc comment; these pages say what each is for.

## Install

A game depends on play's `main` branch:

```json title="package.json"
{
  "dependencies": {
    "@hookedin/play": "git+https://github.com/hookedin/play.git#main"
  }
}
```

The [template](https://github.com/hookedin/game-template)'s workflow runs `npm update @hookedin/play` before it tests
and builds, so every deploy takes play's newest commit, and on `main` commits the lockfile it tested, which a local
install starts from. There are no versions and no tags: a push to play's `main` is the release.

- Node 26 or later.
- The SDK's modules are raw `.ts` files, with no compiled JavaScript and no declaration files.
  [`hookedin-game build`](../games/publishing.md#build) bundles a page with esbuild.
- TypeScript checks the SDK as source, as the template's `tsconfig.json` does: `module` and `moduleResolution`
  `NodeNext`, `allowImportingTsExtensions`, `noEmit`, `strict`, the `DOM` library.
- Node does not strip types from files inside `node_modules`, so a game's Node tests load the SDK through tsx
  ([testing](../games/testing.md#running-tests)).

## Entry points

Import each path on its own. A browser-only module touches `window` as it loads, so importing it in Node throws; a
Node-safe module imports anywhere.

| Import                                    | What it is                                                                                                                                                       | Runs                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `@hookedin/play/sdk/sdk`                  | [`HookedIn`](hookedin.md), the wallet bridge, and its types                                                                                                      | Browser only                          |
| `@hookedin/play/sdk/round`                | [`RoundClient`](round.md), a multi-step round as a sequence of casino bets                                                                                       | Node-safe                             |
| `@hookedin/play/sdk/engine`               | [The pricing engine](engine.md)                                                                                                                                  | Node-safe                             |
| `@hookedin/play/sdk/developer`            | [`createDeveloper`](developer.md), for a game's own server                                                                                                       | Node-safe; runs wherever `fetch` does |
| `@hookedin/play/sdk/steps`                | [Binary steps](steps.md), a shared draw backed with binary casino bets                                                                                           | Node-safe                             |
| `@hookedin/play/sdk/admits`               | [The casino's admission rule](admits.md), and a bet's measured return                                                                                            | Node-safe                             |
| `@hookedin/play/sdk/outcome`              | [The rule a round's outcome follows](outcome.md), and what a casino bet pays on it                                                                               | Node-safe                             |
| `@hookedin/play/sdk/synth`                | [`createSynth`](synth.md#createsynth), synthesized sound                                                                                                         | Node-safe; sound plays in a browser   |
| `@hookedin/play/sdk/json`                 | [The JSON layer](json.md): bigints written as decimal strings and read back strictly                                                                             | Node-safe                             |
| `@hookedin/play/testing/game-wallet.ts`   | [`gameWallet`](../games/testing.md#gamewallet), the real wallet against a stub casino                                                                            | Node                                  |
| `@hookedin/play/sdk/bin/hookedin-game.js` | `buildGame` and `serveGame`, the command's [build and serve](../games/publishing.md#build), and `createStaticServer`, which serves a built game as its host does | Node                                  |

The stylesheet [`shared.css`](synth.md#sharedcss) reaches a game through the build.
