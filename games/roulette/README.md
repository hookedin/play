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
- **The game page** ([src/game.ts](src/game.ts)): lays out the chips, asks the wallet to place them on the table's round, and reads the landed number from the settled receipt the wallet sends it.
- **The wheel** ([server/wheel.ts](server/wheel.ts)): the game's referee. It keeps the table's round, named by the casino and committed to the wheel's seed before anybody bets, saves it and names it to the pages. Twenty seconds after the first chip on it is down, and at the latest five seconds before its deadline, it draws the round: every bet on it rides one spin. It is built on `createReferee` from the [game SDK](../../sdk), holds no money of its own and never touches a bet.
- **The casino**: names the table's round by the hash of a secret, holds each player's stake, and takes each bet against the bankroll as it is placed, with every bet on the round before it. When the wheel draws the round, it reveals the secret and owes every bet on it what it won.
- **Each player's wallet**: checks that the round the page names is open, this game's and committed by the wheel, signs the bet on it, sends it to the casino itself, and checks the revealed seed and secret against the round and the seed hash its bet named before it collects the winnings and sends the page the receipt.

Page and wheel are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the wheel, a Durable Object per asset, on the same origin. The page names its asset with `?asset=`.

### The flow

1. The page polls `GET /api/table`: `{round, closesAt, now, players, staked, last}`, the round to bet on, when the wheel spins, who is at the table, and the last spin. The page counts down to `closesAt` against `now`, the wheel's clock, not its own.
2. The page turns the chips into `{stake, prizes}` and calls `HookedIn.place({id, stake, prizes, round})` on the table's round, having saved `id`, the terms and the round first. The wallet signs a debit on the round and sends it to the casino, which takes it against the bankroll with every bet on the round before it: red and black hedge each other, and ten players on one number share the room one would have had. The casino holds the stake: it leaves the game's balance at once, and the bet is final. A bet the round cannot take is declined, and the chips are the player's again. A bet nobody draws by its round's deadline, ten minutes after the casino named the round, comes back.
3. The page tells the wheel somebody bet (`POST /api/table/placed`). The wheel believes the casino, not the page: it reads the open bets on its round, and spins twenty seconds after the first was placed, by the casino's clock, or five seconds before the round's deadline if that comes first.
4. At the time, the wheel calls `referee.draw(round)` on the round it saved, revealing its seed. The casino reveals the secret and owes every bet on the round what it won. The number is `pocket(outcome)`, the same for every player. The wheel's next look opens the next round; a wheel whose draw reply was lost sees another round taking bets than the one it saved, reads the saved one (`referee.round`) and records where the ball landed.
5. The page sees its round in `last` and asks its wallet about the bet (`HookedIn.receipt(id)`), so the wallet looks at once: it checks the draw, collects what the bet won, and sends the settled receipt, which the page hears with `HookedIn.onReceipt`. The page reads the number from `receipt.outcome`, never from the wheel, and spins to it. A bet too late for its round is turned away, and its chips stay on the layout for the next spin.

After a reload the page finds its saved bet's receipt with `HookedIn.receipt(id)`.

### Files

| Path                                                               | What                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [src/table.ts](src/table.ts)                                       | Pockets, spots, and a layout as one bet. Shared by the page and the wheel                                    |
| [src/game.ts](src/game.ts), [src/wheel-view.ts](src/wheel-view.ts) | The page and its canvas wheel                                                                                |
| [server/wheel.ts](server/wheel.ts)                                 | The referee: the round, its bets, the clock, the spin. Everything outside is handed in, so it runs in a test |
| [server/worker.ts](server/worker.ts)                               | The Worker and the Durable Object that holds an asset's wheel                                                |
| [test/](test/)                                                     | The table's arithmetic against the casino's own admission rule, and the wheel against a stub casino          |
| [server/worker.test.ts](server/worker.test.ts)                     | The Durable Object opening its wheel against a stub casino                                                   |

## Fairness and trust

- **The page never holds keys or money.** The wallet signs the layout whole and records exactly what it risks and the most it can pay.
- **The spin is fixed before anybody bets.** The casino names the table's round by the hash of a secret, and the wheel commits the hash of its seed to it before the table opens; every bet names both. The outcome is `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`, low 64 bits, and the wallet checks the revealed seed and secret against the hashes its bet named before it collects.
- **Nobody can choose the number, and neither knows it alone.** The wheel never sees the secret before the draw, and the casino never sees the seed. Together they could know it in advance, and decline winning bets as they come; a declined bet can be checked against the round's draw, which is public.
- **The wheel can stall, not steal.** It chooses when to spin, never what a bet pays, and a bet it never draws comes back at its round's deadline.
- **The casino holds the bet.** Its stake leaves the channel when it is placed, and what it pays, or refunds, is the casino's promise until the wallet collects it: until then it is outside the principal the contract protects, as the [trust model](../../README.md#trust-model) says.

