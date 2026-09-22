# HookedIn Roulette

European roulette with one wheel for the whole table: every player's chips ride the same spin. A reference game for [HookedIn](https://play.hookedin.com), and the example of a game played **against the house by many players at once**: a shared round, which the game's server opens and closes and every player's own wallet joins.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Roulette. It is hosted at `roulette-game.hookedin.com`.

## How to play

1. Choose a chip and click the layout: a number, red or black, odd or even, low or high, a dozen or a column. Right-click takes a chip off.
2. Press **Place bets**. The first time, your wallet asks how much the game may play with and whether it may join the game's shared rounds.
3. The wheel spins twenty seconds after the first chip at the table is down. Until then **Take my bet back** returns your chips.
4. The ball lands for everyone at once. A number returns 36 for 1, a dozen or a column 3 for 1, and the even-money bets 2 for 1. Zero is the house's: that is the whole 2.7% edge.

There is a wheel for each asset: you join the one for what your wallet plays with, ETH or test coins.

## How it works

This game uses a **shared round**. The pieces are:

- **The table** ([src/table.ts](src/table.ts)): the wheel's 37 pockets are 37 stretches of the round's 64-bit outcome, a chip is a prize over the stretches of the numbers it covers, and a player's whole layout is **one bet** of at most 37 prizes. The wallet signs it whole, so the player's wallet, not this page, establishes what was offered.
- **The game page** ([src/game.ts](src/game.ts)): lays out the chips, asks the wallet to join the open round, and reads the landed number from the verified receipt.
- **The wheel** ([server/wheel.ts](server/wheel.ts)): the round's host. It opens a round with the hash of a seed, and closes it with the seed when the betting time is up. It is built on `createHost` from the [game SDK](../../sdk), holds no money and never touches a bet.
- **The casino**: names each round by the hash of a secret of its own, which it draws knowing only the hash of the wheel's seed, admits each seat against the whole table, and on close reveals the secret and settles every seat.
- **Each player's wallet**: signs the bet, sends it to the casino itself, and verifies the result.

Page and wheel are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the wheel, a Durable Object per asset, on the same origin. The page names its asset with `?asset=`.

### The flow

1. The page polls `GET /api/table`. The wheel keeps one round open: `host.round()` draws a seed and asks the casino for a round in its asset, with the table's betting time and room to close it, sending only the seed's hash. Round and seed are saved before any page is shown the round, and no page is ever shown the seed. The reply is `{round: {id, seedHash}, closesAt, now, players, staked, last}`; the page counts down to `closesAt` against `now`, the wheel's clock, not its own.
2. The page turns the chips into `{stake, prizes}` and calls `HookedIn.bet({id, stake, prizes, round})`, having saved `id` and the terms first. The wallet signs the bet and sends it to the casino, which admits the seat against everything already on the table: red and black hedge each other, ten players on one number share the room one would have had. The reply is `{status: 'pending'}`: a seat. A seat that does not fit comes back as a verified rejection and the chips are the player's again.
3. The page tells the wheel a seat was taken (`POST /api/table/seated`). The wheel believes the casino, not the page: it reads the round's seats, and the first seat starts the twenty-second clock. If the last player leaves, the clock stops.
4. At the time, the wheel calls `host.close(round, seed)`. The casino checks the seed against the hash every seat signed, reveals the round's secret, settles every seat in one record, and names the wheel's next round. The number is `pocket(roundOutcome(seed, secret))`, the same for every player.
5. Each page sees `last.round` equal to its own and calls `HookedIn.bet` again with the same `id`: the wallet fetches its result, verifies it, and returns the receipt. The page reads the number from `receipt.outcome`, never from the wheel, and spins to it.

`HookedIn.cancel(id)` gives a seat up before the close, or returns the result if the wheel got there first; the page also calls it when a bet reached the casino just as the round closed. After a reload the page finds its saved bet's receipt with `HookedIn.receipt(id)`. A round the casino does not know, or one left empty for eight minutes, gives way to a fresh one.

### Files

| Path                                                               | What                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [src/table.ts](src/table.ts)                                       | Pockets, spots, and a layout as one bet. Shared by the page and the wheel                             |
| [src/game.ts](src/game.ts), [src/wheel-view.ts](src/wheel-view.ts) | The page and its canvas wheel                                                                         |
| [server/wheel.ts](server/wheel.ts)                                 | The host: one open round, the clock, the close. Everything outside is handed in, so it runs in a test |
| [server/worker.ts](server/worker.ts)                               | The Worker and the Durable Object that holds an asset's wheel                                         |
| [test/](test/)                                                     | The table's arithmetic against the casino's own admission rule, and the wheel against a stub casino   |
| [server/worker.test.ts](server/worker.test.ts)                     | The Durable Object opening its wheel against a stub casino                                            |

