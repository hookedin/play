---
title: Command-line tools
description: hookedin-game, the recovery CLI and the watchtower, with every argument, variable and behaviour.
sidebar:
  order: 3
---

Three commands. `hookedin-game` builds and serves a game. `npm run recover` settles a channel on-chain from its
evidence, without the casino. `npm run watchtower` challenges a stale close of one channel. The last two run from a
checkout of play; all three need Node 24.4 or later.

## `hookedin-game`

[sdk/bin/hookedin-game.js](../../sdk/bin/hookedin-game.js), installed with `@hookedin/play` as the `hookedin-game`
command. The template's `npm run build` and `npm run dev` run it; in play, run it as `node sdk/bin/hookedin-game.js`.

```text
hookedin-game build [dir ...]
hookedin-game serve [dir]
```

Each `dir` is a game folder holding `src/`, the current folder when none is given. There are no flags. A failure prints
its message and exits with status 1.

### `build`

For each folder, `build`:

1. reads `src/manifest.json`, with its `developer` replaced by `HOOKEDIN_DEVELOPER` when that is set, and refuses a
   `developer` that is not `0x` and 40 hex digits, or is the zero address;
2. deletes `dist/`;
3. bundles `src/game.ts` with esbuild into `dist/game.js`: an ES module for ES2022, with a source map and legal
   comments inline;
4. copies every file in `src/` whose name does not end in `.ts`, folders included;
5. with `HOOKEDIN_DEVELOPER` set, writes that developer into `dist/manifest.json`;
6. adds `shared.css` and `brand/hookedin-mark.svg` from the SDK, and writes `_headers`.

It prints `Built <name> into <dir>/dist/ (developer <address>)`.

| File in `dist/`                               | From                                    |
| --------------------------------------------- | --------------------------------------- |
| `game.js`, `game.js.map`                      | `src/game.ts` and everything it imports |
| `index.html`, `manifest.json`, styles, images | Copied from `src/`                      |
| `shared.css`                                  | The SDK's shared styles                 |
| `brand/hookedin-mark.svg`                     | The HookedIn mark                       |
| `_headers`                                    | Written by the build                    |

### The `_headers` file

In the format Cloudflare applies to static assets; any other host sends the same headers:

```text
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

The policy lets the page load from and talk to its own origin only, with images also as `data:` URLs.
`Access-Control-Allow-Origin: *` lets the wallet read the manifest from another origin.

### `serve`

`serve` builds the game, then serves its `dist/` at `http://127.0.0.1:4185`, and prints the manifest URL to add as a
custom game.

- A request for a page, a path ending in `/` or `.html`, builds the game again first, so a change shows on reload. A
  failed build answers 500 with its message.
- It serves every file in `dist/`, with the headers from `dist/_headers` and `Cache-Control: no-store`.
- A path with a `..` segment, or with a segment starting with `.` or `_`, answers 404, as does a missing file.
- It listens on `127.0.0.1` only.

### `hookedin-game` variables

| Variable             | Used by          | Meaning                                                                                                    |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `HOOKEDIN_DEVELOPER` | `build`, `serve` | The developer address the built manifest names in place of its own, such as a local casino's house account |
| `PORT`               | `serve`          | The port to serve on. Default `4185`                                                                       |

## `npm run recover`

[scripts/verify-evidence.ts](../../scripts/verify-evidence.ts) verifies a channel's evidence bundle and, given an RPC,
reads the channel on-chain and sends the contract call that closes, challenges, finalizes or collects it. It needs no
casino API and no channel key. When to use it: [backups and recovery](../wallet/backups-and-recovery.md). `npm run`
runs it from play's root, so relative paths are read from there.

```sh
npm run recover -- channel.json --rpc https://ethereum-sepolia-rpc.publicnode.com --action inspect
HOOKEDIN_RECOVERY_KEY=0x… npm run recover -- channel.json --rpc https://ethereum-sepolia-rpc.publicnode.com --action start
```

