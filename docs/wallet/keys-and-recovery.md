---
title: Keys and recovery
description: Your key and its passkey, your own build, another device, recovery bundles, lost replies, comparing with the casino, the casino's history, recovery mode and the watchtower.
sidebar:
  order: 4
---

Your key is your account: it signs everything you do with your money, and only it can close your balance without the
casino. The casino holds the latest state of your balance and gives it to any wallet with your key; your own copy of
that state, your evidence, is what lets you settle when the casino does not.

## Your key

Your first visit is a guest's, who can open games but holds no balance and has no name. **Create wallet** in the top
bar, or anything that needs an account, offers:

- **Create with a passkey** makes a passkey for play.hookedin.com, which your device or password manager keeps and syncs
  like any passkey; the account's key is the passkey's [PRF](https://w3c.github.io/webauthn/#prf-extension) output,
  which never leaves the browser. Each passkey is an account of its own: **Sign in with a passkey** opens one you made
  before.
- **Create a key file** makes an account whose key is in the file it downloads, `hookedin-<address>.txt`, which **Open a
  key file**, under **Sign in**, opens again. **Import a private key** opens an account from its key, pasted, in any
  copy of the wallet, including one you [build yourself](#your-own-build). Anyone who has the file can take everything
  the account holds.

A passkey works only at play.hookedin.com, and only on devices whose passkeys support PRF; the wallet says when they do
not. The wallet keeps the key of the account in use in this browser, so it signs your bets without asking. Deleting the
passkey, or losing the key file, loses the account and everything it holds: nobody can recover a key for you.

**Keys**, in Settings, has **Save a key file**, a second copy of the key in use, **Show this wallet's private key**, and
every account this browser holds a key for. **Start over** deletes everything the wallet keeps in this browser, every
account's key, evidence, receipts and allowances, after a warning: a passkey's account opens again with the passkey, and
a key file's needs the file.

## Your own build

play.hookedin.com serves the wallet, and the wallet holds your key, so you trust whoever publishes it not to serve one
that takes it ([trust model](../overview/trust-model.md#what-you-trust-the-casino-for)). To trust no one with your key,
build the wallet from this repository and run it yourself, with Node 26 or later:

```sh
git clone https://github.com/hookedin/play
cd play
npm ci
npm run dev
```

It serves the same wallet, on the same deployment, at http://127.0.0.1:4184, and runs the commit you checked out, which
you can read, until you pull another. Its accounts and evidence are its own. Create a key file in it, and never use that
key at play.hookedin.com: a passkey works only there, and any key used there is held by whatever wallet it serves at the
time. It is the first step to [playing with zero trust](../overview/zero-trust.md).

## On another device

Sign in with your passkey, or import your key, and the wallet takes up your balance from the casino: the latest state it
holds of your channel, checked to carry your own signatures and the casino's, and your [bankroll
shares](bankroll-fund.md#the-statements-your-wallet-checks). A device that missed play elsewhere takes up the casino's
later state when it opens, or on **Retry** once an operation of its own is refused for following an older state, which
voids that operation. Receipts, activity, [game allowances](getting-started.md#games-and-their-allowances), each game's
saved state and the payout of a developer bet placed there, whose receipt is its proof, stay in the browser they
happened in.

The casino's copy is taken on its word: had it given an older state, a wallet without the newer one could not tell. A
current recovery bundle settles your balance without trusting it, and carries the withdrawals the contract still owes.

## Recovery bundles

**Export recovery bundle**, under Recovery in Settings, saves `hookedin-channel-<channelId>.json` for your balance's
channel, and one for a channel still closing beside it; **Export evidence** beside a closed balance's claim, and the
banner of a pending operation, do the same. A bundle names the deployment and holds the channel's latest evidence, the
evidence of each withdrawal and lock-in the contract may still owe something, and a casino bet the casino has not
settled, with its quote ([its fields](../reference/signed-messages.md#evidence)); it holds no keys and no game data. It
changes with every operation, so export it again after you play or withdraw.

A browser may clear a site's data to free disk space, your evidence with it. **Keep this wallet's data**, under
Recovery, asks it not to, and Recovery says whether it agreed; when it declines, your recovery bundle is the copy that
lasts.

**Import a recovery bundle**, under Recovery, reads one back while nothing is pending. The wallet refuses a bundle of
another chain, contract, signer or account, one older than or conflicting with its saved checkpoint, one for a channel
the contract does not hold for this account, and one holding a withdrawal your account and the casino did not sign. From
an imported bundle the wallet can close, challenge, finalize and collect, and play on when it holds the latest state the
casino has; its withdrawals join Activity. A casino bet it carries is for a [watchtower](#the-watchtower) to dispute:
the wallet that imports it does not take it up.

## When a reply is lost

The wallet saves every signed request before it sends it. When the casino's answer does not arrive, the operation stays
pending, play on that channel waits, and a banner names it: what it is, its amount and game, its ID, the sequence it was
signed at, and what the last attempt to send it ran into. The banner offers:

- **Retry**, which asks the casino for the state it holds, then sends the exact saved request again if that state does
  not already answer it. The casino answers a retry with the result it recorded, accepted or rejected, so an operation
  is never carried out twice.
- **Export recovery bundle** and **Close without the casino**, for a casino that does not answer. A close settles at the
  latest completed state, and an operation the casino never completed costs nothing.

A timeout is not a rejection: the wallet keeps a signed operation until it has a verified answer. The same banner covers
an on-chain transaction that has not confirmed: **Retry** looks for its outcome, including a replacement your account
sent at the same nonce, and sends the exact saved transaction again when the network has none, and **Speed up** sends it
with a higher fee, within the wallet's [caps](closing-and-claims.md#fees-and-gas).

## Comparing with the casino

**Advanced**, in Settings, shows your balance as this browser holds it beside the casino's copy, with each row that
differs marked, and both records whole as JSON. **Take up the casino's state** puts the casino's state in place of this
browser's, whatever it is, an earlier one or another at the same sequence, which the wallet never takes up by itself,
and drops any operation the casino has not answered; a warning says first what your balance becomes. The casino's state
carries your own signatures, but an earlier one gives up what came after it: export your [recovery
bundle](#recovery-bundles) first, whose import puts a later state back.

## The casino's history

The casino records everything it decides in its signing history, each record committing to every record before it, and
every reply on your channel brings its signature of where that history ends, a [history
head](../reference/signed-messages.md#history-heads). On every check, every 10 minutes and when you press ↻, the wallet
asks the casino for the record of the head it holds
([`GET /api/history/:id`](../casino-api/public.md#get-apihistoryid)), and moves on to the newest head only once that
record is there as signed. When it is missing or changed, the casino has rewritten its history: a banner says so, and
the wallet keeps that head, which holds the casino's signature, so a newer one cannot hide the rewrite.

## Recovery mode

When the casino does not answer, answers with errors, or reports another chain, contract, signer or protocol revision
than the wallet's [pinned deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment), the wallet starts
in **recovery mode**. Exporting and importing evidence, closing without the casino, challenging, finishing a close and
collecting work, against the pinned contract through the pinned RPCs, and Activity still holds the transaction that
sends a withdrawal; play, deposits, withdrawals and locking in do not. Reload once the casino is back. With a key file,
[your own build](#your-own-build) recovers the same way; a passkey works only at play.hookedin.com.

## The watchtower

The watchtower watches one channel from its recovery bundle, from a machine you run, and challenges a stale close or
disputes a casino bet the casino left unsettled. It sends with a relayer key of its own, an account apart from yours
with ETH for gas, in `HOOKEDIN_RELAYER_KEY`, and runs from a checkout of this repository:

```sh
HOOKEDIN_RELAYER_KEY=0x... npm run watchtower -- --deployment trusted.json --evidence channel.json --journal .private/watchtower.json
```

| Argument            | Meaning                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--deployment FILE` | Required. The deployment you trust, such as the `deployment` of [config/production.json](../../config/production.json), with the fields of a [pinned deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment) |
| `--evidence FILE`   | Required. The channel's recovery bundle, read again on every tick: replace it with a fresh export after you play or withdraw                                                                                                    |
| `--journal FILE`    | Required. The transaction journal. A lock file beside it, its path with `.lock`, keeps a second watchtower out                                                                                                                  |
| `--once`            | Run one tick and exit, with status 1 if it failed                                                                                                                                                                               |

On start it checks the deployed code and signer against the release's pinned artifact and the deployment file, and stops
if either differs; outside Anvil it refuses a `witnessRpcUrl` on the same host as `rpcUrl`. Every 4 seconds it reads the
bundle again, checks that it belongs to the deployment, observes the chain through both RPCs, and sends
`challengeClose`, saved in the journal first, when the contract is closing on an older state than the bundle's and the
deadline has not passed. When the bundle carries a casino bet its quote covers, it sends `dispute` instead: at once when
a close stops short of the bet, and on an active channel an hour before the quote expires. Until then it reports
`unsettled-bet`, since the casino may still settle the bet, which the wallet's next export then leaves out; a bet whose
quote expired undisputed reports `expired-bet`. It starts a close only by disputing a bet, never needs your account's
key, and knows only what the bundle holds.

Each tick prints one JSON line, `{ time, alerts, pending, relayerBalance }`, where `pending` is the hash of the
journal's pending transaction or `null`; a failed tick prints `{ severity: "critical", reason }` to standard error, and
the next runs as usual. `SIGINT` and `SIGTERM` stop it after the current tick. Each alert is
`{ channelId?, severity, reason, remaining?, detail? }`, where `remaining` is the seconds left before the challenge
deadline, or for `unsettled-bet` the seconds left to dispute the bet, until its quote expires or the close's deadline,
whichever comes first:

| `reason`                      | Severity                                                  | Meaning                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale-close`                 | `warning`; `critical` with under an hour left             | The channel is closing on an older state than the evidence. A challenge is sent                                                                                                                                 |
| `unsettled-bet`               | `warning`; `critical` with under an hour left             | The bundle carries a casino bet the casino has not settled. A dispute is sent with under an hour left on an active channel, and at once when a close stops short of the bet                                     |
| `expired-bet`                 | `warning` on an active channel; `critical` once it closes | The bundle carries a casino bet whose quote expired before anyone disputed it: unless the casino settles it, it ends void. On an active channel the casino may have settled it, and a newer export carries none |
| `disputed-bet`                | `warning`; `critical` with under an hour left             | The close disputes a casino bet, and the evidence is at its sequence: a challenge with it settles the bet                                                                                                       |
| `missed-deadline`             | `critical`                                                | The channel is closing on an older state than the evidence, and the deadline has passed                                                                                                                         |
| `conflicting-sequence`        | `critical`                                                | The closing state has the evidence's sequence and a different hash                                                                                                                                              |
| `finalized-state-differs`     | `critical`                                                | The channel finalized on a state older than the evidence. A finalized channel cannot be challenged                                                                                                              |
| `channel-defense-failed`      | `critical`                                                | Reading or verifying the channel failed, or the chain cannot settle the evidence (it took in a deposit a reorg removed); `detail` says why                                                                      |
| `recovery-transaction-failed` | `critical`                                                | The challenge or dispute could not be sent; `detail` says why                                                                                                                                                   |
