# HookedIn play

The public half of [HookedIn](https://hookedin.com): the wallet served at <https://play.hookedin.com>, the settlement contract, the protocol code the wallet and the casino share, the game SDK, the house's games, and the documentation, which <https://hookedin.com/docs> renders from [docs/](docs/).

Everything a player has to trust is here, so it can be read, built and checked: the **wallet** ([client/](client/)), which holds the keys, signs exact bets and verifies every result before it shows it; the **settlement contract** ([contracts/HookedInCasino.sol](contracts/HookedInCasino.sol)), which holds the deposits and decides what a closed channel is owed; the **shared protocol** ([protocol/](protocol/)); and the player's **recovery tools**, which close, challenge and collect without the casino. The casino service is private, and the wallet never takes its word for anything it can check. [How it works](docs/overview/how-it-works.md) and [the trust model](docs/overview/trust-model.md) say the rest.

## Documentation

| Read                                                                                         | To                                                                    |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Introduction](docs/index.md)                                                                | See the parts and where to start                                      |
| [Using the wallet](docs/wallet/getting-started.md)                                           | Play, withdraw, back up, recover without the casino, verify a release |
| [Building games](docs/games/quick-start.md)                                                  | Build, test and publish a game, with a server of its own or without   |
| [SDK reference](docs/sdk/index.md)                                                           | Look up every export of `@hookedin/play/sdk`                          |
| [Casino API](docs/casino-api/index.md)                                                       | Call the casino over HTTP                                             |
| [Signed messages](docs/reference/signed-messages.md), [contract](docs/reference/contract.md) | Check or reimplement the protocol                                     |
| [Architecture](docs/overview/architecture.md)                                                | Understand the design and its settled trade-offs                      |

## What is here

| Path                                   | Contents                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [client/](client/)                     | The wallet: channel, funding accounts, storage, backups, activity, the game iframe bridge, the pinned contract artifact, default settings and the static host's `_headers`             |
| [contracts/](contracts/)               | `HookedInCasino.sol` and two contracts used only by tests                                                                                                                              |
| [protocol/](protocol/)                 | Signed structures and hashing, types, the risk rule, chain observation, deployment verification, evidence recovery, transaction journal and dispute worker                             |
| [sdk/](sdk/)                           | The game SDK, `@hookedin/play/sdk`, and the `hookedin-game` build tool                                                                                                                 |
| [games/](games/)                       | The house's games: [samson](games/samson/), [plinko](games/plinko/), [dice](games/dice/), [blackjack](games/blackjack/), [mines](games/mines/), [roulette](games/roulette/)            |
| [docs/](docs/)                         | The documentation                                                                                                                                                                      |
| [scripts/](scripts/)                   | Compile and build, the local static server, the recovery CLI (`verify-evidence.ts`), the watchtower, test vectors, release packaging and a pricing demo                                |
| [testing/](testing/)                   | `contract.ts`: Anvil, a deployment and hand-signed evidence. `game-wallet.ts`: a real wallet on an in-memory casino stub for game tests, held to the casino by `conformance.ts`        |
| [test/](test/)                         | Contract behaviour, agreement between the TypeScript and contract derivations, the recovery CLI, wallet, iframe bridge, risk and vectors, journal, static build, browser storage, docs |
| [vectors/bets.json](vectors/bets.json) | Committed vectors for pricing and outcomes                                                                                                                                             |
| [catalog.json](catalog.json)           | The house developer and the games it publishes as `@hookedin`, by name: the library a deployment ships with                                                                            |
| [config/](config/)                     | The deployment the wallet release pins                                                                                                                                                 |
| [brand/](brand/)                       | The HookedIn mark                                                                                                                                                                      |

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

## Deploy

The wallet is a static site. Pushing to `main` releases it: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs the whole test suite, builds with `HOOKEDIN_CLIENT_CONFIG=config/production.json`, and publishes `dist/` to Cloudflare with `wrangler deploy`, as the static-assets Worker described in [wrangler.jsonc](wrangler.jsonc) (the successor to Cloudflare Pages). It then publishes each game from its own folder, as the Worker its `wrangler.jsonc` describes, at `https://<id>-game.hookedin.com`. The workflow needs the repository secret `CLOUDFLARE_API_TOKEN` (from Cloudflare's **Edit Cloudflare Workers** template) and the variable `CLOUDFLARE_ACCOUNT_ID`; without the token it still tests and builds.

Roulette takes the [developer bets](docs/games/developer-bets.md) of many players on one spin, backs them with one casino bet of its developer's on one of its developer's rounds, and ships its page and its server as one Cloudflare Worker. The rest are static pages. The server holds the key of the account the game is published from, the house developer in [catalog.json](catalog.json): a secret, set once from `games/roulette` with `npx wrangler secret put DEVELOPER_KEY`.

To publish the wallet by hand: `HOOKEDIN_CLIENT_CONFIG=config/production.json npm run build && npx wrangler deploy`. To publish a game: `node sdk/bin/hookedin-game.js build games/<id>`, then `npx wrangler deploy` from `games/<id>`.

Client-side routes (`/account`, `/wallet`, `/games`, `/bets`, `/bankroll`, `/settings`, `/activity`, `/games/<key>`, `/@<alias>/<game>`) rely on the single-page fallback set in `wrangler.jsonc`, and `dist/_redirects` serves `/@<alias>` ones as written rather than letting Cloudflare redirect them to `/%40<alias>`. `dist/_headers` carries the Content-Security-Policy and `frame-ancestors 'none'`; any other host must send the same headers and serve `index.html` for unknown paths.

The operator commits [config/production.json](config/production.json), the deployment the wallet release pins; it is published as `config.js`, so it holds nothing secret. [Deployment](docs/reference/deployment.md) describes its fields.

## Contributing

Read [AGENTS.md](AGENTS.md) first: simplicity is the governing constraint, and nothing keeps a compatibility path. Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Copyright (c) 2026 HookedIn.
