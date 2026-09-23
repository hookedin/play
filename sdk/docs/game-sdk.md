# HookedIn game SDK

A game owns its rules, presentation, state and persistence. The wallet owns the signed channel balance, its keys and settlement. The wallet accepts atomic bets (a stake and the prizes it can pay) and deterministic payments; it never executes game rules and it stores nothing for a game.

## Loading a game

Host a CORS-enabled manifest and an embeddable HTML entry:

```json
{
  "id": "my-game",
  "name": "My game",
  "description": "An independently developed game.",
  "entry": "./index.html",
  "developer": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
}
```

### What the manifest states, and what the wallet does with it

Do not state what your game pays back, and the manifest gives you no field for it. A return a game promises is unverifiable: nothing bounds how often a game wagers the money it holds, so a game promising 99% can still turn a balance over until it is gone, and the number reads as a guarantee it is not. What a player gets instead is measured. The wallet computes the exact return of every bet before it signs it — the stake against every prize's width and payout — and shows that figure against the bet in their history; the casino publishes the same figure for every bet placed in your game, at `GET /api/games/<key>`. Both are arithmetic on bets that really happened, so they cannot flatter you.

Build a game whose table you would be willing to have measured, and prove the floor in your own test rather than in your manifest: the reference games do, over every bet they can place at every stake they take ([plinko](../../games/plinko/test/plinko.test.ts)). Two things make a table pay back slightly less than its arithmetic suggests, so leave room for them: prize ranges are whole outcomes, and payouts are whole units. Both round down, and at dust stakes they dominate — a Plinko board that returns 99% at a thousand wei returns 38% at one wei. `betReturn(bet)` from `@hookedin/play/protocol/risk.ts` returns what the wallet measures, in millionths of the stake.

`referee` is the address of the key your game's server runs its [pots](#pots) with, if it has any. It is published with the game, and the casino lets only that key open, resolve or void the game's pots.

A published game's wallet URL is `/@<alias>/<name>`, or `/~<uname>/<name>` from a publisher with no alias: the name they gave the game in their profile, under the name they play as. Any manifest, published or not, is linkable as `/games/custom?manifest=<encoded manifest URL>`. Opening a link loads the manifest and shows the game; no spending authority comes from the URL. The wallet's other pages are `/`, `/account`, `/wallet`, `/games`, `/bets`, `/bankroll`, `/settings`, `/activity` and a player's own `/@<alias>` or `/~<uname>`.

The wallet embeds the entry with `sandbox="allow-scripts allow-same-origin"`. The game keeps its own origin, so it can use its host's localStorage, IndexedDB and cookies for round state and preferences. Everything else stays denied: no parent DOM, no wallet keys or storage, no browser wallet provider, no top-level navigation, popups, forms, modal dialogs or downloads. The wallet refuses any manifest or entry served from its own origin, because a same-origin frame could remove its own sandbox; the wallet host also sends `frame-ancestors 'none'`, so its pages are never frameable. Modules must support CORS. `hookedin-game build` writes these headers into `dist/_headers`, the file Cloudflare Pages reads; on another host, send the same headers yourself. Assets at the manifest and entry URLs are not content-pinned.

A game is its developer and the name it goes by. Publish your game yourself, from the account its manifest names as `developer`: in the wallet, open **My games** and give the game a name (`[a-z0-9-]`, at most 32 characters) and its manifest URL. It is then at `@<your alias>/<game name>` — or `~<your uname>/<game name>` if you have no alias — for anyone, and in your library. A profile holds a hundred games, and publishing needs a funded ETH channel. Whoever publishes a game is its developer: the wallet refuses a published game whose manifest names anyone else, so a host that is taken over cannot redirect your commission. The URL is only where the game is served. Move hosts by publishing the same name at the new URL, and the game keeps its key, its bets and its players' receipts. The library a deployment ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json); to be in it, open an issue or pull request on [hookedin/play](https://github.com/hookedin/play). A manifest that is published nowhere can still be loaded directly: open Games, choose **Add a custom game** and paste the manifest URL. It then goes by its manifest URL, so it is a different game from any you publish.

## Game balances

