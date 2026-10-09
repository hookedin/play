---
title: Introduction
description: What HookedIn is, the parts it is made of, and where to start.
---

HookedIn is a casino on Ethereum that your own wallet checks. You deposit ETH into a contract, then play with signed
messages instead of transactions: the wallet signs each bet, the casino signs the result, and the wallet verifies that
result and saves the evidence before it shows you anything. The contract pays out what you withdraw, from your deposits
first and the casino's bankroll for the rest, and settles your channel without the casino if you close it alone.
HookedIn runs on Sepolia (chain 11155111).

## Open beta

HookedIn is in open beta: anyone can play, deposit, withdraw and publish a game, with Sepolia's test ETH, which is free
and worth nothing. While it lasts, a reset can start balances, history and names over ([changing the
contract](reference/deployment.md#changing-the-contract)), and the SDK, the game bridge and the casino API change
without notice: a game that installs `@hookedin/play` from `main` takes each change when it next installs. Tell us what
breaks in the [HookedIn Discord](https://discord.gg/C38EkHr7sG) or a [GitHub
issue](https://github.com/hookedin/play/issues), and report a vulnerability privately, as [SECURITY.md](../SECURITY.md)
says.

## The parts

| Part       | What it does                                                                                                                                                         | Where it lives                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Contract   | Holds deposits, pays withdrawals, settles closed channels and pays claims. It knows nothing of games                                                                 | [contracts/HookedInCasino.sol](../contracts/HookedInCasino.sol) |
| Wallet     | Holds your keys, signs exact bets, verifies every result, keeps the evidence and sends your on-chain transactions                                                    | [client/](../client/), served at https://play.hookedin.com      |
| Protocol   | The signed structures, hashes, state derivation and admission rule the wallet and the casino share                                                                   | [protocol/](../protocol/)                                       |
| Casino     | Quotes rounds, admits bets against half its bankroll, signs results, has the contract pay withdrawals and keeps the books. The service is private; its API is public | [Casino API](casino-api/index.md)                               |
| Games      | Sites of their own, each known by its URL and run in a sandboxed frame inside the wallet. Four of the house's games are in this repository                           | [games/](../games/)                                             |
| SDK        | The wallet bridge, a round helper, exact step pricing, a developer kit and the build tool                                                                            | [Packages and imports](sdk/index.md)                            |
| Watchtower | Challenges a stale close of your channel, or disputes a casino bet the casino left unsettled, from its exported evidence, on a machine you run                       | [The watchtower](wallet/keys-and-recovery.md#the-watchtower)    |

Everything a player has to trust is in this repository. The casino service is private, and a player does not have to
trust its code: the wallet checks every signature, revealed secret and balance change against the public protocol, and
with its saved evidence a player can close a channel and collect what it is owed without the casino.

## Where to start

- **To play**, open the wallet: [Getting started](wallet/getting-started.md).
- **To play with zero trust**, run your own wallet and games: [Play with zero trust](overview/zero-trust.md).
- **To build a game**, start from the template: [Quick start](games/quick-start.md).
- **To integrate with the casino**, read the [Casino API](casino-api/index.md).
- **To check the protocol**, read [how it works](overview/how-it-works.md), the [trust model](overview/trust-model.md),
  the [signed messages](reference/signed-messages.md) and [the contract](reference/contract.md).
