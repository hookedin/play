# HookedIn game SDK

`@hookedin/play/sdk` is what a HookedIn game is built with: the wallet bridge, a helper for multi-step rounds, an exact pricing engine, a balance strip, synthesized sound, shared styles, and a one-command build.

A HookedIn game is a static web page. The [HookedIn wallet](https://play.hookedin.com) loads it in a sandboxed iframe from the game's own host. The game owns its rules, its presentation and its saved state. The wallet owns the player's keys, the signed channel balance and settlement. The game asks the wallet to place bets through `postMessage`; the wallet signs each bet, sends it to the casino and verifies the result before the game hears about it. A wallet plays with the network's ETH or with the casino's test coins. A game reads which from `wallet.hello` and formats its amounts in that asset.

A bet is a stake plus 1 to 64 prizes. Each prize is a range of a 64-bit outcome and a payout. The outcome comes from a secret the casino committed to beforehand, combined with a seed the player's wallet draws afterwards. Anything that fits that shape can be a game: a dice roll, a Plinko board, a slot spin, a hand of blackjack played one card at a time.

No game states what it pays back, and the manifest has no field for it: nothing bounds how often a game wagers the money it holds, so a promised percentage is unverifiable and reads as a guarantee it is not. What a player gets instead is measured. The wallet works out the exact return of every bet from its own prize table before it signs it and keeps that figure in the player's bet history, and the casino publishes the same figure for every bet placed in a game.

Developers earn half the commission on every bet placed through their game. It is owed to the `developer` address in the game's manifest: the casino keeps the tally, and an ordinary HookedIn wallet opened from that address shows it and collects it by itself.

## Start from the template

The fastest way to build a game is to fork [hookedin/game-template](https://github.com/hookedin/game-template). Its README is the step-by-step developer guide. The reference games are in [games/](../games/); the template is its own repository:

| Game                                                       | What it shows                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [dice](../games/dice/)                                     | The smallest `RoundClient` game: one decision, two outcomes                         |
| [plinko](../games/plinko/)                                 | A one-shot prize table written by hand, with no round helper                        |
| [samson](../games/samson/)                                 | A 243-ways slot whose prize table is counted exactly from its reel strips           |
| [blackjack](../games/blackjack/)                           | A multi-step game with doubles, splits and insurance, priced by the engine          |
| [mines](../games/mines/)                                   | Reveal-or-cash-out, the simplest multi-step graph                                   |
| [roulette](../games/roulette/)                             | Many players against the house, their bets drawn on one outcome a spin by its wheel |
| [game-template](https://github.com/hookedin/game-template) | A bridge probe: every wallet method, sent by hand. The starting point for forks     |

## Install

The SDK is part of play, and the games in [games/](../games/) import it by the package's own name. A game outside this repository installs play as a git dependency on its `main` branch:

```json
{
  "dependencies": {
    "@hookedin/play": "git+https://github.com/hookedin/play.git#main"
  }
}
```

`package-lock.json` records the exact commit, so an install is reproducible, and `npm update` moves a game to the newest one. The template runs exactly that every six hours, and on demand, in its `Update play` workflow, which commits the lockfile and releases the game only if its tests pass. There are no versions and no tags: a push to `main` is the release.

It needs Node 24.4 or later. It ships raw TypeScript, not compiled JavaScript. A game bundles it with esbuild, which the SDK's own build tool does for you. Node-side tests in a game that installs `@hookedin/play` must run as `node --import tsx --test`, because Node does not strip types from files inside `node_modules`; play's own tests run with plain `node --test`.

Package entry points:

| Import                                           | What it is                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `@hookedin/play/sdk`                             | Everything. Browser only: the bridge touches `window` when it loads                                     |
| `@hookedin/play/sdk/engine`                      | The pricing engine. Pure and safe to import in Node                                                     |
| `@hookedin/play/sdk/sdk`                         | The `HookedIn` wallet bridge ([src/sdk.ts](src/sdk.ts))                                                 |
| `@hookedin/play/sdk/round`                       | `RoundClient` ([src/round.ts](src/round.ts))                                                            |
| `@hookedin/play/sdk/bank`                        | `mountBank` ([src/bank.ts](src/bank.ts))                                                                |
| `@hookedin/play/sdk/synth`                       | `createSynth` ([src/synth.ts](src/synth.ts))                                                            |
| `@hookedin/play/sdk/admits`                      | The casino's admission rule ([src/admits.ts](src/admits.ts))                                            |
| `@hookedin/play/sdk/referee`                     | `createReferee`, for a game's own server ([src/referee.ts](src/referee.ts)). Runs wherever `fetch` does |
| `@hookedin/play/sdk/generated/blackjack-funding` | The precomputed blackjack price table                                                                   |

Any other `@hookedin/play/sdk/<module>` resolves to `src/<module>.ts`.

## The wallet bridge

`HookedIn` sends `{ hookedin: true, id, method, params }` to the parent wallet with `postMessage` and resolves when the reply with the same `id` arrives. Questions (`wallet.hello`, `wallet.info`, `game.receipt`) are answered at once; anything that signs or asks the player takes its turn in the order you asked. A refusal rejects with a `HookedInError`: act on its stable `code`, show its `message`.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

HookedIn.onBalance(({ balance, pending }) => render(balance, pending));

await HookedIn.hello(); // what this wallet offers, and the asset it plays with
const stake = HookedIn.parseAmount('0.000001'); // whole smallest units of that asset, as a decimal string
const funding = await HookedIn.requestFunds({ amount: stake });
if (!funding.funded) return; // the player declined

const id = crypto.randomUUID();
localStorage.setItem('pending', id); // save the operation id before the wallet signs anything

const receipt = await HookedIn.bet({
  id,
  stake,
  // 49.5% of the outcome space pays twice the stake: a 99% return.
  prizes: [{ rangeStart: '0', rangeEnd: String(((1n << 64n) * 495n) / 1000n), payout: String(2n * BigInt(stake)) }],
});
if (receipt.status === 'signed' && receipt.verified) {
  // receipt.outcome is the round's verified 64-bit value; receipt.payout is what the prizes paid.
}
```

| Member                                                    | What it does                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `call(method, params)`                                    | Send any bridge request. Rejects with the wallet's error message, or after 180 seconds of silence                                |
| `limits()`                                                | Every bound this wallet holds a bet to: the prizes one holds, the outcome space, the bets one round takes, the furthest deadline |
| `balance()`                                               | The game's latest spending limit `{ balance, pending }`, as pushed by the wallet                                                 |
| `onBalance(listener)`                                     | Called on every `game.balance` push. Returns a function that stops listening                                                     |
| `requestFunds({ amount? })`                               | Ask the player for money. The wallet shows its own dialog, in its own words; resolves `{ funded, amount, balance, pending }`     |
| `receipt(id)`                                             | The outcome of an earlier operation by the game's own `id`, or `null`                                                            |
| `bet({ id, stake, prizes, group? })`                      | One atomic bet on the player's own round                                                                                         |
| `bet({ id, stake, prizes, deadline, group? })`            | A bet on your referee's open round, drawn against the bankroll; the same call returns what it paid once it has                   |
| `bet({ id, stake, terms, deadline, group? })`             | A bet your referee settles by a split; the same call returns what it paid once it has                                            |
| `payment(id, amount, group?)`                             | A deterministic payment to the bankroll                                                                                          |
| `storageScope(info)`                                      | A storage key unique to this page, chain, player and asset, on the player's uname                                                |
| `initializeGame({ stakeInput, assetLabels })`             | Read-only startup: `wallet.hello`, `wallet.info`, the first balance, asset labels and the recommended stake                      |
| `hello()`, `info()`                                       | The wallet's methods and asset `{id, symbol, decimals}`; the player's `{uname, alias, chainId, bankroll, recommendedStake}`      |
| `parseAmount`, `formatAmount`, `exactAmount`, `stepStake` | Amounts in the wallet's asset, whatever its decimals, and a 1-2-5 stake ladder for an input field                                |

The bridge methods are `wallet.hello`, `wallet.info`, `game.bet`, `game.payment`, `game.receipt` and `game.requestFunds`. A `group` labels bets and payments that belong together, the steps of one hand or the bets on one match, and the wallet shows them as one; `RoundClient` gives every step of a round its round's ID. [docs/game-sdk.md](docs/game-sdk.md) is the full reference: parameters, results, recovery after a lost reply and bets that settle later.

`mountBank(element, { round? })` renders the balance strip the reference games show: the money the wallet lets the game risk in this tab, live, with an **Add funds** button. With the game's `RoundClient` it leaves out the cash inside an unfinished round. It shows the asset's symbol and marks test coins. `createSynth()` makes short tones without audio files.

## RoundClient: multi-step games

`RoundClient` runs a game with several steps, such as a hand of blackjack, as one bet per step. You give it a function that builds the game's graph of public states. It prices every state with the engine, and for each action the player takes it:

1. saves the chosen action and a fresh operation `id` in the game's own `localStorage`, before anything is signed;
2. asks the wallet for more money through `game.requestFunds` if the step needs more than the game holds;
3. places the step as one `game.bet` (or a `game.payment`, or nothing when no money moves);
4. checks that the verified payout matches the successor state the outcome names, then advances.

After a reload, `restore()` reads the saved round and resolves a lost reply through `game.receipt`. A verified rejection keeps the same action under a fresh `id`. `watch(listener)` reloads the round when another tab of the same game changes it.

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import { createMines } from '@hookedin/play/sdk/engine';

const round = new RoundClient(HookedIn, setup =>
  createMines({ tiles: 5, mines: 1, cashouts: [120n, 156n, 228n].map(n => (BigInt(setup.stake) * n) / 100n) }),
);
await round.restore();
let state = await round.start({ stake: HookedIn.parseAmount('0.000001') });
state = await round.action('reveal'); // state.actions lists what is legal next
```

The optional third constructor argument is a precomputed `FundingTable`. Blackjack passes one so that a hand starts without pricing 14,065 states in the browser. Without a table, `RoundClient` compiles prices in the page with `compileGameAsync`.

## The engine

[src/engine/](src/engine/) prices finite decision games exactly. A game is a finite acyclic graph of public states with exact rational probabilities. The engine works backward from the terminal payouts and gives every state the least cash that finances each action as one bet the casino's admission rule accepts. It uses bigint arithmetic throughout and draws no randomness for any step that moves money.

| File                                      | What it holds                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| [rational.ts](src/engine/rational.ts)     | Exact fractions                                                                         |
| [model.ts](src/engine/model.ts)           | `GameGraph` and its node, action and outcome types                                      |
| [transition.ts](src/engine/transition.ts) | One step as one bet: `priceTransition`, `compileTransition`                             |
| [engine.ts](src/engine/engine.ts)         | `compileGame`, `loadFundedGame`, `prepareAction`, `resolveTransition`, `evaluatePolicy` |
| [blackjack.ts](src/engine/blackjack.ts)   | The blackjack rules as a graph                                                          |
| [mines.ts](src/engine/mines.ts)           | The Mines rules as a graph                                                              |

[src/admits.ts](src/admits.ts) is the casino's own admission rule, imported from `@hookedin/play/protocol/risk.ts`. A price computed with it is a price the casino will honour.

[src/generated/blackjack-funding.ts](src/generated/blackjack-funding.ts) is a 1 MB table of precomputed blackjack action prices. Regenerate it with `npm run generate:blackjack` after changing the blackjack rules or the pricing code. `npm test` fails when the committed table is stale.

See [docs/engine.md](docs/engine.md) for the API and [docs/sequential-games.md](docs/sequential-games.md) for the derivation.

## The build tool

The package installs a `hookedin-game` command ([bin/hookedin-game.js](bin/hookedin-game.js)).

```sh
hookedin-game build [dir ...]   # each game folder's src/ -> its dist/; the current folder by default
hookedin-game serve [dir]       # serve one on http://127.0.0.1:4185 (PORT moves it)
```

`build` bundles `src/game.ts` with esbuild into `dist/game.js` (ES module, ES2022, with a source map). It copies everything else in `src/` that is not TypeScript, writes `dist/manifest.json`, and adds `shared.css`, the brand mark and a `_headers` file. `dist/` is plain files that any static host can serve.

`_headers` is the format Cloudflare Pages reads. It sets a Content-Security-Policy that lets the page load from and talk to only its own origin, `Access-Control-Allow-Origin: *` so the wallet can fetch the manifest and modules from another origin, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. On any other host, send the same headers.

`serve` builds the game again on every page load, so a change shows on reload.

The wallet refuses a manifest whose `developer` is the zero address, and `build` refuses one that is not a real address: set `developer` in `src/manifest.json` to the address that earns the game's commission.

A game folder needs only this:

```text
src/game.ts         entry point, bundled to dist/game.js
src/index.html      loads ./shared.css, ./style.css and ./game.js
src/style.css
src/manifest.json   { id, name, description, entry, developer }
```

## A game with a server

A game with a server has a **referee**: a key you publish with the game. Its pages place bets that settle later with their own wallets, and the referee settles them: it **draws** bets with prizes against the bankroll, many players on one outcome, and it **splits** bets with terms, whose outcome no prize table can say: a cash-out when the player chooses, a match that ends next month. `createReferee` is the server's side:

```ts
import { createReferee } from '@hookedin/play/sdk/referee';

const referee = await createReferee({ casinoURL, key, game: { developer, name } });
// Before anybody bets: the casino names the round and the referee commits its seed to it, so every bet on it
// has its outcome fixed before it is placed. Players' wallets bet on the open round.
await referee.open('eth');
// A spin: every open bet on the round, drawn on one outcome, each admitted with those before it or refunded,
// and every bet it took is paid. The next round opens with it.
const { outcome, bets } = await referee.draw('eth');

// Splits: the open bets of a group, and what each pays, signed here. Your bank at the casino keeps the rest
// of each stake or pays what the split comes to beyond it.
const open = await referee.bets('round-812');
await referee.settle(open.map(bet => ({ bet: bet.bet, player: cashedOut(bet), casino: share(bet) })));
```

A bet nobody settles by its deadline is refunded. Page and server ship as one Cloudflare Worker: `dist/` as static assets, and a `server/worker.ts` that answers `/api/` on the same origin. [Bets that settle later](docs/game-sdk.md#bets-that-settle-later) explains it; [roulette](../games/roulette/) is the reference for a draw.

## Testing against the real wallet

Game tests do not mock the wallet. `@hookedin/play/testing/game-wallet.ts` builds the real `CasinoWallet` with an in-memory store, an open channel and a stub casino that derives and signs states exactly as the protocol says. A test wires a bridge object to it and hands that to `RoundClient` or to the game's own client:

```ts
import test from 'node:test';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { RoundClient } from '@hookedin/play/sdk/round';

test('a round settles through the wallet', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity('my-game'));
  await w.setGameLimit('200000');
  const bridge = {
    balance: async () => w.gameLimit(),
    call: async (method: string, params: any = {}) => {
      if (method === 'wallet.hello') return w.gameHello();
      if (method === 'wallet.info') return { ...w.gameInfo(), bankroll: '1000000000000' };
      if (method === 'game.receipt') return w.gameReceipt(params.id);
      return method === 'game.bet' ? w.gameBet(params) : w.gamePayment(params);
    },
  };
  const round = new RoundClient(bridge, myGraph, undefined, { store: memoryStore(), name: 'my-game' });
  // myGraph builds your GameGraph; memoryStore() is a get/set/remove RoundStore over a Map.
  // Start a round, act, then assert on w.balance().
});
```

[test/game-client.test.ts](test/game-client.test.ts) is the fullest example: spending limits, lost replies, verified rejections, reloads and two tabs. For a game with a referee the stub casino plays the referee's part too: `f.draw()` draws the referee's open round, `f.settle(bet, player, casino)` splits a bet with terms and `f.refund` lets its deadline pass, so a test bets with `w.gameBet` and asks again for what the bet paid.

The SDK's tests run with the rest of play's, from the repository root:

```sh
npm ci
npm test
```

`npm test` builds the wallet and every game, type-checks, checks the vectors and the blackjack funding table, and runs every suite; [the quick start](../README.md#quick-start) lists what it needs.

## Layout

```text
bin/hookedin-game.js                 build and serve command
src/sdk.ts                           HookedIn wallet bridge
src/round.ts                         RoundClient
src/bank.ts                          mountBank balance strip
src/synth.ts                         createSynth
src/admits.ts                        the casino's admission rule
src/referee.ts                       createReferee, for a game's own server
src/wire.ts                          types shared by the page and the server
src/engine/                          exact continuation pricing, blackjack and mines rules
src/generated/blackjack-funding.ts   precomputed blackjack prices
scripts/blackjack-funding.ts         generator for that table
scripts/demos/                       command-line blackjack and mines demos
shared.css                           shared styles
test/                                bridge, round helper and engine tests
docs/                                reference documentation
```

## Documentation

- [docs/game-sdk.md](docs/game-sdk.md): manifests, the sandbox, game balances, every bridge method, recovery, bets that settle later and developer earnings.
- [docs/engine.md](docs/engine.md): the pricing engine's API.
- [docs/sequential-games.md](docs/sequential-games.md): how a multi-step game becomes a sequence of native bets, with the blackjack rules and exact edge.
- [docs/collapsing-bets.md](docs/collapsing-bets.md): playing a prize table too large for one bet.
- Wallet and protocol: [protocol](../docs/protocol.md), [pricing and commission](../docs/economics.md), [verification](../docs/verification.md).

## License

[MIT](../LICENSE)
