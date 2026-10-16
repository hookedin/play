---
title: Developer bets
description: Bets against you, settled by your server, and provably fair schemes on your rounds and your casino bets.
sidebar:
  order: 7
---

A developer bet is a bet against you, the game's developer, not the casino's bankroll: many players on one roulette
spin, a crash curve, a football match. The player's wallet places it with the casino, its stake goes straight into your
game's bank, and your server settles it later, paying from that bank. Playing such a game trusts you: the player is paid
what your settlement says, and whether you can pay is between you and your players, a [settled
trade-off](../overview/architecture.md#settled-trade-offs) the wallet tells players of ([trust
model](../overview/trust-model.md)). Trying one takes a stand-in casino or real ETH ([trying it](#trying-it)).

## Your game's server key and bank

Your server signs with the game's **server key**, a key you make for it and name beside the game on the wallet's
**Developer** page ([`POST /api/account/games/server`](../casino-api/channels.md#post-apiaccountgamesserver)); until you
do, it is your account's own key, which holds everything the account holds, so name one before your server runs. Only
that key settles the game's developer bets, opens its rounds and places the casino bets that back them, spending the
game's bank and nothing else: a key that leaks costs the game's bank at most, and naming another makes the old one
nothing.

Make it in your game's folder: this saves the key in `.dev.vars`, which `wrangler dev` reads and git ignores, and prints
only its address.

```sh
node -e "const w = require('ethers').Wallet.createRandom(); require('fs').appendFileSync('.dev.vars', 'SERVER_KEY=' + w.privateKey + '\n'); console.log(w.address)"
```

Name that address on **Developer**, and give the deployed Worker the key with `npx wrangler secret put SERVER_KEY`. The
key goes nowhere else: not into the wallet, a command line or a message.

The game's **bank** is a balance at the casino ([earnings](publishing.md#earnings)): the stakes of its developer bets
and half the commission of its casino bets go in, and its settlements and its own casino bets are paid from it. Nothing
in it is reserved.

## Placing a bet from the page

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';

const id = crypto.randomUUID(); // saved with the bet before asking, like any operation
HookedIn.onReceipt(receipt => {
  if (receipt.id === id) show(`Paid ${HookedIn.formatAmount(receipt.payout!)}`);
});
const receipt = await HookedIn.developerBet({
  id,
  stake: 1000n * HookedIn.METH,
  group: 'match-812',
  meta: { pick: 'home', odds: 210 },
});
// 'open': the stake is in your game's bank and the bet is final. receipt.bet is the hash that names it.
```

`show` is your page's own.

- The wallet signs a debit carrying the game's ID, the group, the meta and the bet's [round](#a-round-of-your-own) if it
  names one, and sends it to the casino. The reply comes at once: `open`, with `bet`, the hash that names the bet at the
  casino and to your server, or `rejected`. An open bet is final, with no deadline and no refund, until you settle it.
- Only a published game takes developer bets: a game opened by its URL alone is refused with `invalid-request`
  ([publishing](publishing.md#publish-it)). A deposit pays one only once the chain finalizes it, about 15 minutes after
  it; what the player won or was sent pays at once.
- The player allows developer bets with the allowance: call `HookedIn.placesDeveloperBets()` as your page loads, so the
  dialog warns of them and **Allow** allows them too ([the allowance](how-a-game-works.md#the-allowance)). Until then, a
  developer bet is refused with `developer-bets-not-allowed`, whose message is
  [`HookedIn.NO_DEVELOPER_BETS`](../sdk/hookedin.md#no_developer_bets).
- Once your server settles a bet, the wallet checks the settlement against your server key, collects what it pays into
  the bet's group, which joins the allowance when the page ends it with
  [`HookedIn.end`](../reference/bridge.md#gameend), and pushes the `settled` receipt as a `game.receipt` event. It looks
  every 10 minutes, so a page that hears from your server that a bet has settled calls `HookedIn.receipt(id)` to have it
  look at once.
- Until the wallet collects it, what a bet is paid is the casino's promise, outside what the contract protects.

## Meta

`meta` is your game's own JSON object, saying what the bet is: a pick and its odds, a layout of chips, a cash-out made
while a round runs. The player signs it, the casino keeps it with the bet and never reads it, and your server settles
the bet by it. It takes at most `bounds.meta` bytes as canonical JSON, 4,096, its numbers are safe integers, so odds go
as whole hundredths (`210`) or a string (`'2.10'`), and its text is well-formed, without a NUL.

Meta is what the player signed, not what you offered: check it against your offer before you pay it. For a page to prove
to your server that a bet is its own, it puts the hash of a secret it keeps in the meta.

## Your server

[`createDeveloper`](../sdk/developer.md#createdeveloper) from `@hookedin/play/sdk/developer` is the server's side,
wherever `fetch` runs: Node, or a Cloudflare Worker.

```ts
import { createDeveloper } from '@hookedin/play/sdk/developer';
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';

// A Worker's env holds the game's server key, as a secret, and the game's ID, which the Developer page shows beside
// the game.
const developer = await createDeveloper({
  casinoURL: 'https://casino.hookedin.com',
  key: env.SERVER_KEY,
  game: env.GAME,
});

/** Every open bet of the game, a page at a time, in the order they were placed. */
async function openBets() {
  const bets: PublicDeveloperBet[] = [];
  for (let after = ''; ;) {
    const page = await developer.bets({ status: 'open', after });
    bets.push(...page.bets);
    if (!page.more) return bets;
    after = page.cursor;
  }
}

/** Every open bet now, then each new one as it is placed, while `running()` says so. */
async function follow(take: (bets: PublicDeveloperBet[]) => Promise<void>, running: () => boolean) {
  for (let after = ''; running();)
    try {
      // Held up to 25 seconds until a bet comes.
      const page = await developer.bets({ after, wait: 25 });
      await take(page.bets);
      after = page.cursor;
    } catch {
      // Again shortly, from the oldest open bet: the casino may be away, or its records restored.
      after = '';
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
}
```

A server that runs a table follows its bets: the casino holds each request until a bet on the game is placed, and the
server asks again with the page's cursor, taking each page before it moves the cursor on, so a bet it failed to take
comes again. Only the game's server key waits, one wait per game at a time, a newer wait answering the one before, and
at most 4 games per key: run one server per game, as one Durable Object does. After a restart or a failed read, start
from the beginning: the bets open then are the ones still to settle, and your server finds those it already took by
their hash.

## Settling

```ts
/** The odds you offer on each pick, in hundredths of the stake. */
const OFFER = new Map([
  ['home', 210],
  ['draw', 330],
  ['away', 380],
]);

/** The match ended: pay every bet on it. A bet whose meta is not exactly a pick and the odds you offer on it gets its
 * stake back: a player writes their own meta, so take it in one form only. */
async function settleMatch(group: string, result: string) {
  const bets = (await openBets()).filter(bet => bet.group === group);
  await developer.settle(
    bets.map(bet => {
      const { pick, odds, ...more } = bet.meta,
        offered = typeof pick === 'string' && OFFER.get(pick) === odds && Object.keys(more).length === 0;
      if (!offered) return { bet: bet.bet, player: bet.stake, casino: 0n };
      return {
        bet: bet.bet,
        player: pick === result ? (bet.stake * BigInt(odds as number)) / 100n : 0n,
        // About half of what the bet is expected to earn you: 2% of a 4% margin.
        casino: bet.stake / 50n,
      };
    }),
  );
}
```

[`settle`](../sdk/developer.md#settle) signs a `Settlement` for each bet with the server key: the bet's hash, `player`,
what the player is paid, and `casino`, what the casino is given, both from the game's bank. It posts them 256 at a time;
each batch is paid whole or refused with `bank-short`, its bets staying open, and a bet settled before answers with what
settled it. Settle each bet the moment it is decided, at the spin, the cash-out or the final whistle, and give a bet you
should not have taken its stake back.

## A round of your own

A bet can ride on a secret your server chose before the player signed it. Keep a secret of 32 random bytes, publish its
`keccak256` hash, `0x` and 64 lowercase hex digits, as the round, and have the page name it on each bet:

```ts
const receipt = await HookedIn.developerBet({ id, stake, meta, round, group });
```

The player signs the round with the bet. The casino settles a bet that names a round only with the secret that hashes to
it, and refuses a secret with any other bet: settle it with `{ bet, player, casino, secret }`, the secret beside the
signed `Settlement`, which proves itself by its hash. The wallet checks the secret before it collects, and shows the
player, under **Fixed before you bet**, the round their bet named and the secret that hashes to it. What the secret
decides is your game's rules, which the player can then check; the round proves only that you chose it before they bet.
You know it from the start, so a draw nobody may know in advance rides on the casino's
[rounds](#provably-fair-rounds-and-your-casino-bets) instead.

## The casino's share

The casino's part of a developer bet is the `casino` amount your settlement gives it: its policy asks for about half of
what the bet is expected to earn you, and nothing enforces it ([pricing and commission](../reference/economics.md)). A
bet your own casino bets back has paid its share already, as their commission: settle it with `casino: 0n`.

## Provably fair: rounds and your casino bets

A game whose players share one outcome can make it checkable by anyone, with rounds the casino names for it and your
casino bets on them:

- [`developer.openRound()`](../sdk/developer.md#openround) asks the casino for a round, named by the hash of a secret
  the casino keeps. Every call names another round; keep track of yours.
- [`developer.seedHash(round.id)`](../sdk/developer.md#seedhash) is the hash of the seed your casino bet on that round
  will bring, derived from the server key and the round, so it is the same on every call, and nobody without the key can
  know it.
- [`developer.casinoBet({ round, stake, chance, prize, group, meta })`](../sdk/developer.md#casinobet) places a casino
  bet on the round from the game's bank, paying `prize` into the bank when the round's outcome is below `chance`. The
  casino admits it like any casino bet, before it reads the round's secret, and reveals the round, accepted or declined:
  its seed, secret, 64-bit outcome and your casino bet. A bank short of the stake is refused with `bank-short`,
  revealing nothing.
- [`developer.reveal({ round, group, meta })`](../sdk/developer.md#reveal) reveals a round without betting anything: a
  casino bet of stake, chance and prize zero, signed, grouped and kept like any other.
- `group`, 1 to 64 characters, is required: give your casino bets the group of the developer bets they concern, so
  anyone reads them together. `meta` follows a developer bet's rules, and the casino keeps it with the reveal: commit
  there, before the outcome is known, to what you chose, such as the bets you cover, and save it before you place the
  bet. The round is the casino bet's ID, so placing it again after a lost reply or a restart is the same bet, with the
  same answer.

Neither party alone knows a round's outcome before it is revealed: the casino does not know the seed, and you do not
know the secret, so what a casino bet's meta commits to cannot be chosen to favour anyone.

## Shared games: binary steps

A game whose players share one draw of `n` equally likely outcomes, such as a roulette wheel's 37 pockets, draws it as a
walk down a fixed balanced binary tree over them, one level per round. Each level is one casino bet of yours, from the
game's bank, priced backward from what you owe on each outcome, so the bankroll backs the whole draw. [Binary
steps](../sdk/steps.md) prices the tree, gives each level's bet and walks it, and `stepOutcome` checks a walk from what
the casino publishes.

Each chance rounds down to whole outcomes, so an outcome is reached with its share to within one outcome in 2^64 per
level. Name each level's side in its casino bet's meta, signed before its round is revealed. A level the bank cannot
fund still reveals its round, with `reveal`, and one the bankroll declines is revealed by the declined bet: the walk
goes on either way, and the bank carries that level itself. Whether the bankroll takes a step decides who carries it,
never how likely each outcome is.

**Open the rounds before anybody bets.** A draw needs [`levels(n)`](../sdk/steps.md#levels) rounds, one per level of the
deepest walk. Open them all first, work out their seed hashes, and give the draw an ID that commits to both, such as the
hash of the rounds and then the seed hashes; its players' bets carry that ID as their `group`, so the casino records the
commitment with every bet. Level `k` of the walk is then placed on round `k`, and nothing else. A server that opened its
rounds after its players bet could reveal one, dislike where the walk went, and walk again on a fresh round, and no page
could tell.

```ts
import { concat, keccak256 } from 'ethers';
import { levels, next, priceSteps, stepBet } from '@hookedin/play/sdk/steps';
import type { StepNode } from '@hookedin/play/sdk/steps';

// Before anybody bets: the draw's rounds and seed hashes, and its ID, which its players' bets carry as their group.
const rounds: string[] = [];
for (let level = 0; level < levels(n); level++) rounds.push((await developer.openRound()).id);
const seedHashes = await Promise.all(rounds.map(round => developer.seedHash(round))),
  group = keccak256(concat([...rounds, ...seedHashes])).slice(2);
await save({ group, rounds, seedHashes }); // before anybody is told of it

// When betting ends: the bets you cover and what you owe on each outcome, saved before the first step.
const bets = (await openBets()).filter(bet => bet.group === group),
  covered = bets.map(bet => bet.bet),
  owed = owedOn(bets),
  plan = priceSteps(owed, await developer.virtualBankroll());
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
            if (error.code === 'bank-short') return reveal(); // the bank carries this level
            throw error;
          })
      : await reveal();
  const staked = revealed.casinoBet!.stake !== 0n;
  node = next(node, staked ? revealed.casinoBet!.meta.side : 'left', revealed.outcome!);
}

// The walk reached node.lo: pay each covered bet what it wins there. The commission is on your casino bets.
await developer.settle(bets.map(bet => ({ bet: bet.bet, player: pays(bet, node.lo), casino: 0n })));
```

`n` is how many outcomes the draw has. `save`, `owedOn` and `pays` are your game's own: [roulette's
`src/table.ts`](https://github.com/hookedin/game-roulette/blob/main/src/table.ts) turns chips into what each pocket
pays. [`developer.virtualBankroll()`](../sdk/developer.md#virtualbankroll) is what the casino admits casino bets
against, as it last reported it; pricing at it, as roulette does, leaves the other half of the bankroll for ordinary
movement. After a restart, finish the walk from what you saved: a level's round, revealed already, is the step as it was
placed. `ethers` comes with `@hookedin/play`; add it to your own dependencies to import it.
[Roulette](https://github.com/hookedin/game-roulette) runs this scheme with one wheel for every player: its README walks
through a spin, and its page checks each one.

## The order of requests

One draw of a provably fair game, from the first request to the players' money:

1. **The server opens the draw**: `developer.openRound()` sends
   [`POST /api/rounds`](../casino-api/developers.md#post-apirounds) once per level, with a `DeveloperAccess` token the
   server key signs, and the server publishes the draw's ID.
2. **Players bet**: each page calls [`game.developerBet`](../reference/bridge.md#gamedeveloperbet) with the draw's ID as
   its `group`, and the wallet sends the signed debit to
   [`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations), which puts the stake
   in the game's bank.
3. **The server closes betting**: it reads the open bets
   ([`GET /api/developer-bets`](../casino-api/public.md#get-apideveloper-bets)), saves which it covers and what it owes
   on each outcome, and prices the walk.
4. **The server walks**, one round per level: `developer.casinoBet` or `developer.reveal` sends
   [`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet) with the seed and a
   signed `BankCasinoBet`, and the casino reveals the round.
5. **The server settles**: `developer.settle` sends
   [`POST /api/developer-bets/settle`](../casino-api/developers.md#post-apideveloper-betssettle), a signed `Settlement`
   per bet, paid from the game's bank.
6. **The wallet collects**: it reads the settled bet
   ([`GET /api/developer-bets/:bet`](../casino-api/public.md#get-apideveloper-betsbet)), checks the signatures and any
   round's secret, signs a credit for exactly the player's amount, and pushes the settled receipt to the page
   ([events](../reference/bridge.md#events)).

Anyone can then check the draw: [`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround) shows each
round's seed, secret, outcome and your casino bet with its group and meta, and
[`@hookedin/play/sdk/outcome`](../sdk/outcome.md#checking-a-round) recomputes them. A page talks to nobody but its own
origin: it reads a round through its player's wallet with [`HookedIn.round`](../reference/bridge.md#walletround).

## Crash games

A crash game whose players all set their cash-out before the draw fits the same walk: its equally likely outcomes are
crash points, and on each the server owes what the cash-outs it reaches pay. A cash-out made by hand while the curve
climbs cannot ride a round: to know when to crash, the server would have to reveal the draw at take-off, and a revealed
round is public, so every page would know the crash point. Such a game keeps its crash point to itself and settles every
bet on its word, as the house's [crash](https://github.com/hookedin/game-crash) does: a flight's ID is the hash of a
secret revealed after the crash, each seat names it as its [round](#a-round-of-your-own), and each escape is paid from
the game's bank once the flight has crashed, with the secret.

## One Cloudflare Worker

A game with a server ships page and server as one Cloudflare Worker: `dist/` as static assets, and a Worker answering
`/api/` with a Durable Object holding its state, on the page's own origin, so the build's `connect-src 'self'` holds.
Roulette's Durable Object follows the game's bets while a page watches and sends every page the table as it changes, as
server-sent events. [Roulette's repository](https://github.com/hookedin/game-roulette) is a GitHub template with all of
this in place: its `wrangler.jsonc` names the casino and the game's ID, as `GAME`, and its README sets `SERVER_KEY`, the
key you name as the game's server, as a secret.

## Trying it

The local wallet [`hookedin-game serve`](quick-start.md#try-it-with-pretend-money) serves takes casino bets only: its
casino lives in the page, out of your server's reach. Without ETH, a game with a server is tried two ways:

- Its tests, where [`gameWallet`](testing.md#gamewallet)'s `developer` stands in for the `Developer` your server
  creates, against the same stub casino as the wallet ([testing a server](testing.md#testing-a-server)).
- A local preview that runs your page and your server against that stand-in, as crash's `npm run demo` does with its
  [test/harness.ts](https://github.com/hookedin/game-crash/blob/main/test/harness.ts).

With the real casino, developer bets take real ETH. From an account with a balance, publish the game at the URL your
server runs on, `http://127.0.0.1:<port>/` while you work, name its server key, put a little in its bank if its casino
bets need it, and play it at its name. Once it is deployed, publish the same name with the deployed URL: it keeps its
ID, its bank and its server key.