A game's balance is a spending limit for the open tab: the money the wallet lets the game risk, including its winnings. It is never persisted. Leaving the game, navigating to another wallet page, reloading or closing the tab releases the limit back to the channel balance; the money was never anywhere else. Every wager or payment must fit the limit. Verified profits raise it; losses and payments lower it. Games cannot change the limit or choose their fee recipient. Their own wagers and payments are the only signatures a game can obtain.

The wallet pushes a `game.balance` event into the iframe as soon as it has loaded and whenever the limit or pending state changes, so there is nothing to poll; `HookedIn.balance()` resolves to the latest push. A game asks for money with `game.requestFunds`. The wallet then shows its own dialog, where the player sets the game's spending limit or declines, and replies with whether they set it (`funded`), the limit they chose (`amount`) and the resulting balance. The game's suggested `amount` is how much more than it has now; it is shown to the player and does not bind the wallet. Every word in that dialog is the wallet's own: a game passes it no text. The player can also raise or lower the limit from the wallet's top bar at any time, including while one of your operations is pending: the limit is the tab's own reservation and signs nothing, so it runs up to the signed balance less what that operation has already committed. The game learns of every change through `game.balance`. Only the player's confirmation in that dialog grants spending authority; the wallet page shows no funding control of its own, so a game that needs money must ask. Without an open channel, `game.balance` reports a zero balance, financial methods fail, and `game.requestFunds` replies `funded: false` after the wallet has offered the player its channel setup; a game should render normally and simply ask again later.

### ETH and test coins

A wallet plays in one asset: the network's ETH, or the casino's test coins, which every wallet has and nobody can win or lose anything real with. A game needs no code for either; it reads `asset` from `wallet.hello` and formats amounts with it. The player chooses in the wallet, which reloads the game, because a spending limit is in one asset. A round belongs to one asset too.

The game can lose its entire limit, including winnings. The wallet verifies individual wagers and the limit. It does not certify the game's advertised rules, its animations, or that a game it has funded finishes. Each wager must independently pass casino risk admission.

## Bridge

Use the `HookedIn` object from [src/sdk.ts](../src/sdk.ts) (`import { HookedIn } from '@hookedin/play/sdk/sdk'`) or exchange envelopes yourself:

```js
parent.postMessage({ hookedin: true, id: 1, method: 'wallet.hello', params: {} }, '*');
```

Replies carry the same `id` and either `result` or `error: {code, message}`. Both sides check the exact window sending the message, and the wallet also checks that the message comes from the origin of your entry page and answers only that origin, so keep the game on the origin it was loaded from. The wallet accepts requests only from its active iframe and bounds message sizes (70,000 characters a request). Questions (`wallet.hello`, `wallet.info`, `game.receipt`) are answered at once, also while a bet or the player's dialog is open. Everything else signs something or asks the player, and takes its turn in the order you asked; at most 32 requests wait. The envelope `id` is a non-negative safe integer that must rise with every request (the SDK counts from 1); the wallet refuses one that does not. It routes one reply; the `id` inside a financial request is the game's durable name for that operation.

| Method              | Parameters                          | Result                                                                               |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `wallet.hello`      | `{}`                                | `{methods, asset: {id, symbol, decimals}, chainId, limits}`: what this wallet offers |
| `wallet.info`       | `{}`                                | `{uname, alias, chainId, bankroll, recommendedStake}`: the player's two names        |
| `game.receipt`      | `{id}`                              | The receipt of a previous operation by its game ID, or `null`                        |
| `game.bet`          | `{id, stake, prizes}`               | Verified result or rejection receipt                                                 |
| `game.enter`        | `{id, pot, stake, prizes?, quote?}` | The entry's receipt at once, and once the pot has ended, what it paid                |
| `game.payment`      | `{id, amount}`                      | Verified signed receipt                                                              |
| `game.requestFunds` | `{amount?}`                         | `{funded, amount, balance, pending}` after the player's decision                     |

`HookedIn` has a typed method for each: `receipt`, `bet`, `enter`, `payment` and `requestFunds`; `HookedIn.call(method, params)` sends any of them.

Every reply about an operation is one receipt, whichever method asked: `{id, kind, status, verified}` under your own `id`, a bet's `stake` and `prizes` as they played, a settled bet's `outcome` and `payout`, an entry's `pot`, and once its pot has ended its `payout` and, unless the pot was void, its `outcome`; and a rejection's or a void pot's `reason`. The signed evidence, the player's channel and its balance stay in the wallet.

Unsolicited messages from the wallet carry `event` instead of `id`:

