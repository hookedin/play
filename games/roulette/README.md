# HookedIn Roulette

European roulette with one wheel for the whole table: every player's chips ride the same spin. A reference game for [HookedIn](https://play.hookedin.com), and the example of a game played **against the house by many players at once**: every player's own wallet places a developer bet, and the game's wheel backs the whole table with one casino bet of its own.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Roulette. It is hosted at `roulette-game.hookedin.com`.

## How to play

1. Choose a chip and click the layout: a number, red or black, odd or even, low or high, a dozen or a column. Right-click takes a chip off.
2. Press **Place bets**. The first time, your wallet asks how much the game may play with. A bet is final once it is in.
3. The wheel spins twenty seconds after the first chip at the table is down.
4. The ball lands for everyone at once. A number returns 36 for 1, a dozen or a column 3 for 1, and the even-money bets 2 for 1. Zero is the house's: that is the whole 2.7% edge.

There is a wheel for each asset: you join the one for what your wallet plays with, ETH or test coins.

## How it works

Every spin is one round of the wheel's. The pieces are:

- **The table** ([src/table.ts](src/table.ts)): the wheel's 37 pockets are 37 stretches of the spin's 64-bit outcome, a chip is a prize over the stretches of the numbers it covers, and a player's whole layout is **one developer bet** of at most 37 prizes. The wallet signs it whole, so the player's wallet, not this page, establishes what was offered.
- **The game page** ([src/game.ts](src/game.ts)): lays out the chips, asks the wallet to place them on the table's round, and reads the landed number from the settled receipt the wallet sends it.
- **The wheel** ([server/wheel.ts](server/wheel.ts)): the game's developer, with the key of the account the game is published from. It opens the table's round, named by the casino and committed to the seed of the wheel's own casino bet before anybody bets, saves it and names it to the pages. Twenty seconds after the first chip on it is down, it spins: it places one casino bet on the round, from its bank, of every layout on the table together, which reveals the round, and pays every bet what it is owed. It is built on `createDeveloper` from the [game SDK](../../sdk), and never touches a bet.
- **The casino**: names the table's round by the hash of a secret, puts each player's stake in the wheel's bank as the bet is placed, and admits the wheel's casino bet against the bankroll like any other, before it reads the round's secret.
- **Each player's wallet**: checks that the round the page names is open, the wheel's and committed, signs the developer bet on it, sends it to the casino itself, and checks the revealed seed and secret against the round and the seed hash its bet named, and the wheel's signed casino bet and settlement, before it collects the winnings and sends the page the receipt.

Page and wheel are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the wheel, a Durable Object per asset, on the same origin. The page names its asset with `?asset=`.

### The flow

1. The page polls `GET /api/table`: `{round, closesAt, now, players, staked, last}`, the round to bet on, when the wheel spins, who is at the table, and the last spin. The page counts down to `closesAt` against `now`, the wheel's clock, not its own.
2. The page turns the chips into `{stake, prizes}` and calls `HookedIn.developerBet({id, stake, prizes, round})` on the table's round, having saved `id`, the terms and the round first. The wallet signs a debit that names the round and sends it to the casino, which puts the stake in the wheel's bank: it leaves the game's balance at once, and the bet is final.
3. The page tells the wheel somebody bet (`POST /api/table/placed`). The wheel believes the casino, not the page: it reads the open developer bets on its round, and spins twenty seconds after the first was placed, by the casino's clock.
4. At the time, the wheel places its casino bet on the round it saved, covering every open bet on it that is a roulette layout: whole pockets, paying at most 36 times its stake across the 37. Its stake is theirs together and its prizes are theirs added up, at most one per pocket: red and black hedge each other, and ten players on one number stack. The casino admits it against the bankroll and reveals the round; the number is `pocket(outcome)`, the same for every player. The wheel pays each covered bet what its layout pays there, and gives every other bet its stake back: one that is not a layout, one that came too late for the spin, and every bet on a spin the bankroll declines. The wheel's next look opens the next round. A wheel whose casino bet reply was lost places it again on the round it saved, and gets the same answer.
5. The page sees its round in `last` and asks its wallet about the bet (`HookedIn.receipt(id)`), so the wallet looks at once: it checks the round and the wheel's settlement, collects what the bet was paid, and sends the settled receipt, which the page hears with `HookedIn.onReceipt`. The page reads the number from `receipt.outcome`, never from the wheel, and spins to it. A bet whose stake came back is `returned`, and its chips stay on the layout for the next spin.

After a reload the page finds its saved bet's receipt with `HookedIn.receipt(id)`.

### Files

| Path                                                               | What                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [src/table.ts](src/table.ts)                                       | Pockets, spots, a layout as one developer bet, and the table's layouts together. Shared by the page and the wheel |
| [src/game.ts](src/game.ts), [src/wheel-view.ts](src/wheel-view.ts) | The page and its canvas wheel                                                                                     |
| [server/wheel.ts](server/wheel.ts)                                 | The developer: the round, its bets, the clock, the spin. Everything outside is handed in, so it runs in a test    |
| [server/worker.ts](server/worker.ts)                               | The Worker and the Durable Object that holds an asset's wheel                                                     |
| [test/](test/)                                                     | The table's arithmetic against the casino's own admission rule, and the wheel against a stub casino               |
| [server/worker.test.ts](server/worker.test.ts)                     | The Durable Object opening its wheel against a stub casino                                                        |

