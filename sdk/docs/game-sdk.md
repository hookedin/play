# HookedIn game SDK

A game owns its rules, presentation, state and persistence. The wallet owns the signed channel balance, its keys and settlement. The wallet accepts casino bets (a stake and the prizes it can pay, settled against the casino's bankroll at once), developer bets (bets against your game's developer, which the developer settles) and deterministic payments; it never executes game rules and it stores nothing for a game.

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

Build a game whose table you would be willing to have measured, and prove the floor in your own test rather than in your manifest: the reference games do, over every bet they can place at every stake they take ([plinko](../../games/plinko/test/plinko.test.ts)). Two things make a table pay back slightly less than its arithmetic suggests, so leave room for them: prize ranges are whole outcomes, and payouts are whole units. Both round down, and at dust stakes they dominate — a Plinko board that returns 99% at a thousand wei returns 38% at one wei. `betReturn(bet)` from `@hookedin/play/sdk/admits` returns what the wallet measures, in millionths of the stake.

`developer` is the address of the account you publish the game from. It earns the game's commission, its bank takes the stakes of your game's [developer bets](#developer-bets), if it has any, and its key is the one your game's server settles them with: the casino lets only that key settle them, or place the casino bets that back them.

A published game's wallet URL is `/@<alias>/<name>`, or `/~<uname>/<name>` from a developer with no alias: the name they gave the game in their profile, under the name they play as. Any manifest, published or not, is linkable as `/games/custom?manifest=<encoded manifest URL>`. Opening a link loads the manifest and shows the game; no spending authority comes from the URL. The wallet's other pages are `/`, `/account`, `/wallet`, `/games`, `/bets`, `/bankroll`, `/settings`, `/activity` and a player's own `/@<alias>` or `/~<uname>`.

The wallet embeds the entry with `sandbox="allow-scripts allow-same-origin"`. The game keeps its own origin, so it can use its host's localStorage, IndexedDB and cookies for round state and preferences. Everything else stays denied: no parent DOM, no wallet keys or storage, no browser wallet provider, no top-level navigation, popups, forms, modal dialogs or downloads. The wallet refuses any manifest or entry served from its own origin, because a same-origin frame could remove its own sandbox; the wallet host also sends `frame-ancestors 'none'`, so its pages are never frameable. Modules must support CORS. `hookedin-game build` writes these headers into `dist/_headers`, the file Cloudflare Pages reads; on another host, send the same headers yourself. Assets at the manifest and entry URLs are not content-pinned.

A game is its developer and the name they publish it under: its key, `keccak256(abi.encode(developer, name))`, stays the same wherever it is served. Publish your game in the wallet of the account its manifest names: open **My games** and give the game a name (`[a-z0-9-]`, at most 32 characters) and its manifest URL. It is then at `@<your alias>/<game name>` — or `~<your uname>/<game name>` if you have no alias — for anyone, and in your library. A profile holds a hundred games, and publishing needs a funded ETH channel. The wallet refuses a published game whose manifest names another developer, so nobody else can publish a game you host. The URL is only where the game is served: move hosts by publishing the same name at the new URL, and the game keeps its key, its bets and its players' receipts. The library a deployment ships with is what `@hookedin` publishes, from [catalog.json](../../catalog.json); to be in it, open an issue or pull request on [hookedin/play](https://github.com/hookedin/play). A manifest that is published nowhere can still be loaded directly: open Games, choose **Add a custom game** and paste the manifest URL. It then has the key of its manifest's developer and URL, so it is a different game from any you publish; it earns no developer anything and takes no developer bets.

## Game balances

A game's balance is a spending limit for the open tab: the money the wallet lets the game risk, including its winnings. It is never persisted. Leaving the game, navigating to another wallet page, reloading or closing the tab releases the limit back to the channel balance; the money was never anywhere else. Every bet or payment must fit the limit. Verified profits raise it; losses and payments lower it. Games cannot change the limit or choose their fee recipient. Their own bets and payments are the only signatures a game can obtain.

The wallet pushes a `game.balance` event into the iframe as soon as it has loaded and whenever the limit or pending state changes, so there is nothing to poll; `HookedIn.balance()` resolves to the latest push. A game asks for money with `game.requestFunds`. The wallet then shows its own dialog, where the player sets the game's spending limit or declines, and replies with whether they set it (`funded`), the limit they chose (`amount`) and the resulting balance. The game's suggested `amount` is how much more than it has now; it is shown to the player and does not bind the wallet. Every word in that dialog is the wallet's own: a game passes it no text. The player can also raise or lower the limit from the wallet's top bar at any time, including while one of your operations is pending: the limit is the tab's own reservation and signs nothing, so it runs up to the signed balance less what that operation has already committed. The game learns of every change through `game.balance`. Only the player's confirmation in that dialog grants spending authority; the wallet page shows no funding control of its own, so a game that needs money must ask. Without an open channel, `game.balance` reports a zero balance, financial methods fail, and `game.requestFunds` replies `funded: false` after the wallet has offered the player its channel setup; a game should render normally and simply ask again later.

### ETH and test coins

A wallet plays in one asset: the network's ETH, or the casino's test coins, which every wallet has and nobody can win or lose anything real with. A game needs no code for either; it reads `asset` from `wallet.hello` and formats amounts with it. The player chooses in the wallet, which reloads the game, because a spending limit is in one asset. A round belongs to one asset too.

The game can lose its entire limit, including winnings. The wallet verifies individual bets and the limit. It does not certify the game's advertised rules, its animations, or that a game it has funded finishes. Each casino bet must independently pass casino risk admission.

## Bridge

Use the `HookedIn` object from [src/sdk.ts](../src/sdk.ts) (`import { HookedIn } from '@hookedin/play/sdk/sdk'`) or exchange envelopes yourself:

```js
parent.postMessage({ hookedin: true, id: 1, method: 'wallet.hello', params: {} }, '*');
```

Replies carry the same `id` and either `result` or `error: {code, message}`. Both sides check the exact window sending the message, and the wallet also checks that the message comes from the origin of your entry page and answers only that origin, so keep the game on the origin it was loaded from. The wallet accepts requests only from its active iframe and bounds message sizes (70,000 characters a request). Questions (`wallet.hello`, `wallet.info`, `game.receipt`) are answered at once, also while a bet or the player's dialog is open. Everything else signs something or asks the player, and takes its turn in the order you asked; at most 32 requests wait. The envelope `id` is a non-negative safe integer that must rise with every request (the SDK counts from 1); the wallet refuses one that does not. It routes one reply; the `id` inside a financial request is the game's durable name for that operation.

| Method              | Parameters                                                           | Result                                                                               |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `wallet.hello`      | `{}`                                                                 | `{methods, asset: {id, symbol, decimals}, chainId, limits}`: what this wallet offers |
| `wallet.info`       | `{}`                                                                 | `{uname, alias, chainId, bankroll, recommendedStake}`: the player's two names        |
| `game.receipt`      | `{id}`                                                               | The receipt of a previous operation by its game ID, or `null`                        |
| `game.casinoBet`    | `{id, stake, prizes, group?}`                                        | Its receipt: `settled` or `rejected`                                                 |
| `game.developerBet` | `{id, stake, prizes, round, group?}` or `{id, stake, terms, group?}` | Its receipt at once: `open` or `rejected`. See [below](#developer-bets)              |
| `game.payment`      | `{id, amount, group?}`                                               | Its receipt: `settled` or `rejected`                                                 |
| `game.requestFunds` | `{amount?}`                                                          | `{funded, amount, balance, pending}` after the player's decision                     |

`HookedIn` has a typed method for each: `receipt`, `casinoBet`, `developerBet`, `payment` and `requestFunds`; `HookedIn.call(method, params)` sends any of them.

`group` is a label of 1 to 64 characters for bets and payments that belong together: the steps of one hand, the bets on one match. The player signs it with each, the wallet's bet history shows a group as one row with its net result, and the game's public record at the casino can be read by group. `RoundClient` gives every step of a round its round's `id`.

Every reply about an operation is one receipt, whichever method asked, and every receipt a game gets is one the wallet checked. It is `{id, kind, status}` under your own `id`: `kind` is `casino-bet`, `developer-bet` or `payment`. A casino bet or a payment is `settled` (done, and what it paid is in the channel) or `rejected` (declined with a signed checkpoint that leaves the balance unchanged). A developer bet is `rejected` (the casino did not take it), `open` (its stake is with your developer's bank, the bet final), `settled` (paid what it is owed), `returned` (its developer did not cover it and paid its stake back) or `shorted` (paid less than it is owed, which the wallet can prove). A settled bet's `basis` says what its payout rests on: `outcome`, the round's revealed secret and seed, which the wallet checked against the hashes the bet signed, or `developer`, its developer's signed settlement of a bet with terms, which is the developer's word. With them come a bet's `stake`, `prizes` or `terms`, `round` and `group` as it was placed; a developer bet's `bet`, the hash that names it at the casino and to your server; a bet's `outcome`, once its round is revealed; a developer bet's `owed`, what a bet with prizes is owed; `payout`, what a settled bet paid; and a rejection's `reason`. The signed evidence, the player's channel and its balance stay in the wallet.

Unsolicited messages from the wallet carry `event` instead of `id`:

| Event          | Fields               | When                                                                               |
| -------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `game.balance` | `{balance, pending}` | The game's spending limit or pending state changed                                 |
| `game.receipt` | `{receipt}`          | A developer bet this game placed has been settled, and the wallet has collected it |

`HookedIn.onBalance(listener)` and `HookedIn.onReceipt(listener)` hear them; each returns a function that stops listening.

`wallet.hello` also carries `limits`: `prizes`, the most one bet holds; `outcomeSpace`, the size of the space a prize range lies in; `covers`, the most developer bets one casino bet of your developer covers, and one batch of settlements settles; `terms`, the most a developer bet's terms take as canonical JSON; and `group`, the longest group label. They are part of the protocol revision, and the same numbers the casino reports in `GET /api/config` as `limits`, so a wallet and a casino that disagree stop before signing anything. Read them rather than carrying copies. Your server reads the same as its developer kit's `limits`.

Amounts are whole numbers of the asset's smallest unit, as decimal strings: `wallet.hello` names the asset and its `decimals`, and `HookedIn.parseAmount`, `formatAmount` and `exactAmount` convert with them, so a game never assumes a unit. A bet is a `stake`, paid to enter, and 1 to 64 `prizes`. Each prize is `{rangeStart, rangeEnd, payout}`: it pays when the round's outcome, a uniform integer below `2^64`, falls in `[rangeStart, rangeEnd)`, so its probability is its width over `2^64`. Prizes may overlap, and then they add; an outcome in no prize pays nothing; a prize smaller than the stake is a partial loss. A casino bet moves the balance by `−stake + every prize that holds the outcome`. Casino commissions do not add another player debit. A payment subtracts `amount` with no commission. All operations are off-chain channel updates.

The wallet signs the whole bet, so the player's wallet, not your page, establishes what was offered: it records the exact return and the most the bet could pay with every receipt. The receipt of a settled bet with prizes carries `outcome`, the round's 64-bit value, and `payout`, what the prizes paid. Read your presentation from `outcome`: which bucket, which card, which reel stops. A result shown that way is a function of the verified outcome and needs no randomness of your own. [Plinko](../../games/plinko/) reads the ball's whole path from it, and [src/round.ts](../src/round.ts) reports where in the hit range the outcome fell for games that show one of several equivalent results.

For example, a coin flip that doubles the stake 49% of the time:

```js
HookedIn.onBalance(({ balance }) => render(balance));
const funding = await HookedIn.requestFunds({ amount: '1000000000000' });
if (!funding.funded) return; // The player declined; the balance is unchanged.
const id = crypto.randomUUID();
persist({ id }); // Your own storage, before the wallet signs anything.
const receipt = await HookedIn.casinoBet({
  id,
  stake: '1000000000000',
  prizes: [{ rangeStart: '0', rangeEnd: '9038904596117680291', payout: '2000000000000' }],
});
// A rejection leaves the balance unchanged; offer the same bet again under a fresh id.
if (receipt.status === 'settled') {
  // receipt.payout is '2000000000000' or '0'; receipt.outcome is the round's verified 64-bit value.
}
```

A table with more distinct prizes than one bet holds can still be played by [collapsing it client-side](collapsing-bets.md), at a cost in what the wallet can verify. None of the sample games needs to.

### Developer bets

A casino bet settles against the casino's bankroll in the one request that places it. A game with a server can also take **developer bets**: bets against you, the game's developer, which your server settles — a roulette wheel many players bet on together, a crash curve, a football match. The stake goes into your **bank** at the casino the moment the bet is placed, and the player is paid what your server settles, from that bank. Players trust you to pay, and the wallet tells them so. Your server signs with your key: the key of the account you publish the game from, whose address the manifest names as its `developer`. So the server holds everything that account holds: your games, their commission and your bank. Keep the key as safe as all of that, or publish the game from an account of its own.

The page places a developer bet with `HookedIn.developerBet` (`game.developerBet`). The wallet signs a debit and **sends it to the casino itself**: the reply is the bet's receipt, `open`, with `bet`, the hash that names it; the stake has left the game's balance, and **the bet is final** — there is no taking it back. Your server never touches it. The same request again returns the receipt as it stands. Once your server has settled it, the wallet checks the settlement, works out what the bet is owed, collects what it was paid into the channel, raises the game's limit by it and pushes the new receipt to the page as a `game.receipt` event, which `HookedIn.onReceipt` hears. The wallet looks by itself every few seconds. A page that learns from its own server that its bet has settled can ask `game.receipt` with the bet's `id`: the reply is the receipt as it stands, and the wallet looks at once. After a reload, `game.receipt` finds the bet. Your server relays nothing the wallet relies on. Until the wallet collects it, what the bet is paid is the casino's promise, outside the principal the contract protects, as the [trust model](../../README.md#trust-model) says.

```ts
import { createDeveloper } from '@hookedin/play/sdk/developer';

// Your key, and the name you publish the game under: the two make the game's key.
const developer = await createDeveloper({ casinoURL, key, name });
const { bets, cursor, more } = await developer.bets(); // this game's open developer bets, a page at a time
```

The kit checks `developerProtocol` in the casino's `GET /api/config`, a hash of only what a developer shares with the casino (`DeveloperAccess`, `Commit`, `Settlement`, `BankCasinoBet`, the outcome and the limits), so a change to what only wallets sign does not stop it. Each developer bet comes with its `bet` hash, `uname`, `asset`, `stake`, its `round`, `seedHash` and `prizes` or its `terms`, and `placedAt`, the casino's time it took the bet. `bets({status, group, after, limit})` pages them, of one group if you name one: open ones by hash, read from the start each time; settled ones in the order they settled, so a saved `cursor` never misses one.

**A developer bet with prizes** is provably fair. It names a round of yours: `developer.openRound(asset)` asks the casino for a new round in an asset, the hash of a secret the casino keeps, and commits the seed of your own casino bet on it, derived from your key and the round, before anybody bets on it. Every call names a new round, so keep track of yours: one per table and spin, as many at once as you like.

```ts
const round = await developer.openRound('eth'); // tell your pages round.id
```

The page gets the round's `id` from your server and bets with `HookedIn.developerBet({id, stake, prizes, round})`. The wallet reads the round before it signs: it must be open, yours, in the player's asset and committed. The bet names the round and the seed hash, so its outcome is fixed before it is placed, and neither you nor the casino knows it alone. A round that takes no more bets is refused with `round-closed` before anything is signed.

**Betting on a round ends with your casino bet on it.** When your game is ready — the wheel's betting time is up — your server places one casino bet of its own on the round, from your bank, naming the developer bets it covers:

```ts
const revealed = await developer.casinoBet({ round: round.id, stake, prizes, covers });
```

`covers` names up to `limits.covers` open developer bets on the round, by hash. The casino admits your casino bet against its bankroll like any other, before it reads the round's secret, and reveals the round. Accepted, its stake leaves your bank and what its prizes pay comes back to it, and half its commission is yours, as for any casino bet of your game; declined, it moves no money and covers nothing. The round's outcome then decides what each developer bet on it is **owed**: what its prizes pay if your accepted casino bet covers it, and its stake back if not. Players sign their own prizes, so cover only bets whose prizes you would back. Add up the prizes of the bets you cover into your casino bet's, equal ranges adding and disjoint ranges hedging, and its stake from theirs: your bank then pays exactly what they win, and the bankroll carries the risk. Price a table before offering it with the casino's own rule ([`admits`](../src/admits.ts)). A developer bet that reaches the casino after your casino bet is never covered, and is owed its stake back. The round is your casino bet's ID: save the round before you place it, and placing it again, after a lost reply or a restart, is the same bet with the same answer. `developer.round(id)` reads any round as anyone may. [Roulette](../../games/roulette/) is the reference.

Then settle each developer bet on the round with what it is owed. `owed(bet, round)` from the kit works it out as the wallet does:

```ts
import { owed } from '@hookedin/play/sdk/developer';

await developer.settle(bets.map(bet => ({ bet: bet.bet, player: owed(bet, revealed), casino: 0n })));
```

Pay a covered bet less than it is owed, or leave a winner uncovered, and the player's receipt shows it: `shorted` with what it was owed, or `returned` with what it would have paid.

**A developer bet with terms** pays what your server signs. The page bets with `HookedIn.developerBet({id, stake, terms})`: `terms` is your game's own JSON object, up to `limits.terms` bytes of canonical JSON, saying what the player bet on (a pick and its odds, a cash-out made while the round runs), and the player signs it; its numbers are whole, so write odds like `'2.1'` as strings. A crash game with cash-out by hand settles every bet this way, with a crash point your server keeps to itself: its word. A round cannot do it: to know when to crash, your server would have to reveal the round at take-off, and a revealed round is public, so every page would know the crash point. Your server settles any open bet whenever it chooses:

```ts
await developer.settle(bets.map(bet => ({ bet: bet.bet, player: cashedOut(bet), casino: share(bet) })));
```

**Settling.** `player` is what the player is paid and `casino` what the casino is given, each signed here with a `Settlement` over the bet's hash, both from your **bank**, which took the stake: deposit into it, and take money out, on the wallet's **My games** page. Nothing in it is reserved, and a batch the bank cannot pay is refused whole (`bank-short`). Whether you can pay what your developer bets are owed is between you and your players, outside HookedIn: playing your game trusts you for its payments, and for its outcomes when a bet has terms ([settled trade-offs](../../architecture.md#settled-trade-offs)). Settle each bet the moment it is decided — a spin, a cash-out, a final whistle — so the player is paid at once. The casino asks for about half of what each developer bet is expected to earn you as its `casino` part; nothing enforces it, and a covered bet with prizes paid it already, on your casino bet. Give a bet you should not have taken its stake back. A page can prove to your server that a bet is its own by putting the hash of a secret it keeps in the terms.

A developer bet is in the asset the player plays with. It has no deadline and no refund: it stays open until you settle it, and the game's public record shows how many are. See [developer bets](../../docs/protocol.md#developer-bets).

`id` is 1–64 characters of letters, digits, `.`, `_`, `:` or `-`. The wallet scopes it by player, asset and game, so another game cannot reuse it. The same `id` with the same terms returns the saved receipt; changing the terms fails. There is at most one pending channel operation.

**One Worker.** A game with a server ships page and server as one Cloudflare Worker: `dist/` as static assets and a `server/worker.ts` that answers `/api/`, with a Durable Object for its state. Page and server share an origin, so the build's `connect-src 'self'` holds. The server takes `CASINO_URL` and `GAME_NAME` as variables and `DEVELOPER_KEY` as a secret (`wrangler secret put DEVELOPER_KEY`; locally, `.dev.vars`), the key's address and the name making the game's key. For local play, the casino's launcher runs such a game in [games/](../../games/) with `wrangler dev`, against its own casino and with the key of the local `@hookedin`, which publishes it at the address its `wrangler.jsonc` gives `wrangler dev`.

## State and recovery

Keep round state at your own origin, keyed by the game page, the player's `uname` from `wallet.info` (`HookedIn.info()`) and the asset in play: games that share a host would otherwise read each other's rounds, accounts that share a browser would read each other's state, and ETH play would read the state of test-coin play. `HookedIn.storageScope(info)` builds such a key. Key by `uname`, which is theirs for good, never by `alias`, which is whatever they are called today. `HookedIn.showName(info)` writes either of them the way they are written everywhere: `@Bob`, or `~uname` without an alias. Choose and save your action and its operation `id` before requesting settlement. After a crash or reload, read your saved pending operation and call `game.receipt` with its `id`: a receipt says what became of it, and its result applies exactly once; `null` with a pushed `pending` of true means the wallet still holds the signed request, and the player recovers it from the wallet's banner; `null` otherwise means this wallet has no record of it, and the same request under the same `id` is safe to send.

An `id` is the player's, in one asset and one game, whichever channel it is signed on: on the player's next channel the same `id` finds the operation instead of placing another. A wallet that has lost its receipts, restored from an older backup, has no record of an `id` its player already used on another channel: `game.receipt` returns `null`, and sending the request again is refused with `id-used`, because the operation was carried out and its result is not in this wallet. Do not send it again under another `id` without asking the player.

A receipt with `status: "rejected"` proves cancellation through a jointly signed higher-sequence checkpoint, which the wallet checked. It has no outcome, balance change or commission. Offer the same bet again under a fresh `id`; the old `id` keeps returning the rejection. A timeout or generic error proves no cancellation: retry the exact pending request with the same `id`.

Round state does not travel in wallet backups or to another browser, and the spending limit does not survive a reload. Money does: every step settles the channel balance, so an abandoned round leaves the wallet holding its current value, and a resumed round simply asks for funds again. A player can walk away after any settled step with the cash it left them: a [settled trade-off](../../architecture.md#settled-trade-offs).

The optional [src/round.ts](../src/round.ts) helper (`RoundClient`) keeps the round in the game origin's localStorage under that scope (its page path by default, or a `name` option), keeps the pending step across rejection and reload, resolves lost replies through `game.receipt`, and asks the wallet for money through `game.requestFunds` when a step needs more than the limit holds: it suggests the shortfall plus four stakes so one authorization lasts. Every started round carries an `id`, so a game with state beyond one round, such as the slot's bonus counter, applies a finished round exactly once. It also carries a hash of the rules it is played under, the graph the page builds for its setup. A round saved under other rules is let go once: `restore()` throws an error telling the player that what it held is in their balance, and the next `restore()` returns `null`. Two tabs of one game share its origin storage; the helper re-reads the round before every action and `watch(listener)` reloads it when another tab writes, while the wallet's single pending operation per channel keeps the money consistent regardless. The wallet also allows only one funded game per wallet across tabs. [src/bank.ts](../src/bank.ts) (`mountBank`) renders the balance strip the sample games show, listening to `game.balance` events and offering an **Add funds** button. Its `hold` keeps the shown figure still while a game is revealing a settled result. Given the game's `RoundClient` (`mountBank(element, { round })`), it also leaves out the cash inside an unfinished round and stands still while a step settles, so that the figure moves once a round: it drops by what the player put in and rises by what the round finally pays. The cash it leaves out is the player's all the same: between steps the wallet's limit holds it, and a player who stops keeps it. The sample games bundle the sequential compiler and construct their own graphs. Other games can use different implementations and submit the same casino bets and payments.

The wallet picks the seed of a casino bet on the player's own round; the seed of a casino bet on a developer's round is the developer's. A game page learns an outcome only from a completed receipt. Casino withholding and changes in shared bankroll can interrupt a game. Signed winnings remain subject to the existing channel settlement and house-liquidity rules.

## Errors

A refused call rejects with a `HookedInError`. Branch on `code`; `message` is for the player.

| Code                 | Meaning                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `invalid-request`    | The request is malformed, its envelope `id` did not rise, or it is a `game.developerBet` for a game published nowhere |
| `unknown-method`     | This wallet offers no such method; `wallet.hello` lists what it does                                                  |
| `busy`               | The player is doing something in the wallet, or 32 of your requests already wait                                      |
| `no-channel`         | No open channel: call `requestFunds`                                                                                  |
| `insufficient-funds` | The request exceeds the game's spending limit: call `requestFunds`                                                    |
| `pending-operation`  | A signed operation awaits recovery in the wallet; watch the pushed `pending` flag                                     |
| `id-conflict`        | This operation `id` is already bound to other terms                                                                   |
| `id-used`            | Carried out on another channel, and this wallet has lost the receipt: ask the player before a fresh `id`              |
| `round-closed`       | A developer bet names a round that takes no more bets: its developer's casino bet revealed it                         |
| `game-closed`        | The game is not the open one                                                                                          |
| `failed`             | Anything else. A refusal by the casino carries the casino's own code, such as `paused` or `not-due`                   |

The SDK itself adds `no-wallet` (the page is not inside a wallet) and `timeout` (no reply in three minutes).

## Developer earnings

Half of each casino bet's commission is owed to your game's developer: the account that publishes it, which its manifest names. A game nobody publishes earns no developer anything. The casino keeps a running tally of what that address has earned and collected, in each asset, and puts it in that address's own channel. Every developer's totals are public (`GET /api/status`); the channel and its payouts are not. To see it, open an ordinary HookedIn wallet from that address: its wallet page shows the tally, and the wallet collects what is due by itself, so the money becomes part of that channel's signed balance. Nobody at the casino has to approve or send anything. See [developer earnings](../../docs/protocol.md#developer-earnings).
