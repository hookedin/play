---
title: Backups and recovery
description: Encrypted backups, recovery bundles, lost replies, recovery mode and the watchtower.
sidebar:
  order: 4
---

Your signed evidence is what lets you settle without the casino. Keep two things: an encrypted backup of every account
you fund, and a current recovery bundle of each channel.

## What to keep

|              | Encrypted backup                                                      | Recovery bundle                                                                                         |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Holds        | An account's key, channels, evidence, pending operations and receipts | One channel's opening and its latest evidence                                                           |
| Keys         | The account's key                                                     | None                                                                                                    |
| Protected by | Your passphrase                                                       | Nothing: it holds no key                                                                                |
| Restores     | The whole account, in a wallet                                        | Settlement: closing, challenging, finalizing, collecting; play, when it holds the casino's latest state |
| Made with    | **Download encrypted backup** on Settings                             | **Export recovery bundle** under Recovery on the Wallet page                                            |

## Passphrases

The wallet passphrase encrypts this browser's keys; signed evidence stays readable in browser storage. Withdrawals,
redirected claims, showing a private key and downloading an encrypted backup ask for it again. The backup passphrase
protects one downloaded file; the two are separate, and support can reset neither. If you forget the wallet passphrase
but have a checked backup and its backup passphrase, open the wallet in a fresh browser profile, choose a new wallet
passphrase there, and restore the backup. Keep the original browser data until every account and its latest evidence
are safely recovered.

## Encrypted backups

On **Settings**, under **Keys and backups**, enter a passphrase of 12 to 1,024 characters as the **Backup passphrase**
and your wallet passphrase to authorize **Download encrypted backup**. The wallet downloads
`hookedin-encrypted-wallet.json`. A backup holds only the account in use:

- its key;
- every channel's opening, latest evidence and pending operation;
- its bankroll fund statements, developer bets and bank statements;
- its latest 100 receipts, and every receipt still to be settled: a developer bet still open, and a withdrawal not yet
  paid or returned;
- its play limits, breaks and recorded usage.

It holds no game state. Back up every account you fund, each on its own: a key alone cannot rebuild a signed balance.

After downloading, keep the backup passphrase in the field and select that saved file with **Check saved backup**. The
wallet decrypts it and checks its account, deployment and recovery contents against the saved wallet; a matching file
unlocks the Deposit tab's receiving controls. Save and check a fresh copy after playing or moving ETH: Settings and the
Wallet page say when your evidence has changed since. A checked copy is a snapshot, not an automatic backup.

| Property       | Value                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| Format         | A `HOOKEDIN/WALLET-BACKUP/1` envelope around a `HOOKEDIN/WALLET/1` record       |
| Key derivation | PBKDF2-SHA256, 600,000 iterations, a random 16-byte salt                        |
| Cipher         | AES-256-GCM, a random 12-byte IV, `HOOKEDIN/WALLET-BACKUP/1` as additional data |
| Size           | At most 16 MiB before encryption                                                |

To restore, enter the passphrase and choose the file with **Restore a backup**, with no operation or transaction
pending. Before it writes anything, the wallet checks that:

- the backup is for this chain and this contract;
- every channel belongs to the backup's account, and all the evidence verifies;
- it replaces no saved evidence with an older or conflicting checkpoint and changes no pending operation.

A backup of another account switches the wallet to that account. Restoring keeps the stricter play controls and the
higher daily usage of the saved wallet and the backup; it does not shorten a break.

## Recovery bundles

