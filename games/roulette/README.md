# HookedIn Roulette

European roulette with one wheel for the whole table: every player's chips ride the same spin. A reference game for [HookedIn](https://play.hookedin.com), and the example of a game played **against the house by many players at once**: every player's own wallet places a bet, and the game's referee draws the whole table on one outcome.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Roulette. It is hosted at `roulette-game.hookedin.com`.

## How to play

1. Choose a chip and click the layout: a number, red or black, odd or even, low or high, a dozen or a column. Right-click takes a chip off.
2. Press **Place bets**. The first time, your wallet asks how much the game may play with. A bet is final once it is in.
3. The wheel spins twenty seconds after the first chip at the table is down.
4. The ball lands for everyone at once. A number returns 36 for 1, a dozen or a column 3 for 1, and the even-money bets 2 for 1. Zero is the house's: that is the whole 2.7% edge.

There is a wheel for each asset: you join the one for what your wallet plays with, ETH or test coins.

## How it works

Every spin is one **draw**. The pieces are:

- **The table** ([src/table.ts](src/table.ts)): the wheel's 37 pockets are 37 stretches of the spin's 64-bit outcome, a chip is a prize over the stretches of the numbers it covers, and a player's whole layout is **one bet** of at most 37 prizes. The wallet signs it whole, so the player's wallet, not this page, establishes what was offered.
- **The game page** ([src/game.ts](src/game.ts)): lays out the chips, asks the wallet to place them, and reads the landed number from the verified receipt.
- **The wheel** ([server/wheel.ts](server/wheel.ts)): the game's referee. It keeps a round open for the table, committed to its seed before anybody bets, and twenty seconds after the first chip at the table is down it draws the round: every bet on it rides one spin. It is built on `createReferee` from the [game SDK](../../sdk), holds no money and never touches a bet.
- **The casino**: holds each player's stake until the spin, names the table's round by the hash of a secret, admits the round's bets one at a time against those before them, reveals the secret and owes every bet what it won, all in the one request that draws them.
- **Each player's wallet**: checks that the open round's commitment is the wheel's, signs the bet on it, sends it to the casino itself, and checks the revealed seed and secret against the round and the seed hash its bet named before it collects the winnings.

Page and wheel are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the wheel, a Durable Object per asset, on the same origin. The page names its asset with `?asset=`.

### The flow

1. The page polls `GET /api/table`: `{closesAt, now, players, staked, last}`, when the wheel spins, who is at the table, and the last spin. The page counts down to `closesAt` against `now`, the wheel's clock, not its own.
2. The page turns the chips into `{stake, prizes}` and calls `HookedIn.bet({id, stake, prizes, deadline})`, having saved `id` and the terms first. The wallet signs a debit on the wheel's open round and sends it to the casino, which holds the stake: it leaves the game's balance at once, and the bet is final. No bankroll is held for it yet. A bet nobody draws in five minutes comes back.
3. The page tells the wheel somebody bet (`POST /api/table/placed`). The wheel believes the casino, not the page: it reads the open bets on its round, and spins twenty seconds after the first was placed, by the casino's clock.
4. At the time, the wheel calls `referee.draw(asset)`, revealing its seed. The casino admits the round's bets one at a time against those before them: red and black hedge each other, ten players on one number share the room one would have had, and one that does not fit is refunded. It reveals the secret and owes every bet it took what it won, and the next round opens. The number is `pocket(outcome)`, the same for every player.
5. Each page sees a new spin and calls `HookedIn.bet` again with the same `id`: the wallet checks the draw, collects what the bet won, and returns the receipt. The page reads the number from `receipt.outcome`, never from the wheel, and spins to it. A bet placed while the wheel was spinning rides the next spin; one that reaches the casino after its round was drawn comes back, to be placed again.

After a reload the page finds its saved bet's receipt with `HookedIn.receipt(id)`.

### Files

