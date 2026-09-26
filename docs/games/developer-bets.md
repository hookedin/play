---
title: Developer bets
description: Bets against you, settled by your server, and provably fair schemes on your rounds and your casino bet.
sidebar:
  order: 8
---

A developer bet is a bet against you, the game's developer, instead of the casino's bankroll: many players on one
roulette spin, a crash curve, a football match. The player's wallet places it with the casino, and its stake goes
straight into your bank; your server settles it later, paying from that bank. A game that takes developer bets runs a
server with your key.

Playing such a game trusts you. The player is paid what your settlement says, and whether you can pay is between you and
your players, outside HookedIn: a [settled trade-off](../overview/architecture.md#settled-trade-offs). The wallet tells
players so ([trust model](../overview/trust-model.md)).

## Your key and your bank

Your server signs with the key of the account you publish the game from, the address the manifest names as
`developer`. The casino lets only that key settle the game's developer bets and place the casino bets that back them.
The server therefore holds everything the account holds: its games, their commission and its bank. A developer who
wants the server to hold less publishes the game from an account of its own.

Your **bank** is a balance at the casino, one per asset. The stakes of your developer bets go in as they are placed;
your settlements and your casino bets are paid from it, and an accepted casino bet's payout goes back in. Nothing in it
is reserved. Deposit into it and withdraw from it on the wallet's **My games** page, from the account's own channel in
the asset the wallet plays with. A batch of settlements the bank cannot pay in full is refused whole, with `bank-short`.

## Placing a bet from the page

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

const id = crypto.randomUUID(); // saved with the bet before asking, like any operation
HookedIn.onReceipt(receipt => {
  if (receipt.id === id) show(`Paid ${HookedIn.formatAmount(receipt.payout!)}`);
});
const receipt = await HookedIn.developerBet({
  id,
  stake: HookedIn.parseAmount('0.001'),
  group: 'match-812',
  meta: { pick: 'home', odds: 210 },
});
// 'open': the stake is in your bank and the bet is final. receipt.bet is the hash that names it.
```

`show` is your page's own.

- The wallet signs a debit carrying the game's key, the group and the meta, and sends it to the casino itself; your
  server never touches it. The reply comes at once: `open`, with `bet`, the hash that names the bet at the casino and
  to your server, or `rejected`.
- A developer bet is final: there is no taking it back, no deadline and no refund. It stays open until you settle it,
  and the game's public record counts the open ones.
- Only a published game takes developer bets. A game opened from a bare manifest URL is refused with `invalid-request`
  ([publishing](publishing.md)).
- Once you settle a bet, the wallet checks your signed settlement and collects what it pays into the player's channel.
  While the game is open, it raises the game's limit by that and pushes the receipt, `settled` with its `payout`, as a
  `game.receipt` event. The wallet looks every 4 seconds; a page that hears from your server that a bet has settled
  calls `HookedIn.receipt(id)`, and the wallet looks at once. After a reload, `HookedIn.receipt(id)` finds the bet.
- Until the wallet collects it, what a bet is paid is the casino's promise, outside the principal the contract
  protects.

## Meta

`meta` is your game's own JSON object, saying what the bet is: a pick and its odds, a layout of chips, a cash-out made
while a round runs. The player signs it; the casino keeps it with the bet and never reads it; your server reads it and
settles the bet by it. It takes at most `limits.meta` bytes as canonical JSON, 4,096, and its numbers are safe
integers: write odds as whole hundredths (`210`) or as a string (`'2.10'`).

Meta is what the player signed, not what you offered: check it against your offer before you pay it. For a page to
prove to your server that a bet is its own, it puts the hash of a secret it keeps in the meta.

## Your server

[`createDeveloper`](../sdk/developer.md#createdeveloper) from `@hookedin/play/sdk/developer` is the server's side. It
runs wherever `fetch` does: Node, or a Cloudflare Worker.

```ts
import { createDeveloper } from '@hookedin/play/sdk/developer';
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';

// Your key, and the name you publish the game under: with the key's address it makes the game's key.
const developer = await createDeveloper({
  casinoURL: 'https://casino.hookedin.com',
  key: process.env.DEVELOPER_KEY!,
  name: 'my-game',
});

/** Every open bet in a group, a page at a time. */
async function openBets(group: string) {
  const bets: PublicDeveloperBet[] = [];
  for (let after = ''; ;) {
    const page = await developer.bets({ status: 'open', group, after });
    bets.push(...page.bets);
    if (!page.more) return bets;
    after = page.cursor;
  }
}
```

`createDeveloper` reads the casino's `GET /api/config` and refuses a casino that speaks another revision of what
developers sign, with `protocol-mismatch`. `developer.game` is the game's key and `developer.limits` the bounds a bet is
held to. `developer.bets` pages open bets by hash, read from the start each time, and settled bets in the order they
settled, so a saved `cursor` never misses one; `developer.bet(hash)` reads one.

## Settling

```ts
/** The odds you offer, in hundredths of the stake. */
const OFFER: Record<string, number> = { home: 210, draw: 330, away: 380 };

/** The match ended: pay every bet on it. A bet on an offer you did not make gets its stake back. */
async function settleMatch(group: string, result: string) {
  const bets = await openBets(group);
  await developer.settle(
    bets.map(bet => {
      const odds = OFFER[String(bet.meta.pick)],
        offered = odds !== undefined && bet.meta.odds === odds;
      if (!offered) return { bet: bet.bet, player: BigInt(bet.stake), casino: 0n };
      return {
        bet: bet.bet,
        player: bet.meta.pick === result ? (BigInt(bet.stake) * BigInt(odds)) / 100n : 0n,
        // About half of what the bet is expected to earn you: 2% of a 4% margin.
        casino: BigInt(bet.stake) / 50n,
      };
    }),
  );
}
```

- [`settle`](../sdk/developer.md#settle) signs a `Settlement` for each bet with your key: the bet's hash, `player`,
  what the player is paid, and `casino`, what the casino is given, both from your bank. It posts them 256 at a time;
  each batch is paid whole or refused with `bank-short`, and its bets stay open. A bet settled before answers with what
  settled it.
- Settle each bet the moment it is decided, at the spin, the cash-out or the final whistle, so the player is paid at
  once.
- Give a bet you should not have taken its stake back.

## The casino's share

The casino's part of a developer bet is the `casino` amount your settlement gives it. The casino's policy asks for
about half of what each bet is expected to earn you, as a casino bet's commission splits in two; nothing enforces it. A
bet your own casino bet backs has paid its share already, as that casino bet's commission: settle it with `casino: 0n`.
See [earnings](earnings.md).

## Provably fair: rounds and your casino bet

A game whose players share one outcome can make it checkable by anyone, with two things the casino gives you: rounds,
and your casino bet on one.

- [`developer.openRound(asset)`](../sdk/developer.md#openround) asks the casino for a round in an asset, named by the
  hash of a secret the casino keeps. Every call names another round; keep track of yours.
- [`developer.seedHash(round.id)`](../sdk/developer.md#seedhash) is the hash of the seed your casino bet on that round
  will bring. The seed is derived from your key and the round, so it is the same on every call, and nobody without the
  key can know it.
- Publish the round and the seed hash before anybody bets, and have each bet name the seed hash in its meta. The casino
  records each bet's meta as it takes the bet, so the outcome was fixed before the bets, and neither you nor the casino
  knows it alone.
- When betting ends, place one casino bet on the round, from your bank, with
  [`developer.casinoBet({ round, stake, prizes, meta })`](../sdk/developer.md#casinobet). Add up the bets you back: its
  stake is theirs together and its prizes theirs added up, equal ranges adding and disjoint ranges hedging, at most 64
  prizes. Your bank then pays exactly what they win, and the bankroll carries the risk. The casino admits it like any
  casino bet, before it reads the round's secret, and reveals the round: its seed, secret, 64-bit outcome and your
  casino bet. Accepted, the bet's stake leaves your bank, what its prizes pay comes back, and half its commission is
  yours. Declined, it moves no money, and the round is revealed all the same.
- `meta` follows a developer bet's rules, and the casino keeps it with the reveal: commit there to what you chose
  before the outcome was known, such as the hash of the bets you back. Save that before you place the bet. The round is
  the casino bet's ID, so placing it again after a lost reply or a restart is the same bet, and gets the same answer.
- Then settle each bet by your scheme. Price a table before offering it with the casino's own rule
  ([`admits`](../sdk/admits.md#admits)).

```ts
import { concat, keccak256 } from 'ethers';
import { outcome } from '@hookedin/play/sdk/outcome';

// Before anybody bets: a round, and the hash of the seed your casino bet on it will bring. Tell your pages both.
const round = await developer.openRound('eth');
const seedHash = await developer.seedHash(round.id);

// When betting ends: every open bet on the round that named the seed hash, saved before your casino bet.
const bets = (await openBets(round.id.slice(2))).filter(bet => bet.meta.seedHash === seedHash);
const covered = bets.map(bet => bet.bet);
await save(round.id, covered);
const revealed = await developer.casinoBet({
  round: round.id,
  ...together(bets), // their stakes and prizes added up
  meta: { covered: keccak256(concat(covered)) },
});

// Each bet is paid what its own prizes pay on the outcome, or its stake if the bankroll declined the casino bet.
await developer.settle(
  bets.map(bet => ({
    bet: bet.bet,
    player: revealed.casinoBet?.accepted
      ? outcome(prizesOf(bet), revealed.seed!, revealed.secret!).payout
      : BigInt(bet.stake),
    casino: 0n,
  })),
);
```

`save`, `together` and `prizesOf` are your game's own:
[roulette's `together`](https://github.com/hookedin/game-roulette/blob/main/src/table.ts) adds layouts up pocket by
pocket. The group is the round's 64 hex digits, which fits a group's 64 characters. `ethers` comes with
`@hookedin/play`; add it to your own dependencies to import it.

## The order of requests

One round of a provably fair game, from the first request to the players' money, and who signs what:

1. **The server opens a round.** `developer.openRound(asset)` sends
   [`POST /api/rounds`](../casino-api/developers.md#post-apirounds), authorized by a `DeveloperAccess` token your key
   signs. The casino picks a secret, keeps it, and names the round by its hash
   ([`openRound`](../sdk/developer.md#openround)).
2. **The server publishes the seed hash.** `developer.seedHash(round.id)` works it out locally from your key, and your
   server gives its pages the round and the seed hash through its own API. Nothing is signed
   ([`seedHash`](../sdk/developer.md#seedhash)).
3. **Players bet.** Each page calls [`game.developerBet`](../reference/bridge.md#gamedeveloperbet) with the round in its
   `group` and the seed hash in its `meta`. The player's wallet signs a debit with its channel key and sends it to
   [`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations); the casino signs the
   channel's next state, records the bet with its meta, group and time, and puts the stake in your bank.
