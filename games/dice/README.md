# HookedIn Dice

Pick a win chance, pick a stake, roll. A reference game for [HookedIn](https://play.hookedin.com), and the smallest example of a game built on `RoundClient`. Play it at [dice-game.hookedin.com](https://dice-game.hookedin.com/) through the wallet: open [play.hookedin.com](https://play.hookedin.com) and choose Dice.

## How to play

1. Set what the game may spend from your wallet with **Adjust allowance**.
2. Set the win chance with the slider, from 10% to 90% in steps of 0.5%, or type it.
3. Enter a stake, or halve or double it with **½** and **2×**, and press **Roll dice** or Space.

A win pays `99% / win chance` times the stake: 2× at 49.5%, 9.9× at 10%, 1.1× at 90%. A loss pays nothing. The roll shown is the verified outcome on a 0–100 scale: a win falls under the win chance, a loss at or above it. The track marks where the last roll landed against the winning zone, and the strip above it keeps the last ten rolls.

**Auto** makes one press roll 10, 50 or 100 times at the same stake and odds; the button then reads **Stop** and ends the run after the roll under way.

## How it works

The whole game is one decision with two outcomes: [src/rules.ts](src/rules.ts) builds it as a graph, and [src/game.ts](src/game.ts) plays it with `RoundClient`. A roll is one casino bet: the player's stake, a chance of `chance / 10000` of the 2^64 outcomes, where `chance` is the win chance in basis points, and a prize of `stake × 9900 / chance`, rounded down to the wei. The game shows `dice:win` or `dice:lose` by whether the verified outcome fell below the chance.

**Return.** The nominal return is 99%: `chance/10000 × 9900/chance = 0.99`. The payout is rounded down to a whole number of wei, so the exact figure can be below 99% by less than one wei per roll; [test/dice.test.ts](test/dice.test.ts) checks this at every chance on the slider. A roll has two outcomes, so the return the wallet measures of its bet is the roll's.

**Limits.** `RoundClient` prices the bet with the casino's own admission rule against half the reported bankroll. A stake the casino could not back, which happens sooner at low win chances, is refused with a message before anything is signed.

To change the rules: the `9900n` in `winPayout` in [src/rules.ts](src/rules.ts) is the return in basis points, and `CHANCE_MIN` and `CHANCE_MAX` are the chance limits, which the slider keeps to; keep the multiplier in `odds()` in [src/game.ts](src/game.ts) and the test in step. A higher return leaves the casino less edge, so it admits smaller stakes. The die is pure CSS.

## Run it, test it, make it yours

From play's root, `node sdk/bin/hookedin-game.js serve games/dice` serves the game at `http://127.0.0.1:4185/`, and `node --test games/dice/test/*.test.ts` runs its tests. [The house games](../../docs/games/quick-start.md#the-house-games) says how to open it in the wallet and start a game of your own from it, [publishing](../../docs/games/publishing.md) how a game is hosted and listed, and [how it works](../../docs/overview/how-it-works.md) why nobody picks a round's outcome.

## License

[MIT](../../LICENSE)