## Fairness and trust

- **The page never holds keys or money.** The wallet signs the layout whole and records exactly what it risks and the most it can pay.
- **The spin is fixed before anybody bets.** The casino names the table's round by the hash of a secret, and the wheel commits the hash of its seed to it before the table opens; every bet names both. The outcome is `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`, low 64 bits, and the wallet checks the revealed seed and secret against the hashes its bet named before it collects.
- **Nobody can choose the number, and neither knows it alone.** The wheel never sees the secret before its casino bet reveals it, and the casino never sees the seed. Together they could know it in advance and leave winning bets uncovered; every returned bet's receipt shows what it would have paid.
- **A roulette bet is a developer bet: it trusts the wheel's developer to pay.** Its stake is in the developer's bank from the moment it is placed, and the wallet checks what the wheel pays against what the bet is owed and shows any shortfall. What it is paid is the casino's promise until the wallet collects it: until then it is outside the principal the contract protects, as the [trust model](../../README.md#trust-model) says.

Read [developer bets](../../docs/protocol.md#developer-bets) before you build on this.

## Run it

You need Node 24.4 or later.

The casino the wheel talks to must be the one the players' wallets use. With the full local stack, caserver's `npm run dev` runs the Worker, page and wheel together with `wrangler dev`, at `http://127.0.0.1:8790`, against its own casino and with its local house's key, and publishes the game in that house's `@hookedin`. Against another wallet, run `npm ci` in this repository's root, then in `games/roulette`:

```sh
npx wrangler dev --var DEVELOPER_KEY:0xYourKey --var GAME_NAME:roulette
```

`DEVELOPER_KEY` is the private key of the account you publish the game from, and `GAME_NAME` the name you publish it under: the two make its key. The wheel talks to the `CASINO_URL` in [wrangler.jsonc](wrangler.jsonc), the public deployment's casino; for another, add `--var CASINO_URL:` and its casino (the `casino` value in the wallet's `config.js`). Then set `developer` in [src/manifest.json](src/manifest.json) to that account's address, publish the game under `GAME_NAME` with `http://127.0.0.1:8790/manifest.json` from that account's wallet, and open it.

`wrangler dev` builds the page into `dist/` as it starts, and again whenever `src/` changes.

## Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/`, `test/`, `server/` and [wrangler.jsonc](wrangler.jsonc) over it; there, set the build command in `wrangler.jsonc` to `npm run build`.

### What to change first

- [src/manifest.json](src/manifest.json): `id`, `name`, `description` and `developer`, the address of the account you publish the game from.
- [wrangler.jsonc](wrangler.jsonc): `GAME_NAME`, the name you publish the game under.
- A different shared game is a different [src/table.ts](src/table.ts): what the outcome means and how a player's choices become prizes. A wheel of fortune is one range per segment, and the wheel's server stays as it is; so is a crash game whose players all set their cash-out before the round, each cash-out one prize. A game whose players decide while the round runs cannot be one round. A crash game with cash-out by hand is such a game, even for the cash-outs set before the round: to know when to crash, its server would have to reveal the round at take-off, and a revealed round is public, so every page would know the crash point. Its server keeps the crash point itself and settles every bet as a [developer bet with terms](../../sdk/docs/game-sdk.md#developer-bets): its word.
- The betting time is `BETTING_MS` in [server/wheel.ts](server/wheel.ts).

You earn half of the commission on the wheel's casino bets. It accrues to the account you publish the game from; the casino keeps the other half. See [pricing and commission](../../docs/economics.md).

## Deploy

Whenever `main` is pushed, this repository's [deploy workflow](../../.github/workflows/deploy.yml) publishes the game to Cloudflare by running `npx wrangler deploy` in `games/roulette`, with [wrangler.jsonc](wrangler.jsonc): one Worker that serves the page and runs the wheel. `wrangler.jsonc` sets `CASINO_URL` and `GAME_NAME` and builds the page before every deploy, so the same command in `games/roulette` publishes it by hand.

Once, give the Worker the key of the account the game is published from: run `npx wrangler secret put DEVELOPER_KEY` in `games/roulette`. The Worker then holds everything that account holds: its games, their commission and its bank. The bank needs no money of its own: the stakes of the bets the wheel covers pay its casino bet, and what that bet pays pays the winners.

A repository made from game-template deploys itself; [its README](https://github.com/hookedin/game-template#deploy) says how.

The build writes `dist/_headers`, which Cloudflare applies by itself. The header that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy, which lets the page talk only to its own origin. Do not host the game on the wallet's own origin; the wallet refuses that too.

## Get listed

Publish it yourself: in the wallet of the account the manifest's `developer` names, open **My games** and give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

```sh
node --test games/roulette/test/*.test.ts games/roulette/server/*.test.ts
```

In this repository's root, `npm test` type-checks everything, the page and the server among it, and runs every test; this runs only this game's. They check the table's arithmetic against the casino's own admission rule, and test the wheel and its Durable Object against a stub casino. Developer bets and the wallet's handling of them are tested in the [game SDK](../../sdk) and the casino service.

## License

[MIT](../../LICENSE)
