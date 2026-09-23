# HookedIn Sports

Fixed odds on real events, from a book that pays its winners out of its own bank. A reference game for [HookedIn](https://play.hookedin.com), and the example of a **developer's pot**: odds the game sets, an outcome its referee names, and winnings beyond the pot paid by the developer's bank at the casino.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Sports. It is hosted at `sports-game.hookedin.com`.

## How to play

1. Pick an outcome in an open market. Its odds are what a winning bet returns per unit staked: 2.50 turns 1 into 2.5.
2. Enter a stake and press **Place bet**. The first time, your wallet asks how much the game may play with. A bet is final once it is in.
3. When the event is over, the book names the winner, and your wallet collects what your bet won. **Your bets** lists each one and how it ended.

A market the book calls off, or does not resolve by its deadline, refunds every bet.

## How it works

- **The book** ([server/book.ts](server/book.ts)): the game's referee, built on `createReferee` from the [game SDK](../../sdk). A market is a developer's pot in each asset, with the outcomes and odds its operator gave it. It quotes each bet: the stake, and one prize on the chosen outcome of the stake times the odds, signed with its key for a minute. It holds no money.
- **The game page** ([src/game.ts](src/game.ts)): lists the open markets, asks the book for a quote, and asks the wallet to enter the market's pot at it with `HookedIn.enter({id, pot, stake, prizes, quote})`. It saves each bet first, and once the market has ended asks the wallet again, which returns what the bet was paid.
- **The casino**: takes an entry only at the book's quote, and on resolution owes every winning bet its prizes. The developer's bank pays what the pot cannot and keeps what it does not pay; a pot it cannot pay in full waits, and is refunded at its deadline.
- **Each player's wallet**: signs the entry, and checks the book's signed result before it collects.

Page and book are one Cloudflare Worker ([server/worker.ts](server/worker.ts)): `dist/` is served as static assets and `/api/` is the book, one Durable Object, on the same origin.

### The operator

The operator runs the book over its API with `Authorization: Bearer <ADMIN_TOKEN>`:

```sh
# Open a market: outcomes with their decimal odds in basis points, and unix-millisecond times.
curl -X POST https://sports-game.hookedin.com/api/markets -H "authorization: Bearer $TOKEN" \
  -d '{"title":"Final","outcomes":[{"name":"Home","odds":21000},{"name":"Draw","odds":34000},{"name":"Away","odds":30000}],"closesAt":1790000000000,"deadline":1790100000000}'
# Name the winner, by its number: 0 is Home here.
curl -X POST https://sports-game.hookedin.com/api/markets/<id>/resolve -H "authorization: Bearer $TOKEN" -d '{"winner":0}'
# Or call it off: every bet is refunded.
curl -X POST https://sports-game.hookedin.com/api/markets/<id>/void -H "authorization: Bearer $TOKEN"
```

A resolution needs the bank to cover the market in full. Put money in it from the developer's own wallet, on the **My games** page, and take it out there whenever you like; nothing in it is reserved. The winner is saved before any pot is resolved, so a resolution cut short by an empty bank finishes, with the same winner, once the bank is funded.

## Fairness and trust

- **The game never holds keys or money.** The wallet signs each bet whole, at the book's signed price.
- **The result is the book's word.** It signs every resolution, so a wrong one is attributable to it, and nothing more: players trust the book to name the real winner, as they would any bookmaker.
- **Winnings beyond the pot are the developer's promise.** The developer's bank pays them, and the casino resolves no market the bank cannot pay in full. Every bet in a market that is never resolved is refunded at its deadline.
- **The casino takes no commission on the book's pots.** It is the developer's risk, not the bankroll's.

Read [pots](../../docs/protocol.md#pots) before you build on this.

## Run it

The book talks to the casino the players' wallets use. With the full local stack, caserver's `npm run dev` runs the Worker, page and book together with `wrangler dev`, at `http://127.0.0.1:8791`, against its own casino, with a fresh referee key and the operator token `local`, and publishes the game in `@hookedin`. Its bank there is empty, so a market resolves only while its winners are owed no more than its bets.

## Make your own

Copy this folder, then:

- [src/manifest.json](src/manifest.json): `id`, `name`, `description`, `developer` (your address) and `referee` (the address of the book's key).
- [wrangler.jsonc](wrangler.jsonc): `name`, `routes`, and `DEVELOPER` and `GAME_NAME`, the address and name you publish the game under.
- Set the secrets once: `npx wrangler secret put REFEREE_KEY` and `npx wrangler secret put ADMIN_TOKEN`.

## Tests

```sh
node --test games/sports/test/*.test.ts games/sports/server/*.test.ts
```

They test the book's markets, quotes and resolutions against a stub referee, and its Durable Object's operator token. Pots and the wallet's handling of entries are tested in the [game SDK](../../sdk) and the casino service.

## License

[MIT](../../LICENSE)
