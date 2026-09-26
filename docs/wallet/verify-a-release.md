---
title: Verify a release
description: What the wallet checks each time it starts, and how to rebuild the contract and the wallet and compare them with what is deployed and served.
sidebar:
  order: 8
---

Everything a player has to trust is in this repository, so it can be rebuilt and compared with what runs. The wallet
checks the deployed contract itself every time it starts; the steps below check the wallet and the contract from their
sources.

## What the wallet checks on start

Before it funds anything, every time it starts, the wallet:

1. requires its RPC to be on the chain it is built for, Sepolia (11155111);
2. reads [`GET /api/config`](../casino-api/public.md#get-apiconfig) and requires the casino's `protocol` to equal its
   own, the hash of every signed structure and shared rule in [protocol.ts](../../protocol/protocol.ts), and the
   casino's chain, contract and owner to equal its pinned deployment; otherwise it starts in
   [recovery mode](backups-and-recovery.md#recovery-mode);
3. reads the code at the pinned contract address, at a block both of its RPCs agree on, and requires it to equal the
   runtime pinned in [client/contract-artifact.ts](../../client/contract-artifact.ts) with the immutable `owner` filled
   in, the owner to be the pinned operator, and the code's keccak-256 hash to match `runtimeHash` when the pin sets one;
4. requires `CHALLENGE_PERIOD()` to return 86400.

If the code or the owner differ, the wallet does not start. The pinned deployment is the `deployment` of the
configuration the wallet is built with, [config/production.json](../../config/production.json) for
https://play.hookedin.com, served as `/config.js` ([deployment](../reference/deployment.md)). The checks are in
[protocol/deployment.ts](../../protocol/deployment.ts) and [client/wallet.ts](../../client/wallet.ts).

## Reproduce the contract

```sh
npm ci
npm run compile
```

`npm run compile` compiles [contracts/](../../contracts/) with solc 0.8.37, the optimizer at 200 runs, the IR pipeline,
the Cancun EVM and no metadata hash, and fails if the runtime differs from the pin in `client/contract-artifact.ts`. It
writes the compiler input and output to `build/compile-input.json` and `build/contracts.json`. With no metadata hash in
the bytecode, the pin moves only when the compiled code does, never for a comment or a name. `npm run release:artifact`
rewrites the pin; maintainers run it after reviewing a contract change.

## Compare the served wallet

`npm run build` compiles the contract, checks the pin, and writes the wallet to `dist/`:

| File                                                          | Contents                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `main.js`, `main.js.map`                                      | Every wallet and protocol module, bundled by esbuild into one readable, unminified ES module, with its map |
| `vendor/ethers.js`                                            | Byte for byte the `dist/ethers.min.js` of the ethers release in `package-lock.json`                        |
| `config.js`                                                   | The deployment's settings, `export default { network, casino, deployment }`                                |
| `index.html`, `style.css`, `brand/`, `_headers`, `_redirects` | The page, its styles, the mark, the response headers and the rewrite for `/@alias` routes                  |

`main.js` imports exactly `/config.js` and `/vendor/ethers.js`, and a test holds it to that. The headers set
`script-src 'self'` and `frame-ancestors 'none'`. To check the served ethers and configuration:

```sh
curl -s https://play.hookedin.com/vendor/ethers.js | shasum -a 256
shasum -a 256 node_modules/ethers/dist/ethers.min.js
curl -s https://play.hookedin.com/config.js
```

The two hashes are equal, and `config.js` names the casino and the pinned deployment. To check `main.js`, build the
served commit with the production configuration and compare hashes.
[The deploy workflow](../../.github/workflows/deploy.yml) publishes every push to `main` whose tests pass, so the served
wallet is the latest such commit.

```sh
HOOKEDIN_CLIENT_CONFIG=config/production.json npm run build
curl -s https://play.hookedin.com/main.js | shasum -a 256
shasum -a 256 dist/main.js
```

## Package the sources

After `npm run build`, `npm run audit:package` checks the pin against the compiled runtime and the compiler input
against the current sources. It then copies the sources, the lockfile, the compiler input and output, and any test
reports in `build/`, into a fresh directory: `build/releases/<version>-<time>/` by default, or the directory given after
`--`. Its `source-manifest.json` holds the SHA-256 of every source file, of the compiler input and output, and of the
runtime pin, so a package records exactly what a release was made from.

## Run the tests

`npm test` needs Node 24.4 or later, Foundry's `anvil` on `PATH` (or named by `ANVIL_BIN`) and an installed Google
Chrome. It builds everything, type-checks every TypeScript source and test, checks the committed
[test vectors](../../vectors/bets.json) and the blackjack funding table, and runs every suite in [test/](../../test/),
[sdk/test/](../../sdk/test/), each game's `test/` and roulette's server. Chain-writing tests start disposable Anvil
deployments with [testing/contract.ts](../../testing/contract.ts), which signs evidence by hand, so the contract is
tested with no casino at all. The main suites:

| Suites                                                                                                 | What they hold                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel-contract`, `settlement-campaign`                                                              | Principal protection, retained debts, evidence checks, replay across channels and chains, the 2^128 bound, FIFO allocation, seeded campaigns against an independent cash-flow model, rejected recipients |
| `derivation`                                                                                           | The contract's `derive` and the TypeScript derivation agree on every operation kind and on invalid encodings                                                                                             |
| `risk`                                                                                                 | The commission search against exhaustive enumeration and an independent integer-root oracle, overlapping prizes, and that a signed operation binds every field and the deployment                        |
| `recovery-cli`, `transaction-journal`                                                                  | The CLI closes, challenges, finalizes and collects without the casino, the channel key or compiler output; the journal refuses a changed intent and latches a failed write                               |
| `client-network`, `client-observation`, `funding-history`, `wallet-history`, `rpc-timeout`, `activity` | Network pinning, stale observations pausing play, durable state across reloads, no signing after a failed write, replaced transactions, bounded reads of older channels, RPC timeouts                    |
| `iframe-bridge`, `game-log`                                                                            | The bridge answers only the bound frame, requires rising request IDs, serializes operations, bounds requests, and offers no signing or key methods                                                       |
| `static`                                                                                               | The built wallet is one module plus the untouched ethers and its configuration, every route sends `frame-ancestors 'none'`, and no other file is exposed                                                 |
| `browser`                                                                                              | Real IndexedDB and Web Locks in Chrome: atomic commits, encrypted backups, restore refusing a downgrade, and two tabs starting at once                                                                   |
| `conformance`                                                                                          | The stub casino that games are tested against behaves as the casino does                                                                                                                                 |
| `docs`                                                                                                 | Every bridge method, game error and SDK export has its entry in these docs, and every relative link resolves                                                                                             |

The casino service is private and has its own suite; its integration tests run the wallet from this repository against
the real service.
