---
title: Developer kit
description: Reference for @hookedin/play/sdk/developer, the kit a game's server opens rounds, places its casino bets and settles developer bets with.
sidebar:
  order: 4
---

`import { createDeveloper } from '@hookedin/play/sdk/developer';` is the server side of a game with developer bets. The
module is Node-safe and runs wherever `fetch` does: Node, a Cloudflare Worker, a browser. Every call goes to the
casino's public API. [Developer bets](../games/developer-bets.md) is the guide, with the order of requests and
[roulette](../../games/roulette/server/) as the worked example.

The kit signs with the developer's key: the key of the account the game is published from, whose address the manifest
names as its `developer`. A server holding it holds everything that account holds: its games, their commission and its
bank. A developer who wants their server to hold less publishes the game from an account of its own.

```ts
import { createDeveloper } from '@hookedin/play/sdk/developer';

const developer = await createDeveloper({
  casinoURL: 'https://casino.hookedin.com',
  key: process.env.DEVELOPER_KEY!,
  name: 'roulette',
});
const round = await developer.openRound('eth');
const seedHash = await developer.seedHash(round.id); // publish both before anybody bets
```

## The developer

### `createDeveloper`

```ts
export async function createDeveloper({
  casinoURL,
  key,
  name,
}: {
  casinoURL: string;
  key: string;
  name: string;
}): Promise<Developer>;
```

| Parameter   | Type     | Meaning                                                                                                            |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `casinoURL` | `string` | The casino's base URL, without a trailing slash: `https://casino.hookedin.com`, or `http://127.0.0.1:4183` locally |
| `key`       | `string` | The developer's private key, hex                                                                                   |
| `name`      | `string` | The name the game is published under. With the key's address it makes the game's key                               |

