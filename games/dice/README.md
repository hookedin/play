# HookedIn Dice

Pick a win chance, pick a stake, roll. A reference game for [HookedIn](https://play.hookedin.com), and the smallest example of a game built on `RoundClient`.

Play it at [dice-game.hookedin.com](https://dice-game.hookedin.com/manifest.json) through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Dice.

## How to play

1. Add funds to the game from your wallet with **Add funds**.
2. Set the win chance with the slider, from 10% to 90% in steps of 0.5%.
3. Enter a stake and press **Roll dice**.

A win pays `99% / win chance` times the stake: 2× at 49.5%, 9.9× at 10%, 1.1× at 90%. A loss pays nothing. The roll shown is the verified outcome on a 0–100 scale: a win falls under the win chance, a loss at or above it.

The wallet plays with the network's ETH or the casino's test coins; the game is the same either way.

## How it works

The whole game is one decision with two outcomes. [src/rules.ts](src/rules.ts) describes it as a graph, and [src/game.ts](src/game.ts) hands it to `RoundClient` from the [game SDK](../../sdk):

```ts
actions: [{ id: 'roll', outcomes: [
  { next: 'dice:win',  probability: fraction(BigInt(chance), 10000n) },
  { next: 'dice:lose', probability: fraction(BigInt(10000 - chance), 10000n) },
]}],
// terminals
{ id: 'dice:win',  kind: 'terminal', payout: (BigInt(setup.stake) * 9900n) / BigInt(chance) },
{ id: 'dice:lose', kind: 'terminal', payout: 0n },
```

`chance` is the win chance in basis points. `RoundClient` turns the `roll` action into one bet:

- the **stake** is the player's stake;
- its **chance** is `chance / 10000` of the 2^64 outcomes;
- its **prize**, `stake × 9900 / chance`, is paid when the round's outcome is below the chance.

Where `chance / 10000` of 2^64 is not a whole number of outcomes, the bet's chance is rounded down or one outcome more, drawn in the page so that the odds are exact on average ([transition.ts](../../sdk/src/engine/transition.ts) in the SDK). The wallet signs that bet, the casino settles it, and the game shows `dice:win` or `dice:lose` according to whether the verified outcome fell below the chance.

**Return.** The nominal return is 99%: `chance/10000 × 9900/chance = 0.99`. The payout is rounded down to a whole number of wei, so the exact figure can be below 99% by less than one wei per roll. [test/dice.test.ts](test/dice.test.ts) checks this at every chance on the slider. A roll has two outcomes, so the return the wallet measures of its bet is the roll's.

**Limits.** Before a roll, `RoundClient` prices the bet with the casino's own admission rule against half the reported bankroll. A stake the casino could not back, which happens sooner at low win chances, is refused with a message before anything is signed.

| File                                   | What it holds                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| [src/rules.ts](src/rules.ts)           | The graph above, and the chance limits                                                   |
| [src/game.ts](src/game.ts)             | All of the page logic: startup, recovery, the roll button                                |
| [src/index.html](src/index.html)       | The page and the rules text                                                              |
| [src/style.css](src/style.css)         | Dice-specific styles, on top of the SDK's `shared.css`                                   |
| [src/manifest.json](src/manifest.json) | What the wallet reads to load the game                                                   |
| [test/dice.test.ts](test/dice.test.ts) | The return at every chance, the chance limits, and rolls settled through the real wallet |

Recovery is `RoundClient`'s job. It saves the roll and its operation `id` in `localStorage` before the wallet signs, and `round.restore()` on startup resolves a roll whose reply was lost. A reload mid-roll shows **Resume roll**.

## Fairness

The game page is untrusted by design. It runs in a sandboxed iframe on its own origin and talks to the wallet only through `postMessage`.

- **The game never holds keys.** It sends the wallet a bet: a stake, a chance and a prize. The wallet checks the bet against the spending limit the player gave this game, signs the exact terms with the channel key and sends them to the casino. Money reaches the game only through the wallet's own **Add funds** dialog, and leaving the game returns the rest.
- **Nobody picks the outcome.** Every casino bet is on a round. The casino fixes the round's secret first and names the round by the secret's hash. The wallet picks its seed only after it has that name, signs the round and the seed's hash into the bet, and reveals the seed with the settlement. The outcome is the low 64 bits of `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`.
- **The wallet verifies.** It checks that the revealed secret hashes to the round it signed, recomputes the outcome, pays the prize itself if the outcome is below the chance, and checks the casino's signature on the new balance. Only then does the game receive its receipt: `settled`.
- **The game never sees future entropy.** It learns the outcome only from a completed receipt. It cannot supply the seed and cannot see the secret early. A bet the casino declines comes back with the round's secret, so the wallet shows at once what it would have paid.

The wallet verifies each bet. It does not certify a game's advertised rules or animations, which is why the rules here are open source and the presentation is computed from the verified outcome. See the [protocol](../../docs/overview/how-it-works.md) and [pricing and commission](../../docs/reference/economics.md).

## Run it

You need Node 24.4 or later. From play's root:

```sh
npm ci
node sdk/bin/hookedin-game.js serve games/dice
```

This builds the game into `dist/` and serves it at `http://127.0.0.1:4185` (set `PORT` to move it). Then:

1. Open the wallet at [play.hookedin.com](https://play.hookedin.com).
2. Go to **Games**, choose **Add a custom game** and load `http://127.0.0.1:4185/manifest.json`.

A game served from your own machine works against any HookedIn wallet and casino, because the wallet loads the manifest and the page from your browser. Testing against a fully local stack needs the casino server, which is private; its `npm run dev` runs this game with the rest of the stack. Most developers should use the public Sepolia deployment at play.hookedin.com.

Every page load rebuilds the game, so reload to see a change.

### Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/` and `test/` over it. What to change first:

- [src/manifest.json](src/manifest.json): `id`, `name`, `description`, and `developer` (your address, in place of the one it ships with).
- The rules: the `9900n` in [src/rules.ts](src/rules.ts) is the return in basis points, and the `1000`/`9000` bounds are the chance limits. Keep the slider in [src/index.html](src/index.html), the `odds()` display in [src/game.ts](src/game.ts) and [test/dice.test.ts](test/dice.test.ts) in step. A higher return leaves the casino less edge, so it admits smaller stakes.
- The art: [src/index.html](src/index.html) and [src/style.css](src/style.css). The die is pure CSS.

You earn half the commission on every bet placed through your game. It accrues to the manifest's `developer` address on wins and losses alike and is never an extra charge to the player. See [pricing and commission](../../docs/reference/economics.md).

## Deploy

`node sdk/bin/hookedin-game.js build games/dice`, run from play's root, writes `dist/`: plain static files. On every push, play's [deploy workflow](../../.github/workflows/deploy.yml) tests the game; on a push to `main` it also publishes it to Cloudflare, running `npx wrangler deploy` in `games/dice`, which reads [wrangler.jsonc](wrangler.jsonc). To publish by hand, build it, then run `npx wrangler deploy` in `games/dice`. A game made from game-template deploys through the template's own workflow.

Any static host works. It must send the headers in `dist/_headers`, which Cloudflare applies by itself. The one that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy. Do not host the game on the wallet's own origin; the wallet refuses that too.

Your game is then playable by anyone who loads `https://your-host/manifest.json` as a custom game, or through the link `https://play.hookedin.com/games/custom?manifest=<encoded manifest URL>`.

## Get listed

Publish it yourself: in the wallet, open **My games** and give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

From play's root:

```sh
node --test games/dice/test/*.test.ts
```

This runs [test/dice.test.ts](test/dice.test.ts): the return at every chance on the slider, the chance limits, rolls settled through the real wallet, and that every bet it can place pays back at least the game's floor. `npm test` at play's root type-checks and runs it with every other test. The pricing and round handling it relies on are tested in the [game SDK](../../sdk).

## License

[MIT](../../LICENSE)
