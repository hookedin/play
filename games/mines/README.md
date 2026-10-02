# HookedIn Mines

A five-by-five board with 1 to 24 mines. Pick tiles, find gems, and cash out when you like, at 99% of fair odds. A reference game for [HookedIn](https://play.hookedin.com), and the simplest example of a multi-step game where the player decides when to stop.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Mines. It is hosted at `mines-game.hookedin.com`.

## How to play

1. Set what the game may spend from your wallet with **Allowance** in the wallet's top bar.
2. Choose a stake and how many of the 25 tiles are mines, then **Bet** (or press Space).
3. Pick tiles, or let **Random tile** pick one. A gem raises what you can cash out; a mine ends the round at zero.
4. **Cash out** (or Space) after any gem, for what the button shows.

After `k` gems among `m` mines, a cash-out pays `0.99 × C(25, k) / C(25 − m, k)` times the stake, rounded down to the wei: 99% of the stake at the odds of finding those `k` gems.

| Mines | 1 gem  | 2 gems | 3 gems | 5 gems | Every gem            |
| ----- | ------ | ------ | ------ | ------ | -------------------- |
| 1     | 1.03×  | 1.07×  | 1.12×  | 1.23×  | 24.75× (24 gems)     |
| 3     | 1.12×  | 1.28×  | 1.47×  | 1.99×  | 2,277× (22 gems)     |
| 5     | 1.23×  | 1.56×  | 1.99×  | 3.39×  | 52,598× (20 gems)    |
| 10    | 1.65×  | 2.82×  | 5.00×  | 17.51× | 3,236,072× (15 gems) |
| 24    | 24.75× |        |        |        | 24.75× (1 gem)       |

Which tile you pick is a visual choice. No hidden board is generated in advance: each pick is a fresh bet at the exact odds of the tiles left, decided by its own verified outcome. After a loss the page shows the mine on the tile you picked, and nowhere else, because there is nowhere else.

At a stake large for the casino's bankroll, the casino covers fewer picks than the board holds. The page says so when the round starts and again when you reach the last covered pick; cash out there, or lower the stake to go further.

## How it works

### The rules are a graph

The rules are `createMines` from the SDK's engine, [mines.ts](../../sdk/src/engine/mines.ts). [src/rules.ts](src/rules.ts) builds its arguments from the round's setup, `{ stake, mines, picks }`:

```ts
createMines({ tiles: 25, mines, cashouts: [1, …, picks].map(k => payout(stake, mines, k)) });
```

The graph tracks only the number of safe picks so far, because unrevealed tiles are symmetric. After `j` safe picks, a reveal leads to the mine with probability `mines / (25 − j)` and to the next state otherwise. `cash-out` leads to a terminal that pays `cashouts[j − 1]`. `RoundClient` saves the setup with the round and rebuilds the same graph from it after a reload.

### How far the casino covers

`RoundClient` runs the round, and the engine prices each state with the cash its actions need, working backward from the cash-outs. A reveal has two outcomes, so it is one bet: the stake is the state's cash, the chance is the gem's share of the 2^64 outcomes, and the prize is the next state's cash.

The cash-outs rise exactly as the odds fall, so at them every pick after the first is a fair bet, and the casino's admission rule takes no bet without an edge. Each state therefore holds a little more than its cash-out: what its next pick needs beyond fair odds for the casino to take it. The 1% the first pick keeps pays for all of them, and a longer ladder needs more. `coveredPicks` in [src/rules.ts](src/rules.ts) finds the most picks the bankroll backs at the stake, pricing exactly as `RoundClient` does, against half the bankroll `wallet.info` reports, on a grid of a billionth of the stake. The page starts the round with that many; past them the graph offers only the cash-out.

A cash-out moves the state's cash down to what it pays: the extra goes back to the house as a payment of at most a 99th of the cash-out, and nothing at the last covered pick. The cash is already in the player's signed balance, and a player who leaves without cashing out keeps all of it: a [settled trade-off](../../docs/overview/architecture.md#settled-trade-offs).

**Return.** A player who always cashes out after `k` gems gets back 99% of what they stake, on average and whatever the bankroll, less the wei each cash-out rounds away, because a round reaches `k` gems exactly as often as the rules say. The return the wallet measures is each pick's own, between 99% and 100%: the extra is what a cash-out gives back.

To change the game, `TILES` and `multiplier` in [src/rules.ts](src/rules.ts) set the board and the table; `createMines` takes one positive cash-out per allowed safe pick, at most `tiles − mines`. For different rules altogether, copy [mines.ts](../../sdk/src/engine/mines.ts) into your `src/` and pass your own graph function to `RoundClient`.

## Run it, test it, make it yours

From play's root, `node sdk/bin/hookedin-game.js serve games/mines` serves the game at `http://127.0.0.1:4185/`, and `node --test games/mines/test/*.test.ts` runs its tests. [The house games](../../docs/games/quick-start.md#the-house-games) says how to open it in the wallet and start a game of your own from it, [publishing](../../docs/games/publishing.md) how a game is hosted and listed, and [how it works](../../docs/overview/how-it-works.md) why nobody picks a round's outcome.

## License

[MIT](../../LICENSE)
