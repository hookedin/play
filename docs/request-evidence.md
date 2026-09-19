# Independent recovery and payment evidence

Default wallet exports contain the on-chain opening identity and minimal settlement proof, without keys or game state. Settlement verification needs no game rules.

A recovery bundle supports settlement. Use an encrypted wallet backup to retain channel keys and exact pending operations; games keep their own state.

```sh
npm run recover -- channel.json --rpc https://ethereum-sepolia-rpc.publicnode.com --action inspect
export HOOKEDIN_RECOVERY_KEY=0x...   # a gas-paying key; the original funding key for start
npm run recover -- channel.json --rpc RPC --action start
npm run recover -- channel.json --rpc RPC --action challenge
npm run recover -- channel.json --rpc RPC --action finalize
npm run recover -- channel.json --rpc RPC --action claim
```

`channel.json` is the evidence exported from the wallet. Run recovery from the retained release for that deployment; it does not compile or update runtime pins. Finalization establishes debt; run the separate `claim` action to receive available funds. The signing key comes from `HOOKEDIN_RECOVERY_KEY`. The casino API and channel signing key are unnecessary. Starting a close requires the original funding wallet or casino owner. Anyone can relay challenges, finalize, or collect a claim; payment goes to the beneficiary’s saved destination; only that beneficiary can redirect it using `claimTo`. A private durable journal saves signed transactions before broadcast; rerunning recovers the saved transaction. A failed journal write stops the instance; repair storage and restart from the durable journal before retrying. Confirmed reverts and consumed nonces release the journal. Dropped transactions can be replaced with the same nonce, destination, value and calldata, bounded by a fee cap (`--replace` requests an immediate fee increase). It defaults to `.private/recovery-CHANNEL_ID.json`; `--journal PATH` overrides it. Instead of the environment variable, `--wallet-file FILE` reads the key from a private JSON file at `wallets[ROLE].privateKey`, where `--role` defaults to `player`.

Without `--rpc`, inspection establishes only signature consistency against the bundle's claimed identity. With an independently chosen RPC, inspection checks the network, actual owner, registered player/signer/genesis, and block-specific channel/claim state. It reports the block number/hash, signed balance, finalization time, amount due, amount this contract paid, remaining protected/winnings amounts, and winnings already allocated for collection. Use `--block NUMBER` with `--action inspect` for a historical report; the default is `latest`. Historical state must be available from that RPC; payment logs are never required. Every financial read is pinned to a canonical block hash and the report rejects a changed observation. The CLI uses this one selected RPC and does not run the service/browser witness observer.

A signed balance alone is not overdue debt. A claim becomes due at finalization. An unpaid finalized claim proves that the indicated amount remains unpaid through this contract at the referenced block. It does not prove malicious intent or exclude unrelated external payments. Reports distinguish this claim's protected principal and allocated winnings from unallocated pool cash and cash reserved for senior claims. A junior claim is not shown as collectible merely because the pool holds a senior claim's allocation. Historical transfer failures are outside this current-state report.

Check your wallet regularly while a channel is open and submit challenges yourself, leaving enough time for inclusion on-chain. The independent [watchtower](#watchtower) is optional. Start-close fixes a 24-hour deadline, and challenges do not extend it. Submit newer valid evidence before the deadline. If no valid result evidence exists for an unresolved wager, closure uses the latest completed state without a withholding penalty. Never delete or redraw a signed wager merely because HTTP timed out.

Use `--action claim --to ADDRESS` from the original beneficiary to redirect a claim. Recovery writes can use any gas-paying wallet for challenge/finalize/ordinary claim; only start-close and claim redirection require their corresponding authority.

## Watchtower

```sh
export HOOKEDIN_RELAYER_KEY=0x...   # funded for gas, separate from any funding or settlement key
npm run watchtower -- --deployment trusted.json --evidence channel.json --journal .private/watchtower.json
```

[scripts/watchtower.ts](../scripts/watchtower.ts) watches one channel from its exported evidence file. `trusted.json` is a deployment manifest you verified yourself: `chainId`, `contractAddress`, `operator`, `rpcUrl` and, outside Anvil, an independent `witnessRpcUrl`. On start it checks the deployed bytecode and owner against the pinned release artifact and that manifest, then every four seconds it re-reads the evidence file, observes the chain through both RPCs, and submits `challengeClose` when the contract shows a closure older than the evidence. Transactions are saved in the journal before broadcast, and a lock beside the journal keeps a second instance out. `--once` runs a single tick and exits with an error if it fails. Each tick prints its status and the relayer's balance.

The watchtower knows only what is in the evidence file. Export fresh evidence from the wallet after playing and replace the file, keep the relayer funded, and run it on a machine the casino does not control. It cannot start a close, and it does not need the channel key or the funding key.