**Export recovery bundle**, under Recovery on the Wallet page, saves `hookedin-channel-<channelId>.json` for your
balance's channel, and one for a channel still closing beside it; **Export evidence** beside a closed balance's claim,
and the banner of a pending operation, do the same. A bundle names the deployment, the channel and its latest evidence,
and holds the evidence of each of your withdrawals the contract may still owe something
([its fields](../reference/signed-messages.md#evidence)); it holds no keys, no game data and no pricing. It changes with
every operation, so export it again after you play or withdraw.

**Import a recovery bundle**, under Recovery, reads one back while no operation or transaction is pending. The wallet
refuses a bundle of another chain, contract, owner or account, one older than or conflicting with its saved checkpoint,
one for a channel the contract does not hold for this account, and one holding a withdrawal your account and the casino
did not sign. From an imported bundle the wallet can close, challenge, finalize and collect, and play on when it holds
the latest state the casino has; its withdrawals join Activity like ones this browser sent.

## When a reply is lost

The wallet saves every signed request before it sends it. When the casino's answer does not arrive, the operation stays
pending, play on that channel waits, and a banner names it: what it is, its amount and game, the ID the casino knows it
by, the sequence it was signed at, and what the last attempt to send it ran into, with the casino's code when the casino
refused it. The banner offers:

- **Retry**, which sends the exact saved request again. The casino answers a retry with the result it recorded,
  accepted or rejected, so an operation is never carried out twice.
- **Export recovery bundle** and **Close without the casino**, for a casino that does not answer. A close settles at the
  latest completed state, and an operation the casino never completed costs nothing.

The wallet keeps a signed operation until it has a verified answer: a timeout is not a rejection. A deposit waiting to
be taken into your balance, and a channel waiting to be registered with the casino, need no banner: the wallet asks the
casino again at its next check.

The same banner covers an on-chain transaction that has not confirmed. **Retry** looks for its outcome, including a
replacement your account sent at the same nonce, and sends the exact saved transaction again when the network has none.
**Speed up** sends it again with a higher fee, at most 200 gwei per gas.

## Recovery mode

When the casino does not answer, answers with errors, or reports another chain, contract, owner or protocol revision
than the wallet's [pinned deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment), the wallet starts
in **recovery mode**. Evidence export and import, closing without the casino, challenges, finishing a close, collecting
and **Send it now** work, against the pinned contract through the pinned RPCs; play, deposits, withdrawals from the
balance and locking in do not. Reload once the casino is back.

Recovery needs play.hookedin.com no more than the casino: the same wallet builds from a checkout of this repository,
with Node 24.4 or later, and serves at http://127.0.0.1:4184, where you restore your encrypted backup.

```sh
git clone https://github.com/hookedin/play
cd play
npm ci
HOOKEDIN_CLIENT_CONFIG=config/production.json npm run dev
```

## The watchtower

The watchtower watches one channel from its recovery bundle and challenges a stale close for you, from a machine you
run, with a relayer key of its own: an account apart from yours, with ETH for gas, in `HOOKEDIN_RELAYER_KEY`. It runs
from a checkout of this repository:

```sh
HOOKEDIN_RELAYER_KEY=0x... npm run watchtower -- --deployment trusted.json --evidence channel.json --journal .private/watchtower.json
```

| Argument            | Meaning                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--deployment FILE` | Required. The deployment you trust, such as the `deployment` of [config/production.json](../../config/production.json), with the fields of a [pinned deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment) |
| `--evidence FILE`   | Required. The channel's recovery bundle, read again on every tick: replace it with a fresh export after you play or withdraw                                                                                                    |
| `--journal FILE`    | Required. The transaction journal. A lock file beside it, its path with `.lock`, keeps a second watchtower out                                                                                                                  |
| `--once`            | Run one tick and exit, with status 1 if it failed                                                                                                                                                                               |

On start it checks the deployed code and owner against the release's pinned artifact and the deployment file, and
stops if either differs; outside Anvil it refuses a `witnessRpcUrl` on the same host as `rpcUrl`. Then every 4 seconds
it reads the bundle again, checks that it belongs to the deployment, observes the chain through both RPCs, and sends
`challengeClose`, saved in the journal first, when the contract is closing on an older state than the bundle's and the
deadline has not passed. Each tick prints one JSON line, `{ time, alerts, pending, relayerBalance }`, where `pending` is
the hash of the journal's pending transaction or `null`; a failed tick prints `{ severity: "critical", reason }` to
standard error, and the next runs as usual. `SIGINT` and `SIGTERM` stop it after the current tick. It cannot start a
close, never needs your account's key, and knows only what the bundle holds.

Each alert is `{ channelId?, severity, reason, remaining?, detail? }`, where `remaining` is the seconds left before the
challenge deadline:

| `reason`                      | Severity                                      | Meaning                                                                                                                                    |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `stale-close`                 | `warning`; `critical` with under an hour left | The channel is closing on an older state than the evidence. A challenge is sent                                                            |
| `missed-deadline`             | `critical`                                    | The channel is closing on an older state than the evidence, and the deadline has passed                                                    |
| `conflicting-sequence`        | `critical`                                    | The closing state has the evidence's sequence and a different hash                                                                         |
| `finalized-state-differs`     | `critical`                                    | The channel finalized on a state older than the evidence. A finalized channel cannot be challenged                                         |
| `channel-defense-failed`      | `critical`                                    | Reading or verifying the channel failed, or the chain cannot settle the evidence (it took in a deposit a reorg removed); `detail` says why |
| `recovery-transaction-failed` | `critical`                                    | The challenge could not be sent; `detail` says why                                                                                         |