| Event          | Fields               | When                                               |
| -------------- | -------------------- | -------------------------------------------------- |
| `game.balance` | `{balance, pending}` | The game's spending limit or pending state changed |

`wallet.hello` also carries `limits`: `prizes`, the most one bet holds; `outcomeSpace`, the size of the space a prize range lies in; and `entries`, the most one pot holds. Read them rather than assuming them — a deployment can change any of them, and a game carrying its own copies would not know. A referee reads the same from the casino's `GET /api/config`, which adds the betting windows it takes for a house pot.

Amounts are whole numbers of the asset's smallest unit, as decimal strings: `wallet.hello` names the asset and its `decimals`, and `HookedIn.parseAmount`, `formatAmount` and `exactAmount` convert with them, so a game never assumes a unit. A bet is a `stake`, paid to enter, and 1 to 64 `prizes`. Each prize is `{rangeStart, rangeEnd, payout}`: it pays when the round's outcome, a uniform integer below `2^64`, falls in `[rangeStart, rangeEnd)`, so its probability is its width over `2^64`. Prizes may overlap, and then they add; an outcome in no prize pays nothing; a prize smaller than the stake is a partial loss. The balance moves by `−stake + every prize that holds the outcome`. Casino commissions do not add another player debit. A payment subtracts `amount` with no commission. All operations are off-chain channel updates.

The wallet signs the whole bet, so the player's wallet, not your page, establishes what was offered: it records the exact return and the most the bet could pay with every receipt. A settled receipt carries `outcome`, the round's 64-bit value, and `payout`, what the prizes paid. Read your presentation from `outcome`: which bucket, which card, which reel stops. A result shown that way is a function of the verified outcome and needs no randomness of your own. [Plinko](../../games/plinko/) reads the ball's whole path from it, and [src/round.ts](../src/round.ts) reports where in the hit range the outcome fell for games that show one of several equivalent results.

For example, a coin flip that doubles the stake 49% of the time:

```js
HookedIn.onBalance(({ balance }) => render(balance));
const funding = await HookedIn.requestFunds({ amount: '1000000000000' });
if (!funding.funded) return; // The player declined; the balance is unchanged.
const id = crypto.randomUUID();
persist({ id }); // Your own storage, before the wallet signs anything.
const receipt = await HookedIn.call('game.bet', {
  id,
  stake: '1000000000000',
  prizes: [{ rangeStart: '0', rangeEnd: '9038904596117680291', payout: '2000000000000' }],
});
// A verified rejection leaves the balance unchanged; offer the same bet again under a fresh id.
if (receipt.status === 'signed') {
  // receipt.payout is '2000000000000' or '0'; receipt.outcome is the round's verified 64-bit value.
}
```

A table with more distinct prizes than one bet holds can still be played by [collapsing it client-side](collapsing-bets.md), at a cost in what the wallet can verify. None of the sample games needs to.

### Pots

Several players share **one outcome** by entering a **pot**: a roulette wheel, a crash curve, a football match. The game's server is the pot's **referee**. A referee is just a key, the one you publish the game with as its manifest's `referee`: it needs no channel and holds no money. It opens pots, and ends them.

```ts
import { createReferee, roundOutcome } from '@hookedin/play/sdk/referee';

const referee = await createReferee({ casinoURL, key, game: { developer, name } });
// A house pot, against the bankroll: a seed is drawn here and only its hash is sent. 20 seconds is this
// game's betting time: it runs from the pot's first entry, and it is how long a player's money waits.
const { pot, seed } = await referee.open({ bank: 'house', asset: 'eth', window: 20_000 });
// ...give `pot.id` to the pages, keep `seed` with your game state and show it to nobody; each wallet enters by itself...
const now = await referee.pot(pot.id); // who is in: {entries: [{uname, alias, stake, prizes}], closesAt, ...}
const ended = await referee.resolve(pot.id, { seed }); // only now does the seed leave you: the casino reveals its secret
const outcome = roundOutcome(seed, ended.secret); // the 64-bit value every entry's prizes were read against
```