Read [bets that settle later](../../docs/protocol.md#bets-that-settle-later) before you build on this.

## Run it

You need Node 24.4 or later.

The casino the wheel talks to must be the one the players' wallets use. With the full local stack, caserver's `npm run dev` runs the Worker, page and wheel together with `wrangler dev`, at `http://127.0.0.1:8790`, against its own casino and with a fresh key for the wheel, and publishes the game in `@hookedin` with that key as its referee. Against another wallet, run `npm ci` in this repository's root, then in `games/roulette`:

```sh
npx wrangler dev --var REFEREE_KEY:0xYourWheelKey --var PUBLISHER:0xYourAddress --var GAME_NAME:roulette
```

`REFEREE_KEY` is the wheel's key, a private key you generated for this purpose; `PUBLISHER` and `GAME_NAME` are the address you publish the game from and the name you publish it under, which make its key. The wheel talks to the `CASINO_URL` in [wrangler.jsonc](wrangler.jsonc), the public deployment's casino; for another, add `--var CASINO_URL:` and its casino (the `casino` value in the wallet's `config.js`). Then set `referee` in [src/manifest.json](src/manifest.json) to the wheel key's address, publish the game under `GAME_NAME` with `http://127.0.0.1:8790/manifest.json` from the wallet of `PUBLISHER`, and open it.

`wrangler dev` builds the page into `dist/` as it starts, and again whenever `src/` changes.

## Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/`, `test/`, `server/` and [wrangler.jsonc](wrangler.jsonc) over it; there, set the build command in `wrangler.jsonc` to `npm run build`.

### What to change first

- [src/manifest.json](src/manifest.json): `id`, `name`, `description`, `developer` (the address that earns the game's commission) and `referee` (the address of the wheel's key).
- [wrangler.jsonc](wrangler.jsonc): `PUBLISHER` and `GAME_NAME`, the address you publish the game from and the name you publish it under.
- A different shared game is a different [src/table.ts](src/table.ts): what the outcome means and how a player's choices become prizes. A wheel of fortune is one range per segment, and the wheel's server stays as it is; so is a crash game whose players all set their cash-out before the round, each cash-out one prize. A game whose players decide while the round runs is not a draw. A crash game with cash-out by hand is one, even for the cash-outs set before the round: to know when to crash, its server would have to draw at take-off, and a draw is public, so every page would know the crash point. Its server keeps the crash point itself and settles every bet with [terms and a split](../../sdk/docs/game-sdk.md#bets-that-settle-later): its word.
- The betting time is `BETTING_MS` in [server/wheel.ts](server/wheel.ts).

You earn half of every bet's commission. It accrues to the `developer` address the manifest names; the casino keeps the other half. See [pricing and commission](../../docs/economics.md).

## Deploy

Whenever `main` is pushed, this repository's [deploy workflow](../../.github/workflows/deploy.yml) publishes the game to Cloudflare by running `npx wrangler deploy` in `games/roulette`, with [wrangler.jsonc](wrangler.jsonc): one Worker that serves the page and runs the wheel. `wrangler.jsonc` sets `CASINO_URL`, `PUBLISHER` and `GAME_NAME` and builds the page before every deploy, so the same command in `games/roulette` publishes it by hand.

Once, give the Worker the wheel's key: run `npx wrangler secret put REFEREE_KEY` in `games/roulette`, with a private key you generated for this purpose, and publish the game with its address as referee. Roulette's bets are all drawn, so the wheel's key needs no bank and holds no money: a lost key costs nothing but the bets it had not drawn, which come back at their deadline.

A repository made from game-template deploys itself; [its README](https://github.com/hookedin/game-template#deploy) says how.

The build writes `dist/_headers`, which Cloudflare applies by itself. The header that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy, which lets the page talk only to its own origin. Do not host the game on the wallet's own origin; the wallet refuses that too.

## Get listed

Publish it yourself: in the wallet, open **My games** and give the game a name and this manifest's URL; the manifest's `developer` and `referee` are published with it. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

```sh
node --test games/roulette/test/*.test.ts games/roulette/server/*.test.ts
```

In this repository's root, `npm test` type-checks everything, the page and the server among it, and runs every test; this runs only this game's. They check the table's arithmetic against the casino's own admission rule, and test the wheel and its Durable Object against a stub casino. Draws and the wallet's handling of them are tested in the [game SDK](../../sdk) and the casino service.

## License

[MIT](../../LICENSE)
