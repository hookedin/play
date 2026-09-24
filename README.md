# HookedIn play

HookedIn runs casino games through signed off-chain player channels and a shared casino bankroll. Opening a channel deposits ETH and authorizes a local channel key in one transaction. After that, bets, game payments and switching games need no blockchain transactions: the wallet signs each bet, the casino signs the result, and the wallet verifies it and keeps the evidence. The channel settles on-chain when it closes. Every wallet also has a channel of the casino's test coins, which needs no deposit and never reaches the chain. HookedIn v1 is a prototype on the Sepolia testnet. Mainnet is unsupported.

This repository is the wallet served at <https://play.hookedin.com>, the settlement contract, the protocol code the wallet and the casino share, the game SDK and the house's games.

## Why this repository is public

Everything a player has to trust is here, so it can be read, built and checked:

- the **wallet** ([client/](client/)), which holds the keys, signs exact wagers, verifies every result and rejection, and saves the evidence before showing an outcome;
- the **settlement contract** ([contracts/HookedInCasino.sol](contracts/HookedInCasino.sol)), which holds the deposits and decides what a closed channel is owed;
- the **shared protocol** ([protocol/](protocol/)): the signed structures, hashes, state derivation, risk rule and recovery logic;
- the **player-side tools**: an independent recovery CLI and a watchtower.

The casino service is private, and a player does not need to see it or trust its code. The wallet never takes the casino's word for a result: it checks the casino's signature, the revealed secret against the round the player signed, and the exact balance change, and it refuses anything else. With the saved evidence and an RPC of their choosing, a player can close a channel, challenge a stale close and collect a claim on-chain without the casino's API. The service consumes this repository as a pinned git submodule, so it always runs an exact public protocol revision.

## Trust model

Read this before depositing anything you care about.

