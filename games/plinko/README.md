# HookedIn Plinko

Drop a ball through 8, 12 or 16 rows of pegs into a row of buckets. Three risk levels, up to 1000× the bet, and every board returns exactly 99%. A reference game for [HookedIn](https://play.hookedin.com), and the example to copy for any one-shot prize table.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Plinko. It is hosted at `plinko-game.hookedin.com`.

## How to play

1. Add funds to the game from your wallet with **Add funds**.
2. Choose the rows (8, 12 or 16), the risk (low, medium or high) and the bet.
3. Drop a ball. Each tap queues another ball, up to 20 ahead; autoplay drops 10, 50 or 100.

The ball bounces left or right at each peg with equal chance and lands in a bucket. The bucket's multiplier times the bet is paid. Outer buckets pay the most and are the rarest. Under the buckets, bars show where this session's balls landed and white marks show the exact expectation.

The wallet plays with the network's ETH or the casino's test coins; the game is the same either way.

## How it works

One drop is one bet. The game does not use the round helper; [src/drop.ts](src/drop.ts) is the whole money path.

### The board is the bet

A board with `rows` rows has `rows + 1` buckets. The ball reaches bucket `j` by turning right exactly `j` times, so its probability is `C(rows, j) / 2^rows`.

`dropBet` in [src/tables.ts](src/tables.ts) writes the board as a stake and one prize per bucket. The 64-bit outcome space is cut into `2^rows` equal stretches of `2^(64 − rows)` outcomes, one per path. Bucket `j` gets the `C(rows, j)` paths that belong to it, side by side, and pays `stake × multiplier_j`. Binomial odds divide 2^64 exactly, so nothing is rounded: the bet the wallet signs is the board of fair pegs, to the last outcome. The largest board is 17 prizes, well inside the 64 a bet may hold.

### The outcome is the ball

`landing` in [src/tables.ts](src/tables.ts) reads the verified outcome back. Its top `rows` bits name one of the `2^rows` paths. The function finds that path's bucket and unranks it into a sequence of left and right turns. [src/board.ts](src/board.ts) animates exactly those turns. The ball you watch and the money you are paid are the same fact, and the page draws no randomness of its own.

### The multipliers

[src/tables.ts](src/tables.ts) holds the nine tables in hundredths of the bet, from the outermost bucket to the centre (boards are symmetric):

| Rows | Low                                          | Medium                                      | High                                         |
| ---- | -------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| 8    | 5.7, 2.09, 1.3, 0.9, 0.5                     | 13, 2.7, 1.39, 0.7, 0.4                     | 29, 4.2, 1.44, 0.3, 0.2                      |
| 12   | 10, 3.2, 1.6, 1.4, 1.2, 0.9, 0.56            | 33, 11, 3.6, 2.1, 1.1, 0.6, 0.31            | 175, 23, 8, 2, 0.7, 0.22, 0.19               |
| 16   | 16, 9.7, 2.1, 1.5, 1.4, 1.29, 1.2, 0.9, 0.48 | 110, 41, 10, 4.4, 2.7, 1.49, 1.1, 0.5, 0.32 | 1000, 130, 26, 9.7, 4.1, 2, 0.19, 0.18, 0.16 |

No bucket pays exactly 1×.

**Return.** Every table satisfies `sum(C(rows, j) × multiplier_j) = 99 × 2^rows` in hundredths, which is a return of exactly 99%. [test/plinko.test.ts](test/plinko.test.ts) proves it three ways for all nine boards: from the table arithmetic, from the prize widths (each equals `C(rows, j) × 2^(64 − rows)` and together they tile the whole outcome space), and from the signed bet itself, using the wallet's own `describeBet` to show that the expected payout is exactly 99% of the stake.

### The money path

`DropClient` in [src/drop.ts](src/drop.ts) does four things, in this order:

1. **Build and check the bet.** The board is checked against half the casino's reported bankroll with the casino's own admission rule (`admits` from the SDK). A board the casino cannot back is reported in the player's terms before anything is saved. A bet so small that a multiplier would round to zero wei is refused.
2. **Save first.** The drop and a fresh operation `id` are written to the game's `localStorage`, scoped by page, chain, player and asset, before `game.bet` is called.
3. **Settle.** One `game.bet` request per ball. If the reply is lost, `restore()` finds the result through `game.receipt` under the same `id`. A rejection keeps the same drop and gives it a fresh `id`.
4. **Land.** Only a settled receipt moves the ball. The client recomputes the bucket from `receipt.outcome` and refuses a receipt whose payout differs from the board's.

Wagers settle one at a time while balls fall together. The balance strip leaves a ball's winnings out (`bank.withhold`) until it lands. The bankroll figure is only a planning hint, so it is refreshed every fifty balls rather than on each drop.

| File                                                             | What it holds                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [src/tables.ts](src/tables.ts)                                   | Pure rules: multipliers, `paths`, `dropBet`, `landing`. No DOM, wallet or randomness |
| [src/drop.ts](src/drop.ts)                                       | `DropClient`: the bet, persistence, recovery, verification                           |
| [src/board.ts](src/board.ts)                                     | The canvas: pegs, balls, the landing histogram. It shows the paths it is given       |
| [src/game.ts](src/game.ts)                                       | Page wiring: controls, queue, autoplay, sound                                        |
| [src/index.html](src/index.html), [src/style.css](src/style.css) | The page                                                                             |
| [src/manifest.json](src/manifest.json)                           | What the wallet reads to load the game                                               |

## Fairness

The game page is untrusted by design. It runs in a sandboxed iframe on its own origin and talks to the wallet only through `postMessage`.

- **The game never holds keys.** It sends the wallet a stake and a list of prizes. The wallet checks the bet against the spending limit the player gave this game, signs the exact terms with the channel key and sends them to the casino. Money reaches the game only through the wallet's own **Add funds** dialog, and leaving the game returns the rest.
- **Nobody picks the outcome.** Every bet is on a round. The casino fixes the round's secret first and names the round by the secret's hash. The wallet draws its seed only after it has that name, signs the round and the seed's hash into the bet, and reveals the seed with the settlement. The outcome is the low 64 bits of `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`.
- **The wallet verifies.** It checks that the revealed secret hashes to the round it signed, recomputes the outcome, applies the signed prizes itself and checks the casino's signature on the new balance. Only then does the game receive its receipt: `settled`, with basis `outcome`.
- **The game never sees future entropy.** It learns the outcome only from a completed receipt. It cannot supply the seed and cannot see the secret early. A bet the casino declines comes back with the round's secret, so the wallet shows at once what it would have paid.
- **The ball is the outcome.** The path shown is decoded from the verified 64-bit outcome. There is no second random draw that could disagree with the payout.

The wallet verifies each bet. It does not certify a game's advertised rules or animations, which is why the rules here are open source and the presentation is computed from the verified outcome. See the [protocol](../../docs/protocol.md) and [pricing and commission](../../docs/economics.md).

## Run it

You need Node 24.4 or later. In this repository's root:

```sh
npm ci
node sdk/bin/hookedin-game.js serve games/plinko
```

This builds the game into `dist/` and serves it at `http://127.0.0.1:4185` (set `PORT` to move it). Then:

1. Open the wallet at [play.hookedin.com](https://play.hookedin.com).
2. Go to **Games**, choose **Add a custom game** and load `http://127.0.0.1:4185/manifest.json`.

A game served from your own machine works against any HookedIn wallet and casino, because the wallet loads the manifest and the page from your browser. Testing against a fully local stack needs the casino server, which is private; its `npm run dev` serves this game with the others. Most developers should use the public Sepolia deployment at play.hookedin.com.

Every page load rebuilds the game, so reload to see a change.

## Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/` and `test/` over it.

### What to change first

- [src/manifest.json](src/manifest.json): `id`, `name`, `description`, and `developer` (your address).
- The tables in [src/tables.ts](src/tables.ts). If you change a multiplier, keep `sum(C(rows, j) × multiplier_j)` equal to your target return times `2^rows`, and update the assertion in the first test. Row counts other than 8, 12 and 16 work as long as `rows + 1` is at most 64.
- The board drawing in [src/board.ts](src/board.ts) and the styles in [src/style.css](src/style.css).

You earn half the commission on every bet placed through your game. It accrues to the manifest's `developer` address on wins and losses alike and is never an extra charge to the player. See [pricing and commission](../../docs/economics.md).

## Deploy

The build writes `dist/`: plain static files. Whenever `main` is pushed, this repository's [deploy workflow](../../.github/workflows/deploy.yml) publishes them to Cloudflare by running `npx wrangler deploy` in `games/plinko`, with [wrangler.jsonc](wrangler.jsonc). To publish by hand: `node ../../sdk/bin/hookedin-game.js build && npx wrangler deploy`, in `games/plinko`. A repository made from game-template deploys itself; [its README](https://github.com/hookedin/game-template#deploy) says how.

Any static host works. It must send the headers in `dist/_headers`, which Cloudflare applies by itself. The one that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy. Do not host the game on the wallet's own origin; the wallet refuses that too.

Your game is then playable by anyone who loads `https://your-host/manifest.json` as a custom game, or through the link `https://play.hookedin.com/games/custom?manifest=<encoded manifest URL>`.

## Get listed

Publish it yourself: in the wallet, open **My games** and give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

```sh
node --test games/plinko/test/*.test.ts
```

In this repository's root, `npm test` type-checks everything and runs every test; this runs only [test/plinko.test.ts](test/plinko.test.ts):

- every board is one bet that tiles the outcome space and returns exactly 99%;
- every one of the `2^rows` paths appears exactly once, in its own bucket;
- drops settle through a real wallet, recover a lost reply under the same `id`, and explain the casino's limits;
- every board pays back at least the floor this game is built to.

The third test uses `@hookedin/play/testing/game-wallet.ts`: the real wallet code with an in-memory casino, not a mock.

## License

[MIT](../../LICENSE)
