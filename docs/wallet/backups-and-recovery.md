---
title: Backups and recovery
description: Encrypted backups, recovery bundles, lost replies, recovery mode, the recovery CLI and the watchtower.
sidebar:
  order: 6
---

Your signed evidence is what lets you settle without the casino. Keep two things: an encrypted backup of every account
you fund, and a current recovery bundle of each channel.

## What to keep

|              | Encrypted backup                                                       | Recovery bundle                                          |
| ------------ | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| Holds        | An account's keys, channels, evidence, pending operations and receipts | One channel's opening and its latest signed evidence     |
| Keys         | The funding key, if the wallet holds it, and every channel key         | None                                                     |
| Protected by | Your passphrase                                                        | Nothing: it holds no key                                 |
| Restores     | The whole account, in a wallet                                         | Settlement: closing, challenging, finalizing, collecting |
| Made with    | **Back up selected account** on Settings                               | **Export recovery bundle** on My wallet                  |

## Encrypted backups

On **Settings**, enter a passphrase of 12 to 1,024 characters under **Encrypted wallet backup passphrase** and press
**Back up selected account**. The wallet downloads `hookedin-encrypted-wallet.json`. A backup holds only the selected
account:

- its funding key, if the wallet holds it (a connected browser wallet keeps its own);
- every channel's key, opening, latest evidence, close authorization and pending operation, test channel included;
- its bankroll fund statements, developer bets and bank statements;
- its latest 100 receipts, and the receipt of every developer bet still open.

It holds no game state. Back up every account you fund, each on its own: a key alone cannot rebuild a signed balance.

| Property       | Value                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| Format         | A `HOOKEDIN/WALLET-BACKUP/1` envelope around a `HOOKEDIN/WALLET/1` record       |
| Key derivation | PBKDF2-SHA256, 600,000 iterations, a random 16-byte salt                        |
| Cipher         | AES-256-GCM, a random 12-byte IV, `HOOKEDIN/WALLET-BACKUP/1` as additional data |
| Size           | At most 16 MiB before encryption                                                |

To restore, enter the passphrase and choose the file under **Restore encrypted backup**, with no operation or
transaction pending. Before it writes anything, the wallet checks that:

- the backup is for this chain and this contract;
- every channel belongs to the backup's address, every key matches its channel, and all the evidence verifies;
- it replaces no saved evidence with an older or conflicting checkpoint, and changes no pending operation.

A backup of another account makes that account the funding account; a backup made with a connected browser wallet asks
you to connect that wallet first. The backup's test channel takes the place of the one in the wallet.

## Recovery bundles

**Export recovery bundle** on My wallet saves `hookedin-channel-<channelId>.json` for the open channel. **Export claim
evidence** does the same for a closed channel, and the banner of a pending operation offers **Export channel evidence**.
A bundle names the deployment (`chainId`, `casino`, `operator`), the channel's `opening` as the contract registered it,
its latest `evidence`, and its `claim` once it is finalized
([the bundle's fields](../reference/signed-messages.md#evidence)). It holds no keys, no game data and no pricing. It
changes with every operation, so export it again after you play.

**Import recovery bundle** on My wallet reads one back. The wallet refuses a bundle while an operation or a transaction
is pending, when it belongs to another chain, contract, owner or player, when it is older than the saved checkpoint or
differs from it at the same sequence, and when its opening is not registered on the contract. Without the channel key,
imported evidence still lets the wallet close, challenge, finalize and collect.

## When a reply is lost

The wallet saves every signed request before it sends it. When the casino's answer does not arrive, the operation stays
pending, play on that channel waits, and a banner offers:

- **Retry same request**, which sends the exact saved request again. The casino answers a retry with the result it
  recorded, accepted or rejected, so an operation is never carried out twice.
- **Export channel evidence** and **Start unilateral close**, for a casino that does not answer. A close settles at the
  latest completed state, and an operation the casino never completed costs nothing.

The wallet keeps a signed operation until it has a verified answer: a timeout is not a rejection.

The same banner covers an on-chain transaction that has not confirmed. **Retry same request** looks for its outcome,
including a replacement your funding wallet sent at the same nonce, and sends the exact saved transaction again when the
network has none; a connected browser wallet asks you to approve that. **Speed up transaction** sends it again with a
higher fee, at most 200 gwei per gas. A deposit whose channel was not registered is recovered the same way.

## Recovery mode

When the casino does not answer, answers with errors, or reports another chain, contract, owner or protocol revision
than the wallet's pinned deployment, the wallet starts in **recovery mode**. Evidence export and import, unilateral
close, challenges, finalizing and claims work; play and cooperative close do not. Reload once the casino is back.

The pinned deployment is the one the wallet is built with ([deployment](../reference/deployment.md)), or the one it
verified the last time it started in this browser. A wallet with neither cannot start without the casino.

## The recovery CLI

The recovery CLI settles a channel from its recovery bundle with no casino API and no channel key, through an RPC you
choose. It runs from a checkout of this repository, with Node 24.4 or later:

```sh
git clone https://github.com/hookedin/play
cd play
npm ci
```

1. Inspect the channel. With no `--rpc`, the CLI only checks the bundle's signatures.

   ```sh
   npm run recover -- channel.json --rpc https://ethereum-sepolia-rpc.publicnode.com --action inspect
   ```

2. Start a close, with the funding account's key:

   ```sh
   HOOKEDIN_RECOVERY_KEY=0x... npm run recover -- channel.json --rpc URL --action start
   ```

3. If the close proposes an older state than yours, challenge it before the deadline: `--action challenge`.
4. After the deadline, finalize: `--action finalize`.
5. Collect: `--action claim`, or `--action claim --to ADDRESS` to be paid elsewhere.

Each action inspects first and sends nothing when its end is already reached, and every transaction is saved in a
journal before it is sent, so running the command again resumes it rather than sending another. The CLI checks the
contract's owner and the registered channel, not the contract's code: run it against the contract address you trust.
[The CLI reference](../reference/cli.md#npm-run-recover) has every flag, who may send each action and what an
inspection reports.

## The watchtower

The watchtower watches one channel from its recovery bundle and challenges a stale close for you, from a machine you
run. It needs:

- a deployment manifest you trust: `chainId`, `contractAddress`, `operator`, `rpcUrl` and, on Sepolia, a
  `witnessRpcUrl` on another host. The `deployment` object of [config/production.json](../../config/production.json)
  is one;
- the channel's recovery bundle, which you replace with a fresh export after you play;
- a relayer key with ETH for gas, apart from your funding account, in `HOOKEDIN_RELAYER_KEY`.

```sh
HOOKEDIN_RELAYER_KEY=0x... npm run watchtower -- --deployment trusted.json --evidence channel.json --journal .private/watchtower.json
```

On start it checks the deployed code and owner against the pinned artifact and the manifest. Then, every 4 seconds, it
reads the bundle again, observes the chain through both RPCs, and sends `challengeClose` when the contract holds a close
older than the bundle's evidence and the deadline has not passed. It prints one JSON line per check, with its alerts and
the relayer's balance; `--once` runs a single check and exits. Transactions are saved in the journal before they are
sent, and a lock beside the journal keeps a second watchtower out. It cannot start a close, needs neither the channel key
nor the funding key, and knows only what the bundle holds.

Its alerts, and what each means, are in [the CLI reference](../reference/cli.md#alerts).