It reads [`GET /api/config`](../casino-api/public.md#get-apiconfig) and throws an `Error` with code `protocol-mismatch`
when the casino's `developerProtocol` is not the one this kit signs for: the casino speaks another revision of what a
developer signs ([signed messages](../reference/signed-messages.md)).

Every member that calls the casino rejects with an `Error` when the casino refuses: its message is the casino's `error`,
and it carries `status`, the HTTP status, and `code`, the casino's [error code](../casino-api/index.md#errors). A
request only the developer may make carries a `DeveloperAccess` token signed with the key and valid for 60 seconds
([authentication](../casino-api/index.md)).

### `Developer`

```ts
export interface Developer {
  address: string;
  game: string;
  limits: {
    prizes: number;
    outcomeSpace: string;
    meta: number;
    group: number;
  };
  openRound(asset: AssetId): Promise<Round>;
  seedHash(round: string): Promise<string>;
  round(id: string): Promise<Round>;
  casinoBet(bet: BankCasinoBet): Promise<Round>;
  settle(settlements: Settlement[]): Promise<PublicDeveloperBet[]>;
  bets(query?: {
    status?: 'open' | 'settled';
    group?: string;
    after?: string;
    limit?: number;
  }): Promise<DeveloperBetPage>;
  bet(hash: string): Promise<PublicDeveloperBet | null>;
}
```

What `createDeveloper` resolves with: one developer and one of its games.

#### `address`

```ts
address: string;
```

The developer's address, checksummed.

#### `game`

```ts
game: string;
```

The key of the game this kit serves, in lower case: [`gameKey`](#gamekey) of `address` and `name`.

#### `limits`

```ts
limits: {
  prizes: number;
  outcomeSpace: string;
  meta: number;
  group: number;
}
```

Every bound a bet is held to, from the casino's config: the most prizes one bet holds, the size of the outcome space,
the most a bet's meta takes and the longest group. They are the numbers a wallet reports to a game as its
[limits](../reference/bridge.md#limits).

#### `openRound`

```ts
openRound(asset: AssetId): Promise<Round>;
```

A round in `asset` for the developer's casino bet, named by the casino by the hash of a secret it keeps:
[`POST /api/rounds`](../casino-api/developers.md#post-apirounds). Every call names another round, `open`, so the server
keeps track of its own.

#### `seedHash`

```ts
seedHash(round: string): Promise<string>;
```

The hash of the seed the developer's casino bet on `round` brings. It makes no request: the seed is `keccak256` of the
key's signature of the round (an Ethereum signed message over its 32 bytes), so only this key knows it before the bet,
and the same round always gets the same seed. Published before anybody bets, the hash fixes the round's outcome, since
the casino fixed its secret first.

#### `round`

```ts
round(id: string): Promise<Round>;
```

A round as anyone may read it, revealed or not: [`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround).

#### `casinoBet`

```ts
casinoBet(bet: BankCasinoBet): Promise<Round>;
```

Places the developer's casino bet on one of its rounds, from its bank, and resolves with the revealed round:
[`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet). It signs a
`BankCasinoBet` over the round, the game, the stake, the prizes, the hash of the seed and the hash of `meta`, and sends
the seed with it. The casino admits it against the bankroll like any casino bet. Accepted, its stake leaves the bank and
what its prizes pay on the outcome goes back in; declined, it moves no money. Either way the round is revealed, and
`round.casinoBet.accepted` says which. The seed comes from the key and the round, so placing it again after a lost reply
is the same bet and gets the same answer; a different casino bet on a revealed round is refused with `round-revealed`,
and one the bank cannot pay with `bank-short`.

It throws an `Error` with `status` 400 and code `invalid` before sending when `meta` is not a JSON object of up to
4,096 bytes of canonical JSON with whole numbers, and an `Error` when the secret the casino reveals is not the round's.

```ts
// Back the round's bets with one casino bet of their prizes together, committing to the bets it covers.
const revealed = await developer.casinoBet({
  round: round.id,
  stake: 1000000000000n,
  prizes: [{ rangeStart: '0', rangeEnd: '9223372036854775808', payout: '1980000000000' }],
  meta: { covered: ['0x9ef313d092ad9d9f5f2ac313d77b5be958fdab15452b07fe9c2b5fc71fb804b0'] },
});
revealed.outcome; // the round's 64-bit outcome
revealed.casinoBet!.accepted; // whether the bankroll took it
```

#### `settle`

```ts
settle(settlements: Settlement[]): Promise<PublicDeveloperBet[]>;
```

Settles developer bets, each with a `Settlement` signed here, paid from the developer's bank:
[`POST /api/developer-bets/settle`](../casino-api/developers.md#post-apideveloper-betssettle). It sends them 256 at a
time, and the casino takes each batch whole or, when the bank cannot pay it, refuses it with `bank-short` and settles
none of it; batches sent before a refused one stay settled. A bet settled before answers with what settled it. It
resolves with the bets as settled, in order.

```ts
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';

// The game's own rules: a home win pays the bets on 'home' 2.1 times their stake.
const pays = (bet: PublicDeveloperBet) => (bet.meta.pick === 'home' ? (BigInt(bet.stake) * 21n) / 10n : 0n);
// About half of what a bet was expected to earn the developer: here, 2% of its stake.
const share = (bet: PublicDeveloperBet) => BigInt(bet.stake) / 50n;

const { bets } = await developer.bets({ group: 'match-812' });
await developer.settle(bets.map(bet => ({ bet: bet.bet, player: pays(bet), casino: share(bet) })));
```

#### `bets`

```ts
bets(query?: {
  status?: 'open' | 'settled';
  group?: string;
  after?: string;
  limit?: number;
}): Promise<DeveloperBetPage>;
```

A page of the game's developer bets, of one group if `group` names one:
[`GET /api/developer-bets`](../casino-api/public.md#get-apideveloper-bets). `status` is `open` by default. The casino
lists 100 a page unless `limit` says otherwise, at most 256. Open bets come in order of their hash, as they stand: read
them from the start each time, passing each page's `cursor` as `after` while `more` is `true`. Settled bets come in the
order they settled, so a saved `cursor` never misses one.

```ts
let after: string | undefined; // or the cursor saved last time
for (;;) {
  const page = await developer.bets({ status: 'settled', after });
  for (const bet of page.bets) console.log(bet.bet, bet.settlement!.player);
  after = page.cursor;
  if (!page.more) break;
}
```

#### `bet`

```ts
bet(hash: string): Promise<PublicDeveloperBet | null>;
```

A developer bet as anyone may read it, or `null` for one the casino does not know:
[`GET /api/developer-bets/:bet`](../casino-api/public.md#get-apideveloper-betsbet).

## Types

### `Settlement`

```ts
export interface Settlement {
  bet: string;
  player: string | bigint;
  casino: string | bigint;
}
```

What one developer bet is paid, from the developer's bank, which took the stake when the bet was placed: `player` to its
player and `casino` to the casino. The casino's policy is about half of what the bet was expected to earn the developer;
nothing enforces it, and a bet the developer's casino bet backs paid its commission on that casino bet. `bet` is the
bet's hash.

### `BankCasinoBet`

```ts
export interface BankCasinoBet {
  round: string;
  stake: string | bigint;
  prizes: WirePrizes;
  meta: Record<string, unknown>;
}
```

The developer's casino bet on one of its rounds: its stake and prizes against the bankroll, and `meta`, the developer's
own JSON, which the casino keeps with the reveal and never reads. Whatever the developer commits to there, such as the
hash of the bets it backs, it committed to before the outcome was revealed.

### `DeveloperBetPage`

```ts
export interface DeveloperBetPage {
  bets: PublicDeveloperBet[];
  cursor: string;
  more: boolean;
}
```

A page of a game's developer bets, the cursor to pass as `after` for the next, and whether there is one.

### `gameKey`

```ts
export const gameKey: ({ developer, name }: GameName) => string;
```

A game's key: `keccak256(abi.encode(address developer, string name))`, in lower-case hex. `developer` is the account
that publishes the game and `name` the name it is published under; a game loaded straight from its manifest has the key
of its manifest's developer and its manifest URL as the name. Bets, commission and the public record are kept under it.

```ts
gameKey({ developer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', name: 'my-game' });
// '0x45a9172eb243e9566aeeb6eee4b57f919819ffee38451b919a98840e747caaed'
```

### `AssetId`

```ts
export type AssetId = 'eth' | 'test';
```

What a round, a bet or a bank is in: the network's ETH, or the casino's test coins.

### `PublicDeveloperBet`

```ts
export interface PublicDeveloperBet {
  bet: string;
  game: string;
  group?: string;
  asset: 'eth' | 'test';
  uname: string | null;
  alias: string | null;
  developer: string;
  stake: string;
  placedAt: number;
  status: 'open' | 'settled';
  meta: Record<string, unknown>;
  settlement?: { player: string; casino: string; signature: string };
  settledAt?: number;
}
```

A developer bet as anyone may read it by its hash.

| Field            | Meaning                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `bet`            | The bet's hash: the hash of the operation that placed it, which signs its meta            |
| `game`, `group`  | The game's key, and the group the page gave the bet                                       |
| `asset`          | What it was placed in                                                                     |
| `uname`, `alias` | The player's names                                                                        |
| `developer`      | The developer whose bank took the stake and whose key settles it                          |
| `stake`          | The stake, a decimal string of smallest units                                             |
| `placedAt`       | When the casino took it, in milliseconds since the Unix epoch                             |
| `status`         | `open` until the developer settles it                                                     |
| `meta`           | The game's own JSON, as the player signed it                                              |
| `settlement`     | Once settled: what it pays the player and gives the casino, and the developer's signature |
| `settledAt`      | When it was settled, in milliseconds since the Unix epoch                                 |

### `Round`

```ts
export interface Round {
  id: string;
  developer: string;
  asset: 'eth' | 'test';
  status: 'open' | 'revealed';
  seed?: string;
  secret?: string;
  outcome?: string;
  casinoBet?: DeveloperCasinoBet;
}
```

A developer's round, as anyone may read it: the hash of a secret the casino keeps, named for one developer in one
asset. It is `open` until the developer's casino bet on it reveals it; a revealed round shows the seed, the secret,
their 64-bit `outcome` and the casino bet, `{ game, stake, prizes, meta, signature, accepted, payout? }`: the bet as
the developer signed it, whether the bankroll took it, and what it paid the bank when it did.
[`outcome`](outcome.md#outcome) checks a revealed round.

### `WirePrizes`

```ts
export type WirePrizes = { rangeStart: string; rangeEnd: string; payout: string }[];
```

Prizes on the wire, in decimal strings.
