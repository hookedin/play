# Verification

Use Node 24.4+, Foundry's `anvil` on `PATH` (or name the binary with `ANVIL_BIN`) and an installed Google Chrome. Install dependencies with `npm ci` before running:

```sh
npm test
```

`npm test` compiles the contract and checks it against the committed artifact, bundles the wallet into `dist/`, builds every game, type-checks all TypeScript source and tests, checks the committed vectors and the blackjack funding table, and runs the suites in [test/](../test/), [sdk/test/](../sdk/test/), each game's `games/<id>/test/` and roulette's host in [games/roulette/server/](../games/roulette/server/). `npm run typecheck` runs just the TypeScript checks, including the compile-time API tests in `test/protocol-types.ts`. Vectors check deterministic pricing and outcomes; `npm run vectors` regenerates [vectors/bets.json](../vectors/bets.json). Chain-writing tests use disposable Anvil deployments started by [testing/contract.ts](../testing/contract.ts), which also signs evidence by hand so the contract is tested without any casino service.

This repository tests what it contains: the contract, the shared protocol, the wallet, the player-side tools, the game SDK and the games. The casino service is private and has its own suite; its integration tests run the wallet from this repository against the real server, covering direct opening and activation, rejected bets and lost replies, hosted rounds, the bankroll fund, transfers, stale restores and dispute defence end to end.

## Coverage

The prototype contract targets Cancun or later and uses Solidity's IR optimizer
with 200 runs. Its reentrancy guard uses transient storage. The claim failure
tests check that nested collection is rejected while two consecutive calls in
the same transaction succeed and pay only once. Contract changes regenerate the
current pinned artifact; there are no compatibility artifacts or migration tests.

- Settlement (`channel-contract`, `settlement-campaign`): principal protection, retained debts, evidence verification, replay across channels and chains, the 2^128 balance bound, packed deadlines, FIFO allocation through allocation limits, seeded mixed-action campaigns checked against an independent cash-flow model, rejected recipients, forced ETH, the pinned runtime and signing domain, and gas measurements written to `build/settlement-gas.json`.
- Derivation (`derivation`): the contract's `derive` and the TypeScript `deriveState` agree on every operation kind and on invalid encodings.
- Risk and vectors (`risk`): the Kelly commission search against exhaustive enumeration and an independent integer-root oracle, exact arithmetic near uint256 limits, round admission over a shared outcome, prize tables with partial losses and overlapping prizes, and that a signed operation binds every field and the deployment domain.
- Recovery (`recovery-cli`, `transaction-journal`): the standalone CLI closes, challenges, finalizes and collects without the casino API, the channel key or compiler output; journal retries reject changed intent, latch persistence failures at every write boundary, and reject a canonical-branch change before committing.
- Wallet (`client-network`, `client-observation`, `funding-history`, `wallet-history`, `rpc-timeout`, `activity`): network pinning and the write guard, the disabled faucet outside explicit local development, stale observations pausing play, shared background observations, durable state across reloads, refusal to sign after a persistence failure, replaced injected transactions, bounded historical polling that prioritizes reorged active channels, RPC timeouts, and receipt summaries that never advertise an unconfirmed payment.
- Game boundary (`iframe-bridge`, `game-log`): the bridge accepts requests only from the bound iframe window, requires request IDs to rise, serializes operations, bounds the envelope structurally, rejects developer and wallet-field injection, and exposes no signing or key methods.
- Static build (`static`): the built wallet is one module plus the untouched ethers release and its configuration, every route carries `frame-ancestors 'none'`, client-side routes resolve to the page, and no other file is exposed.

Game rules, step pricing and game-side round storage are tested in [sdk/test/](../sdk/test/) and each game's `games/<id>/test/`, against [testing/game-wallet.ts](../testing/game-wallet.ts): a real wallet from this repository wired to an in-memory casino stub.

## Browser checks

`test/browser.test.ts`, part of `npm test`, runs the wallet's storage in the installed Google Chrome, headless, through playwright-core. It checks real IndexedDB and Web Locks, atomic commits, the persistence-failure latch, encrypted backups, restore downgrade rejection, export of the latest durable record, and synthetic historical wallet channels.

Games are framed with `allow-scripts allow-same-origin` everywhere; the wallet refuses manifests and entries on its own origin and its host sends `frame-ancestors 'none'`.

For the funding-account startup race the test opens two tabs on one origin with a fresh run ID. Both must report one retained funding account, the same selected address, 40 atomic updates and `passed: true`. The records and keys are separate from product wallet data.

The browser storage harness uses synthetic checkpoints. On-chain withdrawal is covered separately on Anvil. These checks do not automate a third-party wallet extension's approval popup.

## Reproducing a release

`npm run compile` fails when the compiled runtime differs from [client/contract-artifact.ts](../client/contract-artifact.ts) and writes the compiler input and output to `build/`. `npm run build` then produces `dist/`, whose `vendor/ethers.js` must hash to the same value as `node_modules/ethers/dist/ethers.min.js` at the version in `package-lock.json`. After a build, `npm run audit:package` copies sources, lockfile, compiler input/output and any reports in `build/` into a fresh directory under `build/releases/` with a SHA-256 manifest. Packaging hashes are provenance, not proof of independent review or infrastructure readiness. `npm run demo` prints a worked pricing example from the vectors and sends no transactions.

## Limits

Full wallet records grow with retained history; the wallet bounds its historical reads per poll and retains up to 100 activity receipts, as described in [the wallet](frontend.md). A saved report records one run, not a live performance guarantee.

The suite does not establish independently operated RPCs, the operator's storage or host-loss recovery, or an external security audit; no third-party audit has taken place. The casino controls availability and liquidity for private winnings. Users retain keys/evidence and must get stale-close challenges mined before the fixed 24-hour deadline.
