---
title: Manifest
description: Every manifest field, and the rules the wallet applies when it fetches, opens and publishes a game.
sidebar:
  order: 2
---

A game's manifest is the JSON file the wallet fetches to load it. The wallet checks it, in
[client/main.ts](../../client/main.ts); the casino never fetches it.

```json title="manifest.json"
{
  "name": "Coin flip",
  "description": "Heads doubles your stake.",
  "entry": "./index.html",
  "developer": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
}
```

## Fields

| Field         | Type   | Meaning                                                                                                                                                                                                                         |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string | Required. The game's title in the wallet: 1 to 80 characters (UTF-16 code units)                                                                                                                                                |
| `entry`       | string | Required. The page the wallet frames, as a URL resolved against the manifest's final URL, so `./index.html` is the page beside the manifest. `http:` or `https:`, with no user name or password, and not on the wallet's origin |
| `developer`   | string | Required. The address of the account that publishes the game: `0x` and 40 hex digits, all lower case, all upper case, or mixed case with a valid EIP-55 checksum. Not the zero address                                          |
| `description` | string | Optional. Shown on the game's card in the library and on profiles, up to its first 220 characters; a card without one says "Independent game"                                                                                   |

The wallet ignores every other field. `hookedin-game build` refuses a manifest whose `developer` is not `0x` and 40 hex
digits, or is the zero address ([build](cli.md#build)).

## Fetching

The wallet fetches the manifest when it opens a game and when it publishes one:

- The manifest URL is `http:` or `https:`, with no user name or password, and not on the wallet's origin.
- The request sends no credentials, bypasses the browser's cache, and gives up after 12 seconds.
- The response must pass CORS for the wallet's origin (`Access-Control-Allow-Origin: *`), have a 2xx status, be at most
  16,384 bytes, and decode as UTF-8 JSON. A `Content-Length` above 16,384 is refused before the body is read.
- The URL the response finally came from, after any redirect, is not on the wallet's origin either, and `entry`
  resolves against it.

Cards in the library and on profiles read the manifest with the same size limit and timeout; a game whose manifest
cannot be read has no card.

## Opening a game

- `/games/custom?manifest=<encoded manifest URL>` opens any manifest. The game's key is
  `keccak256(abi.encode(address developer, string manifestURL))`, with the manifest's `developer` and the URL as the
  wallet normalizes it. Such a game earns no developer commission and takes no developer bets.
- `/@<alias>/<name>` or `/~<uname>/<name>` opens a published game from the manifest URL its profile records. The wallet
  refuses it if the manifest names a different `developer` from the account that published it.

A link grants no spending authority; the player gives the game money in the wallet's own dialog.

## Publishing

Publishing records a name and a manifest URL in the publishing account's profile at the casino, from the wallet's
**My games** page ([`POST /api/channels/:id/games`](../casino-api/channels.md#post-apichannelsidgames)). The wallet
fetches and checks the manifest as above before it asks.

| Rule         | Value                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Name         | 1 to 32 lower-case letters, digits or hyphens, not starting with a hyphen: `^[a-z0-9][a-z0-9-]{0,31}$`                 |
| Manifest URL | At most 300 characters. `https:`, or `http:` only for `localhost`, `127.0.0.1` or `[::1]`. No credentials, no fragment |
| Manifest     | Its `developer` is the publishing account's address                                                                    |
| Account      | Has a funded channel that is not closing                                                                               |
| Profile      | Holds at most 100 games. Publishing a name again points it at another URL                                              |
| Removing     | Needs no funded channel and no manifest                                                                                |

A published game's key is `keccak256(abi.encode(address developer, string name))`, with the publishing account's
address and the name: it stays the same wherever the manifest is served. See [publishing](../games/publishing.md).
