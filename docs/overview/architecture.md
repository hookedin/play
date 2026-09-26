---
title: Architecture
description: The design for reviewers, from boundaries, money and authority to rounds, admission, the wallet, games and the trade-offs made on purpose.
sidebar:
  order: 3
---

HookedIn settles signed casino channels on Sepolia (11155111), or on a local Anvil chain (31337) in development. It has
one immutable contract, one casino writer, an independent wallet and sandboxed games, and each deployment has its own
service state, signing history and wallet state. The design keeps the fewest parts that are correct: clearly disclosed
trust assumptions and manual responsibilities are accepted in place of more protocol machinery, and every added
authority, service, state or setting needs a concrete requirement.

This repository holds the parts a player has to trust: the contract, the wallet and the protocol code both sides share,
with the game SDK and the house's games. The casino service is a separate, private codebase that pins this repository as
a git submodule, so it always runs an exact public protocol revision.

## Boundaries

| Component                                                                         | Responsibility                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Contract](../../contracts/HookedInCasino.sol)                                    | Authenticate settlement, protect principal, enforce the fixed challenge window, keep claims and allocate winnings first in, first out                                         |
| [Shared protocol](../../protocol/protocol.ts), [risk](../../protocol/risk.ts)     | Typed structures, hashes, state derivation and the admission rule, used unchanged by the wallet, the recovery tools, the games' pricing and the casino                        |
| Casino writer (private service)                                                   | Admit casino bets, sign results, keep the secrets of rounds and the fee accounting, keep developer bets and developers' banks, recover exact responses and owner transactions |
| [Wallet](../../client/wallet.ts)                                                  | Authorize exact debits, verify outcomes and rejection checkpoints, save evidence before exposing results, submit settlement transactions                                      |
| [Game sessions](../../client/wallet-games.ts)                                     | Hold the open game's in-memory spending limit and scope its operation IDs                                                                                                     |
| Game frame ([SDK](../sdk/index.md))                                               | Run its own rules, request casino and developer bets, read results from the receipts the wallet checked; no keys and no future outcome entropy                                |
| [Recovery](../../protocol/recovery.ts), [watchtower](../../scripts/watchtower.ts) | Verify exported evidence against current canonical contract state without the casino API or payment logs, and challenge with it                                               |

Players open and fund channels on-chain without the casino's authorization. Activation checks the confirmed deposit and
the channel key's authentication before the casino keeps any state for the channel. The genesis checkpoint supports
unilateral recovery of the deposit. Randomness is not channel state: each casino bet names the round that settles it.

