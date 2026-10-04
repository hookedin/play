---
title: Publishing
description: Build a game, host it anywhere, publish it under your name, and collect the commission it earns.
sidebar:
  order: 8
---

A game is plain static files, hosted wherever you like, and known by its URL. It becomes yours in public when you
publish it: its name in your profile at the casino, pointing at its URL. The name and your address make the game's key,
which stays the same wherever the files are served.

## Build

```sh
npm run build
```

This runs `hookedin-game build [dir ...]`, the command `@hookedin/play` installs
([sdk/bin/hookedin-game.js](../../sdk/bin/hookedin-game.js)); in play, run it as `node sdk/bin/hookedin-game.js`. For
each game folder, the current one by default, it:

1. deletes `dist/`;
2. bundles `src/game.ts` with esbuild into `dist/game.js`, a minified ES2022 module with a source map;
3. copies every other file in `src/`, folders included: the page, its styles, `icon.svg` and other images;
4. adds the SDK's `shared.css` and `brand/hookedin-mark.svg`, and writes `_headers`.

`dist/` is the whole game. `hookedin-game serve [dir]`, which the template's `npm run dev` runs, builds it and serves it
at `http://127.0.0.1:4185/` (`PORT` moves it) with its `_headers`, building again on every page load, so a change shows
on reload. A failure prints its message and exits with status 1.

### The `_headers` file

```text
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

The policy lets the page load from and talk to its own origin only, with images also as `data:` URLs
([the sandbox](how-a-game-works.md#the-sandbox)). Cloudflare applies the file by itself; any other host sends the same
headers. The wallet needs no header of its own: it only frames the page and shows `icon.svg` as an image.

## The game's URL

The game's URL is the address of `dist/index.html`, such as `https://dice-game.hookedin.com/`, and the page's origin is
the game's ([origins](../reference/bridge.md#origins)). The wallet frames a game only at an `http:` or `https:` URL with
no user name or password, and never on its own origin. Anyone can play it by that URL, with **Open a game by its URL**
in the library or at `https://play.hookedin.com/games/custom?url=<encoded game URL>`; a link grants no spending
authority.

A game opened by its URL alone is published by nobody: its key is made from the zero address and its URL
([game keys](../reference/signed-messages.md#game-keys)), so it is a different game from any you publish, nobody earns
its commission, and it takes no developer bets.

### The icon

A game may serve `icon.svg` beside its page, at `new URL('icon.svg', gameURL)`. It is a square SVG that fills the whole
square, one symbol that stands for the game, like the tiles of a casino lobby; a 512 × 512 `viewBox` is a good default.
The wallet rounds its corners, so draw no rounded background of your own. It shows the icon as the game's tile, in the
library, on profiles and while the game loads; a game without one gets a tile with the first letter of its name. The
build copies `src/icon.svg` like any other file.

## Deploy to Cloudflare

A repository made from the template deploys itself to Cloudflare, as a Worker that serves `dist/` as static assets:

1. In `wrangler.jsonc`, change `name`, and add `routes` for a domain on your Cloudflare account:
   `"routes": [{ "pattern": "game.example.com", "custom_domain": true }]`. Without `routes`, the game is served at
   `<name>.<your-subdomain>.workers.dev`.
2. In the repository's **Settings → Secrets and variables → Actions**, add the secret `CLOUDFLARE_API_TOKEN`, made in
   Cloudflare from the **Edit Cloudflare Workers** template, and the variable `CLOUDFLARE_ACCOUNT_ID`.
3. Push to `main`.

The **Deploy** workflow runs on every push: it checks the formatting, runs `npm test` and builds, and on `main`, with
the token set, publishes `dist/` with `wrangler deploy`. To publish by hand, `npm run build && npx wrangler deploy`. A
game with a server deploys the same way, as one Worker that also answers `/api/`
([one Cloudflare Worker](developer-bets.md#one-cloudflare-worker)).

## Publish it

Publish from the wallet of the account that is to be the game's developer, and a game with a server from the account
whose key the server holds. On **My games**, give the game's name and its URL; the wallet fetches nothing first.
Publishing needs an open balance, a profile holds 100 games, and the name and URL follow the rules of
[`POST /api/channels/:id/games`](../casino-api/channels.md#post-apichannelsidgames).

The game is then at `https://play.hookedin.com/@<username>/<name>`, by your Discord username, or
`/~<uname>/<name>` for an account that verified no Discord account ([your name](../wallet/getting-started.md#your-name)), for anyone with a wallet, and on your profile. Its key,
`keccak256(abi.encode(developer, name))`, does not change with its URL: to move a game, publish the same name with the
new URL, and it keeps its bets, its players' receipts and its public record.

The library a deployment ships with is what `@hookedin` publishes, listed in [catalog.json](../../catalog.json). To be
in it, open an issue or a pull request on [hookedin/play](https://github.com/hookedin/play).

## Earnings

You earn half the commission on every casino bet placed in a game you publish. Commission is the edge the bankroll does
not need, set when the bet is admitted, rounded down to an even amount and split in half between the game's developer
and the casino: a [settled trade-off](../overview/architecture.md#settled-trade-offs), whose arithmetic is in
[pricing and commission](../reference/economics.md).

- It depends on the bet's edge and on the casino's bankroll. A bet with no more edge than the bankroll needs earns
  nothing, and a bet with no edge is declined.
- It is never an extra debit to the player: the stake, chance and prize are exactly what the player signed.
- No fee protects a player from a game. A game can spend its whole allowance on bets that pay back little, and the
  wallet records each bet's [measured return](casino-bets.md#measured-return) without refusing it: the allowance the
  player sets is their protection.
- Every settled casino bet earns it, won or lost, your own casino bets on your rounds included, for whoever publishes
  the game when the bet settles. A rejected bet earns nothing, nor does a reveal, and a game nobody publishes earns its
  developer nothing. A developer bet earns no commission, since the bankroll does not back it
  ([the casino's share](developer-bets.md#the-casinos-share)).

The casino keeps the tally for the publishing account's address, and a HookedIn wallet opened with that account's key
([open the wallet](../wallet/getting-started.md#open-the-wallet)) collects it by itself, with a balance open, as a
credit that account signs into its balance. Nobody at the casino approves or sends anything, nothing moves on-chain,
and the bankroll does not change: money the casino owed you becomes your signed balance, which settles like any other
([closing and claims](../wallet/closing-and-claims.md)). The wallet shows, under your balance, what your games have earned and how much
of it is collected.

Every developer's totals are public: [`GET /api/status`](../casino-api/public.md#get-apistatus) lists them under
`developers`, with `earned`, `collected` and `outstanding`, and [hookedin.com/bankroll](https://hookedin.com/bankroll/)
shows them. The tally is the casino's word: casino bets are private to their channels, so nobody can check that it
counted every one. Each player's receipts show the commission of their own bets.