4. **The server's casino bet reveals the round.** When betting ends, the server reads the open bets
   ([`GET /api/developer-bets`](../casino-api/public.md#get-apideveloper-bets)), saves which it backs, and places its
   casino bet: `developer.casinoBet` sends
   [`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet) with the seed and a
   `BankCasinoBet` your key signs over the round, the game, the stake, the prizes, the seed hash and the meta's hash.
   The casino admits it against the bankroll before reading the secret, then reveals the round; the SDK checks that the
   revealed secret hashes to the round ([`casinoBet`](../sdk/developer.md#casinobet)).
5. **The server settles.** For each bet a `Settlement` your key signs over the bet's hash, the player's amount and the
   casino's: `developer.settle` sends
   [`POST /api/developer-bets/settle`](../casino-api/developers.md#post-apideveloper-betssettle), paid from your bank
   ([`settle`](../sdk/developer.md#settle)).
6. **The wallet collects.** Each player's wallet reads the settled bet
   ([`GET /api/developer-bets/:bet`](../casino-api/public.md#get-apideveloper-betsbet)), checks your signature over it,
   signs a credit for exactly the player's amount with its channel key, and the casino signs the channel's next state.
   The wallet then pushes the settled receipt to the page ([events](../reference/bridge.md#events)).

Anyone can then check the round: [`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround) shows its
seed, its secret, the outcome and your casino bet with its meta, and [`outcome`](../sdk/outcome.md#outcome),
`roundId` and `seedHash` from `@hookedin/play/sdk/outcome` recompute them.

## Roulette, the worked example

[Roulette](https://github.com/hookedin/game-roulette) runs this scheme with one wheel per asset.

- The wheel, [server/wheel.ts](https://github.com/hookedin/game-roulette/blob/main/server/wheel.ts), keeps one round
  open and serves `GET /api/table`: `{ round, seedHash, closesAt, now, players, staked }`.
- The page, [src/game.ts](https://github.com/hookedin/game-roulette/blob/main/src/game.ts), places a player's whole
  layout as one developer bet: its `group` is the round's 64 hex digits and its meta `{ seedHash, chips }`, each chip a
  spot and its amount as a decimal string. It then posts `POST /api/table/placed`. The wheel believes the casino, not
  the page, and reads the open bets itself.
- Twenty seconds after the first bet, by the casino's clock, the wheel saves the list of bets it covers, every open bet
  in the group that names the seed hash and is a layout of known spots adding up to its stake, and places one casino
  bet of all their chips together, at most one prize per pocket, with meta `{ covered }`: the `keccak256` of the
  covered bets' hashes, in order.
- It keeps the spin at `GET /api/spins/:round` and settles every bet: what its chips pay on the number if the spin
  covered it, and its stake otherwise, for a bet too late for the spin, a bet that is not a layout, or a spin the
  bankroll declined. `casino` is `0`: the commission is on the wheel's casino bet.
- The page reads the spin, checks the secret against the round and the seed against the seed hash its bet named, and
  works out the number itself.

Its README's [fairness and trust](https://github.com/hookedin/game-roulette#fairness-and-trust) says how anyone checks
a spin.

## Crash games

A crash game whose players all set their cash-out before the round fits a round: each cash-out is one prize, and the
server backs them with its casino bet as roulette does. A cash-out made by hand while the curve climbs cannot ride a
round: to know when to crash, the server would have to reveal the round at take-off, and a revealed round is public, so
every page would know the crash point. Such a game keeps its crash point to itself and settles every bet on its word.

## One Cloudflare Worker

A game with a server ships page and server as one Cloudflare Worker: `dist/` as static assets, and `server/worker.ts`
answering `/api/`, with a Durable Object holding its state. Page and server share an origin, so the build's
`connect-src 'self'` holds. [Roulette's repository](https://github.com/hookedin/game-roulette) is a GitHub template with
all of this in place, tested and deployed on every push; its `wrangler.jsonc`, for a game of your own:

```json
{
  "name": "my-game",
  "main": "server/worker.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "dist", "binding": "ASSETS", "run_worker_first": ["/api/*"] },
  "durable_objects": { "bindings": [{ "name": "WHEEL", "class_name": "RouletteWheel" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RouletteWheel"] }],
  "vars": { "CASINO_URL": "https://casino.hookedin.com", "GAME_NAME": "my-game" },
  "build": { "command": "npm run build", "watch_dir": "src" }
}
```

- `CASINO_URL` is the casino's API. `GAME_NAME` is the name you publish the game under; with the key's address it makes
  the game's key.
- `DEVELOPER_KEY`, the private key of the account you publish from, is a secret: set it once with
  `npx wrangler secret put DEVELOPER_KEY`. Locally, pass it to `npx wrangler dev --var DEVELOPER_KEY:0x…`, or put it in
  a `.dev.vars` file that git ignores.
- The Durable Object creates its developer once, as
  [server/worker.ts](https://github.com/hookedin/game-roulette/blob/main/server/worker.ts) does:

  ```ts
  const developer = await createDeveloper({ casinoURL: env.CASINO_URL, key: env.DEVELOPER_KEY, name: env.GAME_NAME });
  ```

- Developer bets need a published game, so publish it under `GAME_NAME` from the developer's wallet to play it:
  locally, at the Worker's own manifest URL, such as `http://127.0.0.1:8790/manifest.json` for roulette under
  `wrangler dev` ([publishing](publishing.md)).
