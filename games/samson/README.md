# Samson's Gold

A five-reel, three-row, 243-ways slot for [HookedIn](https://play.hookedin.com). Jawbone wilds, honeycomb scatters, and a bonus on its own reels where the wilds multiply. It is the showcase reference game: the whole payout distribution is counted exactly from the reel strips, and every spin is one bet the wallet signs whole.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Samson's Gold. It is hosted at `samson-game.hookedin.com`.

## How to play

1. Add funds to the game from your wallet with **Add funds**.
2. Set the bet and spin.

Rules:

- A win is three, four or five adjacent reels from the left that carry the same symbol (or a wild). There are no paylines: every combination of matching positions is a way, and ways multiply the pay.
- **Only the best win on the screen pays.** No win is smaller than the bet.
- **Jawbone wilds** appear on reels 2, 3 and 4 and stand in for any paying symbol.
- **Honeycomb scatters** appear on reels 1, 3 and 5. Three of them trigger the Honey Bonus.
- **The Honey Bonus** is eight spins on a separate set of reels whose wilds carry ×2 and ×3. Multipliers of every wild in a win multiply together.

Pays per way, in bets:

| Symbol  | 3 reels | 4 reels | 5 reels |
| ------- | ------- | ------- | ------- |
| Lion    | 4       | 16      | 96      |
| Pillars | 2       | 8       | 24      |
| Shears  | 2       | 6       | 18      |
| Torch   | 2       | 4       | 12      |
| A       | 1       | 3       | 9       |
| K       | 1       | 3       | 8       |
| Q, J    | 1       | 2       | 6       |

Bonus spins are prepaid, not free. The triggering spin adds eight bets of cash to its payout, and the game offers to spend that on eight bonus spins at the triggering bet. You may keep the cash instead. **Buy bonus** is the same eight spins without waiting for a trigger.

The wallet plays with the network's ETH or the casino's test coins; the game is the same either way.

## How it works

### One spin is one bet

[src/math.ts](src/math.ts) holds the reel strips, the paytable and every rule. It has no DOM, no wallet and no randomness.

An **outcome** of a spin is the pair (best pay, bonus triggered). `distribution(machine)` counts, exactly, how many of the machine's stop combinations produce each outcome. It does not simulate. A win depends on the first three reels only through the running product of ways and multipliers for each symbol still alive, so the counter groups the first three reels by that state and then crosses each group with reels four and five. The main reels have 509,358,726 stop combinations and the bonus reels 714,125,160; each is counted in a fraction of a second.

`slotGraph` turns that count into a one-decision graph: a single `spin` action whose outcomes are the distinct results, each with probability `count / total` as an exact fraction, and each a terminal paying `stake × (pay + 8 if the bonus triggered)`. `RoundClient` from the [game SDK](../../sdk) compiles the `spin` into one bet: the stake, and prizes for the outcomes that pay, laid end to end across the 64-bit outcome space (neighbouring outcomes that pay the same share one prize). The main game has 44 outcomes and the bonus 54, so both fit the 64 prizes a bet may hold. The wallet signs the whole table.

Reel odds do not divide 2^64, so each outcome's width is rounded to the nearest whole outcome. The played probability is within one part in 2^64 of the counted one.

### The reels shown come from the outcome

After settlement the game knows which prize the verified outcome hit, and where inside that prize's range it fell. `sampleStops` uses that position as an index into exactly those stop combinations that produce the settled result, and returns one of them. The reels stop there. Reels and money are therefore jointly distributed as if the physical strips had been spun, and the page draws no randomness of its own. [src/game.ts](src/game.ts) re-evaluates the chosen window and refuses to show it if it does not pay what was settled.

### Why the rules look the way they do

Pricing one bet with the SDK's exact compiler costs roughly the cube of the number of distinct payouts. The rules keep that set small: only the best win pays, every pay is a whole number of bets of the form 2^a·3^b, and way counts and wild multipliers are products of 2s and 3s. The main game has 38 distinct payouts and the bonus 48. A side effect is that a win is never smaller than the bet, so the game never presents a net loss as a win.

Bonus spins are prepaid because the casino has no notion of free credit: every spin must be a real bet with a real stake. The bonus reels carry their own house edge, so each bonus spin passes the casino's admission rule like any other. The game keeps its bonus counter and last window in its own `localStorage` next to the round, and applies each finished round exactly once, by the round's `id`.

### What the reels pay

These are counted from the paytable, and the game states none of them anywhere a player reads:
a figure a game promises about itself cannot be checked, because nothing bounds how often it
wagers what it holds. A player's own return is measured from the bets they signed, in their
wallet's bet history and in this game's public record at the casino.

| Reels | Counted from the reels         | Any payout | Bonus trigger | Top payout | Distinct payouts |
| ----- | ------------------------------ | ---------- | ------------- | ---------- | ---------------- |
| Main  | 490253039/509358726 = 96.2491% | 1 in 4.95  | 1 in 156.1    | 1,152×     | 38               |
| Bonus | 3735679/3881115 = 96.2527%     | 1 in 4.25  | 1 in 127.7    | 6,912×     | 48               |

The main-game return counts the eight bets of bonus cash at face value. [test/samson.test.ts](test/samson.test.ts) pins both return fractions and both top payouts exactly, from the counted distribution. It also checks the counter against brute-force evaluation of every window on a small machine, outcome by outcome, and checks that the signed bet's expected payout matches what the reels pay to within the 2^64 rounding. The other columns are computed from the same `distribution`.

### Files

| File                                                             | What it holds                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [src/math.ts](src/math.ts)                                       | Strips, paytable, `evaluate`, the exact counter `distribution`, `sampleStops`, `slotGraph` |
| [src/game.ts](src/game.ts)                                       | Page logic: spins, the bonus offer and counter, autoplay, recovery                         |
| [src/reels.ts](src/reels.ts)                                     | The spinning reels. They show the strips and stops they are given; they decide nothing     |
| [src/sound.ts](src/sound.ts)                                     | Synthesized sound, built on the SDK's `createSynth`. There are no audio files              |
| [src/symbols/](src/symbols/)                                     | Ten SVG symbols, the only image assets                                                     |
| [src/index.html](src/index.html), [src/style.css](src/style.css) | The page and the paytable                                                                  |
| [src/manifest.json](src/manifest.json)                           | What the wallet reads to load the game                                                     |

## Fairness

The game page is untrusted by design. It runs in a sandboxed iframe on its own origin and talks to the wallet only through `postMessage`.

- **The game never holds keys.** It sends the wallet a stake and a list of prizes. The wallet checks the bet against the spending limit the player gave this game, signs the exact terms with the channel key and sends them to the casino. Money reaches the game only through the wallet's own **Add funds** dialog, and leaving the game returns the rest.
- **Nobody picks the outcome.** Every casino bet is on a round. The casino fixes the round's secret first and names the round by the secret's hash. The wallet picks its seed only after it has that name, signs the round and the seed's hash into the bet, and reveals the seed with the settlement. The outcome is the low 64 bits of `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`.
- **The wallet verifies.** It checks that the revealed secret hashes to the round it signed, recomputes the outcome, applies the signed prizes itself and checks the casino's signature on the new balance. Only then does the game receive its receipt: `settled`.
- **The game never sees future entropy.** It learns the outcome only from a completed receipt. It cannot supply the seed and cannot see the secret early. A bet the casino declines comes back with the round's secret, so the wallet shows at once what it would have paid.
- **The reels are the outcome.** The stop position is chosen by the verified outcome, from exactly the positions that pay what was settled.

The wallet verifies each bet. It does not certify a game's advertised rules or animations, which is why the rules here are open source and the presentation is computed from the verified outcome. See the [protocol](../../docs/overview/how-it-works.md) and [pricing and commission](../../docs/reference/economics.md).

## Run it

You need Node 24.4 or later. In this repository's root:

```sh
npm ci
node sdk/bin/hookedin-game.js serve games/samson
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
- The theme: the SVGs in [src/symbols/](src/symbols/), the copy in [src/index.html](src/index.html), the styles, and the tones in [src/sound.ts](src/sound.ts). None of these touch the maths.
- The maths: `MACHINES` and `PAYS` in [src/math.ts](src/math.ts). Any change to a strip or a pay changes the return, so update the expected fractions in the test. A reel window may show at most one wild or scatter; the counter enforces this. Keep the number of distinct outcomes at 64 or fewer and the distinct payouts small, or spins will be slow to price or will not fit one bet.

You earn half the commission on every bet placed through your game. It accrues to the manifest's `developer` address on wins and losses alike and is never an extra charge to the player. See [pricing and commission](../../docs/reference/economics.md).

## Deploy

The build writes `dist/`: plain static files. Whenever `main` is pushed, this repository's [deploy workflow](../../.github/workflows/deploy.yml) publishes them to Cloudflare by running `npx wrangler deploy` in `games/samson`, with [wrangler.jsonc](wrangler.jsonc). To publish by hand: `node ../../sdk/bin/hookedin-game.js build && npx wrangler deploy`, in `games/samson`. A repository made from game-template deploys itself; [its README](https://github.com/hookedin/game-template#deploy) says how.

Any static host works. It must send the headers in `dist/_headers`, which Cloudflare applies by itself. The one that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy. Do not host the game on the wallet's own origin; the wallet refuses that too.

Your game is then playable by anyone who loads `https://your-host/manifest.json` as a custom game, or through the link `https://play.hookedin.com/games/custom?manifest=<encoded manifest URL>`.

## Get listed

Publish it yourself: in the wallet, open **My games** and give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

```sh
node --test games/samson/test/*.test.ts
```

In this repository's root, `npm test` type-checks everything and runs every test; this runs only [test/samson.test.ts](test/samson.test.ts):

- the grouped counter agrees with evaluating every window, outcome by outcome;
- `sampleStops` returns every matching combination exactly once;
- the published machines return exactly the fractions above, with wilds and scatters on the stated reels;
- a spin prices as one bet at the stake, against a bankroll of 25,000 bets, with 30 to 64 prizes;
- spins settle through a real wallet in both modes and survive a reload;
- every step pays back at least the floor this game is built to.

The fifth test uses `@hookedin/play/testing/game-wallet.ts`: the real wallet code with an in-memory casino, not a mock.

## License

[MIT](../../LICENSE)
