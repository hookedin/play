---
title: Publishing
description: Build a game, deploy it anywhere, publish it under your name, bring it players, and collect the commission it earns.
sidebar:
  order: 5
---

A game is plain static files, deployed wherever you like, and known by its URL. Publishing it, on the wallet's
**Developer** page, makes it yours in public: a name in your profile at the casino, such as `Super Dice`, pointing at
its URL, and an ID that stays the game's under any name and wherever its files are served.

## Build

```sh
npm run build
```

This runs `hookedin-game build [dir ...]`, the command `@hookedin/play` installs
([sdk/bin/hookedin-game.js](../../sdk/bin/hookedin-game.js)); in play, run it as `node sdk/bin/hookedin-game.js`. For
each game folder, the current one by default, it deletes `dist/`, bundles `src/game.ts` with esbuild into
`dist/game.js`, a minified ES2022 module with a source map, copies every other file in `src/`, folders included, adds
the SDK's `shared.css` and `brand/hookedin-mark.svg`, and writes `_headers`. `dist/` is the whole game. A failure prints
its message and exits with status 1.

`hookedin-game serve [dir]`, the template's `npm run dev`, builds the game and serves it with its `_headers` at
`http://127.0.0.1:4185/` (`PORT` moves it). It builds again on every page load, and a change in `src/` reloads every
page open from it, keeping its allowance in the wallet, through a script it adds to the page it serves and never to
`dist/`. Beside it, at `http://localhost:4185/`, it serves a local wallet that plays the game with [pretend
money](quick-start.md#try-it-with-pretend-money). `hookedin-game serve <url>` serves the local wallet alone, framing a
game served elsewhere, such as a Worker under `wrangler dev` ([trying it](developer-bets.md#trying-it)).

### The `_headers` file

```text
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

The policy lets the page load from and talk to its own origin only, with images also as `data:` URLs ([the
sandbox](how-a-game-works.md#the-sandbox)). Cloudflare and Netlify apply the file by themselves; any other host must
send the same headers, which a host without custom headers, such as GitHub Pages, cannot. The wallet needs no header of
its own: it only frames the page and shows `icon.svg` as an image.

## The game's URL

The game's URL is the address of `dist/index.html`, such as `https://dice-game.hookedin.com/`, and the page's origin is
the game's ([origins](../reference/bridge.md#origins)). The wallet frames a game only at an `http:` or `https:` URL with
no user name or password, and never on its own origin; a published game's URL is `https:`, or `http:` on `localhost`,
`127.0.0.1` or `[::1]` while you work. Anyone can play it by that URL, with **Open a game by its URL** or at
`https://play.hookedin.com/games/custom?url=<encoded game URL>`; a link grants no spending authority. A game opened by
its URL alone is published by nobody: its ID is made from its URL ([game
IDs](../reference/signed-messages.md#game-ids)), so it is another game than any you publish, nobody earns its
commission, and it takes no developer bets.

### The icon

A game may serve `icon.svg` beside its page, at `new URL('icon.svg', gameURL)`: a square SVG that fills the whole square
with one symbol that stands for the game, like the tiles of a casino lobby; a 512 × 512 `viewBox` is a good default. The
wallet rounds its corners, so draw no rounded background of your own, and shows it as the game's tile, in the library,
on profiles and while the game loads; a game without one gets a tile with the first letter of its name.

## Deploy to Cloudflare

A repository made from the template deploys itself to Cloudflare, as a Worker that serves `dist/` as static assets:

1. In `wrangler.jsonc`, change `name`, and add `routes` for a domain on your Cloudflare account:
   `"routes": [{ "pattern": "game.example.com", "custom_domain": true }]`. Without `routes`, the game is served at
   `<name>.<your-subdomain>.workers.dev`.
2. In the repository's **Settings → Secrets and variables → Actions**, add the secret `CLOUDFLARE_API_TOKEN`, made in
   Cloudflare from the **Edit Cloudflare Workers** template, and the variable `CLOUDFLARE_ACCOUNT_ID`.
3. Push to `main`.

The **Deploy** workflow runs on every push: it checks the formatting, runs `npm test` and builds, and on `main`, with
the token set, deploys with `wrangler deploy`. To deploy by hand, `npx wrangler deploy`. Deploying puts the files
online; publishing, below, is what makes the game yours. A game with a server deploys the same way, as one Worker that
also answers `/api/` ([one Cloudflare Worker](developer-bets.md#one-cloudflare-worker)).

## Publish it

Publish from the wallet of the account that is to be the game's developer: on **Developer**, `/developer`, give the
game's name and its URL. A name is 1 to 32 characters, at least one of them a letter from A to Z or a digit; publishing
needs an open balance, so deposit first, a profile holds 100 games, and the name and URL follow the rules of
[`POST /api/account/games`](../casino-api/channels.md#post-apiaccountgames). A game with a server gets a [server
key](developer-bets.md#your-games-server-key-and-bank) of its own, named beside it. Publishing names your account's
address, in public, as the game's developer.

The game is then at `https://play.hookedin.com/@<username>/<slug>`, by your Discord username, or `/~<uname>/<slug>`
until you verify one ([your name](../wallet/getting-started.md#your-name)), and on your profile. The slug is the name in
lowercase, accents dropped, each run of anything but a letter or a digit one hyphen: `Super Dice` is at
`@<username>/super-dice`. Two of your games never share a slug.

A game's ID does not change with its name or its URL: to move a game, publish the same name with the new URL, and to
rename it, use **Rename** beside it on **Developer**, after which its address follows the new name and the old one stops
working. Either way it keeps its bets, its players' receipts, its bank and its public record. A name with another slug
is another game, with an ID of its own. Taking a game down takes it out of your profile and keeps the rest, and
publishing it again brings it back.

HookedIn takes down a published game that misleads its players, such as one that asks for their keys, as if you had: it
keeps its bank, which stays yours to take out, its server still settles the developer bets placed on it, and its record
stays. You cannot publish it again until HookedIn lets it go; write to support@hookedin.com.

## Getting players

Players find your game by its link, which **Copy link** beside it on **Developer** copies, and on your profile: their
library lists only their own games and those `@hookedin` publishes, in [catalog.json](../../catalog.json). Share that
link, never the game's URL: a game opened by its URL alone is nobody's, and earns you nothing. To be in the library,
open an issue or a pull request on [hookedin/play](https://github.com/hookedin/play).

## Earnings

Every game you publish has a **bank** at the casino, and half the commission on every settled casino bet in the game
goes into it, won or lost, the game's own casino bets on its rounds included, while the game is published. Commission is
the edge the bankroll does not need, never an extra debit to the player: a [settled
trade-off](../overview/architecture.md#settled-trade-offs), whose arithmetic is in [pricing and
commission](../reference/economics.md). A bet with no more edge than the bankroll needs earns nothing, nor does a
rejected bet, a reveal, or a game nobody publishes or one taken down. A developer bet earns no commission, since the
bankroll does not back it ([the casino's share](developer-bets.md#the-casinos-share)); its stake goes into the same
bank. For bets small next to the bankroll, commission is nearly the whole edge, so a game with a 1% edge earns about
0.5% of what its players stake.

The wallet's **Developer** page shows each game's bank, and beside it the game's bets, what its players staked and came
out with, its house edge and the commission it took, from its [public record](../casino-api/public.md#get-apigamesid).
**Put in** and **Take out** move money between a game's bank and your balance, **Max** filling in all the bank holds,
and [Withdraw](../wallet/getting-started.md#withdraw) sends your balance on to any address. Taking out, your wallet
signs a `BankWithdraw`, the casino owes you the amount at once, and the wallet collects it with a credit naming the game
([`POST /api/account/games/withdraw`](../casino-api/channels.md#post-apiaccountgameswithdraw)): nobody approves or sends
anything, nothing moves on-chain, and the bankroll does not change. Only you take money out of your games' banks, also
after taking a game down; a server key spends a bank on its game's bets and settlements alone.

A bank is the casino's word until you take it out, like a fund share: casino bets are private to their channels, so
nobody can check that it counted every one. Take out what the game does not need. Each game's bank and commission are
public in its record, and each player's receipts show the commission of their own bets.
