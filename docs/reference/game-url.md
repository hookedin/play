---
title: Game URL
description: A game is the URL of its page. The rules for that URL, the icon beside it, how the wallet opens and names a game, and the rules for publishing one.
sidebar:
  order: 2
---

A game is its URL: the page the wallet frames, such as `https://dice-game.hookedin.com/`. From the game's host the
wallet takes that page, in a frame, and `icon.svg` beside it, as an image; the casino fetches neither. The wallet's
side is [client/main.ts](../../client/main.ts).

## The URL

The wallet frames a game only at a URL that:

- is `http:` or `https:`;
- has no user name or password;
- is not on the wallet's own origin, where a frame could lift its own sandbox and read the wallet's storage.

The page's origin is the game's: the wallet answers that origin alone on the [bridge](bridge.md#origins), and the game
keeps its state there.

## The icon

A game may serve `icon.svg` beside its page, at `new URL('icon.svg', gameURL)`: for the game above,
`https://dice-game.hookedin.com/icon.svg`. It is a square SVG that fills the whole square, one symbol that stands for
the game, like the tiles of a casino lobby; a 512 × 512 `viewBox` is a good default. The wallet rounds its corners, so
draw no rounded background of your own. It shows the icon as a square tile, above the game's name, in the library and on
profiles, and while the game loads. A game without one gets a tile with the first letter of its name. The home page of
[hookedin.com](https://hookedin.com) shows the house's games by their icons. [`hookedin-game build`](cli.md#build)
copies `src/icon.svg` into `dist/` beside the page, like any other file.

## Opening a game

| Route                                  | Opens                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/@<alias>/<name>`, `/~<uname>/<name>` | A published game, at the URL its profile records ([`GET /api/players/:name/:game`](../casino-api/public.md#get-apiplayersnamegame)) |
| `/games/custom?url=<encoded game URL>` | Any game, by its URL alone, as **Open a game by its URL** in the library does                                                       |

A published game's developer is the account that published it, and its [key](signed-messages.md#game-keys) is
`keccak256(abi.encode(address developer, string name))` with that account's address and the name it is published
under. The wallet calls it by that name in words, its first letter capitalised and hyphens as spaces: `dice` is "Dice".

A game opened by its URL alone is published by nobody. Its developer is the zero address, and its key is made from the
zero address and, as `name`, the URL as the URL parser normalises it, so no published game shares it. Nobody earns its
commission, so the house keeps all of it, and it takes no developer bets. The wallet calls it by its host.

A link grants no spending authority: the player gives a game money in the wallet's own dialog
([games and limits](../wallet/games-and-limits.md#giving-a-game-money)).

## Publishing

Publishing records a name and a game URL in the publishing account's profile at the casino, from the wallet's
**My games** page ([`POST /api/channels/:id/games`](../casino-api/channels.md#post-apichannelsidgames)). The wallet
fetches nothing first: the account that publishes a game is its developer. It earns the game's commission, half of each
casino bet's, its bank takes the game's developer bets, and its key settles them.

| Rule     | Value                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name     | 1 to 32 lower-case letters, digits or hyphens, not starting with a hyphen: `^[a-z0-9][a-z0-9-]{0,31}$`                                                                 |
| URL      | At most 300 characters. `https:`, or `http:` only for `localhost`, `127.0.0.1` or `[::1]`. No user name or password, no fragment. Kept as the URL parser normalises it |
| Account  | Has an open channel that is not closing                                                                                                                                |
| Profile  | Holds at most 100 games. Publishing a name again points it at another URL                                                                                              |
| Removing | Needs no open channel                                                                                                                                                  |

The casino refuses a URL the parser cannot read with "A game is the URL of its page". A published game's key stays the
same wherever the game is served. See [publishing](../games/publishing.md).
