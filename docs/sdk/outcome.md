---
title: Outcomes
description: Reference for @hookedin/play/sdk/outcome, the rule every round's outcome follows, what a casino bet pays on it, and how to check a revealed round by hand.
sidebar:
  order: 7
---

`import { betPayout, outcome, roundId, seedHash } from '@hookedin/play/sdk/outcome';` is the rule every round's outcome
follows, and what a casino bet pays on it, for a page, a server or anybody else that checks a round. The module is
Node-safe. A round is named by the hash of a secret the casino keeps, a seed by its own hash, and the outcome is theirs
together ([signed messages](../reference/signed-messages.md)).

## The rule

### `outcome`

`outcome(seed, secret)`: the outcome of a round's `secret` with a bet's `seed`, both 32-byte hex strings. Every bet on
one round and seed sees the same outcome.

| Result       | Meaning                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `randomHash` | `keccak256(abi.encode(bytes32 keccak256("HOOKEDIN/OUTCOME"), bytes32 seed, bytes32 secret))` |
| `value`      | The round's 64-bit outcome: `randomHash` modulo 2^64, a uniform integer below 2^64           |

### `betPayout`

`betPayout(bet, value)`: what a casino bet pays on the outcome `value`, its `prize` when `value` is below its `chance`,
and `0n` otherwise. `chance` and `prize` may be decimal strings, numbers or bigints, so a receipt's or a round's casino
bet goes in as it is.

### `roundId`

A round's ID, the hash of its secret: `keccak256(secret)`, in lower-case hex.

### `seedHash`

The hash a bet names its seed by: `keccak256(seed)`, in lower-case hex.

## Checking a round

The wallet checks a casino bet on the player's own round before the game hears of it. A game's round is public
once the game's casino bet reveals it ([`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround), which
a game page reads with [`HookedIn.round`](hookedin.md#round)), and anyone can check it by hand:

1. `roundId(round.secret)` is the round's ID: the casino revealed the secret it committed to.
2. `seedHash(round.seed)` is the seed hash the game published before anybody bet: the developer brought the seed it
   committed to.
3. `outcome(round.seed, round.secret).value` is `round.outcome`, and `betPayout(round.casinoBet, value)` is
   `round.casinoBet.payout` when the bankroll accepted the casino bet. A casino bet of stake, chance and prize zero
   only revealed the round, and pays nothing.
4. Each bet's settlement pays what the game's own published rules make of `value`. A spin walked over several rounds
   reaches its outcome through [`stepOutcome`](steps.md#stepoutcome).

```ts
import { betPayout, outcome, roundId, seedHash } from '@hookedin/play/sdk/outcome';

/** A revealed round, checked against the seed hash its game published before anybody bet. */
async function checkRound(id: string, publishedSeedHash: string) {
  const round = await (await fetch(`https://casino.hookedin.com/api/rounds/${id}`)).json();
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(roundId(round.secret), id)) throw new Error("The secret is not the round's");
  if (!same(seedHash(round.seed), publishedSeedHash)) throw new Error('The seed is not the one published');
  const { value } = outcome(round.seed, round.secret);
  if (String(value) !== round.outcome) throw new Error('The outcome does not follow from the seed and the secret');
  // payout is what the casino bet paid, when the bankroll accepted it
  return { value, payout: betPayout(round.casinoBet, value) };
}
```
