---
title: Developer bets
description: Bets against you, settled by your server, and provably fair schemes on your rounds and your casino bets.
sidebar:
  order: 8
---

A developer bet is a bet against you, the game's developer, not the casino's bankroll: many players on one roulette
spin, a crash curve, a football match. The player's wallet places it with the casino, and its stake goes straight into
your bank; your server settles it later, paying from that bank. A game that takes developer bets runs a server with
your key.

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
bet your own casino bets back has paid its share already, as their commission: settle it with `casino: 0n`. See
[earnings](earnings.md).

## Provably fair: rounds and your casino bets

A game whose players share one outcome can make it checkable by anyone, with two things the casino gives you: rounds,
and your casino bets on them.

- [`developer.openRound(asset)`](../sdk/developer.md#openround) asks the casino for a round in an asset, named by the
  hash of a secret the casino keeps. Every call names another round; keep track of yours.
- [`developer.seedHash(round.id)`](../sdk/developer.md#seedhash) is the hash of the seed your casino bet on that round
  will bring. The seed is derived from your key and the round, so it is the same on every call, and nobody without the
  key can know it.
- [`developer.casinoBet({ round, stake, chance, prize, group, meta })`](../sdk/developer.md#casinobet) places a casino
  bet on the round from your bank: it pays `prize` into your bank when the round's outcome is below `chance`. Your bank
  must hold the stake, or the casino refuses the bet with `bank-short` and reveals nothing. The casino admits the bet
  like any casino bet, before it reads the round's secret, and reveals the round: its seed, secret, 64-bit outcome and
  your casino bet. Accepted, the stake leaves your bank, the prize comes back if the bet wins, and half its commission
  is yours. Declined, it moves no money, and the round is revealed all the same.
- [`developer.reveal({ round, group, meta })`](../sdk/developer.md#reveal) reveals a round without betting anything: a
  casino bet of stake, chance and prize zero, signed, grouped and kept like any other.
- `group`, 1 to 64 characters, is required: give your casino bets the group of the developer bets they concern, so
  anyone reads them together. `meta` follows a developer bet's rules, and the casino keeps it with the reveal: commit
  there to what you chose before the outcome was known, such as the bets you cover. Save it before you place the bet.
  The round is the casino bet's ID, so placing it again after a lost reply or a restart is the same bet, and gets the
  same answer.

Neither party alone knows a round's outcome before it is revealed: the casino does not know the seed, and you do not
know the secret. What a casino bet's meta commits to before its round is revealed cannot be chosen to favour anyone.

## Shared games: binary steps

A casino bet has two outcomes. A game whose players share one draw of `n` equally likely outcomes, such as a roulette
wheel's 37 pockets, draws it as a walk down a fixed balanced binary tree over them, one level per round. A node
`[lo, hi)` splits at `mid = lo + ⌊(hi − lo)/2⌋`, and each level is one casino bet of yours, from your bank, priced
backward from what you owe on each outcome, so the bankroll backs the whole draw.
[`@hookedin/play/sdk/steps`](../sdk/steps.md) builds it:

- [`priceSteps(owed, bankroll)`](../sdk/steps.md#pricesteps) prices the tree from `owed`, what you owe on each
  outcome: a leaf needs what is owed on it, a node whose children need the same cash needs that, and any other node the
  least cash whose bet between its children the casino's rule admits at `bankroll`.
  [`stepsCash(plan)`](../sdk/steps.md#stepscash) is what your bank needs at the start.
- [`stepBet(plan, node)`](../sdk/steps.md#stepbet) is a level's casino bet. It backs `side`, the child that needs more
  cash, with that child's share of the node's outcomes as its chance, so whichever way its round goes, your bank then
  holds exactly what the rest of the walk needs, and at the leaf exactly what you owe there. It is `null` where both
  children need the same cash: the level only reveals its round.
- [`next(node, side, outcome)`](../sdk/steps.md#next) takes one level: an outcome below the chance of the side the
  level named reaches that side, and any other the other side. A level with no bet names the left.
- [`stepOutcome(n, steps)`](../sdk/steps.md#stepoutcome) is the verifier: the leaf a walk reaches from each step's
  side, chance and round's outcome. It checks that each chance is its side's share.

Each chance rounds down to whole outcomes, so an outcome is reached with its share to within one outcome in 2^64 per
level. Name each level's side in its casino bet's meta, which is signed before its round is revealed. A level your bank
cannot fund still reveals its round, with `reveal`, and one the bankroll declines is revealed by the declined bet: the
walk goes on either way, and your bank carries that level itself. Whether the bankroll takes a step decides who carries
it, never how likely each outcome is.

**Open the rounds before anybody bets.** A draw needs [`levels(n)`](../sdk/steps.md#levels) rounds, one per level of
the deepest walk. Open them all first, work out their seed hashes, and give the draw an ID that commits to both, such as
the hash of the rounds and then the seed hashes; its players' bets carry that ID as their `group`, so the casino records
the commitment with every bet. Level `k` of the walk is then placed on round `k`, and nothing else. A server that opened
its rounds after its players bet could reveal one, dislike where the walk went, and walk again on a fresh round, and no
page could tell.

```ts
import { concat, keccak256 } from 'ethers';
import { levels, next, priceSteps, stepBet } from '@hookedin/play/sdk/steps';
import type { StepNode } from '@hookedin/play/sdk/steps';

// Before anybody bets: the draw's rounds and seed hashes, and its ID, which its players' bets carry as their group.
const rounds: string[] = [];
for (let level = 0; level < levels(n); level++) rounds.push((await developer.openRound('eth')).id);
const seedHashes = await Promise.all(rounds.map(round => developer.seedHash(round))),
  group = keccak256(concat([...rounds, ...seedHashes])).slice(2);
await save({ group, rounds, seedHashes }); // before anybody is told of it

// When betting ends: the bets you cover and what you owe on each outcome, saved before the first step.
const bets = await openBets(group),
  covered = bets.map(bet => bet.bet),
  owed = owedOn(bets),
  plan = priceSteps(owed, (await developer.bankroll('eth')) / 2n);
let node: StepNode = { lo: 0, hi: n };
for (let level = 0; node.hi - node.lo > 1; level++) {
  const round = rounds[level]!,
    bet = stepBet(plan, node),
    // Signed before the round is revealed: the bets the walk covers, in the first step.
    meta = level ? {} : { covered: keccak256(concat(covered)) },
    reveal = () => developer.reveal({ round, group, meta });
  let revealed = await developer.round(round); // revealed already after a restart
  if (revealed.status !== 'revealed')
    revealed = bet
      ? await developer
          .casinoBet({
            round,
            stake: bet.stake,
            chance: bet.chance,
            prize: bet.prize,
            group,
            meta: { ...meta, side: bet.side },
          })
          .catch(error => {
            if (error.code === 'bank-short') return reveal(); // your bank carries this level
            throw error;
          })
      : await reveal();
  const staked = revealed.casinoBet!.stake !== '0';
  node = next(node, staked ? revealed.casinoBet!.meta.side : 'left', BigInt(revealed.outcome!));
}

// The walk reached node.lo: pay each covered bet what it wins there. The commission is on your casino bets.
await developer.settle(bets.map(bet => ({ bet: bet.bet, player: pays(bet, node.lo), casino: 0n })));
```

`n` is how many outcomes the draw has. `save`, `owedOn` and `pays` are your game's own:
[roulette's `src/table.ts`](https://github.com/hookedin/game-roulette/blob/main/src/table.ts) turns chips into what each
pocket pays. [`developer.bankroll`](../sdk/developer.md#bankroll) is the casino's reported bankroll in the asset;
pricing at half of it, as roulette does, leaves room for ordinary movement. After a restart, finish the walk from what
you saved: a level's round, revealed already, is the step as it was placed. `ethers` comes with `@hookedin/play`; add it
to your own dependencies to import it.

## The order of requests

One draw of a provably fair game, from the first request to the players' money, and who signs what:

1. **The server opens the draw.** `developer.openRound(asset)` sends
   [`POST /api/rounds`](../casino-api/developers.md#post-apirounds) once per level, authorized by a `DeveloperAccess`
   token your key signs: the casino picks a secret for each, keeps it, and names the round by its hash. The server
   works out each round's seed hash and publishes the draw's ID, which commits to both.
2. **Players bet.** Each page calls [`game.developerBet`](../reference/bridge.md#gamedeveloperbet) with the draw's ID
   in its `group`. The player's wallet signs a debit with its channel key and sends it to
   [`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations); the casino signs the
   channel's next state, records the bet with its meta, group and time, and puts the stake in your bank.
3. **The server closes betting.** It reads the open bets in the group
   ([`GET /api/developer-bets`](../casino-api/public.md#get-apideveloper-bets)), saves which it covers and what it owes
   on each outcome, and prices the walk.
4. **The server walks, one of the draw's rounds per level.** `developer.casinoBet`, or `developer.reveal`, sends
   [`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet) with the seed and a
   `BankCasinoBet` your key signs over the round, the game, the stake, the chance, the prize, the group, the seed hash
   and the meta's hash. The casino admits it against the bankroll before reading the secret, then reveals the round; the
   SDK checks that the revealed secret hashes to the round and that the outcome is the seed's and the secret's
   ([`casinoBet`](../sdk/developer.md#casinobet)).
5. **The server settles.** For each bet a `Settlement` your key signs over the bet's hash, the player's amount and the
   casino's: `developer.settle` sends
   [`POST /api/developer-bets/settle`](../casino-api/developers.md#post-apideveloper-betssettle), paid from your bank
   ([`settle`](../sdk/developer.md#settle)).
6. **The wallet collects.** Each player's wallet reads the settled bet
   ([`GET /api/developer-bets/:bet`](../casino-api/public.md#get-apideveloper-betsbet)), checks your signature over it,
   signs a credit for exactly the player's amount with its channel key, and the casino signs the channel's next state.
   The wallet then pushes the settled receipt to the page ([events](../reference/bridge.md#events)).

Anyone can then check the draw: [`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround) shows each
round's seed, its secret, the outcome and your casino bet with its group and meta;
[`outcome`](../sdk/outcome.md#outcome), `roundId` and `seedHash` from `@hookedin/play/sdk/outcome` recompute them, and
`stepOutcome` walks the steps to the outcome they reach. A page talks to nobody but its own origin: it reads a round
through its player's wallet with [`HookedIn.round`](../sdk/hookedin.md#hookedin), which asks the casino.

## Roulette, the worked example

[Roulette](https://github.com/hookedin/game-roulette) runs this scheme with one wheel per asset.

- Each spin opens its six rounds before anybody bets, and its ID is the hash of the rounds and then their seed hashes,
  which the table publishes. The page places a player's whole layout as one developer bet, with the spin as its `group`
  and meta `{ chips }`, each chip a spot and its amount as a decimal string. The wheel believes the casino, not the
  page, and reads the open bets itself.
- At close, the wheel works out what it owes on each of the 37 pockets from the bets it covers, prices the tree once
  with `priceSteps` at half the casino's reported bankroll, and walks it: the spin's round for each level, `stepBet`
  placed as its casino bet with the spin as its group and meta `{ side }`, the first step's meta also committing to the
  covered bets. A level its bank cannot fund, or that the bankroll declines, still reveals its round, so the walk
  reaches its pocket in 5 or 6 steps whatever the bankroll does.
- It settles every covered bet by what its chips pay on the pocket, with `casino` 0: the commission is on the wheel's
  casino bets.
- Nobody can choose the pocket: the casino does not know the wheel's seeds, the wheel does not know the casino's
  secrets, and both were fixed in the spin's ID before anybody bet.
- The page checks each step at the casino through its player's wallet (`HookedIn.round`: the secret, the seed against
  the spin's seed hash, the group and the outcome), runs `stepOutcome` to the pocket, and checks that its own bet is
  covered and paid.

## Crash games

A crash game whose players all set their cash-out before the draw fits the same walk: its equally likely outcomes are
crash points, and on each the server owes what the cash-outs it reaches pay. A cash-out made by hand while the curve
climbs cannot ride a round: to know when to crash, the server would have to reveal the draw at take-off, and a revealed
round is public, so every page would know the crash point. Such a game keeps its crash point to itself and settles
every bet on its word.

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
