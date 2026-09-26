---
title: Deployment
description: The chains, the services and their addresses, and how the wallet pins the deployment it trusts.
sidebar:
  order: 7
---

A deployment is one HookedInCasino contract on one chain, the casino service that signs for it, the wallet release
that pins it, and the games. This page says where each runs and how the wallet decides which deployment to trust. The
current contract is named in [config/production.json](../../config/production.json), and
https://hookedin.com/bankroll/ shows it live.

## Chains

| Chain   | Chain ID   | Confirmations | Use                                     |
| ------- | ---------- | ------------- | --------------------------------------- |
| Sepolia | `11155111` | 2             | The public deployment                   |
| Anvil   | `31337`    | 1             | A local chain for development and tests |

The wallet and the casino refuse any other chain. On Sepolia each of them reads the chain through two RPC endpoints on
different hosts, a primary and a witness, and accepts an observation only when both agree on the block; a local Anvil
chain needs one.

## Services

| Service    | Address                          | What it is                                                                                                              |
| ---------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Website    | https://hookedin.com             | The public site, with the [bankroll](https://hookedin.com/bankroll/) and [players](https://hookedin.com/players/) pages |
| Wallet     | https://play.hookedin.com        | A static site built from this repository, served by a Cloudflare Worker ([wrangler.jsonc](../../wrangler.jsonc))        |
| Casino API | https://casino.hookedin.com      | The casino service, one process behind a TLS proxy: the [Casino API](../casino-api/index.md)                            |
| Games      | `https://<id>-game.hookedin.com` | Each house game in [games/](../../games/), a Cloudflare Worker of its own; roulette's carries its server                |

A local stack runs the same services on `127.0.0.1`: an Anvil chain on port 8545, the casino on 4183, the wallet on
4184 (`npm run dev` serves the wallet alone) and the house games on 4185.

## How the wallet pins its deployment

A wallet release carries its configuration as `config.js`, built from the JSON file that `HOOKEDIN_CLIENT_CONFIG` names.
The production wallet is built from [config/production.json](../../config/production.json); without the variable the
build uses the defaults in [client/config.ts](../../client/config.ts): network `sepolia`, the casino at
`http://127.0.0.1:4183`, and no pinned deployment.

| Field                        | Type    | Meaning                                               |
| ---------------------------- | ------- | ----------------------------------------------------- |
| `network`                    | string  | `sepolia` or `local`: the chain the wallet requires   |
| `casino`                     | string  | The casino API's base URL                             |
| `deployment`                 | object  | The pinned deployment; optional                       |
| `deployment.chainId`         | string  | The chain ID, a decimal string                        |
| `deployment.contractAddress` | address | The HookedInCasino contract                           |
| `deployment.operator`        | address | The contract's `owner`, the casino's signing address  |
| `deployment.rpcUrl`          | string  | The primary RPC                                       |
| `deployment.witnessRpcUrl`   | string  | A second RPC on another host; required on Sepolia     |
| `deployment.runtimeHash`     | bytes32 | Optional: the keccak-256 of the deployed runtime code |

`config.js` is part of the release and holds nothing secret. A player can point a browser at another `network` or
`casino` in the wallet's settings; the pinned deployment still applies.

On start the wallet:

1. Reads [`GET /api/config`](../casino-api/public.md#get-apiconfig) and requires the chain it was built for, its own
   `protocol` ([the protocol revision](signed-messages.md#limits-and-the-protocol-revision)) and, when a deployment is
   pinned, the pinned contract and operator.
2. Reads the contract's code at a confirmed block through its RPCs, and requires the runtime pinned in the release with
   the `owner` filled in, the pinned address, chain and operator, and the pinned `runtimeHash` when there is one. It
   uses the release's ABI, never the casino's.
3. Saves the deployment it verified in the browser, under the chain and the casino URL, and holds later starts to it
   when the release pins none.

A wallet on Sepolia with neither a pinned deployment nor a saved one does not start.

When the casino is unreachable, answers with an error or malformed data, or reports another chain, contract, operator
or protocol, a wallet with a pinned deployment starts in **recovery mode**: play and cooperative closes are off,
while evidence import and export, unilateral closes, challenges and claims work against the pinned contract through the
pinned RPCs. A reload reconnects once the casino is back. A wallet with no pinned deployment and no working casino does
not start. [Backups and recovery](../wallet/backups-and-recovery.md) covers working without the casino.

## Where the current addresses are

- [config/production.json](../../config/production.json): the contract, its owner and the RPCs the production wallet
  pins, and the casino's URL. The casino service runs the deployment this file names and refuses a signing key that is
  not its operator, so the casino and the wallet release that pins it cannot disagree.
- [catalog.json](../../catalog.json): the house developer, `developer`, the account that publishes the house games as
  `@hookedin`, and `games`, each game's name and manifest URL. The casino publishes these in `@hookedin`'s profile as it
  starts.
- https://hookedin.com/bankroll/: the live contract and bankroll.
- The casino itself: `contractAddress`, `operator`, `chainId`, `protocol` and `developerProtocol` in
  [`GET /api/config`](../casino-api/public.md#get-apiconfig), and the commit it runs in
  [`GET /api/status`](../casino-api/public.md#get-apistatus).

## Changing the contract

A change to the contract's compiled code is another deployment: another contract at another address, a casino that starts
from an empty record for it, and a wallet release whose [config/production.json](../../config/production.json) pins
it. Players of the contract before it settle on-chain from their wallets' evidence. Once a release holds money that
matters, the contract stays as it is. [Verify a release](../wallet/verify-a-release.md) checks the served wallet and the
deployed code against this repository.
