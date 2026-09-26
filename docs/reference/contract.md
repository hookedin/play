---
title: The contract
description: HookedInCasino function by function, with its constants, readable storage, callers, effects, reverts, events and custom errors.
sidebar:
  order: 5
---

[HookedInCasino](../../contracts/HookedInCasino.sol) holds every ETH deposit and the house's bankroll, and settles a
channel on the evidence its channel key and the casino signed. It settles money and reads nothing else: what an
operation means is its `memo`, which the contract never reads. The structures and hashes it checks are on
[Signed messages](signed-messages.md); how a player closes and collects is in
[Closing and claims](../wallet/closing-and-claims.md).

## Build

Solidity `^0.8.28`, compiled with solc 0.8.37: optimizer on at 200 runs, the IR pipeline, EVM version Cancun, and no
CBOR metadata ([scripts/compile.ts](../../scripts/compile.ts)). The wallet accepts only the runtime pinned in
[client/contract-artifact.ts](../../client/contract-artifact.ts), with the immutable `owner` filled in;
[Verify a release](../wallet/verify-a-release.md) reproduces it.

The constructor takes no arguments and makes the deploying account `owner`, which is immutable. There is no upgrade,
pause or ownership transfer. There is no `receive` or `fallback` function, so a plain ETH transfer reverts: ETH enters
through `openChannel` and `fundBankroll`, and any ETH forced in counts as house cash. Every function that changes state
holds a transient reentrancy guard.

## Constants

| Getter               | Type      | Value                                                                                                 |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `CHALLENGE_PERIOD()` | `uint256` | 86,400: the challenge window, in seconds                                                              |
| `MAX_BALANCE()`      | `uint256` | 2^128: every deposit, amount, prize and balance is below it                                           |
| `OUTCOME_DOMAIN()`   | `bytes32` | `keccak256("HOOKEDIN/OUTCOME")`, `0xede2fdd26760847d3c92bb2ebf4da0fdbdf441ed687b86dc1257f1962e3857ff` |

A channel's `status` is 0 unopened, 1 open, 2 closing or 3 finalized. Operation kinds are 0 none, 1 casino bet,
2 debit and 3 credit.

## Storage

| Getter                                 | Returns                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner()`                              | `address`: the casino, which signs every checkpoint and alone withdraws house money                                                                                           |
| `protectedPrincipal()`                 | `uint256`: the deposits of open and closing channels, plus the unpaid principal of finalized claims                                                                           |
| `unpaidWinnings()`                     | `uint256`: the unpaid winnings of finalized claims                                                                                                                            |
| `reservedWinnings()`                   | `uint256`: ETH allocated to queued winnings and not yet paid                                                                                                                  |
| `channels(bytes32 channelId)`          | `(address player, uint64 deadline, uint8 status, address signer, uint256 deposit, bytes32 initialHash, uint256 closingSequence, bytes32 closingHash, uint256 closingBalance)` |
| `activeChannel(address player)`        | `bytes32`: the funding account's channel from its opening until it is finalized; zero when there is none                                                                      |
| `withdrawals(bytes32 withdrawalId)`    | `bool`: whether a house withdrawal ID is used                                                                                                                                 |
| `allocatedWinnings(bytes32 channelId)` | `uint256`: ETH allocated to the claim's winnings and not yet paid                                                                                                             |
| `firstClaim()`                         | `bytes32`: the claim at the head of the [winnings queue](#the-winnings-queue); zero when it is empty                                                                          |
| `nextClaim(bytes32 channelId)`         | `bytes32`: the claim behind it in the queue                                                                                                                                   |

A channel's fields:

| Field                                              | Meaning                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `player`                                           | The funding account, which sent the deposit                                             |
| `deadline`                                         | The end of the challenge window while the channel is closing, in Unix seconds; 0 before |
| `status`                                           | 0 unopened, 1 open, 2 closing, 3 finalized                                              |
| `signer`                                           | The channel key                                                                         |
| `deposit`                                          | The wei deposited                                                                       |
| `initialHash`                                      | The hash of the genesis checkpoint                                                      |
| `closingSequence`, `closingHash`, `closingBalance` | The checkpoint a close proposes, then the one it finalized                              |

## Views

| Function                                          | Returns                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domainSeparator()`                               | The EIP-712 domain separator of this deployment on this chain                                                                                        |
| `hashState(Checkpoint)`                           | A checkpoint's digest, its state hash                                                                                                                |
| `hashOperation(Operation)`                        | An operation's digest                                                                                                                                |
| `hashClose(bytes32 channelId, bytes32 stateHash)` | A `Close`'s digest                                                                                                                                   |
| `houseCash()`                                     | `balance − protectedPrincipal − reservedWinnings`: what can be allocated to queued winnings                                                          |
| `withdrawableHouse()`                             | `max(0, balance − protectedPrincipal − unpaidWinnings)`: what the owner can withdraw                                                                 |
| `derive(Checkpoint base, Step step)`              | The checkpoint `step` produces from `base`                                                                                                           |
| `supported(Evidence evidence)`                    | The checkpoint `evidence` proves                                                                                                                     |
| `claims(bytes32 channelId)`                       | `(address beneficiary, bytes32 stateHash, uint256 amount, uint256 paid, uint256 protectedRemaining, uint256 winningsRemaining, uint256 finalizedAt)` |
| `claimRecipient(bytes32 channelId)`               | The address the claim pays                                                                                                                           |

