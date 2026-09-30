# Samson's Gold

A five-reel, three-row, 243-ways slot for [HookedIn](https://play.hookedin.com). Jawbone wilds, honeycomb scatters, and a bonus on its own reels where the wilds multiply. It is the showcase reference game: the whole payout distribution is counted exactly from the reel strips, and a spin is at most one bet, the whole stake against one pay, drawn so that spins pay exactly as the reels do.

Play it through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Samson. It is hosted at `samson-game.hookedin.com`.

## How to play

1. Set what the game may spend from your wallet with **Adjust allowance**.
2. Set the bet with − and +, and press **Spin** or Space. Press again to land the reels, or to cut a win short and spin again.
3. **Turbo** spins faster. **Auto** plays 10 to 100 spins and stops at a bonus; **Stop** ends it.

Rules:

- A win is three, four or five adjacent reels from the left that carry the same symbol (or a wild). There are no paylines: every combination of matching positions is a way, and ways multiply the pay.
- **Only the best win on the screen pays.** No win is smaller than the bet.
- **Jawbone wilds** appear on reels 2, 3 and 4 and stand in for any paying symbol.
- **Honeycomb scatters** appear on reels 1, 3 and 5. Three of them trigger the Honey Bonus.
- **The Honey Bonus** is eight spins on a separate set of reels whose wilds carry ×2 and ×3. Multipliers of every wild in a win multiply together.

Pays per way, in bets:

| Symbol  | 3 reels | 4 reels | 5 reels |
| ------- | ------- | ------- | ------- |
| Lion    | 4       | 16      | 96      |
| Pillars | 2       | 8       | 24      |
| Shears  | 2       | 6       | 18      |
| Torch   | 2       | 4       | 12      |
| A       | 1       | 3       | 9       |
| K       | 1       | 3       | 8       |
| Q, J    | 1       | 2       | 6       |

Bonus spins are prepaid, not free. The triggering spin adds eight bets of cash to its payout, and the game offers to spend that on eight bonus spins at the triggering bet. You may keep the cash instead. **Buy bonus** is the same eight spins without waiting for a trigger.

## How it works

### One spin is one decision

[src/math.ts](src/math.ts) holds the reel strips, the paytable and every rule. It has no DOM, no wallet and no randomness of its own.

An **outcome** of a spin is the pair (best pay, bonus triggered). `distribution(machine)` counts, exactly, how many of the machine's stop combinations produce each outcome. It does not simulate. A win depends on the first three reels only through the running product of ways and multipliers for each symbol still alive, so the counter groups the first three reels by that state and then crosses each group with reels four and five. The main reels have 509,358,726 stop combinations and the bonus reels 714,125,160; each is counted in a fraction of a second.

`slotGraph` turns that count into a one-decision graph: a single `spin` action whose outcomes are the distinct results, each with probability `count / total` as an exact fraction, and each a terminal paying `stake × (pay + 8 if the bonus triggered)`. The main game has 44 outcomes and the bonus 54.

### A spin bets the whole stake against one pay

`RoundClient` from the [game SDK](../../sdk) plays the `spin`. A casino bet has two outcomes, so the SDK collapses the spin ([pricing and collapsing](../../docs/games/collapsing-bets.md)). No win is smaller than the stake, so the only payout below it is nothing: each spin, the page draws with its own randomness one pay above the stake, and bets the whole stake against it. The draw is weighted so that spins reach every pay exactly as often as the reels do. A spin that pays the stake back exactly is drawn the same way and places no bet: about one main spin in thirteen, and one bonus spin in eight. Where two outcomes pay the same, such as 8 bets without the bonus and nothing with it, the round's outcome decides which one the spin reached. Which bet a spin places is this page's word: the wallet verifies the bet, not the draw that chose it ([what is given up](../../docs/games/collapsing-bets.md#what-is-given-up)).

### The reels shown come from the result

After settlement the game knows which outcome the spin reached. `sampleStops` picks one of exactly the stop combinations that produce it, with a generator seeded by the settled spin's `draw`: the round's outcome for a bet, and for a spin without one a value the page drew when it prepared the spin. The reels stop there, and a reload shows the same reels. [src/game.ts](src/game.ts) re-evaluates the chosen window and refuses to show it if it does not pay what was settled.

### Why the rules look the way they do

Pricing one spin with the SDK's exact compiler costs roughly the cube of the number of distinct payouts. The rules keep that set small: only the best win pays, every pay is a whole number of bets of the form 2^a·3^b, and way counts and wild multipliers are products of 2s and 3s. The main game has 38 distinct payouts and the bonus 48. A side effect is that a win is never smaller than the bet, so the game never presents a net loss as a win, and every bet it places stakes the whole bet.

Bonus spins are prepaid because the casino has no notion of free credit: every spin must be a real bet with a real stake. The bonus reels carry their own house edge, so each bonus spin passes the casino's admission rule like any other. The game keeps its bonus counter and last window in its own `localStorage` next to the round, and applies each finished round exactly once, by the round's `id`.

### What the reels pay

These are counted from the paytable, and the game shows none of them to its players, whose return is measured from the bets they signed ([measured return](../../docs/wallet/bets-and-receipts.md#measured-return)).

| Reels | Counted from the reels         | Any payout | Bonus trigger | Top payout | Distinct payouts |
| ----- | ------------------------------ | ---------- | ------------- | ---------- | ---------------- |
| Main  | 490253039/509358726 = 96.2491% | 1 in 4.95  | 1 in 156.1    | 1,152×     | 38               |
| Bonus | 3735679/3881115 = 96.2527%     | 1 in 4.25  | 1 in 127.7    | 6,912×     | 48               |

The main-game return counts the eight bets of bonus cash at face value. [test/samson.test.ts](test/samson.test.ts) pins both return fractions and both top payouts exactly, from the counted distribution. It also checks the counter against brute-force evaluation of every window on a small machine, outcome by outcome, and that the compiled spin reaches every pay exactly as often as the reels do and pays back exactly what they pay. The other columns are computed from the same `distribution`.

Each bet's own return, which the wallet measures and keeps, is lower than the machine's, because the bets for the largest pays carry more of its edge than the rest. With the casino's bankroll far above the stake, the main game's bets pay back from 95.3%, the whole stake against the 1,152× pay, to 97.6%, and the bonus game's from 95.1%, against 6,912×, to 97.5%; the test holds every bet to at least 95.1%. When the bankroll is small beside a pay, its bet must carry more edge still for the casino to take it: at a planning bankroll of 25,000 bets, the bonus game's bet against 6,912× pays back 69.2%.

To change the game, the theme is the SVGs in [src/symbols/](src/symbols/), the copy in [src/index.html](src/index.html), the styles and the tones in [src/sound.ts](src/sound.ts), none of which touch the maths. The maths is `MACHINES` and `PAYS` in [src/math.ts](src/math.ts): any change to a strip or a pay changes the return, so update the test's expected fractions and its `FLOOR`. A reel window may show at most one wild or scatter, which the counter enforces. Keep the distinct payouts few, or spins will be slow to price.

## Run it, test it, make it yours

From play's root, `node sdk/bin/hookedin-game.js serve games/samson` serves the game at `http://127.0.0.1:4185/`, and `node --test games/samson/test/*.test.ts` runs its tests. [The house games](../../docs/games/quick-start.md#the-house-games) says how to open it in the wallet and start a game of your own from it, [publishing](../../docs/games/publishing.md) how a game is hosted and listed, and [how it works](../../docs/overview/how-it-works.md) why nobody picks a round's outcome.

## License

[MIT](../../LICENSE)
