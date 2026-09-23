# HookedIn Roulette

European roulette with one wheel for the whole table: every player's chips ride the same spin. A reference game for [HookedIn](https://play.hookedin.com), and the example of a game played **against the house by many players at once**: a house pot, which the game's referee opens and resolves and every player's own wallet enters.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Roulette. It is hosted at `roulette-game.hookedin.com`.

## How to play

1. Choose a chip and click the layout: a number, red or black, odd or even, low or high, a dozen or a column. Right-click takes a chip off.
2. Press **Place bets**. The first time, your wallet asks how much the game may play with. A bet is final once it is in.
3. The wheel spins twenty seconds after the first chip at the table is down.
4. The ball lands for everyone at once. A number returns 36 for 1, a dozen or a column 3 for 1, and the even-money bets 2 for 1. Zero is the house's: that is the whole 2.7% edge.

There is a wheel for each asset: you join the one for what your wallet plays with, ETH or test coins.

## How it works

This game uses a **house pot**. The pieces are:

- **The table** ([src/table.ts](src/table.ts)): the wheel's 37 pockets are 37 stretches of the pot's 64-bit outcome, a chip is a prize over the stretches of the numbers it covers, and a player's whole layout is **one entry** of at most 37 prizes. The wallet signs it whole, so the player's wallet, not this page, establishes what was offered.
- **The game page** ([src/game.ts](src/game.ts)): lays out the chips, asks the wallet to enter the open pot, and reads the landed number from the verified receipt.
- **The wheel** ([server/wheel.ts](server/wheel.ts)): the game's referee. It opens a house pot with the hash of a seed, and resolves it with the seed when the betting time is up. It is built on `createReferee` from the [game SDK](../../sdk), holds no money and never touches a bet.
- **The casino**: names each house pot by the hash of a secret of its own, which it draws knowing only the hash of the wheel's seed, admits each entry against everything already in the pot, and on resolution reveals the secret and owes every entry what it won.
- **Each player's wallet**: signs the entry, sends it to the casino itself, and checks the seed and secret before it collects the winnings.

Page and wheel are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the wheel, a Durable Object per asset, on the same origin. The page names its asset with `?asset=`.

### The flow

1. The page polls `GET /api/table`. The wheel keeps one pot open: `referee.open({bank: 'house'})` draws a seed and opens a pot in its asset, with the table's betting time and room to resolve it, sending only the seed's hash. Pot and seed are saved before any page is shown the pot, and no page is ever shown the seed. The reply is `{pot, closesAt, now, players, staked, last}`; the page counts down to `closesAt` against `now`, the wheel's clock, not its own.
2. The page turns the chips into `{stake, prizes}` and calls `HookedIn.enter({id, pot, stake, prizes})`, having saved `id` and the terms first. The wallet signs a debit into the pot and sends it to the casino, which admits it against everything already in the pot: red and black hedge each other, ten players on one number share the room one would have had. The stake leaves the game's balance at once, and the entry is final. One that does not fit comes back as a verified rejection and the chips are the player's again.
3. The page tells the wheel somebody entered (`POST /api/table/entered`). The wheel believes the casino, not the page: it reads the pot, whose window the casino starts at the first entry, and spins twenty seconds after it.
4. At the time, the wheel calls `referee.resolve(pot, {seed})`. The casino checks the seed against the hash the pot was opened with, reveals the pot's secret, and owes every entry what it won. The number is `pocket(roundOutcome(seed, secret))`, the same for every player.
5. Each page sees the wheel move on from its pot and calls `HookedIn.enter` again with the same `id`: the wallet checks the seed and secret, collects what the entry won, and returns the receipt. The page reads the number from `receipt.outcome`, never from the wheel, and spins to it.

After a reload the page finds its saved entry's receipt with `HookedIn.receipt(id)`. A pot the casino does not know gives way to a fresh one, and one left empty for eight minutes is called off.

### Files

| Path                                                               | What                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [src/table.ts](src/table.ts)                                       | Pockets, spots, and a layout as one entry. Shared by the page and the wheel                           |
| [src/game.ts](src/game.ts), [src/wheel-view.ts](src/wheel-view.ts) | The page and its canvas wheel                                                                         |
| [server/wheel.ts](server/wheel.ts)                                 | The referee: one open pot, the clock, the spin. Everything outside is handed in, so it runs in a test |
| [server/worker.ts](server/worker.ts)                               | The Worker and the Durable Object that holds an asset's wheel                                         |
| [test/](test/)                                                     | The table's arithmetic against the casino's own admission rule, and the wheel against a stub casino   |
| [server/worker.test.ts](server/worker.test.ts)                     | The Durable Object opening its wheel against a stub casino                                            |