`claims` reads a finalized channel's claim: `beneficiary` is its funding account, `stateHash` and `amount` the checkpoint
it finalized and its balance, `paid` is `amount − protectedRemaining − winningsRemaining`, and `finalizedAt` is in
Unix seconds; every field but `beneficiary` is zero before finalization. `claimRecipient` is the funding account
unless `claimTo` changed it, and zero before finalization.

### `derive`

Applies one step to `base` without checking who signed `base`. A casino bet takes `amount` from the balance and adds
`prize` when the step's [outcome](signed-messages.md#the-outcome) is below `chance`; a debit takes `amount` and a credit
adds it. It reverts:

- `InvalidState` when the operation does not follow `base`: another `channelId`, a `previousStateHash` that is not
  `hashState(base)`, or a `sequence` that is not the base's plus one.
- `Unauthorized` when the channel was never opened, or `authorization` is not the channel key's signature of the
  operation. A signature that is not 65 bytes, has a high `s` or a `v` other than 27 or 28 is refused the same way.
- `InvalidTerms` when the operation breaks [the transition rules](signed-messages.md#transitions): `amount` 0 or at
  least 2^128; a casino bet with a `chance` of 0, a `prize` of 0 or at least 2^128, a zero `round` or `seedHash`, or a
  secret or seed that does not hash to them; a debit or credit with a nonzero `chance`, `prize`, `round`, `seedHash`,
  seed or secret; a casino bet or debit above the balance; a kind other than 1, 2 or 3; a next balance of at least
  2^128. A `chance` is a `uint64`, so its type keeps it below 2^64.
- `InvalidState` when `casinoSignature` is not the owner's signature of the next checkpoint (`Unauthorized` when it is
  malformed).

### `supported`

Returns the checkpoint that `evidence` proves. It reverts:

- `InvalidState` when the channel was never opened.
- `Unauthorized` when `base` is not the genesis (its hash is not `initialHash`) and is not signed by both the channel
  key (`playerSignature`) and the owner (`casinoSignature`).
- `InvalidTerms` when the step's kind is 0 and the step is not the [empty step](signed-messages.md#evidence). With the
  empty step it returns `base`; otherwise it returns `derive(base, step)`, with `derive`'s reverts.
- `InvalidState` when the result's balance is at least 2^128.

## Functions that change state