### Recovery options

| Argument             | Meaning                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `<bundle>`           | The first argument: the evidence file exported from the wallet, at most 16 MiB                                |
| `--rpc URL`          | The JSON-RPC endpoint to read and send through. Without it, only `inspect` runs, offline                      |
| `--action NAME`      | `inspect` (the default), `start`, `challenge`, `finalize` or `claim`                                          |
| `--to ADDRESS`       | With `claim`: pay the claim to this address, with `claimTo`                                                   |
| `--block N`          | With `inspect`: read the chain at block `N` instead of the latest                                             |
| `--journal PATH`     | The transaction journal. Default `.private/recovery-<channelId>.json`                                         |
| `--replace`          | Replace a pending transaction with a higher fee at once, instead of after 45 seconds                          |
| `--wallet-file FILE` | Read the signing key from `wallets[<role>].privateKey` in this JSON file, in place of `HOOKEDIN_RECOVERY_KEY` |
| `--role ROLE`        | The entry of `--wallet-file` to use. Default `player`                                                         |

| Variable                | Meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `HOOKEDIN_RECOVERY_KEY` | The private key that signs and pays for the transaction, when no `--wallet-file` is given |

### Recovery actions

| Action      | Contract call                                               | Who may send it                                      | Sends nothing when                                       |
| ----------- | ----------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `inspect`   | None                                                        | Anyone                                               | –                                                        |
| `start`     | `startClose(evidence)`                                      | The channel's funding account, or the casino's owner | The channel is closing or finalized                      |
| `challenge` | `challengeClose(evidence)`                                  | Anyone                                               | The closing state is at the evidence's sequence or later |
| `finalize`  | `finalizeClose(channelId)`                                  | Anyone, from the challenge deadline                  | The channel is finalized                                 |
| `claim`     | `claim(channelId)`, or `claimTo(channelId, to)` with `--to` | Anyone; `claimTo` only the channel's funding account | The claim is paid in full                                |

- Without `--rpc`, `inspect` checks the bundle's signatures against the identity it claims and prints the verified
  state.
- With `--rpc`, `inspect` also checks, at one canonical block, the chain ID, that the contract's owner is the bundle's
  operator, that the registered player, signer and opening state match the bundle, and that the contract supports its
  evidence. It prints the channel's status, challenge deadline and closing state, the signed balance, the claim with
  what is paid and what remains, and how the claim stands against the contract's cash, as `paymentStatus`:

  | `paymentStatus`                           | Meaning                                                                             |
  | ----------------------------------------- | ----------------------------------------------------------------------------------- |
  | `not finalized`                           | There is no claim yet                                                               |
  | `no unpaid amount`                        | The claim is paid in full                                                           |
  | `claim has funds reserved for collection` | `claim` pays them                                                                   |
  | `unpaid; FIFO allocation pending`         | The contract has free house cash; `claim` reserves it for the oldest winnings first |
  | `unpaid; no unallocated house liquidity`  | Nothing is free to pay it until the contract holds more house cash                  |

- Every other action inspects first, and sends nothing when its end is already reached, unless the journal holds a
  pending transaction, which it resumes. It prints the inspection again once done.
- `challenge` refuses to send when the contract is closing on a different state at the evidence's own sequence: two
  signed states at one sequence need review.
- It uses the contract ABI pinned in the release and one RPC. It compiles nothing and does not check the deployed
  bytecode.

### The recovery journal

- Each signed transaction is saved in the journal before it is broadcast, and a second run resumes it instead of
  signing another. A lock file, the journal's path with `.lock`, keeps a second run out meanwhile.
- A journal belongs to one contract, and refuses another.
- A transaction is limited to 2,000,000 gas and 200 gwei a unit of gas. A replacement keeps the nonce, destination,
  value and calldata, and raises the fee.
- The run waits up to 45 seconds for 2 confirmations on Sepolia, 1 elsewhere. A transaction still pending then stays in
  the journal: run again, or with `--replace` to raise its fee.
