# HookedIn Plinko

Drop a ball through 8, 12 or 16 rows of pegs into a row of buckets. Three risk levels, up to 1000× the bet, and every board returns exactly 99%. A reference game for [HookedIn](https://play.hookedin.com), and the example to copy for a one-shot game of many outcomes.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Plinko. It is hosted at `plinko-game.hookedin.com`.

## How to play

1. Set what the game may spend from your wallet with **Adjust allowance**.
2. Choose the rows (8, 12 or 16), the risk (low, medium or high) and the bet.
3. Press **Drop ball**, or Space. Each press queues another ball, up to 20 ahead. **Auto** makes one press drop 10, 50 or 100 balls; the button then reads **Stop** and ends the run after the ball under way.

The ball bounces left or right at each peg with equal chance and lands in a bucket. The bucket's multiplier times the bet is paid. Outer buckets pay the most and are the rarest. Under the buckets, bars show where this session's balls landed and white marks show the exact expectation.

## How it works

A drop is a round of one decision, played through `RoundClient` from the [game SDK](../../sdk). [src/drop.ts](src/drop.ts) wraps it as `DropClient`, which lands each finished drop once, and the balance strip leaves a ball's winnings out until it lands.

### The board is a graph

A board with `rows` rows has `rows + 1` buckets. The ball reaches bucket `j` by turning right exactly `j` times, so its probability is `C(rows, j) / 2^rows`. `dropGraph` in [src/tables.ts](src/tables.ts) writes the board as one decision, `drop`, whose outcomes are the buckets, each at exactly that probability and each paying `stake × multiplier_j`. A bet too small for every multiplier to pay a whole wei is refused, so the board played is the board shown.

### A drop is one bet

A casino bet has two outcomes, so `RoundClient` collapses the board ([pricing and collapsing](../../docs/games/collapsing-bets.md)). A bucket and its mirror pay the same, so a board has `rows / 2 + 1` payouts. For each drop the page draws two of them with its own randomness, one below the bet and one above: it keeps the smaller, which the ball cannot lose, and stakes the rest of the bet for the difference to the larger. The draw is weighted so that drops reach every bucket exactly as often as the pegs do, and no bucket pays exactly 1×, so every drop places a bet. The casino's verified outcome decides which of the two payouts the ball gets, and which bucket pays it. Which bet a drop places is this page's word: the wallet verifies the bet, not the draw that chose it ([what is given up](../../docs/games/collapsing-bets.md#what-is-given-up)).

### The ball is drawn from the result

`path` in [src/tables.ts](src/tables.ts) draws the ball's left and right turns into its bucket from a generator seeded by the round's outcome, so a reload shows the same ball. [src/board.ts](src/board.ts) animates exactly those turns.

### The multipliers

[src/tables.ts](src/tables.ts) holds the nine tables in hundredths of the bet, from the outermost bucket to the centre (boards are symmetric):

| Rows | Low                                          | Medium                                      | High                                         |
| ---- | -------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| 8    | 5.7, 2.09, 1.3, 0.9, 0.5                     | 13, 2.7, 1.39, 0.7, 0.4                     | 29, 4.2, 1.44, 0.3, 0.2                      |
| 12   | 10, 3.2, 1.6, 1.4, 1.2, 0.9, 0.56            | 33, 11, 3.6, 2.1, 1.1, 0.6, 0.31            | 175, 23, 8, 2, 0.7, 0.22, 0.19               |
| 16   | 16, 9.7, 2.1, 1.5, 1.4, 1.29, 1.2, 0.9, 0.48 | 110, 41, 10, 4.4, 2.7, 1.49, 1.1, 0.5, 0.32 | 1000, 130, 26, 9.7, 4.1, 2, 0.19, 0.18, 0.16 |

**Return.** Every table satisfies `sum(C(rows, j) × multiplier_j) = 99 × 2^rows` in hundredths, which is a return of exactly 99% of the ball. [test/plinko.test.ts](test/plinko.test.ts) proves it for all nine boards, and that the drop the SDK compiles reaches every bucket at exactly its binomial odds.

Each bet's own return, which the wallet measures and keeps, is lower. A drop stakes only what its ball can lose, and the bets for the outer buckets carry more of the board's edge than the rest. With the casino's bankroll far above the stake, the bets pay back from 92.7% to 99.6% of what they stake, and the test holds every bet to at least 92.7%. When the bankroll is small beside a prize, the bet for it must carry more edge still for the casino to take it: at the least bankroll that backs the 16-row low board, its bet for the outer buckets pays back 22%.

If you change a multiplier, keep `sum(C(rows, j) × multiplier_j)` equal to your target return times `2^rows`, and update the test's return assertion and its `FLOOR`.

## Run it, test it, make it yours

From play's root, `node sdk/bin/hookedin-game.js serve games/plinko` serves the game at `http://127.0.0.1:4185/`, and `node --test games/plinko/test/*.test.ts` runs its tests. [The house games](../../docs/games/quick-start.md#the-house-games) says how to open it in the wallet and start a game of your own from it, [publishing](../../docs/games/publishing.md) how a game is hosted and listed, and [how it works](../../docs/overview/how-it-works.md) why nobody picks a round's outcome.

## License

[MIT](../../LICENSE)