## Fairness and trust

- **The game never holds keys or money.** The wallet signs the layout whole and records exactly what it risks and the most it can pay.
- **The casino commits before the seed exists.** A house pot is named by the hash of its secret, and the wheel draws the seed only after it has that name. The outcome is `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`, low 64 bits, and the wallet checks the revealed secret and seed against the pot and its seed hash.
- **Neither the wheel nor the casino can choose the number alone; together they could.** The wheel never knows the secret, the casino fixed it before the seed, and the casino sees the seed only when the pot is resolved: while chips go down, nobody knows the number, so nobody can take or turn away a bet by what it would win.
- **The wheel can stall, not steal.** A pot it never resolves is void once the window it asked for has run from the first entry, and every entry refunded.

Read [pots](../../docs/protocol.md#pots) before you build on this.

## Run it

You need Node 24.4 or later.

The casino the wheel talks to must be the one the players' wallets use. With the full local stack, caserver's `npm run dev` runs the Worker, page and wheel together with `wrangler dev`, at `http://127.0.0.1:8790`, against its own casino and with a fresh key for the wheel, and publishes the game in `@hookedin` with that key as its referee. Against another wallet, run `npm ci` in this repository's root, then in `games/roulette`:

```sh
npx wrangler dev --var REFEREE_KEY:0xYourWheelKey --var DEVELOPER:0xYourAddress --var GAME_NAME:roulette
```

`REFEREE_KEY` is the wheel's key, a private key you generated for this purpose; `DEVELOPER` and `GAME_NAME` are the address and name you publish the game under. The wheel talks to the `CASINO_URL` in [wrangler.jsonc](wrangler.jsonc), the public deployment's casino; for another, add `--var CASINO_URL:` and its casino (the `casino` value in the wallet's `config.js`). Then, in the wallet, publish the game under `GAME_NAME` with `http://127.0.0.1:8790/manifest.json`, whose `referee` is the wheel key's address, and open it.

`wrangler dev` builds the page into `dist/` as it starts, and again whenever `src/` changes.

## Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/`, `test/`, `server/` and [wrangler.jsonc](wrangler.jsonc) over it; there, set the build command in `wrangler.jsonc` to `npm run build`.

### What to change first

- [src/manifest.json](src/manifest.json): `id`, `name`, `description`, `developer` (your address) and `referee` (the address of the wheel's key).
- [wrangler.jsonc](wrangler.jsonc): `DEVELOPER` and `GAME_NAME`, the address and name you publish the game under.
- A different shared game is a different [src/table.ts](src/table.ts): what the outcome means and how a player's choices become prizes. A crash game with automatic cash-out is nested ranges (`[0, t(m))` pays `m × stake`); a wheel of fortune is one range per segment. The wheel's server stays as it is.
- The betting time is `BETTING_MS` in [server/wheel.ts](server/wheel.ts).

You earn half of every entry's commission. It accrues to the address you publish the game under; the casino keeps the other half. See [pricing and commission](../../docs/economics.md).

## Deploy

Whenever `main` is pushed, this repository's [deploy workflow](../../.github/workflows/deploy.yml) publishes the game to Cloudflare by running `npx wrangler deploy` in `games/roulette`, with [wrangler.jsonc](wrangler.jsonc): one Worker that serves the page and runs the wheel. `wrangler.jsonc` sets `CASINO_URL` and builds the page before every deploy, so the same command in `games/roulette` publishes it by hand.

Once, give the Worker the wheel's key: run `npx wrangler secret put REFEREE_KEY` in `games/roulette`, with a private key you generated for this purpose, and publish the game with its address as referee. It holds no money, and a lost one costs nothing but the pots it had open, whose entries are refunded.

A repository made from game-template deploys itself; [its README](https://github.com/hookedin/game-template#deploy) says how.

The build writes `dist/_headers`, which Cloudflare applies by itself. The header that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy, which lets the page talk only to its own origin. Do not host the game on the wallet's own origin; the wallet refuses that too.

## Get listed

Publish it yourself: in the wallet, open **My games** and give the game a name and this manifest's URL; the manifest's `referee` is published with it. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

```sh
node --test games/roulette/test/*.test.ts games/roulette/server/*.test.ts
```

In this repository's root, `npm test` type-checks everything, the page and the server among it, and runs every test; this runs only this game's. They check the table's arithmetic against the casino's own admission rule, and test the wheel and its Durable Object against a stub casino. Pots and the wallet's handling of entries are tested in the [game SDK](../../sdk) and the casino service.

## License

[MIT](../../LICENSE)
