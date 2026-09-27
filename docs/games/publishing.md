---
title: Publishing
description: Build a game, host it anywhere, deploy it to Cloudflare and publish it under your name.
sidebar:
  order: 10
---

A game is plain static files, hosted wherever you like, and known by its URL. It becomes yours in public when you
publish it: its name in your profile at the casino, pointing at its URL. The name and your address make the game's key,
which stays the same wherever the files are served.

## Build

```sh
npm run build
```

This runs [`hookedin-game build`](../reference/cli.md#build): it bundles `src/game.ts` into `dist/game.js`, copies
every other file in `src/`, `icon.svg` among them, and adds the SDK's `shared.css`, the brand mark and a `_headers`
file. `dist/` is the whole game.

## Host it anywhere

Any static host serves `dist/` as it is, provided it sends the headers in `dist/_headers`
([the `_headers` file](../reference/cli.md#the-_headers-file)). Cloudflare applies that file by itself; on another host,
send the same headers yourself. Their Content-Security-Policy keeps the page to its own origin
([the sandbox](how-a-game-works.md#the-sandbox)). The game cannot be served from the wallet's origin: the wallet refuses
it.

The game's URL is the address of `dist/index.html`, such as `https://game.example.com/`
([game URL](../reference/game-url.md)). Once hosted, anyone can play it by that URL, with **Open a game by URL** in the
library or through `https://play.hookedin.com/games/custom?url=<encoded game URL>`.

## Deploy to Cloudflare

A repository made from the template deploys itself to Cloudflare, as a Worker that serves `dist/` as static assets:

1. In `wrangler.jsonc`, change `name`, and add `routes` for a domain on your Cloudflare account:
   `"routes": [{ "pattern": "game.example.com", "custom_domain": true }]`. Without `routes`, the game is served at
   `<name>.<your-subdomain>.workers.dev`.
2. In the repository's **Settings → Secrets and variables → Actions**, add the secret `CLOUDFLARE_API_TOKEN`, made in
   Cloudflare from the **Edit Cloudflare Workers** template, and the variable `CLOUDFLARE_ACCOUNT_ID`.
3. Push to `main`.

The **Deploy** workflow
([.github/workflows/deploy.yml](https://github.com/hookedin/game-template/blob/main/.github/workflows/deploy.yml)) runs
on every push: it checks the formatting, runs `npm test` and builds. On `main`, with the token set, it publishes
`dist/` with `wrangler deploy`. To publish by hand:

```sh
npm run build && npx wrangler deploy
```

A game with a server deploys the same way, as one Worker that also answers `/api/`; its key is a secret, set once
([one Cloudflare Worker](developer-bets.md#one-cloudflare-worker)).

## Keep the SDK current

The template installs `@hookedin/play` from its `main` branch, and `package-lock.json` records the exact commit, so an
install is reproducible. `npm update @hookedin/play` moves it to play's newest `main`; commit the lockfile, and the
push deploys it.

## Publish it in My games

Publish from the wallet of the account that is to be the game's developer, and a game with a server from the account
whose key the server holds. On **My account → My games**, under **Games you publish**, enter the game's name and its
URL, and choose **Publish**. The wallet fetches nothing first.

Publishing needs a funded ETH channel, and a profile holds 100 games; taking a game down with **Remove** needs neither.
The exact rules for names and URLs are in the [game URL reference](../reference/game-url.md#publishing).

The game is then at `https://play.hookedin.com/@<alias>/<name>`, or `/~<uname>/<name>` for an account with no alias,
for anyone with a wallet, and in your own library. Your profile page lists it
([names and publishing](../wallet/names-and-publishing.md)). A published game earns you
[commission](earnings.md), and only a published game takes [developer bets](developer-bets.md).

## Moving hosts

The URL is only where a game is served. To move a game, publish the same name with its URL on the other host. Its
key, `keccak256(abi.encode(developer, name))`, does not change, so the game keeps its bets, its players' receipts and
its public record.

A game nobody publishes still opens, from its URL. It has the key of the zero address and its URL, so it is a
different game from any you publish: it earns no one commission and takes no developer bets.

## The house library

The library a deployment ships with is what `@hookedin` publishes, listed in [catalog.json](../../catalog.json). To be
in it, open an issue or a pull request on [hookedin/play](https://github.com/hookedin/play).