- A transaction that reverts or fails releases the journal for a fresh action.

## `npm run watchtower`

[scripts/watchtower.ts](../../scripts/watchtower.ts) watches one channel from its exported evidence and challenges a
close older than that evidence, from a relayer key of its own. When to run one:
[backups and recovery](../wallet/backups-and-recovery.md). It too runs from play's root.

```sh
export HOOKEDIN_RELAYER_KEY=0x…
npm run watchtower -- --deployment trusted.json --evidence channel.json --journal .private/watchtower.json
```

### Watchtower options

| Argument            | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--deployment FILE` | Required. The deployment you trust, as JSON (below)                                                          |
| `--evidence FILE`   | Required. The channel's evidence bundle, exported from the wallet and read again on every tick               |
| `--journal FILE`    | Required. The transaction journal. A lock file beside it, its path with `.lock`, keeps a second instance out |
| `--once`            | Run one tick and exit, with status 1 if it failed                                                            |

| Variable               | Meaning                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `HOOKEDIN_RELAYER_KEY` | Required. The key that sends and pays for challenges, funded apart from any funding or settlement key |

### The deployment file

The `deployment` object of a wallet configuration, such as the one in
[config/production.json](../../config/production.json):

| Field             | Type           | Meaning                                                                 |
| ----------------- | -------------- | ----------------------------------------------------------------------- |
| `chainId`         | decimal string | The chain: `11155111` for Sepolia, `31337` for a local Anvil            |
| `contractAddress` | address        | The contract                                                            |
| `operator`        | address        | The contract's owner, which signs the casino's side of every channel    |
| `rpcUrl`          | string         | The RPC to read and send through                                        |
| `witnessRpcUrl`   | string         | A second RPC, on a different host from `rpcUrl`. Required outside Anvil |
| `runtimeHash`     | bytes32        | Optional. The keccak-256 hash of the deployed code                      |

### Watchtower behaviour

- On start it checks the deployed bytecode and owner against the release's pinned artifact and the deployment file,
  and `runtimeHash` when given, and stops if any differs. Outside Anvil it refuses a `witnessRpcUrl` on the same host as
  `rpcUrl`.
- Every 4 seconds it runs a tick: it reads the evidence file again, so a fresh export counts from the next tick;
  checks that the evidence belongs to the deployment; observes the chain through both RPCs; and reads the channel.
  When the contract is closing on an older state than the evidence and the deadline has not passed, it sends
  `challengeClose` with the evidence, saved in the journal first. It counts a block final after 2 confirmations, 1 on
  Anvil.
- Each tick prints one JSON line to standard output, `{ time, alerts, pending, relayerBalance }`, where `pending` is
  the hash of the journal's pending transaction or `null`. A failed tick prints `{ severity: "critical", reason }` to
  standard error, and the next tick runs as usual.
- `SIGINT` and `SIGTERM` stop it after the current tick.
- It cannot start a close, and needs neither the channel key nor the funding key.

### Alerts

Each alert is `{ channelId?, severity, reason, remaining?, detail? }`, where `remaining` is the seconds left before the
challenge deadline.

| `reason`                      | Severity                                      | Meaning                                                                                            |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `stale-close`                 | `warning`; `critical` with under an hour left | The channel is closing on an older state than the evidence. A challenge is sent                    |
| `missed-deadline`             | `critical`                                    | The channel is closing on an older state than the evidence, and the deadline has passed            |
| `conflicting-sequence`        | `critical`                                    | The closing state has the evidence's sequence and a different hash                                 |
| `finalized-state-differs`     | `critical`                                    | The channel finalized on a state older than the evidence. A finalized channel cannot be challenged |
| `channel-defense-failed`      | `critical`                                    | Reading or verifying the channel failed; `detail` says why                                         |
| `recovery-transaction-failed` | `critical`                                    | The challenge could not be sent; `detail` says why                                                 |
