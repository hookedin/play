---
title: Play with zero trust
description: Run your own wallet and games, back what you win with collateral, and the contract alone owes you everything you deposit and win.
sidebar:
  order: 3
---

Most casinos ask you to trust them with everything: your deposit, the odds, and whether they pay when you win. HookedIn
fully supports playing with zero trust. You run the wallet that holds your key and the games that choose your bets,
collateral backs everything you can win, and your wallet checks every result before it believes it. The casino can
still refuse to play with you, but it cannot take a wei of what it owes you.

## The setup

1. **Run your own wallet.** Build it from source, create a key file in it, and never use that key at play.hookedin.com
   ([your own build](../wallet/keys-and-recovery.md#your-own-build)). Nobody else ever holds your key, and the code
   you run is a commit you can read.
2. **Run your own games.** A game never sees your key, but it chooses your bets: one served to take your money could
   spend its allowance on bets that pay back little, and a multi-step game picks which bet each collapsed step draws.
   Build the games you play from their source, and open each with **Open a game by its URL** at
   http://127.0.0.1:4185/: dice, mines, plinko and samson from this repository's [games/](../../games/), with
   `node sdk/bin/hookedin-game.js serve games/dice`, and blackjack from
   [hookedin/game-blackjack](https://github.com/hookedin/game-blackjack), with `npm run dev`.
3. **Back what you win with collateral.** Buy [collateral](../wallet/closing-and-claims.md#collateral) for as much as
   you mean to win, and keep your balance within your deposits and collateral: the contract pays all of that, and the
   owner cannot touch it. Count all you have won, not one bet's prize, and a withdrawal uses collateral up. Protection,
   in the wallet's Settings, shows how much more you can win and have protected. A
   [lock-in](../wallet/closing-and-claims.md#lock-in-your-balance) that house cash pays in full protects winnings too,
   as deposits.
4. **Play casino bets.** Your wallet checks every casino bet and the contract enforces it. Do not allow developer bets,
   which a game's developer settles from its bank and can keep by never settling; crash and roulette play only those.
   Transfers between players and [bankroll fund](../wallet/bankroll-fund.md) shares are the casino's promise too.
5. **Keep watch.**
   - Open your wallet at least every 7 days, or run the
     [watchtower](../wallet/keys-and-recovery.md#the-watchtower): a close on an older state becomes final when nobody
     challenges it within 7 days.
   - Keep ETH at your deposit address for the fees of closing, challenging and disputing.
   - When the casino leaves a casino bet unanswered, dispute it with **Close without the casino** before its quote
     expires, within a day. The watchtower does it from your recovery bundle.
   - Play from one browser, or keep its [recovery bundle](../wallet/keys-and-recovery.md#recovery-bundles) current:
     another device takes the casino's word for your latest balance.

## What you get

- Your deposits, and everything you win up to your collateral, are owed to you by the contract, which nobody can
  upgrade or pause, and the owner cannot withdraw what it holds for you.
- Every outcome comes from the casino's secret, committed before your wallet picks its seed, and your wallet recomputes
  it, and what the bet pays, before it believes either.
- A casino bet the casino covered but left unsettled counts as won once you dispute it.
- You can leave alone: close with your latest evidence and collect after 7 days, with no casino server involved.

## What is left

Zero trust in the casino is not zero risk:

- **The contract's code.** It has had no third-party audit ([SECURITY.md](../../SECURITY.md)), and every guarantee here
  is as good as it is. Anyone can [check](../reference/deployment.md#verify-a-release) that the deployed code is the
  source in this repository.
- **The chain.** Your transactions must be mined in time. The wallet reads Sepolia through the two RPCs that
  [config/production.json](../../config/production.json) names, which your own build can point at nodes you run.
- **Availability.** The casino can decline your bets, refuse to sell collateral, or close a channel nobody has played on
  for 7 days. None of it takes what it owes you.