- **One casino operator controls signing and the bankroll.** The deployer of the contract is its immutable owner and only settlement signer. It can create signed winnings claims for accounts it controls; the house bankroll is trusted to that owner, not protected from it.
- **Principal is protected; winnings are not.** While a channel is open its deposit is fully protected by the contract. At closure the contract protects `min(deposit, accepted balance)`: losses reduce what is returned. Anything above the deposit is winnings, an unsecured claim on the shared bankroll. Finalization records unpaid winnings permanently and pays them in FIFO order as cash arrives, but neither replenishment nor a payout deadline is guaranteed. Pool ETH visible on-chain does not prove that all private signed balances are covered. This is a [deliberate capital-efficiency choice](architecture.md#money-and-authority).
- **Test coins are not money.** A test channel is opened at the casino alone: no deposit, nothing on-chain, nothing to close, challenge or collect. A wallet that has deposited nothing plays with them, and the faucet fills its channel with the casino's own coins.
- **You must watch your channel.** Either side can start a unilateral close, and the casino could propose an older signed state. Anyone holding newer evidence can challenge within a fixed 24-hour window; challenges never extend it. If you miss it, an older, lower balance becomes final. Opening the wallet does not send a challenge: you press the button and get the transaction mined in time, or you run a [watchtower](#recover-without-the-casino). The casino's own watcher does not protect you from the casino.
- **The casino can withhold completion.** It can decline a wager, go offline, or never answer, without a protocol penalty. A rejection is a signed checkpoint that leaves balance and entropy unchanged, and an unanswered wager settles at the latest completed state. Verified results do not prove that every requested wager was completed without bias. A declined round is revealed with its rejection, and the wallet records at once what the wager would have paid, so selective rejection is visible on the receipt, not prevented.
- **Bets that settle later trust their referee, and the casino holds them.** A game's referee, its developer's own key, draws its players' bets on one outcome, fixed before any of them is placed: the casino names the round and the referee commits its seed to it first, so nobody can change the outcome and neither knows it alone. The casino takes each bet against the bankroll as it is placed, and the draw pays every bet it took. Together casino and referee could know the outcome and decline winning bets as they come; a declined bet can be checked against the round's draw, which is public. The referee chooses when, never what a drawn bet pays. A bet with terms pays what its referee signs, from the developer's bank. A bet's stake leaves the channel when it is placed, and what it pays, or refunds if nobody settles it by its deadline, is the casino's promise until the wallet collects it: until then it is outside the principal the contract protects. Each bet's receipt says whose word it rests on.
- **Fund shares are the casino's promise.** The bankroll fund is a trust arrangement: shares are signed statements, the casino alone states the price, and it could take the money. The design gives proof of what you hold, not protection.
- **Games are not certified, and a game can waste what it is given.** The wallet verifies each signed bet as a whole prize table and records the return of every bet it signs, but it does not refuse a bet for paying back little: a game can spend its whole spending limit that way. The limit you set is your protection. The wallet does not check a game's advertised rules, how steps combine into a whole game, or the assets a game serves.
- **Playing a game trusts its developer:** for its tables in any game, and in a game with a referee for its outcomes and its payments. A developer's bank reserves nothing: whether a developer can pay what its referee settles, and proving it, is between the developer and its players, outside HookedIn.
- **No third-party audit has taken place.** The tests establish software behaviour only. Contracts, signed messages, APIs and storage formats may change without migration; prototype deployments and data are disposable.

[architecture.md](architecture.md) states the design and these assumptions in full.

## What is here

| Path                                   | Contents                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [client/](client/)                     | The wallet: channel, funding accounts, storage, backups, activity, the game iframe bridge, the pinned contract artifact, default settings and the static host's `_headers`       |
| [contracts/](contracts/)               | `HookedInCasino.sol` and two contracts used only by tests                                                                                                                        |
| [protocol/](protocol/)                 | Signed structures and hashing, types, the risk rule, chain observation, deployment verification, evidence recovery, transaction journal and dispute worker                       |
| [sdk/](sdk/)                           | The game SDK, `@hookedin/play/sdk`: the wallet bridge, round helper, exact step pricing, the referee kit, the `hookedin-game` build tool and the [guide](sdk/docs/game-sdk.md)   |
| [games/](games/)                       | The house's games: [samson](games/samson/), [plinko](games/plinko/), [dice](games/dice/), [blackjack](games/blackjack/), [mines](games/mines/), [roulette](games/roulette/)      |
| [scripts/](scripts/)                   | Compile and build, the local static server, the recovery CLI (`verify-evidence.ts`), the watchtower, test vectors, release packaging and a pricing demo                          |
| [testing/](testing/)                   | `contract.ts`: Anvil, a deployment and hand-signed evidence. `game-wallet.ts`: a real wallet on an in-memory casino stub for game tests, held to the casino by `conformance.ts`  |
| [test/](test/)                         | Contract behaviour, agreement between the TypeScript and contract derivations, the recovery CLI, wallet, iframe bridge, risk and vectors, journal, static build, browser storage |
| [vectors/bets.json](vectors/bets.json) | Committed vectors for pricing and outcomes                                                                                                                                       |
| [catalog.json](catalog.json)           | The games `@hookedin` publishes, by name, with the referee of each that has one: the library a deployment ships with                                                             |
| [docs/](docs/)                         | [Protocol](docs/protocol.md), [economics](docs/economics.md), [wallet](docs/frontend.md), [recovery](docs/request-evidence.md), [verification](docs/verification.md)             |
| [brand/](brand/)                       | The HookedIn mark                                                                                                                                                                |

## Quick start

Requires Node **24.4 or later** and npm. Node runs the TypeScript sources directly; nothing is emitted by `tsc`. The tests also need Foundry's `anvil` on `PATH` and an installed Google Chrome.

```sh
npm ci
npm run build    # compile the contract, check the pinned artifact, bundle the wallet into dist/ and each game into games/<id>/dist/
npm run dev      # build, then serve dist/ at http://127.0.0.1:4184
npm test         # build, type-check, check the vectors and the blackjack funding table, run every test suite (needs anvil and Chrome)
```

`npm run dev` serves the wallet only. Without `HOOKEDIN_CLIENT_CONFIG` the build ships the defaults in [client/config.ts](client/config.ts), which expect a casino service at `http://127.0.0.1:4183`; settings saved in the wallet override them. The game library comes from the casino: it is what `@hookedin` publishes. Playing needs a casino service. When none answers, or it advertises another chain, contract or owner, a wallet whose configuration pins a `deployment` starts in recovery mode: evidence import and export, unilateral close, challenge and claims work, play does not. A wallet with no pinned deployment and no casino cannot start. `PORT` moves the static server.

To work on a game, `node sdk/bin/hookedin-game.js serve games/<id>` serves it at `http://127.0.0.1:4185` and builds it again on every page load; add `http://127.0.0.1:4185/manifest.json` as a custom game in any wallet.

Other commands: `npm run typecheck`, `npm run vectors` (regenerate the vectors), `npm run generate:blackjack` (regenerate the blackjack funding table), `npm run demo` (print a worked pricing example; sends no transactions), `npm run demo:blackjack` and `npm run demo:mines` (trace a priced game with simulated bets), `npm run format`.

## Verify a release

1. **Reproduce the contract bytecode.** `npm ci && npm run compile` compiles [contracts/](contracts/) with the pinned `solc` (optimizer, 200 runs, IR pipeline, Cancun) and fails if the result differs from the runtime pinned in [client/contract-artifact.ts](client/contract-artifact.ts). The compiler input and output are written to `build/`. On start the wallet reads the deployed code through its RPCs and compares it with that pin, with the immutable owner filled in; it refuses to fund an unrecognized contract, a different owner or a different address than its configuration pins ([protocol/deployment.ts](protocol/deployment.ts)).
2. **Compare the served files with your build.** `dist/main.js` is one readable module with a source map. It imports exactly two other files: `/config.js`, which should hold the deployment you expect, and `/vendor/ethers.js`, which is byte-identical to `dist/ethers.min.js` of the ethers version in [package-lock.json](package-lock.json). A test checks both; to check the deployed site yourself:

   ```sh
   curl -s https://play.hookedin.com/vendor/ethers.js | shasum -a 256
   shasum -a 256 node_modules/ethers/dist/ethers.min.js
   ```

3. **Package the sources.** After `npm run build`, `npm run audit:package` copies the sources, lockfile, compiler input and output into a fresh directory under `build/releases/` with a manifest of SHA-256 hashes. The hashes are provenance, not proof of review.

`npm run release:artifact` writes the pinned artifact afresh. It is for maintainers, after reviewing a contract change.

## Recover without the casino

Export channel evidence from the wallet regularly, and keep an encrypted wallet backup. The evidence bundle holds the on-chain opening identity and the minimal signed proof; it contains no keys.

```sh
npm run recover -- channel.json --rpc URL --action inspect
HOOKEDIN_RECOVERY_KEY=0x... npm run recover -- channel.json --rpc URL --action start
npm run watchtower -- --deployment trusted.json --evidence channel.json --journal .private/watchtower.json
```

The recovery CLI supports `inspect`, `start`, `challenge`, `finalize` and `claim` with no casino API and no channel key. Writes need a gas-paying key; starting a close needs the original funding key. The watchtower re-reads one evidence file, verifies the deployment against a manifest you trust, and challenges a stale close from a separately funded `HOOKEDIN_RELAYER_KEY`; outside Anvil it requires two independent RPCs. It is only as current as the evidence file you give it. See [recovery](docs/request-evidence.md).

## Related repositories

- [hookedin/game-template](https://github.com/hookedin/game-template): a starting point for a new game in its own repository. It installs `@hookedin/play` from `main`.
- The casino service (bet server, channel store, signing history, admission, dispute defence) is private. It pins this repository as a git submodule, and its integration tests run the wallet from this repository against the real server.
- The website at <https://hookedin.com> is private.

## Deploy

The wallet is a static site. Pushing to `main` releases it: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs the whole test suite, builds with `HOOKEDIN_CLIENT_CONFIG=config/production.json`, and publishes `dist/` to Cloudflare with `wrangler deploy`, as the static-assets Worker described in [wrangler.jsonc](wrangler.jsonc) (the successor to Cloudflare Pages). It then publishes each game from its own folder, as the Worker its `wrangler.jsonc` describes, at `https://<id>-game.hookedin.com`. The workflow needs the repository secret `CLOUDFLARE_API_TOKEN` (from Cloudflare's **Edit Cloudflare Workers** template) and the variable `CLOUDFLARE_ACCOUNT_ID`; without the token it still tests and builds.

Roulette plays many players against the house on one [draw](docs/protocol.md#bets-that-settle-later) per spin, and ships its page and its referee as one Cloudflare Worker. The rest are static pages. The referee's key is a secret, set once from `games/roulette` with `npx wrangler secret put REFEREE_KEY`, and its address is roulette's `referee` in [catalog.json](catalog.json).

To publish the wallet by hand: `HOOKEDIN_CLIENT_CONFIG=config/production.json npm run build && npx wrangler deploy`. To publish a game: `node sdk/bin/hookedin-game.js build games/<id>`, then `npx wrangler deploy` from `games/<id>`.

Client-side routes (`/account`, `/wallet`, `/games`, `/bets`, `/bankroll`, `/settings`, `/activity`, `/games/<key>`, `/@<alias>/<game>`) rely on the single-page fallback set in `wrangler.jsonc`. `dist/_headers` carries the Content-Security-Policy and `frame-ancestors 'none'`; any other host must send the same headers and serve `index.html` for unknown paths.

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

`deployment` pins the chain, contract and owner independently of whatever the casino API reports, and lets a fresh browser start in recovery mode while the casino is unreachable. An optional `runtimeHash` additionally pins the keccak-256 hash of the deployed code.

## Contributing

Read [AGENTS.md](AGENTS.md) first: simplicity is the governing constraint, and this prototype keeps no compatibility paths. Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Copyright (c) 2026 HookedIn.
