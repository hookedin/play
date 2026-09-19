# HookedIn play

HookedIn runs casino games through signed off-chain player channels and a shared casino bankroll. Opening a channel deposits ETH and authorizes a local channel key in one transaction. After that, bets, game payments and switching games need no blockchain transactions: the wallet signs each bet, the casino signs the result, and the wallet verifies it and keeps the evidence. The channel settles on-chain when it closes. HookedIn v1 is a prototype on the Sepolia testnet. Mainnet is unsupported.

This repository is the wallet served at <https://play.hookedin.com>, the settlement contract, and the protocol code the wallet and the casino share.

## Why this repository is public

Everything a player has to trust is here, so it can be read, built and checked:

- the **wallet** ([client/](client/)), which holds the keys, signs exact wagers, verifies every result and rejection, and saves the evidence before showing an outcome;
- the **settlement contract** ([contracts/HookedInCasino.sol](contracts/HookedInCasino.sol)), which holds the deposits and decides what a closed channel is owed;
- the **shared protocol** ([protocol/](protocol/)): the signed structures, hashes, state derivation, risk rule and recovery logic;
- the **player-side tools**: an independent recovery CLI and a watchtower.

The casino service is private, and a player does not need to see it or trust its code. The wallet never takes the casino's word for a result: it checks the casino's signature, the revealed preimage against the round head the player signed, and the exact balance change, and it refuses anything else. With the saved evidence and an RPC of their choosing, a player can close a channel, challenge a stale close and collect a claim on-chain without the casino's API. The service consumes this repository as a pinned git submodule, so it always runs an exact public protocol revision.

## Trust model

Read this before depositing anything, including test ETH you care about.

