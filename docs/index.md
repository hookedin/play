---
title: Introduction
description: What HookedIn is, the parts it is made of, and where to start.
---

HookedIn is a casino on Ethereum that your own wallet checks. You deposit ETH into a contract once, then play with
signed messages instead of transactions: the wallet signs each bet, the casino signs the result, and the wallet verifies
that result and saves the evidence before it shows you anything. The contract settles your channel when it closes, with
the casino's cooperation or without it. Every wallet can also practice at once with test coins it keeps itself, which
never reach the casino. HookedIn runs on Sepolia (chain 11155111).

## The parts

| Part           | What it does                                                                                                                 | Where it lives                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Contract       | Holds deposits, settles closed channels and pays claims. It knows nothing of games                                           | [contracts/HookedInCasino.sol](../contracts/HookedInCasino.sol) |
| Wallet         | Holds your keys, signs exact bets, verifies every result, keeps the evidence and sends every on-chain transaction            | [client/](../client/), served at https://play.hookedin.com      |
| Protocol       | The signed structures, hashes, state derivation, admission rule and recovery code the wallet and the casino share            | [protocol/](../protocol/)                                       |
| Casino         | Names rounds, admits bets against its bankroll, signs results and keeps the books. The service is private; its API is public | [Casino API](casino-api/index.md)                               |
| Games          | Sites of their own, run in a sandboxed frame inside the wallet. The house's static games are in this repository              | [games/](../games/)                                             |
| SDK            | `@hookedin/play/sdk`: the wallet bridge, a round helper, exact step pricing, a developer kit and the build tool              | [Packages and imports](sdk/index.md)                            |
| Recovery tools | A recovery CLI and a watchtower that settle and defend a channel from its exported evidence                                  | [scripts/](../scripts/)                                         |

Everything a player has to trust is in this repository. The casino service is private, and a player does not have to
trust its code: the wallet checks every signature, revealed secret and balance change against the public protocol, and
with its saved evidence a player can close a channel and collect what it is owed without the casino.

## Where to start

- **To play**, open the wallet: [Getting started](wallet/getting-started.md).
- **To build a game**, start from the template: [Quick start](games/quick-start.md).
- **To integrate with the casino**, read the [Casino API](casino-api/index.md).
- **To check the protocol**, read [how it works](overview/how-it-works.md), the [trust model](overview/trust-model.md),
  the [signed messages](reference/signed-messages.md) and [the contract](reference/contract.md).
