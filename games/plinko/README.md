# HookedIn Plinko

Drop a ball through 8, 12 or 16 rows of pegs into a row of buckets. Three risk levels, up to 1000× the bet, and every board returns exactly 99%. A reference game for [HookedIn](https://play.hookedin.com), and the example to copy for a one-shot game of many outcomes.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Plinko. It is hosted at `plinko-game.hookedin.com`.

## How to play

1. Add funds to the game from your wallet with **Add funds**.
2. Choose the rows (8, 12 or 16), the risk (low, medium or high) and the bet.
3. Drop a ball. Each tap queues another ball, up to 20 ahead; autoplay drops 10, 50 or 100.

The ball bounces left or right at each peg with equal chance and lands in a bucket. The bucket's multiplier times the bet is paid. Outer buckets pay the most and are the rarest. Under the buckets, bars show where this session's balls landed and white marks show the exact expectation.

The wallet plays with the network's ETH, or practices with test coins of its own; the game is the same either way.

## How it works

A drop is a round of one decision, played through `RoundClient` from the [game SDK](../../sdk). [src/drop.ts](src/drop.ts) wraps it as `DropClient`.

### The board is a graph

A board with `rows` rows has `rows + 1` buckets. The ball reaches bucket `j` by turning right exactly `j` times, so its probability is `C(rows, j) / 2^rows`.

`dropGraph` in [src/tables.ts](src/tables.ts) writes the board as one decision, `drop`, whose outcomes are the buckets, each at exactly that probability and each paying `stake × multiplier_j`. A bet too small for every multiplier to pay a whole wei is refused, so the board played is the board shown.

### A drop is one bet

A casino bet has two outcomes, so `RoundClient` collapses the board ([collapsing bets](../../docs/games/collapsing-bets.md)). A bucket and its mirror pay the same, so a board has `rows / 2 + 1` payouts. For each drop the page draws two of them with its own randomness, one below the bet and one above: it keeps the smaller, which the ball cannot lose, and stakes the rest of the bet for the difference to the larger. That is one casino bet, and the draw is weighted so that drops reach every bucket exactly as often as the pegs do. No bucket pays exactly 1×, so every drop places a bet. The casino's verified outcome decides which of the two payouts the ball gets, and which bucket pays it.

### The ball is drawn from the result

`path` in [src/tables.ts](src/tables.ts) draws the ball's left and right turns into its bucket from a generator seeded by the round's outcome, so a reload shows the same ball. [src/board.ts](src/board.ts) animates exactly those turns.

### The multipliers

[src/tables.ts](src/tables.ts) holds the nine tables in hundredths of the bet, from the outermost bucket to the centre (boards are symmetric):

| Rows | Low                                          | Medium                                      | High                                         |
| ---- | -------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| 8    | 5.7, 2.09, 1.3, 0.9, 0.5                     | 13, 2.7, 1.39, 0.7, 0.4                     | 29, 4.2, 1.44, 0.3, 0.2                      |
| 12   | 10, 3.2, 1.6, 1.4, 1.2, 0.9, 0.56            | 33, 11, 3.6, 2.1, 1.1, 0.6, 0.31            | 175, 23, 8, 2, 0.7, 0.22, 0.19               |
| 16   | 16, 9.7, 2.1, 1.5, 1.4, 1.29, 1.2, 0.9, 0.48 | 110, 41, 10, 4.4, 2.7, 1.49, 1.1, 0.5, 0.32 | 1000, 130, 26, 9.7, 4.1, 2, 0.19, 0.18, 0.16 |

No bucket pays exactly 1×.

**Return.** Every table satisfies `sum(C(rows, j) × multiplier_j) = 99 × 2^rows` in hundredths, which is a return of exactly 99% of the ball. [test/plinko.test.ts](test/plinko.test.ts) proves it for all nine boards, and that the drop the SDK compiles reaches every bucket at exactly its binomial odds.

Each bet's own return, which the wallet measures and keeps, is lower. A drop stakes only what its ball can lose, and the bets for the outer buckets carry more of the board's edge than the rest. With the casino's bankroll far above the stake, the bets pay back from 92.7% to 99.6% of what they stake, and the test holds every bet to at least 92.7%. When the bankroll is small beside a prize, the bet for it must carry more edge still for the casino to take it: at the least bankroll that backs the 16-row low board, its bet for the outer buckets pays back 22%.

### The money path

`DropClient` does four things, in this order:

1. **Price the board.** `RoundClient` prices it against half the casino's reported bankroll with the casino's own admission rule (`admits` from the SDK). A board the casino cannot back is reported in the player's terms before anything is saved.
2. **Save first.** The page draws the drop's bet and saves it, with a fresh operation `id`, in the game's `localStorage`, scoped by page, chain and player, or practice, before `game.casinoBet` is called.
3. **Settle.** One `game.casinoBet` request per ball. If the reply is lost, the next `restore()` or drop finds the result through `game.receipt` under the same `id`. A rejection keeps the same bet and gives it a fresh `id`.
4. **Land.** Only a settled receipt moves the ball. `RoundClient` refuses one whose payout is not the bet's, and `DropClient` lands each finished drop once.

Casino bets settle one at a time while balls fall together. The balance strip leaves a ball's winnings out (`bank.withhold`) until it lands.

| File                                                             | What it holds                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [src/tables.ts](src/tables.ts)                                   | Pure rules: multipliers, `paths`, `dropGraph`, `path`. No DOM or wallet        |
| [src/drop.ts](src/drop.ts)                                       | `DropClient`: a drop as a round of `RoundClient`, and the ball it lands        |
| [src/board.ts](src/board.ts)                                     | The canvas: pegs, balls, the landing histogram. It shows the paths it is given |
| [src/game.ts](src/game.ts)                                       | Page wiring: controls, queue, autoplay, sound                                  |
| [src/index.html](src/index.html), [src/style.css](src/style.css) | The page                                                                       |
| [src/manifest.json](src/manifest.json)                           | What the wallet reads to load the game                                         |

## Fairness

The game page is untrusted by design. It runs in a sandboxed iframe on its own origin and talks to the wallet only through `postMessage`.

- **The game never holds keys.** It sends the wallet a bet: a stake, a chance and a prize. The wallet checks the bet against the spending limit the player gave this game, signs the exact terms with the channel key and sends them to the casino. Money reaches the game only through the wallet's own **Add funds** dialog, and leaving the game returns the rest.
- **Nobody picks the outcome.** Every casino bet is on a round. The casino fixes the round's secret first and names the round by the secret's hash. The wallet picks its seed only after it has that name, signs the round and the seed's hash into the bet, and reveals the seed with the settlement. The outcome is the low 64 bits of `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`.
- **The wallet verifies.** It checks that the revealed secret hashes to the round it signed, recomputes the outcome, pays the prize itself if the outcome is below the chance, and checks the casino's signature on the new balance. Only then does the game receive its receipt: `settled`.
- **The game never sees future entropy.** It learns the outcome only from a completed receipt. It cannot supply the seed and cannot see the secret early. A bet the casino declines comes back with the round's secret, so the wallet shows at once what it would have paid.
- **Which bet a drop places is this game's word.** The wallet verifies the bet it signs completely, and knows nothing of the draw that chose it: that drops reach every bucket as often as the pegs do is this page's claim, open source here. A modified page could choose its bets outright; each is one the casino takes on its own, so such a page could misrepresent the game to its player but never harm the bankroll ([what is given up](../../docs/games/collapsing-bets.md#what-is-given-up)).
- **The ball follows the bet.** The verified outcome decides the bucket, and the path shown into it is drawn from that outcome.

The wallet verifies each bet. It does not certify a game's advertised rules or animations, which is why the rules here are open source and the presentation is drawn from the verified outcome. See the [protocol](../../docs/overview/how-it-works.md) and [pricing and commission](../../docs/reference/economics.md).

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
- The tables in [src/tables.ts](src/tables.ts). If you change a multiplier, keep `sum(C(rows, j) × multiplier_j)` equal to your target return times `2^rows`, and update the assertion in the first test and `FLOOR` in the last.
- The board drawing in [src/board.ts](src/board.ts) and the styles in [src/style.css](src/style.css).

You earn half the commission on every bet placed through your game. It accrues to the manifest's `developer` address on wins and losses alike and is never an extra charge to the player. See [pricing and commission](../../docs/reference/economics.md).

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

- every board reaches each bucket at exactly its binomial odds and returns exactly 99%, and the casino takes every bet the page can draw;
- a ball's path lands in its bucket, and the same result draws the same path;
- each drop is one casino bet through a real wallet, recovers a lost reply under the same `id`, and explains the casino's limits;
- every bet this game can place pays back at least the floor it is built to, 92.7% of its stake.

The third test uses `@hookedin/play/testing/game-wallet.ts`: the real wallet code with an in-memory casino, not a mock.

## License

[MIT](../../LICENSE)
