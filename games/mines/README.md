# HookedIn Mines

A five-by-five board with 1 to 24 mines. Pick tiles, find gems, and cash out when you like, at 99% of fair odds. A reference game for [HookedIn](https://play.hookedin.com), and the simplest example of a multi-step game where the player decides when to stop.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Mines. It is hosted at `mines-game.hookedin.com`.

## How to play

1. Add funds to the game from your wallet with **Add funds**.
2. Choose a stake and how many of the 25 tiles are mines, then **Bet** (or press Space).
3. Pick tiles, or let **Random tile** pick one. A gem raises what you can cash out; a mine ends the round at zero.
4. **Cash out** (or Space) after any gem, for what the button shows.

After `k` gems among `m` mines, a cash-out pays `0.99 × C(25, k) / C(25 − m, k)` times the stake, rounded down to the wei: 99% of the stake at the odds of finding those `k` gems.

| Mines | 1 gem  | 2 gems | 3 gems | 5 gems | Every gem            |
| ----- | ------ | ------ | ------ | ------ | -------------------- |
| 1     | 1.03×  | 1.07×  | 1.12×  | 1.23×  | 24.75× (24 gems)     |
| 3     | 1.12×  | 1.28×  | 1.47×  | 1.99×  | 2,277× (22 gems)     |
| 5     | 1.23×  | 1.56×  | 1.99×  | 3.39×  | 52,598× (20 gems)    |
| 10    | 1.65×  | 2.82×  | 5.00×  | 17.51× | 3,236,072× (15 gems) |
| 24    | 24.75× |        |        |        | 24.75× (1 gem)       |

Which tile you pick is a visual choice. No hidden board is generated in advance: each pick is a fresh bet at the exact odds of the tiles left. After a loss the page shows the mine on the tile you picked, and nowhere else, because there is nowhere else.

At a stake large for the casino's bankroll, the casino covers fewer picks than the board holds. The page says so when the round starts and again when you reach the last covered pick; cash out there, or lower the stake to go further.

## How it works

### The rules are a graph

The rules live in the game SDK: [src/engine/mines.ts](../../sdk/src/engine/mines.ts). [src/rules.ts](src/rules.ts) builds its arguments from the round's setup, `{ stake, mines, picks }`:

```ts
createMines({ tiles: 25, mines, cashouts: [1, …, picks].map(k => payout(stake, mines, k)) });
```

The graph tracks only the number of safe picks so far, because unrevealed tiles are symmetric. After `j` safe picks, a reveal leads to the mine with probability `mines / (25 − j)` and to the next state otherwise. `cash-out` leads to a terminal that pays `cashouts[j − 1]`. `RoundClient` saves the setup with the round and rebuilds the same graph from it after a reload.

### How far the casino covers

`RoundClient` from the SDK runs the round, and the SDK's engine prices each state with the cash its actions need, working backward from the cash-outs. A reveal has two outcomes, so it is one bet: the stake is the state's cash, the chance is the gem's share of the 2^64 outcomes, and the prize is the next state's cash. The casino's verified outcome decides gem or mine.

The cash-outs rise exactly as the odds fall, so at them every pick after the first is a fair bet, and the casino's admission rule takes no bet without an edge. Each state therefore holds a little more than its cash-out: what its next pick needs beyond fair odds for the casino to take it. The 1% the first pick keeps pays for all of them, and a longer ladder needs more. `coveredPicks` in [src/rules.ts](src/rules.ts) finds the most picks the bankroll backs at the stake, pricing exactly as `RoundClient` does, against half the bankroll `wallet.info` reports, on a grid of a billionth of the stake. The page starts the round with that many; past them the graph offers only the cash-out.

A cash-out moves the state's cash down to what it pays: the extra goes back to the house as a payment of at most a 99th of the cash-out, and nothing at the last covered pick. The cash is already in the player's signed balance, and a player who leaves without cashing out keeps all of it: a [settled trade-off](../../docs/overview/architecture.md#settled-trade-offs).

**Return.** A player who always cashes out after `k` gems gets back 99% of what they stake, on average and whatever the bankroll, less the wei each cash-out rounds away, because a round reaches `k` gems exactly as often as the rules say. The return the wallet measures is each pick's own, between 99% and 100%: the extra is what a cash-out gives back.

| File                                                             | What it holds                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [src/rules.ts](src/rules.ts)                                     | The cash-outs, the `createMines` call and how far the casino covers    |
| [src/game.ts](src/game.ts)                                       | All page logic: the board, cash-out, recovery                          |
| [src/index.html](src/index.html), [src/style.css](src/style.css) | The page, its gem and mine, and the rules text                         |
| [src/icon.svg](src/icon.svg)                                     | The icon the wallet shows the game by: a square SVG of one symbol      |
| [test/mines.test.ts](test/mines.test.ts)                         | The cash-outs, the casino's cover, and rounds settled through a wallet |
| [mines.ts](../../sdk/src/engine/mines.ts) in the SDK             | The rules                                                              |

`RoundClient` saves the round and each pending step in `localStorage` before the wallet signs. A reload restores the round, with its gems on the first tiles, and a step whose reply was lost is resolved through `game.receipt`.

## Fairness

The game page is untrusted by design. It runs in a sandboxed iframe on its own origin and talks to the wallet only through `postMessage`.

- **The game never holds keys.** It sends the wallet a bet: a stake, a chance and a prize. The wallet checks the bet against the spending limit the player gave this game, signs the exact terms with the channel key and sends them to the casino. ETH reaches the game only through the wallet's own dialog, and leaving the game returns the rest.
- **Nobody picks the outcome.** Every casino bet is on a round. The casino fixes the round's secret first and names the round by the secret's hash. The wallet picks its seed only after it has that name, signs the round and the seed's hash into the bet, and reveals the seed with the settlement. The outcome is the low 64 bits of `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`.
- **The wallet verifies.** It checks that the revealed secret hashes to the round it signed, recomputes the outcome, pays the prize itself if the outcome is below the chance, and checks the casino's signature on the new balance. Only then does the game receive its receipt: `settled`.
- **The game never sees future entropy.** It learns the outcome only from a completed receipt. It cannot supply the seed and cannot see the secret early. A bet the casino declines comes back with the round's secret, so the wallet shows at once what it would have paid.
- **No hidden board.** There is nothing to reveal at the end and nothing the game could have rigged in advance: each pick is decided by its own verified outcome.

The wallet verifies each bet. It does not certify a game's advertised rules or animations, which is why the rules here are open source and the presentation is computed from the verified outcome. See the [protocol](../../docs/overview/how-it-works.md) and [pricing and commission](../../docs/reference/economics.md).

## Run it

You need Node 24.4 or later. From play's root:

```sh
npm ci
node sdk/bin/hookedin-game.js serve games/mines
```

This builds the game into `dist/` and serves it at `http://127.0.0.1:4185/` (set `PORT` to move it). Then:

1. Open the wallet at [play.hookedin.com](https://play.hookedin.com).
2. Go to **Games**, choose **Open a game by its URL** and open `http://127.0.0.1:4185/`.

A game served from your own machine works against any HookedIn wallet and casino, because your browser loads both the wallet and the page. Testing against a fully local stack needs the casino server, which is private; its `npm run dev` runs this game with the rest of the stack. Most developers should use the public Sepolia deployment at play.hookedin.com.

Every page load rebuilds the game, so reload to see a change.

### Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/` and `test/` over it. What to change first:

- [src/icon.svg](src/icon.svg): the icon the wallet shows your game by, a square SVG of one symbol that fills the square, with no rounded background of its own: the wallet rounds its corners ([the icon](../../docs/reference/game-url.md#the-icon)).
- The board and the table: `TILES` and `multiplier` in [src/rules.ts](src/rules.ts). `createMines` takes one positive cash-out per allowed safe pick, at most `tiles − mines`; `coveredPicks` then finds how many of them the casino backs at a stake. Update the rules text in [src/index.html](src/index.html) and [test/mines.test.ts](test/mines.test.ts) to match.
- For different rules altogether, copy [mines.ts](../../sdk/src/engine/mines.ts) (56 lines) into your `src/` and pass your own graph function to `RoundClient`.
- The art: [src/index.html](src/index.html) and [src/style.css](src/style.css).

You earn half the commission on every bet placed through your game once you publish it. It accrues to the account that publishes it, on wins and losses alike, and is never an extra charge to the player. See [pricing and commission](../../docs/reference/economics.md).

## Deploy

`node sdk/bin/hookedin-game.js build games/mines`, run from play's root, writes `dist/`: plain static files. On every push, play's [deploy workflow](../../.github/workflows/deploy.yml) tests the game; on a push to `main` it also publishes it to Cloudflare, running `npx wrangler deploy` in `games/mines`, which reads [wrangler.jsonc](wrangler.jsonc). To publish by hand, build it, then run `npx wrangler deploy` in `games/mines`. A game made from game-template deploys through the template's own workflow.

Any static host works. It must send the headers in `dist/_headers`, which Cloudflare applies by itself, among them the page's Content-Security-Policy. Do not host the game on the wallet's own origin; the wallet refuses that.

Your game is then playable by anyone who opens its URL, such as `https://your-host/`, with **Open a game by its URL**, or through the link `https://play.hookedin.com/games/custom?url=<encoded game URL>`.

## Get listed

Publish it yourself: in the wallet of the account that is to earn its commission, open **My games** and give the game a name and its URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

From play's root:

```sh
node --test games/mines/test/*.test.ts
```

This runs [test/mines.test.ts](test/mines.test.ts): the cash-outs for every mine count and depth, the cap of one pick per gem, rounds settled and reloaded through the real wallet, a round that stops where the casino's cover ends, and that every bet the game can place pays back at least its floor. `npm test` at play's root type-checks and runs it with every other test. The Mines rules and the round handling are tested in the [game SDK](../../sdk).

## License

[MIT](../../LICENSE)
