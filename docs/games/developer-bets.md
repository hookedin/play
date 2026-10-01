---
title: Developer bets
description: Bets against you, settled by your server, and provably fair schemes on your rounds and your casino bets.
sidebar:
  order: 6
---

A developer bet is a bet against you, the game's developer, not the casino's bankroll: many players on one roulette
spin, a crash curve, a football match. The player's wallet places it with the casino, and its stake goes straight into
your bank; your server settles it later, paying from that bank. A game that takes developer bets runs a server with
your key.

Playing such a game trusts you. The player is paid what your settlement says, and whether you can pay is between you and
your players, outside HookedIn: a [settled trade-off](../overview/architecture.md#settled-trade-offs). The wallet tells
players so ([trust model](../overview/trust-model.md)).

## Your key and your bank

Your server signs with the key of the account you publish the game from: publishing makes that account the game's
developer. The casino lets only that key settle the game's developer bets and place the casino bets that back them.
The server therefore holds everything the account holds: its games, their commission and its bank. A developer who
wants the server to hold less publishes the game from an account of its own.

Your **bank** is a balance at the casino. The stakes of your developer bets go in as they are placed; your settlements
and your casino bets are paid from it, and an accepted casino bet's payout goes back in. Nothing in it is reserved.
Put money in and take it out on the wallet's **My games** page, from the account's own balance. A batch of settlements
the bank cannot pay in full is refused whole, with `bank-short`.

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
- Only a published game takes developer bets. A game opened by its URL alone is refused with `invalid-request`
  ([publishing](publishing.md#publish-it)).
- Once you settle a bet, the wallet checks your signed settlement and collects what it pays into the player's balance.
  While the game is open, it raises the game's allowance by that and pushes the receipt, `settled` with its `payout`, as
  a `game.receipt` event. The wallet looks every 4 seconds while its tab is visible; a page that hears from your server
  that a bet has settled calls `HookedIn.receipt(id)`, and the wallet looks at once. After a reload,
  `HookedIn.receipt(id)` finds the bet.
- Until the wallet collects it, what a bet is paid is the casino's promise, outside the principal the contract
  protects.

## Meta

`meta` is your game's own JSON object, saying what the bet is: a pick and its odds, a layout of chips, a cash-out made
while a round runs. The player signs it; the casino keeps it with the bet and never reads it; your server reads it and
settles the bet by it. It takes at most `bounds.meta` bytes as canonical JSON, 4,096, and its numbers are safe
integers: write odds as whole hundredths (`210`) or as a string (`'2.10'`).

Meta is what the player signed, not what you offered: check it against your offer before you pay it. For a page to
prove to your server that a bet is its own, it puts the hash of a secret it keeps in the meta.

## Your server

[`createDeveloper`](../sdk/developer.md#createdeveloper) from `@hookedin/play/sdk/developer` is the server's side. It
runs wherever `fetch` does: Node, or a Cloudflare Worker. It refuses a casino that speaks another revision of what
developers sign, with `protocol-mismatch`.

```ts
import { createDeveloper } from '@hookedin/play/sdk/developer';
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';

// Your key, and the name you publish the game under: with the key's address it makes the game's key.
const developer = await createDeveloper({
  casinoURL: 'https://casino.hookedin.com',
  key: process.env.DEVELOPER_KEY!,
  name: 'my-game',
});

/** Every open bet of the game, a page at a time: open ones are read from the start each time. */
async function openBets() {
  const bets: PublicDeveloperBet[] = [];
  for (let after = ''; ;) {
    const page = await developer.bets({ status: 'open', after });
    bets.push(...page.bets);
    if (!page.more) return bets;
    after = page.cursor;
  }
}
```

## Settling

```ts
/** The odds you offer, in hundredths of the stake. */
const OFFER: Record<string, number> = { home: 210, draw: 330, away: 380 };

/** The match ended: pay every bet on it. A bet on an offer you did not make gets its stake back. */
async function settleMatch(group: string, result: string) {
  const bets = (await openBets()).filter(bet => bet.group === group);
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

The casino's part of a developer bet is the `casino` amount your settlement gives it: its policy asks for about half of
what the bet is expected to earn you, and nothing enforces it ([pricing and commission](../reference/economics.md)). A
bet your own casino bets back has paid its share already, as their commission: settle it with `casino: 0n`.

## Provably fair: rounds and your casino bets

A game whose players share one outcome can make it checkable by anyone, with two things the casino gives you: rounds,
and your casino bets on them.

- [`developer.openRound()`](../sdk/developer.md#openround) asks the casino for a round, named by the hash of a secret
  the casino keeps. Every call names another round; keep track of yours.
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
wheel's 37 pockets, draws it as a walk down a fixed balanced binary tree over them, one level per round. Each level is
one casino bet of yours, from your bank, priced backward from what you owe on each outcome, so the bankroll backs the
whole draw. [Binary steps](../sdk/steps.md) prices the tree, gives each level's bet and walks it, and `stepOutcome`
checks a walk from what the casino publishes.

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
pocket pays. [`developer.virtualBankroll()`](../sdk/developer.md#virtualbankroll) is what the casino admits casino bets
against, half its bankroll, as it last reported it: pricing at it, as roulette does, leaves the other half for ordinary
movement. After a restart, finish the walk from what you saved: a level's
round, revealed already, is the step as it was placed. `ethers` comes with `@hookedin/play`; add it to your own
dependencies to import it.

[Roulette](https://github.com/hookedin/game-roulette) runs this scheme with one wheel for every player: its README
walks through a spin, and its page checks each one.

## The order of requests

One draw of a provably fair game, from the first request to the players' money, and who signs what:

1. **The server opens the draw.** `developer.openRound()` sends
   [`POST /api/rounds`](../casino-api/developers.md#post-apirounds) once per level, authorized by a `DeveloperAccess`
   token your key signs, and the server publishes the draw's ID.
2. **Players bet.** Each page calls [`game.developerBet`](../reference/bridge.md#gamedeveloperbet) with the draw's ID
   in its `group`. The player's wallet signs a debit with the account's key and sends it to
   [`POST /api/channels/:id/operations`](../casino-api/channels.md#post-apichannelsidoperations); the casino signs the
   channel's next state, records the bet with its meta, group and time, and puts the stake in your bank.
3. **The server closes betting.** It reads the open bets
   ([`GET /api/developer-bets`](../casino-api/public.md#get-apideveloper-bets)), saves which it covers and what it owes
   on each outcome, and prices the walk.
4. **The server walks, one of the draw's rounds per level.** `developer.casinoBet`, or `developer.reveal`, sends
   [`POST /api/rounds/:round/casino-bet`](../casino-api/developers.md#post-apiroundsroundcasino-bet) with the seed and a
   `BankCasinoBet` your key signs over the round, the game, the stake, the chance, the prize, the group, the seed hash
   and the meta's hash. The casino admits it before reading the secret, then reveals the round, which the kit checks
   ([`casinoBet`](../sdk/developer.md#casinobet)).
5. **The server settles.** For each bet a `Settlement` your key signs over the bet's hash, the player's amount and the
   casino's: `developer.settle` sends
   [`POST /api/developer-bets/settle`](../casino-api/developers.md#post-apideveloper-betssettle), paid from your bank.
6. **The wallet collects.** Each player's wallet reads the settled bet
   ([`GET /api/developer-bets/:bet`](../casino-api/public.md#get-apideveloper-betsbet)), checks your signature over it,
   signs a credit for exactly the player's amount with the account's key, and the casino signs the channel's next state.
   The wallet then pushes the settled receipt to the page ([events](../reference/bridge.md#events)).

Anyone can then check the draw: [`GET /api/rounds/:round`](../casino-api/public.md#get-apiroundsround) shows each
round's seed, its secret, the outcome and your casino bet with its group and meta, and
[`@hookedin/play/sdk/outcome`](../sdk/outcome.md#checking-a-round) recomputes them. A page talks to nobody but its own
origin: it reads a round through its player's wallet with [`HookedIn.round`](../sdk/hookedin.md#round).

## Crash games

A crash game whose players all set their cash-out before the draw fits the same walk: its equally likely outcomes are
crash points, and on each the server owes what the cash-outs it reaches pay. A cash-out made by hand while the curve
climbs cannot ride a round: to know when to crash, the server would have to reveal the draw at take-off, and a revealed
round is public, so every page would know the crash point. Such a game keeps its crash point to itself and settles
every bet on its word, as the house's [crash](https://github.com/hookedin/game-crash) does: a flight's ID is the hash of
a secret revealed after the crash, and each escape is paid from the developer's bank.

## One Cloudflare Worker

A game with a server ships page and server as one Cloudflare Worker: `dist/` as static assets, and a Worker answering
`/api/` with a Durable Object holding its state, on the page's own origin, so the build's `connect-src 'self'` holds.
[Roulette's repository](https://github.com/hookedin/game-roulette) is a GitHub template with all of this in place: its
`wrangler.jsonc` names the casino and the game, and its README sets `DEVELOPER_KEY`, the key of the account you publish
from, as a secret. Developer bets need the game published under that name from that account
([publishing](publishing.md#publish-it)).
