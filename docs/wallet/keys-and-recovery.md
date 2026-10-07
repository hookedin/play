---
title: Keys and recovery
description: Your key and its passkey, another device, recovery bundles, lost replies, comparing with the casino, the casino's history, recovery mode and the watchtower.
sidebar:
  order: 4
---

Your key is your account: it signs everything you do with your money, and only it can close your balance without the
casino. The casino holds the latest state of your balance, which your key signed, and gives it to any wallet with your
key. Your own copy of that state, your evidence, is what lets you settle when the casino does not.

## Your key

The wallet holds no account until you make one: your first visit is a guest's, who can open games but holds no
balance and has no name. **Create wallet** in the top bar, or anything that needs an account, offers:

- **Create with a passkey** makes a passkey for play.hookedin.com, which your device or password manager keeps and
  syncs to your other devices as it does any passkey. The account's key is the passkey's secret for the wallet, its
  [PRF](https://w3c.github.io/webauthn/#prf-extension) output, which never leaves the browser. Each passkey you make is
  an account of its own, so if you made one before, sign in with it instead. The password manager lists it by the day
  you made it, and then, where the browser lets the wallet say it, by the name the account goes by here.
- **Sign in with a passkey** opens the account of a passkey you made before: the same key, wherever the passkey is.
- **Create a key file** makes an account whose key is in the file it downloads, `hookedin-<address>.txt`. **Import a
  private key** opens an account from its key in any copy of the wallet, including one you
  [build yourself](#recovery-mode). Anyone who has the file can take everything the account holds.

A passkey works only at play.hookedin.com, and only on devices whose passkeys support PRF; the wallet says when they
do not. The wallet keeps the key of the account in use in this browser, so it signs your bets without asking.
Deleting the passkey, or losing the key file, loses the account and everything it holds: nobody can recover a key for
you.

**Backup and keys**, under **Keys** in Settings, has **Save a key file**, a second copy of the key of the account in
use, and **Show this wallet's private key**. It lists every account this browser holds a key for, and **Sign in with a
passkey** or **Import a private key** there switches to another.

**Start over**, under Backup and keys, deletes everything the wallet keeps in this browser, in every tab: the key of every
account saved here, with its evidence, receipts, activity and game allowances, and leaves the wallet with no account. It
warns you first, and says how much the account in use holds. **Sign in with a passkey** opens a passkey's account
again; an account you hold only as a key file needs that file.

## On another device

Sign in with your passkey, or import your key, and the wallet takes up your balance from the casino: the latest state
it holds of your channel, with the reply that signed it. The wallet checks that its evidence carries your own
signatures and the casino's, and signs the state itself; a declined operation's state moves no money. [Bankroll shares](bankroll-fund.md#the-statements-your-wallet-checks) follow the same way.

What stays in the browser it happened in: receipts and activity, [game allowances](getting-started.md#games-and-their-allowances),
each game's saved state, the payout of a developer bet placed there, whose receipt is its proof, and a withdrawal the
contract still owes, which that channel's [recovery bundle](#recovery-bundles) carries.

One account can play on several devices. A device that missed play elsewhere takes up the casino's later state when it
opens, or on **Retry** once an operation of its own is refused for following an older state; that operation is void.

On another device the casino's copy is taken on its word: had it given an older state, a wallet without the newer one
could not tell. A current recovery bundle settles your balance without trusting it.

## Recovery bundles

**Export recovery bundle**, under Recovery in the wallet's Settings, saves `hookedin-channel-<channelId>.json` for your
balance's channel, and one for a channel still closing beside it; **Export evidence** beside a closed balance's claim,
and the banner of a pending operation, do the same. A bundle names the deployment and holds the channel's latest
evidence, whose checkpoint names the channel, and the evidence of each of your withdrawals and lock-ins the contract may still owe something and a casino bet
the casino has not settled, with its quote ([its fields](../reference/signed-messages.md#evidence)); it holds no keys,
no game data and no pricing. It changes with every operation, so export it again after you play or withdraw.

A browser may clear a site's data to free disk space, your evidence with the wallet's. **Keep this wallet's data**,
under Recovery, asks it not to; Recovery says whether it does. Firefox asks you, and other browsers decide for
themselves. When the browser declines, your recovery bundle is the copy that lasts.

**Import a recovery bundle**, under Recovery, reads one back while no operation or transaction is pending. The wallet
refuses a bundle of another chain, contract, owner or account, one older than or conflicting with its saved checkpoint,
one for a channel the contract does not hold for this account, and one holding a withdrawal your account and the casino
did not sign. From an imported bundle the wallet can close, challenge, finalize and collect, and play on when it holds
the latest state the casino has; its withdrawals join Activity like ones this browser sent. A casino bet it carries is
for a [watchtower](#the-watchtower) to dispute: the wallet that imports the bundle does not take it up.

## When a reply is lost

The wallet saves every signed request before it sends it. When the casino's answer does not arrive, the operation stays
pending, play on that channel waits, and a banner names it: what it is, its amount and game, the ID the casino knows it
by, the sequence it was signed at, and what the last attempt to send it ran into, with the casino's code when the casino
refused it. The banner offers:

- **Retry**, which asks the casino for the state it holds, then sends the exact saved request again if that state does
  not already answer it. The casino answers a retry with the result it recorded, accepted or rejected, so an operation
  is never carried out twice.
- **Export recovery bundle** and **Close without the casino**, for a casino that does not answer. A close settles at the
  latest completed state, and an operation the casino never completed costs nothing.

The wallet keeps a signed operation until it has a verified answer: a timeout is not a rejection. A deposit waiting to
be taken into your balance, and a channel waiting to be registered with the casino, need no banner: the wallet asks the
casino again at its next check.

The same banner covers an on-chain transaction that has not confirmed. **Retry** looks for its outcome, including a
replacement your account sent at the same nonce, and sends the exact saved transaction again when the network has none.
**Speed up** sends it again with a higher fee, within the wallet's [caps](closing-and-claims.md#fees-and-gas).

## Comparing with the casino

**Advanced**, the last tab of Settings at `/settings/advanced`, shows your balance as this browser holds it beside the
casino's copy: the sequence, the balance, what it has taken in and withdrawn, the state's hash, an operation the casino
has not answered and your bankroll shares, with each row that differs marked and a line saying how they differ. Below
them are both records whole, as JSON to copy: this browser's saved record of the account, and what the casino answers
the account with for its channel, its shares and what it owes it. Comparing changes nothing.

**Take up the casino's state** replaces this browser's state of your balance with the casino's, whatever it is: an
earlier one, or another at the same sequence, which the wallet never takes up by itself. An operation the casino has not
answered is dropped with it. A warning says first what your balance becomes and what is dropped. The casino's state must
carry your own signatures, as any state the wallet takes up does, so it is one you agreed to; an earlier one gives up
what came after it. Export your [recovery bundle](#recovery-bundles) first: importing it puts a later state back.

## The casino's history

The casino records everything it decides in its signing history, each record committing to every record before it, and
every reply on your channel brings its signature of where that history ends, a [history
head](../reference/signed-messages.md#history-heads). The wallet keeps the newest, and on every check, every 10 minutes
and when you press ↻, asks the casino for that record
([`GET /api/history/:id`](../casino-api/public.md#get-apihistoryid)). When the record is missing or not as signed, the
casino has rewritten its history, and a banner says so: "The casino rewrote its history: the record … it signed is
missing or changed. Keep this browser's wallet, which holds the casino's signature."

## Recovery mode

When the casino does not answer, answers with errors, or reports another chain, contract, owner or protocol revision
than the wallet's [pinned deployment](../reference/deployment.md#how-the-wallet-pins-its-deployment), the wallet starts
in **recovery mode**. Evidence export and import, closing without the casino, challenges, finishing a close and
collecting work, against the pinned contract through the pinned RPCs, and Activity still holds the transaction that sends
a withdrawal; play, deposits, withdrawals from the balance and locking in do not. Reload once the casino is back.

With your key file, recovery needs play.hookedin.com no more than the casino: the same wallet builds from a checkout of
this repository, with Node 26 or later, and serves at http://127.0.0.1:4184, where you import it. A passkey works only
at play.hookedin.com.

```sh
git clone https://github.com/hookedin/play
cd play
npm ci
npm run dev
```

## The watchtower

The watchtower watches one channel from its recovery bundle and challenges a stale close for you, or disputes a casino
bet the casino left unsettled, from a machine you run, with a relayer key of its own: an account apart from yours, with ETH for gas, in `HOOKEDIN_RELAYER_KEY`. It runs
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
deadline has not passed. When the bundle carries a casino bet its quote covers, it sends `dispute` instead: at once when
a close stops short of the bet, and on an active channel an hour before the quote expires, which closes the channel with
the bet. Until then it reports `unsettled-bet`, as the casino may still settle the bet, and the wallet's next export
then carries none. A bet whose quote expired before anyone disputed it cannot be disputed any more: it reports
`expired-bet`. Each tick prints one JSON line, `{ time, alerts, pending, relayerBalance }`, where `pending` is the hash
of the journal's pending transaction or `null`; a failed tick prints `{ severity: "critical", reason }` to standard
error, and the next runs as usual. `SIGINT` and `SIGTERM` stop it after the current tick. It starts a close only by
disputing a bet, never needs your account's key, and knows only what the bundle holds.

Each alert is `{ channelId?, severity, reason, remaining?, detail? }`, where `remaining` is the seconds left before the
challenge deadline, or for `unsettled-bet` before the bet can no longer be disputed: when its quote expires, or the
close's deadline if that comes first:

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