| Function                                                                            | Caller                                            | Effect                                                                                                                                                                                                          | Reverts                                                                                                                                                                                                                                                                                                             | Events                                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `openChannel(address signer) payable returns (bytes32 channelId)`                   | The funding account: anyone, who becomes `player` | Opens the channel `keccak256(abi.encode(msg.sender, signer, msg.value))` with the deposit `msg.value`: status open, `initialHash` the genesis hash, `activeChannel` set, `protectedPrincipal` up by the deposit | `InvalidTerms`: `signer` is zero, or the value is 0 or at least 2^128. `Unauthorized`: the ID was used before, or the caller already has an active channel                                                                                                                                                          | `ChannelOpened`                                                                                 |
| `fundBankroll() payable`                                                            | Anyone                                            | Adds the value to house cash, then allocates up to 8 queued claims                                                                                                                                              | `InvalidTerms`: the value is 0                                                                                                                                                                                                                                                                                      | `BankrollFunded`, `WinningsAllocated`                                                           |
| `withdrawHouse(bytes32 withdrawalId, address payable recipient, uint256 amount)`    | The owner                                         | Marks the ID used and sends `amount` to `recipient`                                                                                                                                                             | `Unauthorized`: not the owner. `InvalidTerms`: the ID is zero or used, `recipient` is zero or the contract, or `amount` is 0. `InsufficientBalance`: `amount` exceeds `withdrawableHouse()`. `TransferFailed`                                                                                                       | `HouseWithdrawal`                                                                               |
| `startClose(Evidence evidence)`                                                     | The funding account or the owner                  | Proposes the checkpoint `supported(evidence)` returns: status closing, `deadline` the block's time plus 24 hours                                                                                                | `supported`'s. `Unauthorized`: the channel is not open, or the caller is neither. `InvalidState`: the deadline does not fit 64 bits                                                                                                                                                                                 | `CloseStarted`                                                                                  |
| `challengeClose(Evidence evidence)`                                                 | Anyone                                            | Swaps the proposed checkpoint for one with a higher sequence; the deadline does not move                                                                                                                        | `supported`'s. `InvalidState`: the channel is not closing, the deadline has passed, or the sequence is not above `closingSequence`                                                                                                                                                                                  | `CloseChallenged`                                                                               |
| `cooperativeClose(Evidence evidence, bytes playerSignature, bytes casinoSignature)` | Anyone holding both `Close` signatures            | [Finalizes](#finalization) at once on `supported(evidence)`                                                                                                                                                     | `supported`'s. `InvalidState`: the channel is finalized, or it is closing and the deadline has passed, or the sequence is below `closingSequence`, or equal to it with another hash. `Unauthorized`: the signatures are not the funding account's and the owner's `Close` of the channel and that checkpoint's hash | `ClaimEstablished`                                                                              |
| `finalizeClose(bytes32 channelId)`                                                  | Anyone                                            | [Finalizes](#finalization) on the proposed checkpoint                                                                                                                                                           | `InvalidState`: the channel is not closing, or the deadline has not come                                                                                                                                                                                                                                            | `ClaimEstablished`                                                                              |
| `claim(bytes32 channelId)`                                                          | Anyone                                            | Allocates up to 8 queued claims, then pays the claim's remaining principal and allocated winnings to its recipient in one call with 100,000 gas                                                                 | `InvalidState`: the channel is not finalized. `TransferFailed`: the recipient refused the payment; nothing changes                                                                                                                                                                                                  | `WinningsAllocated`, `ClaimPayment` when it pays, `ClaimShortfall` while anything is still owed |
| `claimTo(bytes32 channelId, address recipient)`                                     | The funding account                               | Sets the claim's recipient, then pays as `claim`                                                                                                                                                                | `Unauthorized`: the channel is not finalized, or the caller is not its funding account. `InvalidTerms`: `recipient` is zero or the contract. `TransferFailed`                                                                                                                                                       | `ClaimRecipientChanged`, then as `claim`                                                        |
| `allocateWinnings(uint256 limit)`                                                   | Anyone                                            | Allocates house cash to up to `limit` queued claims, oldest first                                                                                                                                               | `InvalidTerms`: `limit` is 0 or above 64                                                                                                                                                                                                                                                                            | `WinningsAllocated`                                                                             |

The channel ID binds the caller, the key and the value, so nobody else can open a given channel and a reorganised
transaction cannot change the deposit under an ID. One funding account has one channel at a time, from its opening
until it is finalized, and each opening needs a combination of key and deposit never used before: the wallet makes a
fresh channel key for every opening.

The challenge window is fixed. While a channel is closing, a challenge or a cooperative close is possible until the
deadline, and from the deadline on only `finalizeClose` is. A challenge never extends the window.

### Finalization

`cooperativeClose` and `finalizeClose` end a channel the same way. It becomes finalized and its `activeChannel` entry
is cleared. Its principal is `min(balance, deposit)` and its winnings `balance − principal`: `protectedPrincipal`
falls by `deposit − principal`, and `unpaidWinnings` rises by the winnings. The claim records the funding account as
its recipient, the state hash, the balance, the principal and winnings still to pay, and the time. A claim with
winnings joins the end of the winnings queue. No ETH moves: collecting is a separate call.

## The winnings queue

A claim's principal was protected from the moment of the deposit, so `claim` pays it at once. Its winnings are owed
from house cash. Finalized claims with winnings wait in one first-in, first-out queue, and house cash is allocated to
them oldest first: up to 8 claims whenever anyone funds the bankroll or collects a claim, up to 64 with
`allocateWinnings`. An allocation is reserved for its claim (`reservedWinnings`), so a recipient that refuses payment
keeps its allocation without holding up the claims behind it. The owner can withdraw only what exceeds protected
principal and every unpaid winning. `ClaimShortfall` reports what a claim is still owed after a collection.

## Events

`channelId` is the first indexed topic of every event that has one.

| Event                                                                                                                                                    | Emitted by                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChannelOpened(bytes32 indexed channelId, address indexed player, uint256 deposit)`                                                                      | `openChannel`                                                                                                                                                                    |
| `CloseStarted(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash, uint256 deadline)`                                                         | `startClose`                                                                                                                                                                     |
| `CloseChallenged(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash)`                                                                        | `challengeClose`                                                                                                                                                                 |
| `ClaimEstablished(bytes32 indexed channelId, address indexed beneficiary, bytes32 stateHash, uint256 amount, uint256 protectedAmount, uint256 winnings)` | Finalization; `beneficiary` is the funding account                                                                                                                               |
| `ClaimPayment(bytes32 indexed channelId, address indexed beneficiary, uint256 amount, uint256 totalPaid)`                                                | `claim` and `claimTo` when they pay; `beneficiary` is the recipient paid, which differs from the funding account after `claimTo`, and `totalPaid` what the claim has paid in all |
| `ClaimShortfall(bytes32 indexed channelId, uint256 remaining)`                                                                                           | `claim` and `claimTo`, while the claim is still owed `remaining`                                                                                                                 |
| `BankrollFunded(address indexed funder, uint256 amount)`                                                                                                 | `fundBankroll`                                                                                                                                                                   |
| `HouseWithdrawal(bytes32 indexed withdrawalId, address indexed recipient, uint256 amount)`                                                               | `withdrawHouse`                                                                                                                                                                  |
| `WinningsAllocated(bytes32 indexed channelId, uint256 amount)`                                                                                           | Every allocation to a queued claim                                                                                                                                               |
| `ClaimRecipientChanged(bytes32 indexed channelId, address indexed recipient)`                                                                            | `claimTo`                                                                                                                                                                        |

## Custom errors

| Error                   | Raised when                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `Unauthorized()`        | The caller or a signature lacks the authority the call needs     |
| `InvalidTerms()`        | An argument or a signed field breaks the rules                   |
| `InvalidState()`        | The channel, its evidence or the time is not what the call needs |
| `InsufficientBalance()` | A house withdrawal exceeds `withdrawableHouse()`                 |
| `TransferFailed()`      | An ETH transfer was refused                                      |
| `Reentrancy()`          | A guarded function was entered again during a call               |

## The two keys of a channel

| Key                           | Is                                             | Signs                                                                                                   | Calls                                                                                              |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The funding account, `player` | The account that sent the deposit              | `Close`                                                                                                 | `openChannel`, `startClose`, `claimTo`; it is the claim's recipient unless `claimTo` names another |
| The channel key, `signer`     | A key named at opening, which the wallet holds | Every operation; its countersignature of every checkpoint; API `Access` tokens; `Redeem` and `Withdraw` | Nothing: it needs no ETH                                                                           |
| The owner                     | The casino                                     | Every checkpoint it produces; `Close`                                                                   | `startClose`, `withdrawHouse`                                                                      |

Every signature the contract checks is recovered with `ecrecover`, so it must come from an externally owned account. A
contract account can fund a channel, but it cannot sign `Close`: it closes with `startClose` and `finalizeClose`.
`challengeClose`, `finalizeClose`, `claim`, `allocateWinnings` and `fundBankroll` are open to anyone, which lets a
watchtower or any relayer defend and collect for a player.