The page calls `HookedIn.enter({id, pot, stake, prizes})`. The wallet signs a debit into the pot and **sends it to the casino itself**: the reply is the entry's receipt, the stake has left the game's balance, and **the entry is final** — there is no taking it back. The referee never touches an entry. Once the pot has ended, the same call with the same `id` and terms returns the receipt with what the entry was paid: the wallet checks what ended the pot, collects the payout into the channel and raises the game's limit by it. So have your server tell its pages that the pot has ended, and let each ask its wallet again. After a reload, `game.receipt` finds the entry, and its `payout` once collected. The referee relays nothing the wallet relies on.

A pot has a **bank**, which settles the difference between what it takes in and what it pays:

- **`house`**: played against the bankroll, like a bet, with one 64-bit outcome for every entry. Equal ranges pay together, disjoint ranges never both pay, and a player's several chips are simply their prizes. The casino admits entries one at a time against the whole pot: entries on the same side share the capacity one would have had, entries on opposite sides hedge each other, and one that does not fit is declined by itself with a verified rejection receipt. Price a layout before asking for it with the casino's own rule ([`admits`](../src/admits.ts)). Ask for the betting time your game takes, and no more: `window`, within `referee.window` (which the casino publishes), runs from the pot's **first entry**, and the pot is void if you have not resolved it by then, so leave room for the resolution itself. An empty house pot waits ten minutes for its first entry. You keep the seed until you resolve: the casino sees only its hash while it admits entries, so nobody knows the outcome meanwhile, but you and the casino together could choose it. [Roulette](../../games/roulette/) is the reference.
- **`developer`**: pays at odds you set, on an outcome you name. Open it with `outcomes`, `closesAt` and `deadline`; price each entry with `referee.quote(pot, stake, prizes)`, prizes over the outcome numbers `0` to `outcomes − 1`, and the page passes the quote to `HookedIn.enter` with those prizes. End it with `referee.resolve(pot, {outcome})`. What the pot pays beyond its entries comes from your **bank** at the casino, which keeps what it does not pay: deposit into it, and take money out, on the wallet's **My games** page. Nothing in it is reserved, but a pot your bank cannot pay in full is not resolved, and at its deadline every entry is refunded. The result is your word, signed.
- **`players`**: players against each other. Open it with `rake`, the most you may keep in basis points, `closesAt` and `deadline`; entries hold no prizes. End it with `referee.resolve(pot, {split: [{entry, amount}], rake})`, which pays out exactly what the pot took in. The rake is shared like commission, half yours.