- **One casino operator controls signing and the bankroll.** The deployer of the contract is its immutable owner and only settlement signer. It can create signed winnings claims for accounts it controls; the house bankroll is trusted to that owner, not protected from it.
- **Principal is protected; winnings are not.** While a channel is open its deposit is fully protected by the contract. At closure the contract protects `min(deposit, accepted balance)`: losses reduce what is returned. Anything above the deposit is winnings, an unsecured claim on the shared bankroll. Finalization records unpaid winnings permanently and pays them in FIFO order as cash arrives, but neither replenishment nor a payout deadline is guaranteed. Pool ETH visible on-chain does not prove that all private signed balances are covered. This is a [deliberate capital-efficiency choice](architecture.md#money-and-authority).
- **You must watch your channel.** Either side can start a unilateral close, and the casino could propose an older signed state. Anyone holding newer evidence can challenge within a fixed 24-hour window; challenges never extend it. If you miss it, an older, lower balance becomes final. Opening the wallet does not send a challenge: you press the button and get the transaction mined in time, or you run a [watchtower](#recover-without-the-casino). The casino's own watcher does not protect you from the casino.
- **The casino can withhold completion.** It can decline a wager, go offline, or never answer, without a protocol penalty. A rejection is a signed checkpoint that leaves balance and entropy unchanged, and an unanswered wager settles at the latest completed state. Verified results do not prove that every requested wager was completed without bias. Once a hash chain is exhausted it is published, and the wallet records what each rejected wager would have paid, so selective rejection is detectable afterwards, not prevented.
- **Hosted rounds trust the host and the casino not to collude.** When a game's host collects several players' bets on one outcome, the host chooses the seed. Neither host nor casino can choose the outcome alone; together they could. The wallet asks before a game may place hosted bets and marks those receipts.
- **Match stakes and fund shares are the casino's promise.** A stake in an open match has left your protected balance and is held in escrow by the casino; the oracle you chose can only move the pot between the seats. The bankroll fund is a trust arrangement: shares are signed statements, the casino alone states the price, and it could take the money. The design gives proof of what you hold, not protection.
- **Games are not certified.** The wallet verifies each signed bet as a whole prize table. It does not check a game's advertised rules, how steps combine into a whole game, or the assets a game serves.
- **No third-party audit has taken place.** The tests establish software behaviour only. Contracts, signed messages, APIs and storage formats may change without migration; prototype deployments and data are disposable.

[architecture.md](architecture.md) states the design and these assumptions in full.

## What is here

| Path                                       | Contents                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [client/](client/)                         | The wallet: channel, funding accounts, storage, backups, activity, the game iframe bridge, the pinned contract artifact, default settings and the static host's `_headers` |
| [contracts/](contracts/)                   | `HookedInCasino.sol` and two contracts used only by tests                                                                                                                  |
| [protocol/](protocol/)                     | Signed structures and hashing, types, the risk rule, hash chains, chain observation, deployment verification, evidence recovery, transaction journal and dispute worker    |
| [scripts/](scripts/)                       | Compile and build, the local static server, the recovery CLI (`verify-evidence.ts`), the watchtower, test vectors, release packaging, a pricing demo and browser checks    |
| [reference/oracle.ts](reference/oracle.ts) | A reference match oracle: the referee host of two-player rock paper scissors                                                                                               |
| [testing/](testing/)                       | `contract.ts`: Anvil, a deployment and hand-signed evidence. `game-wallet.ts`: a real wallet wired to an in-memory casino stub, used by game developers' tests             |
| [test/](test/)                             | Contract behaviour, agreement between the TypeScript and contract derivations, the recovery CLI, wallet, iframe bridge, risk and vectors, journal, static build            |
| [vectors/bets.json](vectors/bets.json)     | Committed vectors for pricing, hash chains and outcomes                                                                                                                    |
| [catalog.json](catalog.json)               | The listed games, as absolute manifest URLs                                                                                                                                |
| [docs/](docs/)                             | [Protocol](docs/protocol.md), [economics](docs/economics.md), [wallet](docs/frontend.md), [recovery](docs/request-evidence.md), [verification](docs/verification.md)       |
| [brand/](brand/)                           | The HookedIn mark                                                                                                                                                          |

## Quick start

Requires Node **24.4 or later** and npm. Node runs the TypeScript sources directly; nothing is emitted by `tsc`. The tests also need Foundry's `anvil` on `PATH`.

```sh
npm ci
npm run build    # compile the contract, check the pinned artifact, bundle the wallet into dist/
npm run dev      # build, then serve dist/ at http://127.0.0.1:4184
npm test         # build, type-check, check the vectors, run the test suite (needs anvil)
```

`npm run dev` serves the wallet only. Without `HOOKEDIN_CLIENT_CONFIG` the build ships the defaults in [client/config.ts](client/config.ts), which expect a casino service at `http://127.0.0.1:4183` and a game catalog at `http://127.0.0.1:4185`; settings saved in the wallet override them. Playing needs a casino service. When none answers, or it advertises another chain, contract or owner, a wallet whose configuration pins a `deployment` starts in recovery mode: evidence import and export, unilateral close, challenge and claims work, play does not. A wallet with no pinned deployment and no casino cannot start. `PORT` moves the static server.

Other commands: `npm run typecheck`, `npm run vectors` (regenerate the vectors), `npm run demo` (print a worked pricing example; sends no transactions), `npm run test:browser` (serve the in-browser storage checks described in [verification](docs/verification.md#browser-checks)), `npm run format`.

## Verify a release

1. **Reproduce the contract bytecode.** `npm ci && npm run compile` compiles [contracts/](contracts/) with the pinned `solc` (optimizer, 200 runs, IR pipeline, Cancun) and fails if the result differs from the runtime pinned in [client/contract-artifact.ts](client/contract-artifact.ts). The compiler input and output are written to `build/`. On start the wallet reads the deployed code through its RPCs and compares it with that pin, with the immutable owner filled in; it refuses to fund an unrecognized contract, a different owner or a different address than its configuration pins ([protocol/deployment.ts](protocol/deployment.ts)).
2. **Compare the served files with your build.** `dist/main.js` is one readable module with a source map. It imports exactly two other files: `/config.js`, which should hold the deployment you expect, and `/vendor/ethers.js`, which is byte-identical to `dist/ethers.min.js` of the ethers version in [package-lock.json](package-lock.json). A test checks both; to check the deployed site yourself:

   ```sh
   curl -s https://play.hookedin.com/vendor/ethers.js | shasum -a 256
   shasum -a 256 node_modules/ethers/dist/ethers.min.js
   ```

3. **Package the sources.** After `npm run build`, `npm run audit:package` copies the sources, lockfile, compiler input and output into a fresh directory under `build/releases/` with a manifest of SHA-256 hashes. The hashes are provenance, not proof of review.

`npm run release:artifact` replaces the pinned artifact. It is for maintainers, after reviewing a contract change.

## Recover without the casino

Export channel evidence from the wallet regularly, and keep an encrypted wallet backup. The evidence bundle holds the on-chain opening identity and the minimal signed proof; it contains no keys.

```sh
npm run recover -- channel.json --rpc URL --action inspect
HOOKEDIN_RECOVERY_KEY=0x... npm run recover -- channel.json --rpc URL --action start
npm run watchtower -- --deployment trusted.json --evidence channel.json --journal .private/watchtower.json
```

The recovery CLI supports `inspect`, `start`, `challenge`, `finalize` and `claim` with no casino API and no channel key. Writes need a gas-paying key; starting a close needs the original funding key. The watchtower re-reads one evidence file, verifies the deployment against a manifest you trust, and challenges a stale close from a separately funded `HOOKEDIN_RELAYER_KEY`; outside Anvil it requires two independent RPCs. It is only as current as the evidence file you give it. See [recovery](docs/request-evidence.md).

## Related repositories

- [hookedin/game-sdk](https://github.com/hookedin/game-sdk): the wallet bridge, round helper and exact step pricing for game developers, with the [SDK guide](https://github.com/hookedin/game-sdk/blob/main/docs/game-sdk.md). It depends on this repository for the risk rule and the test wallet.
- [hookedin/game-template](https://github.com/hookedin/game-template): a starting point for a new game.
- The listed games, each its own static site at `https://<id>-game.hookedin.com`: [samson](https://github.com/hookedin/game-samson), [plinko](https://github.com/hookedin/game-plinko), [dice](https://github.com/hookedin/game-dice), [blackjack](https://github.com/hookedin/game-blackjack), [mines](https://github.com/hookedin/game-mines) and [rps](https://github.com/hookedin/game-rps).
- The casino service (bet server, channel store, signing history, admission, dispute defence) is private. It pins this repository as a git submodule, and its integration tests run the wallet from this repository against the real server.
- The website at <https://hookedin.com> is private.

## Deploy

The wallet is a static site. Pushing to `main` releases it: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs the whole test suite, builds with `HOOKEDIN_CLIENT_CONFIG=config/production.json`, and publishes `dist/` to Cloudflare with `wrangler deploy`, as the static-assets Worker described in [wrangler.jsonc](wrangler.jsonc) (the successor to Cloudflare Pages). The workflow needs the repository secret `CLOUDFLARE_API_TOKEN` (from Cloudflare's **Edit Cloudflare Workers** template) and the variable `CLOUDFLARE_ACCOUNT_ID`; without the token it still tests and builds.

To publish by hand: `HOOKEDIN_CLIENT_CONFIG=config/production.json npm run build && npx wrangler deploy`.

Client-side routes (`/wallet`, `/activity`, `/games/<id>`) rely on the single-page fallback set in `wrangler.jsonc`. `dist/_headers` carries the Content-Security-Policy and `frame-ancestors 'none'`; any other host must send the same headers and serve `index.html` for unknown paths.

The operator commits `config/production.json`. It is published as `config.js`, so it is part of the trusted wallet release and must contain nothing secret:

```json
{
  "network": "sepolia",
  "casino": "https://CASINO_API_ORIGIN",
  "games": "https://play.hookedin.com",
  "deployment": {
    "chainId": 11155111,
    "contractAddress": "0xCONTRACT_ADDRESS",
    "operator": "0xCONTRACT_OWNER_ADDRESS",
    "rpcUrl": "https://FIRST_SEPOLIA_RPC",
    "witnessRpcUrl": "https://SECOND_INDEPENDENT_SEPOLIA_RPC"
  }
}
```

The committed [config/production.json](config/production.json) pins the current Sepolia deployment.

`games` is the base URL that serves `catalog.json`; the build copies [catalog.json](catalog.json) into `dist/`, so the wallet's own origin works. `deployment` pins the chain, contract and owner independently of whatever the casino API reports, and lets a fresh browser start in recovery mode while the casino is unreachable. An optional `runtimeHash` additionally pins the keccak-256 hash of the deployed code.

## Contributing

Read [AGENTS.md](AGENTS.md) first: simplicity is the governing constraint, and this prototype keeps no compatibility paths. Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Copyright (c) 2026 HookedIn.
