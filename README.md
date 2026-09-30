# HookedIn play

The public half of [HookedIn](https://hookedin.com): the wallet served at <https://play.hookedin.com>, the settlement contract, the protocol code the wallet and the casino share, the game SDK, the house's games, and the documentation, which <https://hookedin.com/docs> renders from [docs/](docs/). Everything a player has to trust is here; the casino service is private, and the wallet never takes its word for anything it can check.

## Documentation

| Read                                                                                         | To                                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Introduction](docs/index.md)                                                                | See the parts and where to start                                    |
| [Using the wallet](docs/wallet/getting-started.md)                                           | Play, withdraw, back up, and settle without the casino              |
| [Building games](docs/games/quick-start.md)                                                  | Build, test and publish a game, with a server of its own or without |
| [SDK reference](docs/sdk/index.md)                                                           | Look up every export of the game SDK                                |
| [Casino API](docs/casino-api/index.md)                                                       | Call the casino over HTTP                                           |
| [Signed messages](docs/reference/signed-messages.md), [contract](docs/reference/contract.md) | Check or reimplement the protocol                                   |
| [Deployment and releases](docs/reference/deployment.md)                                      | Find the deployment, and check a release against these sources      |
| [Architecture](docs/overview/architecture.md)                                                | Read the design principle and its settled trade-offs                |

## Quick start

Requires Node **24.4 or later** and npm. Node runs the TypeScript sources directly; nothing is emitted by `tsc`. The tests also need Foundry's `anvil` on `PATH` and an installed Google Chrome.

```sh
npm ci
npm run build    # compile the contract, check the pinned artifact, bundle the wallet into dist/ and each game into games/<id>/dist/
npm run dev      # build, then serve dist/ at http://127.0.0.1:4184
npm test         # build, type-check, check the vectors, run every test suite (needs anvil and Chrome)
```

`npm run dev` serves the wallet alone, on the deployment [config/production.json](config/production.json) pins; `PORT` moves it. caserver's `npm run dev` serves it on a local stack instead. To work on a game, `node sdk/bin/hookedin-game.js serve games/<id>` serves it at `http://127.0.0.1:4185/` and builds it again on every page load; in any wallet, choose **Open a game by its URL** and open that address.

Other commands: `npm run typecheck`, `npm run vectors` (regenerate the vectors), `npm run format`, and `npm run watchtower` ([the watchtower](docs/wallet/keys-and-recovery.md#the-watchtower)).

## Deploy

Pushing to `main` releases the wallet: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs the whole test suite, builds, publishes `dist/` as the static-assets Worker [wrangler.jsonc](wrangler.jsonc) describes, and publishes each game in [games/](games/) as the Worker its own `wrangler.jsonc` describes, at `https://<id>-game.hookedin.com`. Blackjack, roulette and crash publish themselves from their own repositories.

By hand: `npm run build && npx wrangler deploy` publishes the wallet, and `node sdk/bin/hookedin-game.js build games/<id>`, then `npx wrangler deploy` from `games/<id>`, a game.

The wallet's routes, such as `/wallet` and `/@<alias>/<game>`, are client-side: `wrangler.jsonc` sets the single-page fallback, and `dist/_redirects` serves `/@<alias>` paths as written. `dist/_headers` carries the Content-Security-Policy and `frame-ancestors 'none'`; any other host must send the same headers and serve `index.html` for unknown paths. [config/production.json](config/production.json), the deployment the release pins, is published as `config.js` and holds nothing secret.

## Contributing

Read [AGENTS.md](AGENTS.md) first: simplicity is the governing constraint, and nothing keeps a compatibility path. Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Copyright (c) 2026 HookedIn.