The contract settles money and nothing else: a casino bet, a debit or a credit ([how it works](how-it-works.md#channels)).
What an operation means (its name, the game that asked for it, what it pays into or collects from) is the hash `memo`,
which the wallet and the casino check and keep and the contract never reads. A jointly signed checkpoint can establish
any balance both sides accept; one transition the channel key authorized and the casino signed extends it without a
final acknowledgment from the player. The EIP-712 domain binds the name `HookedIn`, version `1`, the chain and the
deployment. Risk admission and commission belong to the casino, and what a game means by its bets to the game. The
wallet and the contract check a casino bet's stake, every prize, the round's secret, the sequence and the arithmetic
bounds, and the wallet records the exact return and largest payout of what the player signed. A bet and a payment sign
the game that asked for them, by its key, and any group the game gave them, so the game a player's money went to is part
of the signed record and the casino tallies commission per game. Commission is not in the signed operation.

The contract reads operations and signatures from calldata, reuses computed hashes, packs a channel's status and deadline
with its player address, and uses a transient reentrancy guard. A claim's beneficiary comes from channel ownership, and
the claim stores only its current payout recipient.

A channel holds one asset: ETH, or test coins ([test coins](how-it-works.md#test-coins)). A test channel's ID is a hash
the contract can never produce, so nothing about it reaches the contract. The casino keeps bankroll, equity,
commissions, developer earnings and liabilities per asset; a round is in one asset only, and the bankroll fund takes ETH
only.

## Money and authority

The deployer is the only owner and settlement signer. It controls house liquidity, including through jointly signed
winning checkpoints for accounts it controls.

An open deposit is fully protected. Finalization protects `min(deposit, accepted balance)` and records the remainder as
winnings debt, so losses reduce the principal returned. Finalization never calls a recipient: a separate collection
transaction pays protected principal and allocated winnings, and a rejected transfer reverts that collection and keeps
the whole unpaid claim. Paid totals are derived from the original amount less the principal and winnings remaining. The
beneficiary can redirect collection. Every channel finalizes once.

Finalized winnings are allocated first in, first out. A recipient that rejects payment keeps its allocation without
stopping later cash from reaching the claims behind it. Funding and collection allocate at most eight entries, and an
explicit `allocateWinnings` at most 64. Every deposit and signed balance is below 2^128 wei, so the uint256 total of
winnings debt cannot overflow and block another channel's finalization, whatever balances the owner signs.

House withdrawals exclude all principal and finalized winnings debt. **Winnings on open channels are unsecured
obligations of the shared pool**: neither replenishment nor a payout deadline is guaranteed. This is an accepted product
choice; collateral dedicated to winnings and per-channel payout ceilings are outside scope
([closing and claims](../wallet/closing-and-claims.md)).

The casino sets an even commission, [the edge the bankroll does not need](#settled-trade-offs), against the current
unreserved bankroll when it admits a casino bet, and the bet's receipt reports it. Commission is operator accounting,
neither an additional player debit nor a fee the wallet verifies. Half accrues to the game's developer and half to casino
earnings, only for completed casino bets; a developer's own casino bet earns its developer half of its commission like
any other. A developer bet is the exception: the bankroll does not back it, and the casino's part of it is what the
developer's settlement gives the casino. Casino earnings stay in bankroll equity, and what is owed to developers is kept
apart. A developer's earnings are owed to the developer's address: the casino keeps a running tally of what each address
has earned and collected, publishes every tally in its public status, and the developer collects with a credit its own
channel signs. Nothing moves on-chain and the bankroll does not change: money the casino already owed becomes the
developer's signed balance ([earnings](../games/earnings.md)).

## What the casino promises

The casino's storage, signing history and chain monitoring are internal to the private service. What a wallet, a
developer or a reviewer can rely on is its observable behaviour:

- It records every response it signs (an opening, a result, a rejection, a fund or bank statement, a developer's casino
  bet, a settlement, a close authorization) durably before the response leaves the writer. Retrying an operation ID
  returns the same accepted or rejected receipt, also after a restart or a restore of older service data, and a game's
  operation its player already carried out on another channel is declined, never carried out twice.
- It signs at most one outcome for a channel position and settles on each round's secret at most once; a round whose
  secret was lost settles nothing.
- A persistence failure stops all further signing rather than risk a conflicting signature or a duplicate payout.
- Play pauses while its chain observation is stale and while it reconciles after a restart or a reorg; results
  already committed stay recoverable throughout.
- It challenges stale closes of channels it knows, in its own interest: its watcher does not protect a player against
  the casino.
- It runs the exact protocol revision it pins from this repository.

These are an operator's promises. The contract enforces none of them, and the wallet is built not to need them: it
verifies every signature, preimage and balance change itself, keeps the evidence and can settle on-chain alone. What the
wallet cannot verify is availability, liquidity and whether every requested casino bet is completed.

## Rounds

Every casino bet is on a round ([rounds](how-it-works.md#rounds)). Only one secret and one seed can settle a casino bet
that signs their hashes. The casino names a round before it sees the seed, and the wallet picks the seed knowing only
the round's hash, so a round needs no signature and the contract checks nothing about rounds but those two hashes.

A round is a channel's own or a developer's. A channel's own round is named by the casino; the casino bet on it opens
and closes it in one request, and the reply names the next one. It is revealed whenever it ends, also when its casino
bet is declined, so the wallet records what a declined bet would have paid. A developer's round is named whenever the
developer asks, in one asset, and revealed by the developer's own casino bet on it
([developer bets](../games/developer-bets.md)).

## Casino bets and developer bets

A **casino bet** settles against the bankroll in the request that places it. A **developer bet** is a bet against a
game's developer instead: its stake leaves the player's balance as a final debit and goes straight into the developer's
bank at the casino, and the developer settles it later with a `Settlement` its own key signs, paid from that bank.
Placing one trusts the developer, and the wallet says so. What a settlement pays is owed to its player and collected
with a credit the wallet works out for itself, so the contract never learns that it waited; until then it is the
casino's promise, outside the principal the contract protects ([trust model](trust-model.md)). There is no escrow, no
deadline and no refund: a developer bet its developer never settles shows in the game's public record as open.

A developer bet is paid what its developer says. Its meta, the game's own JSON, says what it is; the casino keeps it and
never reads it. A game can make its developer bets provably fair with a scheme of its own, on its developer's rounds:
the developer's casino bet on a round is backed by the bankroll and reveals the round, and its meta, kept with the
reveal, commits to whatever the developer chose before the outcome was revealed, such as the bets it backs. The wallet
checks only that the developer signed what it paid; anyone can check a game's scheme against what the casino publishes.
The bankroll sees a developer's hedge as what it is: one casino bet with many prizes.

## Risk admission

Risk admission treats a casino bet as one wager: the exact Kelly condition over the cells its prize ranges cut from the
outcome space, which for one stake and one prize is the closed-form Kelly inequality
([economics](../reference/economics.md)). The casino reserves the bet's worst-case cash decrease plus commission across
the operations in flight, and makes its capacity decision before it reads the round's secret, so no rejection depends on
the outcome. A developer's casino bet is admitted the same way; developer bets are not admitted at all, because the
bankroll does not back them. Admission does not collateralize private balances. A casino bet takes one request and no
RPC reads. The rule itself is [protocol/risk.ts](../../protocol/risk.ts).

A rejection is the casino's signature over an unchanged-balance checkpoint one sequence above the casino bet, which the
wallet verifies and countersigns when it arrives. The casino therefore never holds a player-signed checkpoint that could
supersede a result it has already completed. For a base at sequence n, the casino bet is n+1, its rejection n+2 and the
next attempt n+3. A rejection earns no commission; a lost reply stays pending until it is recovered. The newer proof
can challenge a rejected casino bet within the usual challenge deadline.

The casino can withhold completion selectively without a protocol penalty, so verifying completed results proves
neither that every requested casino bet was completed without bias nor that a whole game finishes. A channel's own
round is revealed with the rejection that declines its casino bet, and the wallet records what the declined bet would
have paid, so selective rejection shows on the receipt; a developer's casino bet that the bankroll declines reveals its
round too. The wallet countersigns a declined casino bet on its channel's own round only with that round's secret, or
when the casino says it lost the round, which the receipt then says in words.

## Chain reads

Chain reads use canonical block hashes and reject a changed observation
([protocol/chain-observer.ts](../../protocol/chain-observer.ts)). RPC requests time out after ten seconds, and a late
response cannot resume a failed read. Sepolia requires two RPCs on different hosts, fresh and progressing heads, and
confirmation depth; a local Anvil chain mines on demand and is exempt from the freshness checks. The wallet, the
watchtower and the casino share this observer.

## The wallet

The wallet keeps funding and channel keys, signed requests, receipts and transaction intents in IndexedDB, and nothing
about games. An injected wallet's funding key stays in that wallet. Web Locks and durable revisions serialize competing
tabs. Each channel owns its pending operation across reorgs and changes of selection, and recovering a registration
follows from the channel's on-chain status. A funding key is committed before its receiving address is shown. Small
settings use Web Storage.

A game's spending limit is a reservation against the signed channel balance, held only in the open tab's memory
([games and limits](../wallet/games-and-limits.md#giving-a-game-money)). It signs nothing, so the player can set it
while an operation is pending, up to the balance less what that operation has committed. A result recovered after a
reload changes only the channel balance. A game's operation IDs belong to the player, the asset and the game, not to a
channel, so exact retries and receipt lookups by the game's own IDs work across the player's channels without game
records in the wallet, and the casino declines an ID its player already used on another channel rather than carry it
out twice. There is no game account in the contract or at the casino.

Encrypted backups hold only the selected account
([backups and recovery](../wallet/backups-and-recovery.md#encrypted-backups)); keys alone cannot rebuild signed
balances. Observations of the active channel commit under the action lock. Bankroll figures and bounded reads of older
channels run outside it and merge into the latest durable revision, so slow optional reads make progress without
holding up play. A persistence failure blocks every further action until the wallet reloads from durable state.
Retrying an operation compares every term against the saved one, and looking up a receipt is explicit. Each transaction
journal latches a failed write and keeps only the pending transaction and the latest completion.

## Games

A manifest states what the wallet holds a game to, and nothing about what a game pays back: a figure a game promised
would be unverifiable, because nothing bounds how often a game wagers the money it holds. What a player gets instead is
measured: the wallet computes the exact return of every casino bet it signs from that bet's own prize table, and the
casino publishes the same figure for every casino bet placed in a game
([measured return](../wallet/bets-and-receipts.md#measured-return)). A developer bet has no prize table and so no such
figure. Every bound a game must respect (the prizes one bet holds, the size of the outcome space, how large a bet's meta
and a group may be) is part of the protocol revision: `wallet.hello` reports them to a game and `GET /api/config` to a
developer, so a game reads them rather than carrying copies.

A game owns its rules, state transitions and persistence. Its frame keeps its host's origin
(`allow-scripts allow-same-origin`) and stores its rounds there, keyed by the player's name and the asset in play. The
wallet never frames its own origin, and its host forbids framing it at all. Each game is its own site, known by its
key, made from its developer and the name they publish it under in their profile at the casino (`@alias/game` or
`~uname/game`). The developer is the account that publishes it: it earns the game's commission, its bank takes the
stakes of the game's developer bets and its key settles them, so a game's server holds everything that account holds.
The wallet refuses a game whose manifest names another developer. Where a game is served can change while its key
stays, so a game keeps its history.

A one-shot game places its whole prize table as one casino bet, and a multi-step game places
[one casino bet per step](#settled-trade-offs), priced with the casino's own admission rule. The wallet signs and
verifies each bet whole, and a game reads what to show from its receipt; developers stay responsible for how steps
combine into their advertised game. A game with a server ships page and server as one Cloudflare Worker on one origin:
static assets, and a Durable Object under `/api/`. The casino deployment runs no game servers. A game learns one thing
about who is playing: their uname, derived from an address the casino never discloses, with their alias beside it; the
player's address, channel and balances never cross the bridge.

Game developers test against [testing/game-wallet.ts](../../testing/game-wallet.ts), a real wallet wired to an
in-memory casino stub that holds every casino bet to the casino's own admission rule.
[testing/conformance.ts](../../testing/conformance.ts) is one behaviour suite that this repository runs against the stub
and the casino runs against itself, so the stub behaves as the casino does wherever a game depends on it
([testing](../games/testing.md)).

## The bankroll fund

The bankroll is open to investors ([bankroll fund](../wallet/bankroll-fund.md)). A player moves money from a channel
into the fund and holds shares of it, priced by the bankroll's equity; selling shares owes the player their worth,
collected with a credit the player's own channel signs. It is a trust arrangement: the casino states the price and
could take the money. What the design guarantees is accountability. Every change to a holding is a statement the casino
signs and the wallet verifies against the holder's own signed transfer or redemption, all of it is in the signing
history, and the owner's own funding and withdrawals trade house shares at the going price, so taking more than the
house owns shows in the fund's signed public state. It is deliberately not a token: shares cannot be transferred, and
nothing about them is on-chain.

## Settled trade-offs

These are chosen on purpose and stay chosen; [AGENTS.md](../../AGENTS.md#settled-decisions) asks that they not be
reopened.

**Commission is the edge the bankroll does not need.** A casino bet is admitted when the bankroll can take it with no
commission at all; commission is then the most that still leaves the bankroll's residual wager Kelly-sound, split
equally between the game's developer and the casino. The calculation is more involved than a fixed rate, and that is
the point: a fee taken first would shrink every bet the bankroll can take, while this admits the largest ones and
charges only the surplus. A game sets its own tables, and its developer earns half of the edge they carry. Nothing here
pretends to protect a player from a game: any game can waste the money it is given on bets that pay back little,
whatever the fee, and a cap would only hide that. The player's protection is the spending limit they set, and the
measured return of every casino bet, which the wallet records and does not enforce.

**A multi-step game is a sequence of casino bets.** Every step is one casino bet, settled on its own, so the bankroll
moves atomically with each step and no step waits on another. A player can walk away after any settled step with the
cash that step left them; nothing makes them finish a hand. A game built this way is a series of casino bets, each
admitted and charged by itself, not a committed hand, and its prices follow from that.

**A developer's solvency is outside HookedIn.** A developer's bank reserves nothing, and a settlement is paid from it
only as far as it can pay. Whether a developer can pay what its developer bets are owed, and proving it, is between the
developer and its players; the casino does not attempt it. Playing a developer's game trusts that developer: for its
tables in any game, and with a developer bet for its payment and for whatever its scheme promises.

## Recovery and manual responsibility

Either party can start a unilateral close. Anyone with strictly newer supported evidence can challenge before the fixed
24-hour deadline, and challenges never extend it. After the deadline anyone can finalize or trigger collection. An
immediate cooperative close needs the funding account and the casino. Every signature the contract checks is an EOA
signature, so a contract account that funds a channel exits through a unilateral close.

**Players must watch their channel and get a challenge of a stale close mined before the deadline.** The wallet shows
the observation time, the saved and proposed sequences, the balance at risk, the deadline and any pending challenge,
with the protected principal, unpaid winnings and allocated winnings of each claim
([closing and claims](../wallet/closing-and-claims.md)). Opening the wallet does not send a challenge. The 0.001 ETH
reserve is a convenience floor, not a guaranteed gas budget. An independent watchtower is optional; the casino's
watcher does not protect against a malicious casino.

A recovery bundle holds the on-chain opening identity and the minimal supported proof, with no private keys, game data
or pricing. A single independently chosen RPC can verify the registered identity and the current state of a claim,
without payment logs. Inspecting a past block needs the state at that block, and cannot guarantee that the block
survives a later reorg. Game state is not needed to settle a channel
([backups and recovery](../wallet/backups-and-recovery.md)).

## Release

The wallet ships exactly one runtime pin, [client/contract-artifact.ts](../../client/contract-artifact.ts). Compiling
checks it without replacing it; `npm run release:artifact` rewrites it once a contract change has been reviewed. The
contract is compiled without a metadata hash, so the pin moves only when the compiled code does: a comment or a name
changes nothing that is deployed. Recovery runs the archived artifact without compiling.

`npm run build` writes the wallet to `dist/` as one readable `main.js` with its source map, `vendor/ethers.js`
byte-identical to the npm release of ethers, and `config.js` with the deployment's settings, so each can be checked on
its own. `npm run audit:package` archives every file git tracks, the compiler input and output and the tests' gas
report, with a manifest of their hashes ([verify a release](../wallet/verify-a-release.md)).

Wallet release credentials are kept apart from the casino's hosting: the wallet is a static site that shares nothing
with the service but the public protocol. Fencing hosts, and drills for lost storage, stale restores, nonces, RPCs and
keys, belong to the operator of the casino service. A change to the contract's compiled code means deploying the
contract afresh; once a release holds money that matters, the contract stays as it is.
