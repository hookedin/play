# HookedIn Mines

Five tiles, one mine. Reveal up to three gems and choose when to cash out. A reference game for [HookedIn](https://play.hookedin.com), and the simplest example of a multi-step game where the player decides when to stop.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Mines. It is hosted at `mines-game.hookedin.com`.

## How to play

1. Add funds to the game from your wallet with **Add funds**.
2. Enter a stake and start.
3. Pick a tile. A gem lets you continue or cash out; the mine ends the round at zero.

| Cash out after | Chance of getting there | Pays  | Return |
| -------------- | ----------------------- | ----- | ------ |
| One gem        | 4/5                     | 1.20× | 96%    |
| Two gems       | 4/5 × 3/4 = 3/5         | 1.56× | 93.6%  |
| Three gems     | 4/5 × 3/4 × 2/3 = 2/5   | 2.28× | 91.2%  |

Which tile you pick is a visual choice. No hidden board is generated in advance: each reveal is a fresh bet at the exact remaining odds.

The wallet plays with the network's ETH or the casino's test coins; the game is the same either way.

## How it works

### The rules are a graph

The rules live in the game SDK: [src/engine/mines.ts](../../sdk/src/engine/mines.ts). [src/rules.ts](src/rules.ts) calls

```ts
createMines({ tiles: 5, mines: 1, cashouts: [120n, 156n, 228n].map(n => (BigInt(setup.stake) * n) / 100n) });
```

The graph tracks only the number of safe picks so far, because unrevealed tiles are symmetric. After `j` safe picks, `reveal` leads to the mine with probability `mines / (tiles − j)` and to the next state otherwise. `cash-out` leads to a terminal that pays `cashouts[j − 1]`.

### Every reveal is one bet

`RoundClient` from the SDK runs the round. The SDK's engine prices each state with the cash that finances its actions, working backward from the cashouts. A `reveal` becomes one bet: the stake is the state's current cash, the mine's stretch of the outcome space pays nothing, and the gem's stretch pays the cash of the next state. The casino's verified outcome decides gem or mine. `cash-out` leads to a state worth the same cash, so it places no bet at all: the money is already in the player's signed balance.

Each further reveal has its own house edge, which is why the return falls as you go deeper. This is deliberate. A ladder with a constant overall return would make later reveals zero-edge bets, and the casino's admission rule does not accept those at a finite bankroll. The derivation is in [sequential games built from native bets](../../sdk/docs/sequential-games.md#mines-another-n-move-graph).

The page shows a **continuation value** during the round. It is the cash the current state is priced at, which can differ slightly from the nominal multiple. It is not a cash-out quote.

**Return.** The three fixed-stop returns in the table above are exact. They are proven in the SDK's test suite ([test/sequential-games.test.ts](../../sdk/test/sequential-games.test.ts), "Mines uses the same engine and preserves stopping-policy payouts without payments"), which evaluates each stopping policy over the compiled game with exact fractions.

| File                                                             | What it holds                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| [src/rules.ts](src/rules.ts)                                     | The `createMines` call                                               |
| [src/game.ts](src/game.ts)                                       | All page logic: tiles, cash-out, recovery                            |
| [src/index.html](src/index.html), [src/style.css](src/style.css) | The page and the rules text                                          |
| [src/manifest.json](src/manifest.json)                           | What the wallet reads to load the game                               |
| [test/mines.test.ts](test/mines.test.ts)                         | The board, its cash-outs, and rounds settled through the real wallet |
| [mines.ts](../../sdk/src/engine/mines.ts) in the SDK             | The rules                                                            |

`RoundClient` saves the round and each pending step in `localStorage` before the wallet signs. A reload restores the round, and a step whose reply was lost is resolved through `game.receipt`.

## Fairness

The game page is untrusted by design. It runs in a sandboxed iframe on its own origin and talks to the wallet only through `postMessage`.

- **The game never holds keys.** It sends the wallet a stake and a list of prizes. The wallet checks the bet against the spending limit the player gave this game, signs the exact terms with the channel key and sends them to the casino. Money reaches the game only through the wallet's own **Add funds** dialog, and leaving the game returns the rest.
- **Nobody picks the outcome.** Every bet is on a round. The casino fixes the round's secret first and names the round by the secret's hash. The wallet draws its seed only after it has that name, signs the round and the seed's hash into the bet, and reveals the seed with the settlement. The outcome is the low 64 bits of `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`.
- **The wallet verifies.** It checks that the revealed secret hashes to the round it signed, recomputes the outcome, applies the signed prizes itself and checks the casino's signature on the new balance. Only then does the game receive a receipt with `verified: true`.
- **The game never sees future entropy.** It learns the outcome only from a completed receipt. It cannot supply the seed and cannot see the secret early. A bet the casino declines comes back with the round's secret, so the wallet shows at once what it would have paid.
- **No hidden board.** There is nothing to reveal at the end and nothing the game could have rigged in advance: each reveal is decided by its own verified outcome.

The wallet verifies each bet. It does not certify a game's advertised rules or animations, which is why the rules here are open source and the presentation is computed from the verified outcome. See the [protocol](../../docs/protocol.md) and [pricing and commission](../../docs/economics.md).

## Run it

You need Node 24.4 or later. From play's root:

```sh
npm ci
node sdk/bin/hookedin-game.js serve games/mines
```

This builds the game into `dist/` and serves it at `http://127.0.0.1:4185` (set `PORT` to move it). Then:

1. Open the wallet at [play.hookedin.com](https://play.hookedin.com).
2. Go to **Games**, choose **Add a custom game** and load `http://127.0.0.1:4185/manifest.json`.

A game served from your own machine works against any HookedIn wallet and casino, because the wallet loads the manifest and the page from your browser. Testing against a fully local stack needs the casino server, which is private; its `npm run dev` runs this game with the rest of the stack. Most developers should use the public Sepolia deployment at play.hookedin.com.

Every page load rebuilds the game, so reload to see a change.

### Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/` and `test/` over it. What to change first:

- [src/manifest.json](src/manifest.json): `id`, `name`, `description`, and `developer` (your address, in place of the one it ships with).
- The board: `tiles`, `mines` and `cashouts` in [src/rules.ts](src/rules.ts) are plain arguments. `cashouts` has one entry per allowed safe pick, at most `tiles − mines`. Give every reveal a positive edge: the expected cash after a reveal must be below the cash before it, or the casino will decline the bet. Update the tiles in [src/index.html](src/index.html), the rules text and [test/mines.test.ts](test/mines.test.ts) to match.
- For different rules altogether, copy [mines.ts](../../sdk/src/engine/mines.ts) (56 lines) into your `src/` and pass your own graph function to `RoundClient`.
- The art: [src/index.html](src/index.html) and [src/style.css](src/style.css).

You earn half the commission on every bet placed through your game. It accrues to the manifest's `developer` address on wins and losses alike and is never an extra charge to the player. See [pricing and commission](../../docs/economics.md).

## Deploy

`node sdk/bin/hookedin-game.js build games/mines`, run from play's root, writes `dist/`: plain static files. On every push, play's [deploy workflow](../../.github/workflows/deploy.yml) tests the game; on a push to `main` it also publishes it to Cloudflare, running `npx wrangler deploy` in `games/mines`, which reads [wrangler.jsonc](wrangler.jsonc). To publish by hand, build it, then run `npx wrangler deploy` in `games/mines`. A game made from game-template deploys through the template's own workflow.

Any static host works. It must send the headers in `dist/_headers`, which Cloudflare applies by itself. The one that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy. Do not host the game on the wallet's own origin; the wallet refuses that too.

Your game is then playable by anyone who loads `https://your-host/manifest.json` as a custom game, or through the link `https://play.hookedin.com/games/custom?manifest=<encoded manifest URL>`.

## Get listed

Publish it yourself: in the wallet, open **My wallet** and, under your name, give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

From play's root:

```sh
node --test games/mines/test/*.test.ts
```

This runs [test/mines.test.ts](test/mines.test.ts): the board and its cash-outs, rounds settled through the real wallet, and that every step pays back at least the game's floor. `npm test` at play's root type-checks and runs it with every other test. The Mines rules, their returns and the round handling are tested in the [game SDK](../../sdk).

## License

[MIT](../../LICENSE)
