---
title: Deployment and releases
description: The chains, the services and their addresses, how the wallet pins the deployment it trusts, and how to check a release against this repository.
sidebar:
  order: 5
---

A deployment is one HookedInCasino contract on one chain, the casino service that signs for it, the wallet release
that pins it, and the games. The current contract is named in [config/production.json](../../config/production.json),
its source is
[verified on Etherscan](https://etherscan.io/address/0x4F1008A8617dfb0353B1cd03C398066C55f83b7C#code), and
https://hookedin.com/bankroll/ shows it live.

## Chains

| Chain    | Chain ID | Confirmations | Use                                     |
| -------- | -------- | ------------- | --------------------------------------- |
| Ethereum | `1`      | 2             | The public deployment                   |
| Anvil    | `31337`  | 1             | A local chain for development and tests |

The wallet and the casino refuse any other chain. On Ethereum each of them reads the chain through two RPC endpoints on
different hosts, a primary and a witness, and accepts an observation only when both agree on the block; a local Anvil
chain needs one.

## Services

| Service    | Address                          | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website    | https://hookedin.com             | The public site, with the [bankroll](https://hookedin.com/bankroll/) page                                                                                                                                                                                                                                                                                                                                                                   |
| Wallet     | https://play.hookedin.com        | A static site built from this repository, served by a Cloudflare Worker ([wrangler.jsonc](../../wrangler.jsonc))                                                                                                                                                                                                                                                                                                                            |
| Casino API | `https://casino.hookedin.com`    | The casino service, one process behind a TLS proxy: the [Casino API](../casino-api/index.md)                                                                                                                                                                                                                                                                                                                                                |
| Games      | `https://<id>-game.hookedin.com` | Each house game, a Cloudflare Worker of its own: dice, mines, plinko and samson from [games/](../../games/), blackjack from [hookedin/game-blackjack](https://github.com/hookedin/game-blackjack), roulette and crash with their servers from [hookedin/game-roulette](https://github.com/hookedin/game-roulette) and [hookedin/game-crash](https://github.com/hookedin/game-crash), not yet published at the casino, so neither takes bets |

A local stack runs the same services on `127.0.0.1`: an Anvil chain on port 8545, the casino on 4183, the wallet on
4184 (`npm run dev` serves the wallet alone) and the games in [games/](../../games/) on 4187, apart from 4185, where
`hookedin-game serve` serves a game of your own.

## How the wallet pins its deployment

A wallet release carries its configuration as `config.js`, built from
[config/production.json](../../config/production.json); a local launcher serves its own. `config.js` is part of the
release and holds nothing secret.

| Field                        | Type    | Meaning                                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------------------------- |
| `network`                    | string  | `mainnet` or `local`: the chain the wallet requires                          |
| `casino`                     | string  | The casino API's base URL                                                    |
| `deployment`                 | object  | The pinned deployment                                                        |
| `deployment.chainId`         | string  | The chain ID, a decimal string                                               |
| `deployment.contractAddress` | address | The HookedInCasino contract                                                  |
| `deployment.operator`        | address | The contract's `signer`, the casino's signing address                        |
| `deployment.block`           | number  | The block the contract was deployed in, from which the casino reads its logs |
| `deployment.rpcUrl`          | string  | The primary RPC                                                              |
| `deployment.witnessRpcUrl`   | string  | A second RPC on another host; required on Ethereum                           |

On start the wallet:

1. reads [`GET /api/config`](../casino-api/public.md#get-apiconfig) and requires the chain it was built for, its own
   `protocol` ([the protocol revision](signed-messages.md#bounds-and-the-protocol-revision)) and the pinned contract and
   operator; otherwise it starts in [recovery mode](../wallet/keys-and-recovery.md#recovery-mode);
2. loads its saved account, so the game library works from here on: it needs nothing from the chain;
3. meanwhile, checks the deployment: it reads the code at the pinned address, at a confirmed block both of its RPCs
   agree on, and requires the runtime pinned in [client/contract-artifact.ts](../../client/contract-artifact.ts) with
   the immutables `signer` and `treasury` filled in, and that signer to be the pinned operator.

Everything with ETH, such as a deposit, a bet or a close, waits for that check. One that fails is shown in a banner, and
nothing with ETH goes ahead until a reload checks again. On Ethereum the check requires a pinned deployment; a local
build without one takes the casino's word for its contract. The checks are in
[protocol/deployment.ts](../../protocol/deployment.ts) and [client/wallet.ts](../../client/wallet.ts).

## Where the current addresses are

- [config/production.json](../../config/production.json): the contract, the block it was deployed in, its signer and the
  RPCs the production wallet pins, and the casino's URL. The casino service runs the deployment this file names and
  refuses a signing key that is not its operator, so the casino and the wallet release that pins it cannot disagree.
- [catalog.json](../../catalog.json): the house developer, `developer`, the account that publishes the house games as
  `@hookedin`, and `games`, each game's name, such as `Dice` at `@hookedin/dice`, and its
  [URL](../games/publishing.md#the-games-url). The casino publishes these in `@hookedin`'s profile as it starts.
  `trusted` lists the other developers whose games' developer bets take a deposit before the chain finalizes it, as
  the house's do ([operations](../casino-api/channels.md#post-apichannelsidoperations)).
- The casino itself: `contractAddress`, `operator`, `chainId`, `protocol` and `developerProtocol` in
  [`GET /api/config`](../casino-api/public.md#get-apiconfig), and the commit it runs in
  [`GET /api/status`](../casino-api/public.md#get-apistatus).

## Verify a release

Everything a player has to trust is in this repository, so a release can be rebuilt and compared with what runs.

**The contract.** After `npm ci`, `npm run compile` compiles [contracts/](../../contracts/) with solc 0.8.37, the
optimizer at 200 runs, the IR pipeline, the Cancun EVM and no metadata hash, and fails if the runtime differs from the
pin in `client/contract-artifact.ts`. It writes the compiler input and output to `build/compile-input.json` and
`build/contracts.json`. Etherscan compiled the same input, with the contract its only source, to the code at the
contract's address. With no metadata hash in the bytecode, the pin moves only when the compiled code does, never for
a comment or a name. `npm run release:artifact` rewrites the pin; maintainers run it after reviewing a contract change.

**The served wallet.** `npm run build` compiles the contract, checks the pin, and writes the wallet to `dist/`:

| File                                                          | Contents                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `main.js`, `main.js.map`                                      | Every wallet and protocol module, bundled by esbuild into one readable, unminified ES module, with its map |
| `vendor/ethers.js`                                            | Byte for byte the `dist/ethers.min.js` of the ethers release in `package-lock.json`                        |
| `config.js`                                                   | The deployment's settings, `export default { network, casino, deployment }`                                |
| `index.html`, `style.css`, `brand/`, `_headers`, `_redirects` | The page, its styles, the mark, the response headers and the rewrite for `/@username` routes               |

`main.js` imports exactly `/config.js` and `/vendor/ethers.js`, and a test holds it to that. The headers set
`script-src 'self'` and `frame-ancestors 'none'`. [The deploy workflow](../../.github/workflows/deploy.yml) publishes
every push to `main` whose tests pass, so the served wallet is the latest such commit. Built from that commit with the
production configuration, the two ethers hashes are equal, `config.js` names the casino and the pinned deployment, and
`main.js` hashes the same as the served one:

```sh
curl -s https://play.hookedin.com/vendor/ethers.js | shasum -a 256
shasum -a 256 node_modules/ethers/dist/ethers.min.js
curl -s https://play.hookedin.com/config.js
npm run build
curl -s https://play.hookedin.com/main.js | shasum -a 256
shasum -a 256 dist/main.js
```

**The tests.** `npm test` needs Node 26 or later, Foundry's `anvil` on `PATH` (or named by `ANVIL_BIN`) and an
installed Google Chrome. It builds everything, type-checks every source and test, checks the committed
[test vectors](../../vectors/protocol.json), and runs every suite in [test/](../../test/), [sdk/test/](../../sdk/test/)
and each game's `test/`. The contract's suites deploy it on disposable Anvil chains and sign evidence by hand
([testing/contract.ts](../../testing/contract.ts)), so it is tested with no casino at all; the casino's private suite
runs this wallet against the real service.

## Changing the contract

The contract stays as it is. A change to its compiled code is another deployment: another contract at another address,
a casino that starts from an empty record for it, and a wallet release that pins it. One is made only to fix something
that puts money at risk, after players are told, and once the casino can keep defending the contract it replaces until
every channel on it is final. Players of that contract take their balances out of it on-chain, with their wallets'
evidence.