`referee.void(pot)` calls a pot off, and a pot nobody resolves by its deadline is void: every entry is refunded. A pot is played in one asset, ETH unless you name another, and a wallet playing something else is declined, so run pots for each asset your game takes. A pot holds up to 256 entries. See [pots](../../docs/protocol.md#pots).

`id` is 1–64 characters of letters, digits, `.`, `_`, `:` or `-`. The wallet scopes it by channel and game, so another game cannot reuse it. The same `id` with the same terms returns the saved receipt; changing the terms fails. There is at most one pending channel operation.

**One Worker.** A game with a referee ships page and server as one Cloudflare Worker: `dist/` as static assets and a `server/worker.ts` that answers `/api/`, with a Durable Object for its state. Page and server share an origin, so the build's `connect-src 'self'` holds. The server takes `CASINO_URL`, `DEVELOPER` and `GAME_NAME` as variables and `REFEREE_KEY` as a secret (`wrangler secret put REFEREE_KEY`; locally, `.dev.vars`). For local play, the casino's launcher runs such a game in [games/](../../games/) with `wrangler dev`, against its own casino and with a fresh `REFEREE_KEY`, and publishes it in `@hookedin` at the address its `wrangler.jsonc` gives `wrangler dev`, with that key as its referee.

## State and recovery

Keep round state at your own origin, keyed by the game page, the player's `uname` from `wallet.info` (`HookedIn.info()`) and the asset in play: games that share a host would otherwise read each other's rounds, accounts that share a browser would read each other's state, and ETH play would read the state of test-coin play. `HookedIn.storageScope(info)` builds such a key. Key by `uname`, which is theirs for good, never by `alias`, which is whatever they are called today. `HookedIn.showName(info)` writes either of them the way they are written everywhere: `@Bob`, or `~uname` without an alias. Choose and save your action and its operation `id` before requesting settlement. After a crash or reload, read your saved pending operation and call `game.receipt` with its `id`: a receipt means the wallet settled it and the outcome applies exactly once; `null` with a pushed `pending` of true means the wallet still holds the signed request, and the player recovers it from the wallet's banner; `null` otherwise means nothing was signed on the channel the player has now.

An `id` belongs to the channel it was signed on. Once the player has opened a new channel, `game.receipt` finds nothing for an `id` the one before settled: its result is in the player's wallet history, not in reach of the game. Sending the request again then places a second bet. So save an `id` only for as long as its request is in flight, and when a reload finds one with no receipt and nothing pending, ask the player before sending it again rather than doing it silently.

A receipt with `status: "rejected"` and `verified: true` proves cancellation through a jointly signed higher-sequence checkpoint. It has no outcome, balance change or commission. Offer the same bet again under a fresh `id`; the old `id` keeps returning the rejection. A timeout or generic error proves no cancellation: retry the exact pending request with the same `id`.

Round state does not travel in wallet backups or to another browser, and the spending limit does not survive a reload. Money does: every atomic step settles the channel balance, so an abandoned round leaves the wallet holding its current value, and a resumed round simply asks for funds again.

The optional [src/round.ts](../src/round.ts) helper (`RoundClient`) keeps the round in the game origin's localStorage under that scope (its page path by default, or a `name` option), keeps the pending step across rejection and reload, resolves lost replies through `game.receipt`, and asks the wallet for money through `game.requestFunds` when a step needs more than the limit holds: it suggests the shortfall plus four stakes so one authorization lasts. Every started round carries an `id`, so a game with state beyond one round, such as the slot's bonus counter, applies a finished round exactly once. Two tabs of one game share its origin storage; the helper re-reads the round before every action and `watch(listener)` reloads it when another tab writes, while the wallet's single pending operation per channel keeps the money consistent regardless. The wallet also allows only one funded game per wallet across tabs. [src/bank.ts](../src/bank.ts) (`mountBank`) renders the balance strip the sample games show, listening to `game.balance` events and offering an **Add funds** button. Its `hold` keeps the shown figure still while a game is revealing a settled result. Given the game's `RoundClient` (`mountBank(element, { round })`), it also leaves out the cash inside an unfinished round and stands still while a step settles: between steps the wallet's limit holds the round's continuation cash, which is not a cash-out quote, so a hand's running value is never shown as money. The figure drops by what the player put in and rises by what the round finally pays. The sample games bundle the sequential compiler and construct their own graphs. Other games can use different implementations and submit the same atomic operations.

The wallet draws the seed of a bet on its own round; a house pot's seed is its referee's. A game page learns an outcome only from a completed receipt. Casino withholding and changes in shared bankroll can interrupt a game. Signed winnings remain subject to the existing channel settlement and house-liquidity rules.

## Errors

A refused call rejects with a `HookedInError`. Branch on `code`; `message` is for the player.

| Code                 | Meaning                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `invalid-request`    | The request is malformed, or its envelope `id` did not rise                                         |
| `unknown-method`     | This wallet offers no such method; `wallet.hello` lists what it does                                |
| `busy`               | The player is doing something in the wallet, or 32 of your requests already wait                    |
| `no-channel`         | No open channel: call `requestFunds`                                                                |
| `insufficient-funds` | The request exceeds the game's spending limit: call `requestFunds`                                  |
| `pending-operation`  | A signed operation awaits recovery in the wallet; watch the pushed `pending` flag                   |
| `pot-closed`         | The pot takes no more entries                                                                       |
| `wrong-asset`        | The pot is played with another asset than this wallet's                                             |
| `id-conflict`        | This operation `id` is already bound to other terms                                                 |
| `game-closed`        | The game is not the open one                                                                        |
| `failed`             | Anything else. A refusal by the casino carries the casino's own code, such as `paused` or `not-due` |

The SDK itself adds `no-wallet` (the page is not inside a wallet) and `timeout` (no reply in three minutes).

## Developer earnings

Half of each bet's commission is owed to your game's developer: the address that published it, which its manifest names. The casino keeps a running tally of what that address has earned and collected, in each asset, and puts it in that address's own channel. Every developer's totals are public (`GET /api/status`); the channel and its payouts are not. To see it, open an ordinary HookedIn wallet from that address: its wallet page shows the tally, and the wallet collects what is due by itself, so the money becomes part of that channel's signed balance. Nobody at the casino has to approve or send anything. See [developer earnings](../../docs/protocol.md#developer-earnings).
