# HookedIn Blackjack

Blackjack with hit, stand, double, split and insurance, dealt from an unlimited deck. A reference game for [HookedIn](https://play.hookedin.com), and the example of a multi-step game: every step is at most one casino bet, signed and verified by the player's wallet.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Blackjack. It is hosted at `blackjack-game.hookedin.com`.

## How to play

Add funds, set a stake and deal. The table rules follow Stake Originals Blackjack:

| Rule            | Behaviour                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Cards           | Every card is an independent 1-in-52 draw, with replacement (unlimited decks)                             |
| Dealer          | Stands on all 17s, and checks for blackjack before you play                                               |
| Blackjack       | Pays 3:2. Two naturals push                                                                               |
| Wins and pushes | An ordinary win pays 1:1. A push returns the bet                                                          |
| Double          | On any first two cards, including after a split. One more card                                            |
| Split           | One equal-value pair, once, for an additional equal bet. No re-splitting. Both hands face the same dealer |
| Split aces      | One card each. A split 21 is not a natural                                                                |
| Insurance       | Offered against an Ace. Costs half the bet, pays 2:1                                                      |
| Surrender       | None                                                                                                      |

The stake must be an even number of wei. Doubles, splits and insurance need enough additional money in the game balance; the game asks the wallet for more when they do not fit.

The wallet plays with the network's ETH or the casino's test coins; the game is the same either way.

## How it works

### The rules are a graph

The rules live in the game SDK: [src/engine/blackjack.ts](../../sdk/src/engine/blackjack.ts). `createBlackjack({ stake })` builds a finite graph of public states. Each decision node lists the legal actions (`deal`, `hit`, `stand`, `double`, `split`, `insurance`, and the dealer's automatic steps). Each action lists its successor states with exact rational probabilities, one per card, and each terminal node has its gross payout.

### Every step is one bet at most

`RoundClient` from the SDK runs the hand. The SDK's engine works backward through the graph and gives every state a cash value: the least money that finances each action from that state as bets the casino's admission rule accepts. When you act, the successors that need the same cash make one class, and the step becomes:

- nothing, when every successor needs the state's cash;
- a payment of the difference to the bankroll, when every successor needs the same smaller cash, as standing often does;
- otherwise one casino bet between a lower and a higher class, drawn by the page with its own randomness:

```text
stake  = current cash − cash of the lower class
prize  = cash of the higher class − cash of the lower class
```

The page keeps the lower class's cash, which the step cannot lose, and the draw and each bet's chance are weighted so that every class is reached exactly as often as the rules say ([collapsing bets](../../docs/games/collapsing-bets.md)). When one class needs exactly the state's cash and another more, the page can also draw that class with no bet at all. Whatever the outcome, the player's cash after the step is exactly the cash of the class reached. When several cards need that cash, the card dealt is drawn from the round's outcome, so a reload deals the same card. Extra wagers (double, split, insurance) add existing player money through the action's `additionalCash`.

A hand is therefore a short sequence of casino bets. Nothing reserves a whole hand, and stopping between steps leaves the player holding the current signed balance: a [settled trade-off](../../docs/overview/architecture.md#settled-trade-offs). The derivation is in [sequential games built from casino bets](../../docs/games/sequential-games.md).

### The funding table

Pricing the full graph takes time, so [src/game.ts](src/game.ts) passes `RoundClient` a precomputed table, `blackjackFunding` from `@hookedin/play/sdk/generated/blackjack-funding`. It stores each action's required cash at a 1,000,000-wei stake and a planning bankroll of 256 stakes. `RoundClient` uses it when the stake is a multiple of 1,000,000 wei and the casino's bankroll covers 672 stakes, scaling every amount by an exact integer. Any other stake, or a smaller bankroll, falls back to pricing in the page with `compileGameAsync`. Probabilities and payouts are the same either way.

### Return

With optimal play through a completed hand the house edge is exactly

```text
40248916821673328324125295 / 7056410014866816666030739693 = 0.5703880122736%
```

of the initial bet, a return of 99.4296119877264%. Insurance is declined under optimal play. Other strategies do worse. Stopping a hand midway through the wallet is outside this figure.

[test/blackjack-rules.test.ts](test/blackjack-rules.test.ts) proves it. The test computes the optimal value of the game graph and compares it with an independent oracle that calculates dealer probabilities and stand, hit, double and split values from raw totals, without using the graph, the pricing engine or any commission code. Both must equal the exact fraction `7016161098045143337706614398 / 7056410014866816666030739693`. The same file checks each table rule above against the graph.

The wallet measures each bet of a hand on its own, and one bet's return is not the hand's: the same file pins that a step's bet can pay back less than half its stake, and that standing can pay the bankroll with nothing back.

### Files

| File                                                                            | What it holds                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [src/game.ts](src/game.ts)                                                      | Page logic: the `RoundClient`, automatic dealer steps, buttons, recovery                                              |
| [src/view.ts](src/view.ts)                                                      | `blackjackTable` rebuilds the hands from the round's saved card labels; `cardHand` totals them. No display randomness |
| [src/index.html](src/index.html), [src/style.css](src/style.css)                | The table and the rules text                                                                                          |
| [src/manifest.json](src/manifest.json)                                          | What the wallet reads to load the game                                                                                |
| [blackjack.ts](../../sdk/src/engine/blackjack.ts) in the SDK                    | The rules                                                                                                             |
| [blackjack-funding.ts](../../sdk/src/generated/blackjack-funding.ts) in the SDK | The precomputed prices                                                                                                |

The cards on screen are replayed from the labels of settled steps, which `RoundClient` saves in `localStorage`. A reload mid-hand restores the same cards, and a step whose reply was lost is resolved through `game.receipt`.

## Fairness

The game page is untrusted by design. It runs in a sandboxed iframe on its own origin and talks to the wallet only through `postMessage`.

- **The game never holds keys.** It sends the wallet a bet: a stake, a chance and a prize. The wallet checks the bet against the spending limit the player gave this game, signs the exact terms with the channel key and sends them to the casino. Money reaches the game only through the wallet's own **Add funds** dialog, and leaving the game returns the rest.
- **Nobody picks the outcome.** Every casino bet is on a round. The casino fixes the round's secret first and names the round by the secret's hash. The wallet picks its seed only after it has that name, signs the round and the seed's hash into the bet, and reveals the seed with the settlement. The outcome is the low 64 bits of `keccak256(abi.encode(keccak256("HOOKEDIN/OUTCOME"), seed, secret))`.
- **The wallet verifies.** It checks that the revealed secret hashes to the round it signed, recomputes the outcome, pays the prize itself if the outcome is below the chance, and checks the casino's signature on the new balance. Only then does the game receive its receipt: `settled`.
- **The game never sees future entropy.** It learns the outcome only from a completed receipt. It cannot supply the seed and cannot see the secret early. A bet the casino declines comes back with the round's secret, so the wallet shows at once what it would have paid.
- **Which bet a step places is this game's word.** The wallet verifies the bet it signs completely, and knows nothing of the draw that chose it: that cards come as often as an unlimited deck deals them is this page's claim, open source here. A modified page could choose its bets outright; each is one the casino takes on its own, so such a page could misrepresent the game to its player but never harm the bankroll ([what is given up](../../docs/games/collapsing-bets.md#what-is-given-up)).
- **The cards follow the bets.** A step's verified outcome decides the class it reaches and the card within it; a step drawn with no bet deals its card from the page's own draw. You choose an action before its bet is drawn, and the drawn bet is saved before it is signed and kept through a rejection, so nothing is gained by retrying.

The wallet verifies each bet. It does not certify a game's advertised rules or animations, which is why the rules here are open source and the presentation is drawn from the settled result. See the [protocol](../../docs/overview/how-it-works.md) and [pricing and commission](../../docs/reference/economics.md).

## Run it

You need Node 24.4 or later. From play's root:

```sh
npm ci
node sdk/bin/hookedin-game.js serve games/blackjack
```

This builds the game into `dist/` and serves it at `http://127.0.0.1:4185` (set `PORT` to move it). Then:

1. Open the wallet at [play.hookedin.com](https://play.hookedin.com).
2. Go to **Games**, choose **Add a custom game** and load `http://127.0.0.1:4185/manifest.json`.

A game served from your own machine works against any HookedIn wallet and casino, because the wallet loads the manifest and the page from your browser. Testing against a fully local stack needs the casino server, which is private; its `npm run dev` runs this game with the rest of the stack. Most developers should use the public Sepolia deployment at play.hookedin.com.

Every page load rebuilds the game, so reload to see a change.

### Make your own

Start a repository from [game-template](https://github.com/hookedin/game-template) and copy this game's `src/` and `test/` over it. What to change first:

- [src/manifest.json](src/manifest.json): `id`, `name`, `description`, and `developer` (your address, in place of the one it ships with).
- The table: [src/index.html](src/index.html), [src/style.css](src/style.css) and the card rendering in [src/game.ts](src/game.ts).

### Changing the rules

The rules file is part of the SDK, so a game that changes them needs its own copy:

1. Copy [src/engine/blackjack.ts](../../sdk/src/engine/blackjack.ts) from the SDK into your `src/`, and change its imports of `./rational.ts` and `./model.ts` to `@hookedin/play/sdk/engine`.
2. In [src/game.ts](src/game.ts) and [src/view.ts](src/view.ts), import `createBlackjack`, `blackjackState` and `addCard` from your copy.
3. The committed funding table does not match your rules. Either pass `undefined` as `RoundClient`'s third argument, which makes it compile prices in the browser at the start of a round, or generate your own table: adapt [scripts/blackjack-funding.ts](../../sdk/scripts/blackjack-funding.ts) from the SDK to import your rules and write the table into your repository.
4. Update [test/blackjack-rules.test.ts](test/blackjack-rules.test.ts) to import your copy. Its independent oracle encodes the current rules, so a rule change needs a matching change there, and the expected return fraction will differ.

Never use the SDK's table with different rules: the prices would be wrong for your graph.

You earn half the commission on every bet placed through your game. It accrues to the manifest's `developer` address on wins and losses alike and is never an extra charge to the player. See [pricing and commission](../../docs/reference/economics.md).

## Deploy

`node sdk/bin/hookedin-game.js build games/blackjack`, run from play's root, writes `dist/`: plain static files. On every push, play's [deploy workflow](../../.github/workflows/deploy.yml) tests the game; on a push to `main` it also publishes it to Cloudflare, running `npx wrangler deploy` in `games/blackjack`, which reads [wrangler.jsonc](wrangler.jsonc). To publish by hand, build it, then run `npx wrangler deploy` in `games/blackjack`. A game made from game-template deploys through the template's own workflow.

Any static host works. It must send the headers in `dist/_headers`, which Cloudflare applies by itself. The one that matters most is `Access-Control-Allow-Origin: *`: the wallet fetches `manifest.json` from a different origin and refuses a game whose manifest it cannot read. The file also sets the page's Content-Security-Policy. Do not host the game on the wallet's own origin; the wallet refuses that too.

Your game is then playable by anyone who loads `https://your-host/manifest.json` as a custom game, or through the link `https://play.hookedin.com/games/custom?manifest=<encoded manifest URL>`.

## Get listed

Publish it yourself: in the wallet, open **My games** and give the game a name and this manifest's URL. It is then at `@<your name>/<game name>` for anyone with a wallet. The library the casino ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json) in this repository; open an issue or a pull request to be in it.

## Tests

From play's root:

```sh
node --test games/blackjack/test/*.test.ts
```

This runs [test/blackjack-rules.test.ts](test/blackjack-rules.test.ts): the exact edge against the independent oracle, that every state is reachable, acyclic and normalized, that all 52 cards are equiprobable, one test per table rule (double, split, split aces, insurance, the dealer's check, naturals), and how far one step's bet can pay back from the hand's return. `npm test` at play's root type-checks and runs it with every other test.

Pricing, the funding table and wallet settlement of blackjack rounds are tested in the [game SDK](../../sdk).

## License

[MIT](../../LICENSE)