| Path                                                               | What                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [src/table.ts](src/table.ts)                                       | Pockets, spots, and a layout as one bet. Shared by the page and the wheel                              |
| [src/game.ts](src/game.ts), [src/wheel-view.ts](src/wheel-view.ts) | The page and its canvas wheel                                                                          |
| [server/wheel.ts](server/wheel.ts)                                 | The referee: the open bets, the clock, the spin. Everything outside is handed in, so it runs in a test |
| [server/worker.ts](server/worker.ts)                               | The Worker and the Durable Object that holds an asset's wheel                                          |
| [test/](test/)                                                     | The table's arithmetic against the casino's own admission rule, and the wheel against a stub casino    |
| [server/worker.test.ts](server/worker.test.ts)                     | The Durable Object opening its wheel against a stub casino                                             |

## Fairness and trust

- **The game never holds keys or money.** The wallet signs the layout whole and records exactly what it risks and the most it can pay.
- **The spin is fixed before anybody bets.** The casino names the table's round by the hash of a secret, and the wheel commits the hash of its seed to it before the table opens; every bet names both. The outcome is `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`, low 64 bits, and the wallet checks the revealed seed and secret against the hashes its bet named before it collects.
- **Nobody can choose the number, and neither knows it alone.** The wheel never sees the secret before the draw, and the casino never sees the seed. Together they could know it in advance, and turn winning bets away: a bet the draw declines is refunded with the draw on record, so what it would have paid is on its receipt.
- **The wheel can stall, not steal.** It chooses when to spin, never what a bet pays, and a bet it never draws comes back at its deadline.

Read [bets that settle later](../../docs/protocol.md#bets-that-settle-later) before you build on this.

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
- A different shared game is a different [src/table.ts](src/table.ts): what the outcome means and how a player's choices become prizes. A wheel of fortune is one range per segment, and the wheel's server stays as it is; so is a crash game whose players set their cash-out before the round, each cash-out one prize. A game whose players decide while the round runs, a crash game cashed out by hand, is not a draw: its server settles each bet itself, with [terms and a split](../../sdk/docs/game-sdk.md#bets-that-settle-later).
- The betting time is `BETTING_MS` in [server/wheel.ts](server/wheel.ts).

You earn half of every bet's commission. It accrues to the address you publish the game under; the casino keeps the other half. See [pricing and commission](../../docs/economics.md).

## Deploy

Whenever `main` is pushed, this repository's [deploy workflow](../../.github/workflows/deploy.yml) publishes the game to Cloudflare by running `npx wrangler deploy` in `games/roulette`, with [wrangler.jsonc](wrangler.jsonc): one Worker that serves the page and runs the wheel. `wrangler.jsonc` sets `CASINO_URL` and builds the page before every deploy, so the same command in `games/roulette` publishes it by hand.

Once, give the Worker the wheel's key: run `npx wrangler secret put REFEREE_KEY` in `games/roulette`, with a private key you generated for this purpose, and publish the game with its address as referee. It holds no money, and a lost one costs nothing but the bets it had not drawn, which come back at their deadline.

A repository made from game-template deploys itself; [its README](https://github.com/hookedin/game-template#deploy) says how.

The build writes `dist/_headers`, which Cloudflare applies by itself. The header that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy, which lets the page talk only to its own origin. Do not host the game on the wallet's own origin; the wallet refuses that too.

## Get listed

Publish it yourself: in the wallet, open **My games** and give the game a name and this manifest's URL; the manifest's `referee` is published with it. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

```sh
node --test games/roulette/test/*.test.ts games/roulette/server/*.test.ts
```

In this repository's root, `npm test` type-checks everything, the page and the server among it, and runs every test; this runs only this game's. They check the table's arithmetic against the casino's own admission rule, and test the wheel and its Durable Object against a stub casino. Draws and the wallet's handling of them are tested in the [game SDK](../../sdk) and the casino service.

## License

[MIT](../../LICENSE)
