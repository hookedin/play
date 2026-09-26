---
title: Outcomes
description: Reference for @hookedin/play/sdk/outcome, the rule every round's outcome follows, and how to check a revealed round by hand.
sidebar:
  order: 6
---

`import { outcome, roundId, seedHash } from '@hookedin/play/sdk/outcome';` is the rule every round's outcome follows,
for a page, a server or anybody else that checks a round. The module is Node-safe. A round is named by the hash of a
secret the casino keeps, a seed by its own hash, and the outcome is theirs together. The casino names the round before
the seed is picked, so neither side knows the outcome before both are out. [Signed messages](../reference/signed-messages.md)
gives the derivation's place in the protocol.

## The rule

### `outcome`

```ts
export function outcome(
  prizes: readonly Prize[],
  seed: string,
  secret: string,
): {
  randomHash: string;
  value: bigint;
  payout: bigint;
};
```

The outcome of a round's `secret` with a bet's `seed`, both 32-byte hex strings, and what `prizes` pay on it.

| Result       | Meaning                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `randomHash` | `keccak256(abi.encode(bytes32 keccak256("HOOKEDIN/OUTCOME"), bytes32 seed, bytes32 secret))` |
| `value`      | The round's 64-bit outcome: `randomHash` modulo 2^64, a uniform integer below 2^64           |
| `payout`     | The sum of the payouts of every prize whose `[rangeStart, rangeEnd)` holds `value`           |

A prize's fields may be decimal strings, numbers or bigints, so the wire's prizes go in as they are. With no prizes it
gives the outcome alone, as [roulette](../../games/roulette/) reads its pocket from `outcome([], seed, secret).value`.

### `roundId`

```ts
export const roundId: (secret: string) => string;
```

A round's ID, the hash of its secret: `keccak256(secret)`, in lower-case hex.

### `seedHash`

```ts
export const seedHash: (seed: string) => string;
```

The hash a bet names its seed by: `keccak256(seed)`, in lower-case hex. Whoever knows the round's secret cannot know
the outcome before the seed is out.

## Checking a round

The wallet checks a casino bet on the player's own round before the game hears of it: the receipt's `outcome` is one
the wallet derived itself. A developer's round is public once the developer's casino bet reveals it
([`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround)), and anyone can check it by hand:

1. `roundId(round.secret)` is the round's ID: the casino revealed the secret it committed to.
2. `seedHash(round.seed)` is the seed hash the game published before anybody bet: the developer brought the seed it
   committed to.
3. `outcome(round.casinoBet.prizes, round.seed, round.secret).value` is `round.outcome`, and its `payout` is
   `round.casinoBet.payout` when the bankroll accepted the casino bet.
4. Each bet's settlement pays what the game's own published rules make of `value`.

```ts
import { outcome, roundId, seedHash } from '@hookedin/play/sdk/outcome';

/** A revealed round, checked against the seed hash its game published before anybody bet. */
async function checkRound(id: string, publishedSeedHash: string) {
  const round = await (await fetch(`https://casino.hookedin.com/api/rounds/${id}`)).json();
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(roundId(round.secret), id)) throw new Error("The secret is not the round's");
  if (!same(seedHash(round.seed), publishedSeedHash)) throw new Error('The seed is not the one published');
  const { value, payout } = outcome(round.casinoBet.prizes, round.seed, round.secret);
  if (String(value) !== round.outcome) throw new Error('The outcome does not follow from the seed and the secret');
  return { value, payout }; // payout is what the casino bet paid, when it was accepted
}
```
