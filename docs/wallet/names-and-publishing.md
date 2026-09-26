---
title: Names and publishing
description: Unames and aliases, public player pages, and publishing a game under your name.
sidebar:
  order: 4
---

Players are known by names, never by addresses. Every account has a uname, may take an alias, has a public page, and
can publish games that anyone plays at its name.

## Your uname

Every account has a **uname**: 24 characters of `23456789abcdefghijkmnopqrstvwxyz`, written with a tilde, such as
`~3byt9ocwnnzaxanmiz3stocj`. The casino derives it from your address with a keyed hash whose key it keeps secret, so
the uname does not reveal the address. It is the same for every channel your address opens, ETH or test, and it does
not change. The casino first knows it when your wallet opens its test channel.

A uname is what games, developers and other players learn about you: a game gets it from
[`wallet.info`](../reference/bridge.md#walletinfo), and the casino's public records name players by it.

## An alias

An **alias** is a shorter name you are shown by instead, written with an at sign, such as `@Bob`. Take one on
**My account**, under **Take an alias**, with **Save alias**; **Give up my alias** returns you to your uname. Your uname
stays yours either way, and both names always find you.

| Rule     | Requirement                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Form     | 3 to 20 ASCII letters, digits and underscores, starting with a letter                                                                           |
| Unique   | Case does not count, nor `l`, `1` and `i`, nor `0` and `o`: `@Bob` and `@B0b` are the same alias                                                |
| Reserved | `hookedin`, `casino`, `house`, `bankroll`, `operator`, `admin`, `support`, `system`, `faucet` and `custom`, and every alias that reads the same |
| Needs    | An open ETH channel, both to take an alias and to give it up                                                                                    |

Taking another alias replaces the one you had. The casino's refusals are listed under
[`POST /api/channels/:id/alias`](../casino-api/channels.md#post-apichannelsidalias).

## Your public page

`/@alias` or `/~uname` is a player's public page: their name, their uname under an alias, when the casino first knew
them, how many bets they have played in each asset with what they staked and won, and the games they publish. It is
read from [`GET /api/players/:name`](../casino-api/public.md#get-apiplayersname), which anyone can call. **See your
public profile** on My account opens yours. The casino's list of players is at https://hookedin.com/players/.

## Publishing a game

A game you publish is reachable at your name, and anyone can play it with their own wallet.

1. Host the game and its manifest, with the manifest's `developer` set to this account's address
   ([publishing](../games/publishing.md)).
2. On **My games**, under **Games you publish**, enter a name and the manifest's URL, and press **Publish**.

The wallet first loads the manifest exactly as it would to play the game, and refuses one whose `developer` is another
address: publish it from that account instead.

The name, the URL and the account must meet [the publishing rules](../reference/manifest.md#publishing).

The game is then at `/@alias/name`, or `/~uname/name` without an alias, and it appears in your own library. Its
[key](../reference/signed-messages.md#game-keys) is made from who publishes the game and the name, never from where the
game is served. Publishing the same name at
another URL moves the game to that host and keeps its key, its bet history and its players' receipts. **Remove** takes
a game down, which needs no funded channel.

Publishing makes this account the game's developer. It earns half of each casino bet's commission in the game, its bank
takes the stakes of the game's developer bets, and its key settles them ([earnings](../games/earnings.md),
[developer bets](../games/developer-bets.md)). **Your bank**, on My games, is that bank, in the asset the tab plays
with: **Deposit** moves money into it from your channel, and **Withdraw** takes it back, collected into your channel.
Your address is public once you publish: the manifest names it, and so does your profile at the casino.

The library every wallet shows is what `@hookedin` publishes; [publishing](../games/publishing.md) explains how a game
joins it.