## Fairness and trust

A shared round involves more trust than a player's own bet, and the wallet tells the player so before the first one.

- **The game never holds keys or money.** The wallet signs the layout whole and records its exact return and the most it can pay.
- **The casino commits before the seed exists.** A round is named by the hash of its secret, and the wheel draws the seed only after it has that name. The outcome is `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`, low 64 bits, and the wallet checks the revealed secret and seed against the round and the seed hash it signed.
- **Neither the wheel nor the casino can choose the number alone; together they could.** The wheel never knows the secret, the casino fixed it before the seed, and the casino sees the seed only when the round closes: while chips go down, nobody knows the number, so nobody can take or turn away a bet by what it would win. In a player's own bet the seed is the wallet's, which is why the wallet asks before a game may use shared rounds, and marks those bets in the activity list.
- **A declined or abandoned bet is not hidden.** Every round is revealed when it ends, so the wallet records what a bet the casino declined, or one the player took back, would have paid.
- **The wheel can stall, not steal.** A round it never closes is revealed by the casino once the betting window the wheel asked for has run from the first seat, and every seat declined. A player can take a bet back, or change their chips, at any time before the close.

Read [rounds](../../docs/protocol.md#rounds) before you build on this.

## Run it

You need Node 24.4 or later.

The casino the wheel talks to must be the one the players' wallets use. With the full local stack, caserver's `npm run dev` runs the Worker, page and wheel together with `wrangler dev`, at `http://127.0.0.1:8790`, against its own casino and with a fresh key for the wheel, and publishes the game in `@hookedin`. Against another wallet, run `npm ci` in this repository's root, then in `games/roulette`:

```sh
npx wrangler dev --var HOST_KEY:0xYourWheelKey
```

`HOST_KEY` is the wheel's key, a private key you generated for this purpose. The wheel talks to the `CASINO_URL` in [wrangler.jsonc](wrangler.jsonc), the public deployment's casino; for another, add `--var CASINO_URL:` and its casino (the `casino` value in the wallet's `config.js`). Then open **Games**, choose **Add a custom game** and load `http://127.0.0.1:8790/manifest.json`.

`wrangler dev` builds the page into `dist/` as it starts, and again whenever `src/` changes.

## Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/`, `test/`, `server/` and [wrangler.jsonc](wrangler.jsonc) over it; there, set the build command in `wrangler.jsonc` to `npm run build`.

### What to change first

- [src/manifest.json](src/manifest.json): `id`, `name`, `description` and `developer` (your address).
- A different shared game is a different [src/table.ts](src/table.ts): what the outcome means and how a player's choices become prizes. A crash game with automatic cash-out is nested ranges (`[0, t(m))` pays `m × stake`); a wheel of fortune is one range per segment. The wheel's server stays as it is.
- The betting time is `BETTING_MS` in [server/wheel.ts](server/wheel.ts).

You earn half of every bet's commission. It accrues to the manifest's `developer` address; the casino keeps the other half. See [pricing and commission](../../docs/economics.md).

## Deploy

Whenever `main` is pushed, this repository's [deploy workflow](../../.github/workflows/deploy.yml) publishes the game to Cloudflare by running `npx wrangler deploy` in `games/roulette`, with [wrangler.jsonc](wrangler.jsonc): one Worker that serves the page and runs the wheel. `wrangler.jsonc` sets `CASINO_URL` and builds the page before every deploy, so the same command in `games/roulette` publishes it by hand.

Once, give the Worker the wheel's key: run `npx wrangler secret put HOST_KEY` in `games/roulette`, with a private key you generated for this purpose. It holds no money, and a lost one costs nothing but the rounds it had open.

A repository made from game-template deploys itself; [its README](https://github.com/hookedin/game-template#deploy) says how.

The build writes `dist/_headers`, which Cloudflare applies by itself. The header that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy, which lets the page talk only to its own origin. Do not host the game on the wallet's own origin; the wallet refuses that too.

## Get listed

Publish it yourself: in the wallet, open **My wallet** and, under your name, give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

```sh
node --test games/roulette/test/*.test.ts games/roulette/server/*.test.ts
```

In this repository's root, `npm test` type-checks everything, the page and the server among it, and runs every test; this runs only this game's. They check the table's arithmetic against the casino's own admission rule, and test the wheel and its Durable Object against a stub casino. Rounds and the wallet's handling of shared bets are tested in the [game SDK](../../sdk) and the casino service.

## License

[MIT](../../LICENSE)
