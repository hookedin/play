---
title: The contract
description: HookedInCasino function by function, with its constants, readable storage, callers, effects, reverts, events and custom errors.
sidebar:
  order: 5
---

[HookedInCasino](../../contracts/HookedInCasino.sol) holds every ETH deposit and the house's bankroll, and settles a
channel and pays its withdrawals on the evidence its account and the casino signed. It settles money and reads nothing
else: what an operation means is its `memo`, which the contract never reads. The structures and hashes it checks are on
[Signed messages](signed-messages.md); how a player closes and collects is in
[Closing and claims](../wallet/closing-and-claims.md).

## Build

Solidity `^0.8.28`, compiled with solc 0.8.37: optimizer on at 200 runs, the IR pipeline, EVM version Cancun, and no
CBOR metadata ([scripts/compile.ts](../../scripts/compile.ts)). The wallet accepts only the runtime pinned in
[client/contract-artifact.ts](../../client/contract-artifact.ts), with the immutable `owner` filled in;
[Verify a release](../wallet/verify-a-release.md) reproduces it.

The constructor takes no arguments and makes the deploying account `owner`, which is immutable. There is no upgrade,
pause or ownership transfer. There is no `receive` or `fallback` function, so a plain ETH transfer reverts: ETH enters
through `deposit` and `fundBankroll`, and any ETH forced in counts as house cash. It leaves through `withdraw`, `claim`,
`claimTo` and `withdrawHouse`. Every function that changes state holds a transient reentrancy guard.

## Constants

| Getter               | Type      | Value                                                                                                 |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `CHALLENGE_PERIOD()` | `uint256` | 86,400: the challenge window, in seconds                                                              |
| `MAX_BALANCE()`      | `uint256` | 2^128: every deposit, amount, prize, balance and `withdrawn` is below it                              |
| `OUTCOME_DOMAIN()`   | `bytes32` | `keccak256("HOOKEDIN/OUTCOME")`, `0xede2fdd26760847d3c92bb2ebf4da0fdbdf441ed687b86dc1257f1962e3857ff` |

A channel's `status` is 0 unopened, 1 open, 2 closing or 3 finalized. Operation kinds are 0 none, 1 casino bet,
2 debit, 3 credit, 4 deposit and 5 withdrawal.

## Storage

| Getter                         | Returns                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owner()`                      | `address`: the casino, which signs every checkpoint and alone withdraws the house's money                                                                                      |
| `protectedPrincipal()`         | `uint256`: the `principal` of open and closing channels, plus the unpaid principal of claims                                                                                   |
| `unpaidWinnings()`             | `uint256`: the unpaid winnings of claims                                                                                                                                       |
| `queuedWinnings()`             | `uint256`: the winnings of every claim so far, in the order the claims were recorded: the [winnings queue](#the-winnings-queue)                                                |
| `channels(bytes32 channelId)`  | `(address player, uint64 deadline, uint8 status, uint256 deposited, uint256 principal, uint256 claimed, uint256 closingSequence, bytes32 closingHash, uint256 closingBalance)` |
| `channelIndex(address player)` | `uint256`: how many of the account's channels have started closing, and so the index of its current one                                                                        |
| `claims(bytes32 id)`           | `(address beneficiary, address recipient, uint256 protectedRemaining, uint256 winningsRemaining, uint256 queueEnd)`                                                            |

A channel's fields:

| Field                                              | Meaning                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player`                                           | The account, which signs everything on the channel                                                                                                                         |
| `deadline`                                         | The end of the challenge window while the channel is closing, in Unix seconds; 0 before                                                                                    |
| `status`                                           | 0 unopened, 1 open, 2 closing, 3 finalized                                                                                                                                 |
| `deposited`                                        | Everything ever deposited into the channel, from which what a checkpoint is [owed](#finalization) is worked out                                                            |
| `principal`                                        | The deposits the contract holds for the channel: every deposit as it arrives, less what [withdrawals](#withdrawals) took of them; 0 once finalized, its claim holding them |
| `claimed`                                          | Everything the channel's [withdrawals](#withdrawals) have made into claims                                                                                                 |
| `closingSequence`, `closingHash`, `closingBalance` | The checkpoint a close proposes, then the one it finalized, and what it is [owed](#finalization)                                                                           |

A claim's fields:

| Field                | Meaning                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beneficiary`        | The account, which alone may redirect the claim with `claimTo`; zero where there is no claim                                                                                                        |
| `recipient`          | Whom collecting pays: a close's account or a withdrawal's `recipient`, until `claimTo` names another; the contract itself is the beneficiary's current channel, which takes the payment as deposits |
| `protectedRemaining` | The principal still to pay, which `protectedPrincipal` counts                                                                                                                                       |
| `winningsRemaining`  | The winnings still to pay, which `unpaidWinnings` counts                                                                                                                                            |
| `queueEnd`           | Where the claim's winnings end in the [winnings queue](#the-winnings-queue): `queuedWinnings` once they joined it                                                                                   |

A close's claim is under its channel's ID, recorded at [finalization](#finalization); a withdrawal's is under its ID,
the hash of its operation, recorded by `withdraw` ([withdrawals](#withdrawals)). A withdrawal paid in full at once keeps
only its `beneficiary`, which records it once. A close's amount and what is paid of it are the channel's
`closingBalance` and `closingBalance − protectedRemaining − winningsRemaining`.

## Views

| Function                       | Returns                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domainSeparator()`            | The EIP-712 domain separator of this deployment on this chain                                                                                                                                     |
| `hashState(Checkpoint)`        | A checkpoint's digest, its state hash                                                                                                                                                             |
| `hashOperation(Operation)`     | An operation's digest                                                                                                                                                                             |
| `channelOf(address player)`    | The account's current channel, `keccak256(abi.encode(player, channelIndex(player)))`, which is never closing                                                                                      |
| `withdrawableHouse()`          | `max(0, balance − protectedPrincipal − unpaidWinnings)`: what no deposit and no unpaid winning is owed, which `withdrawHouse` can pay, and `withdraw` pays at once beyond a channel's `principal` |
| `supported(Evidence evidence)` | The checkpoint `evidence` proves                                                                                                                                                                  |
| `collectable(bytes32 id)`      | What `claim` pays now: the claim's remaining principal, and as much of its winnings as house cash reaches in the [winnings queue](#the-winnings-queue)                                            |

### `supported`

Returns the checkpoint that `evidence` proves: with the [empty step](signed-messages.md#evidence), its `base`, and
otherwise the checkpoint its step produces from `base`. A casino bet takes `amount` from the balance and adds `prize`
when the step's [outcome](signed-messages.md#the-outcome) is below `chance`; a debit takes `amount`, a withdrawal takes
it and adds it to `withdrawn`, a credit adds it, and a deposit adds it to both `balance` and `deposited`.
Whether the channel holds what a checkpoint has `deposited` is for a close to check. The channel's zero checkpoint,
`(channelId, 0, 0x0, 0x0, 0, 0, 0)`, is its [base](signed-messages.md#the-base) and needs no signature. It reverts:

- `InvalidState` when the channel was never opened.
- `Unauthorized` when `base` is not the channel's zero checkpoint and is not signed by both the account
  (`playerSignature`) and the owner (`casinoSignature`).
- `InvalidTerms` when the step's kind is 0 and the step is not the empty step.
- `InvalidState` when the operation does not follow `base`: another `channelId`, a `previousStateHash` that is not
  `hashState(base)`, or a `sequence` that is not the base's plus one.
- `Unauthorized` when `authorization` is not the account's signature of the operation. A signature that is not 65
  bytes, has a high `s` or a `v` other than 27 or 28 is refused the same way.
- `InvalidTerms` when the operation breaks [the transition rules](signed-messages.md#transitions): `amount` 0 or at
  least 2^128; a withdrawal whose `recipient` is zero or the contract, or another kind with a nonzero `recipient`; a
  casino bet with a `chance` of 0, a `prize` of 0 or at least 2^128, a zero `round` or `seedHash`, or a secret or seed
  that does not hash to them; any other kind with a nonzero `chance`, `prize`, `round`, `seedHash`, seed or secret; a
  casino bet, debit or withdrawal above the balance; a kind other than 1 to 5. A `chance` is a `uint64`, so its type
  keeps it below 2^64.
- `InvalidState` when `casinoSignature` is not the owner's signature of the next checkpoint (`Unauthorized` when it is
  malformed).
- `InvalidState` when the result's `balance` or `withdrawn` is at least 2^128.

## Functions that change state

| Function                                                   | Caller                   | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Reverts                                                                                                                                                                                                                                 | Events                                                      |
| ---------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `deposit(address player) payable`                          | Anyone                   | Adds the value to the `deposited` and `principal` of the account's current channel, `channelOf(player)`, and to `protectedPrincipal`; an unopened channel opens, with `player` as its account                                                                                                                                                                                                                                                                                                                      | `InvalidTerms`: `player` is zero or the contract, the value is 0, or the channel's `deposited` would reach 2^128                                                                                                                        | `ChannelOpened` when it opens the channel, `ChannelDeposit` |
| `fundBankroll() payable`                                   | Anyone                   | Adds the value to house cash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `InvalidTerms`: the value is 0                                                                                                                                                                                                          | `BankrollFunded`                                            |
| `withdrawHouse(address payable recipient, uint256 amount)` | The owner                | Sends `amount` of the house's money to `recipient` with all the gas left                                                                                                                                                                                                                                                                                                                                                                                                                                           | `Unauthorized`: not the owner. `InvalidTerms`: `recipient` is zero or the contract, or `amount` is 0. `InsufficientBalance`: `amount` exceeds `withdrawableHouse()`. `TransferFailed`: `recipient` refused the payment; nothing changes | `HouseWithdrawal`                                           |
| `withdraw(Evidence evidence)`                              | Anyone                   | [Records](#withdrawals) the withdrawal that is the step of `evidence` as a claim under its ID, once, and adds its amount to the channel's `claimed`; during a close it lowers `closingBalance` by as much, to no less than 0. It pays the recipient at once what the channel's `principal` and house cash cover, in one call with 100,000 gas, or into the account's current channel as deposits when the recipient is the contract; the claim keeps the rest, or all of it when the recipient refuses the payment | `InvalidTerms`: the step is not a withdrawal. `supported`'s. `InvalidState`: the channel is finalized, or the withdrawal was recorded                                                                                                   | `Withdrawal`; `ClaimPayment` when it pays                   |
| `startClose(Evidence evidence)`                            | The account or the owner | Proposes the checkpoint `supported(evidence)` returns: status closing, `deadline` the block's time plus 24 hours, `closingBalance` what the checkpoint is [owed](#finalization); `channelIndex(player)` rises by one, so the account's next deposit opens its next channel                                                                                                                                                                                                                                         | `supported`'s. `Unauthorized`: the channel is not open, or the caller is neither. `InvalidState`: the deadline does not fit 64 bits, or the checkpoint's `deposited` exceeds the channel's `deposited`                                  | `CloseStarted`                                              |
| `challengeClose(Evidence evidence)`                        | Anyone                   | Swaps the proposed checkpoint, and what it is owed, for one with a higher sequence; the deadline does not move                                                                                                                                                                                                                                                                                                                                                                                                     | `supported`'s. `InvalidState`: the channel is not closing, the deadline has passed, the sequence is not above `closingSequence`, or the checkpoint's `deposited` exceeds the channel's `deposited`                                      | `CloseChallenged`                                           |
| `finalizeClose(bytes32 channelId)`                         | Anyone                   | [Finalizes](#finalization) on the proposed checkpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `InvalidState`: the channel is not closing, or the deadline has not come                                                                                                                                                                | `CloseFinalized`                                            |
| `claim(bytes32 id)`                                        | Anyone                   | Pays `collectable(id)`, the claim's remaining principal and whatever of its winnings house cash reaches, to its recipient in one call with 100,000 gas, or into the beneficiary's current channel as deposits when the recipient is the contract                                                                                                                                                                                                                                                                   | `InvalidState`: there is no claim under `id`. `TransferFailed`: the recipient refused the payment; nothing changes                                                                                                                      | `ClaimPayment` when it pays                                 |
| `claimTo(bytes32 id, address recipient)`                   | The beneficiary          | Sets the claim's recipient, then pays as `claim`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `Unauthorized`: there is no claim under `id`, or the caller is not its beneficiary. `InvalidTerms`: `recipient` is zero. `TransferFailed`                                                                                               | `ClaimRecipientChanged`, then as `claim`                    |

An account's current channel is `channelOf(player)`: its first, then, each time a close starts, the next, so it is never
closing. Anyone may deposit into it, and the first deposit opens it; whoever funded it, the account alone signs for it.
The balance takes a deposit in with a deposit operation the casino signs, and until then a close adds it to what the
channel is owed. A channel stays open through every withdrawal: only a close ends it, and the account's next deposit
opens its next channel while it closes.

The challenge window is fixed. While a channel is closing, a challenge is possible until the deadline, and from the
deadline on only `finalizeClose` is. A challenge never extends the window.

### Withdrawals

A withdrawal (kind 5) is an operation the account signs that takes `amount` from the balance and names a `recipient`
([transitions](signed-messages.md#transitions)). The balance pays it at once, in the checkpoint the casino signs after
it. `withdraw` records it on-chain on evidence whose step is that operation, with the casino's signature of that
checkpoint, and anyone may send it:

- It makes each withdrawal a claim once, under the hash of its operation: `claims` holds it, and `Withdrawal` says from
  which channel, to whom and how much.
- It records until the channel is finalized, whatever checkpoint a close proposes. It adds the amount to the channel's
  `claimed`, and during a close takes it off `closingBalance`, to no less than 0.
- The claim's principal is `min(amount, principal)`, out of the channel's `principal`; the rest is winnings, which join
  the [winnings queue](#the-winnings-queue) behind every earlier claim.
- It pays the recipient at once what is covered, the principal and whatever of the winnings house cash reaches, in one
  call with 100,000 gas. What is not covered stays owed, for anyone to collect with `claim`. A recipient that refuses
  the payment leaves all of it owed: recording never depends on the recipient, so nobody sends a withdrawal twice.
- A withdrawal to the contract itself locks the balance in: what it pays goes into the account's current channel as
  deposits, adding to its `deposited` and `principal`, and no ETH leaves the contract. The balance takes it in like any
  deposit.

Taking the channel's `principal` first leaves what is at risk unchanged: what a balance holds above it is owed from
house cash before and after. The account, the claim's beneficiary, can redirect it with `claimTo`. A withdrawal never
recorded comes back with the close, to the account and not its recipient: a checkpoint counts what its balance has
`withdrawn`, and a close is owed what of it did not become a claim ([finalization](#finalization)).

### Finalization

A checkpoint `s` is owed its balance, the deposits it has not taken in and what it withdrew that is not yet a claim,
less what the channel's claims took that it did not withdraw:
`owed = max(0, s.balance + deposited − s.deposited + s.withdrawn − claimed)`, with the channel's `deposited` and
`claimed`, so a close on a checkpoint older than a recorded withdrawal is owed that much less. A checkpoint that has
taken in more than the channel's `deposited` is refused: `startClose` and `challengeClose` revert on it with
`InvalidState`. A close records what its checkpoint is owed as `closingBalance`.

`finalizeClose` finalizes the channel. Its principal is `min(owed, principal)`, with the channel's `principal`, and its
winnings `owed − principal`: `protectedPrincipal` falls by the channel's `principal` less the claim's, which returns to
house cash, and `unpaidWinnings` rises by the winnings. The claim, under the channel's ID, records the account as its
beneficiary and recipient, and the principal and winnings still to pay; the channel keeps the checkpoint and what it is
owed. The winnings join the end of the [winnings queue](#the-winnings-queue). Finalization moves no ETH: collecting is a
separate call.

## The winnings queue

A claim's principal is deposits the contract held for its channel, so `claim` pays it at once. Its winnings are owed
from house cash, in one queue in the order the claims were recorded, a withdrawal's by `withdraw` and a close's at
finalization: `queuedWinnings` is the queue so far, and each claim's winnings are one stretch of it. House cash, the
contract's ETH less `protectedPrincipal`, covers the queue from the front: every unpaid winning but those at its end
that it falls short of, `max(0, unpaidWinnings − house cash)`. A claim collects what of its winnings is covered in one
call, however far back it waits (`collectable`), and collecting leaves the cash covering every other claim as it was, so
a recipient that refuses payment keeps its share without holding up the claims behind it. `withdrawHouse` pays only what
exceeds protected principal and every unpaid winning, and a withdrawal's winnings join the end of the queue, so no
withdrawal, the owner's or a player's, takes cash a claim is owed, and what the queue has covered stays covered.

## Events

The first indexed topic is `withdrawalId` in `Withdrawal`, `claimId` in `ClaimPayment` and `ClaimRecipientChanged`, and
`channelId` in every other event that has one.

| Event                                                                                                                                                  | Emitted by                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChannelOpened(bytes32 indexed channelId, address indexed player)`                                                                                     | `deposit`, when it opens the channel                                                                                                               |
| `ChannelDeposit(bytes32 indexed channelId, uint256 amount, uint256 deposited)`                                                                         | `deposit`, and a claim paid into a channel; `deposited` is the channel's `deposited` afterwards                                                    |
| `Withdrawal(bytes32 indexed withdrawalId, bytes32 indexed channelId, address indexed recipient, uint256 amount)`                                       | `withdraw`, when it records a withdrawal; `withdrawalId` is the hash of its operation, its claim's ID, and `channelId` the channel it is from      |
| `CloseStarted(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash, uint256 deadline)`                                                       | `startClose`                                                                                                                                       |
| `CloseChallenged(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash)`                                                                      | `challengeClose`                                                                                                                                   |
| `CloseFinalized(bytes32 indexed channelId, address indexed beneficiary, bytes32 stateHash, uint256 amount, uint256 protectedAmount, uint256 winnings)` | `finalizeClose`; `beneficiary` is the account, the claim's                                                                                         |
| `ClaimPayment(bytes32 indexed claimId, address indexed recipient, uint256 amount)`                                                                     | Every payment of a claim: `withdraw` at once, and `claim` and `claimTo` when they pay; `recipient` is the address paid, the contract for a channel |
| `BankrollFunded(address indexed funder, uint256 amount)`                                                                                               | `fundBankroll`                                                                                                                                     |
| `HouseWithdrawal(address indexed recipient, uint256 amount)`                                                                                           | `withdrawHouse`                                                                                                                                    |
| `ClaimRecipientChanged(bytes32 indexed claimId, address indexed recipient)`                                                                            | `claimTo`                                                                                                                                          |

## Custom errors

| Error                   | Raised when                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `Unauthorized()`        | The caller or a signature lacks the authority the call needs              |
| `InvalidTerms()`        | An argument or a signed field breaks the rules                            |
| `InvalidState()`        | The channel, its evidence, a claim or the time is not what the call needs |
| `InsufficientBalance()` | `withdrawableHouse()` is short of a house withdrawal                      |
| `TransferFailed()`      | A recipient refused a house withdrawal or a collection                    |
| `Reentrancy()`          | A guarded function was entered again during a call                        |

## The two keys of a channel

| Key                   | Is                                                                                                 | Signs                                                                                                       | Calls                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The account, `player` | The player's account, whose address the wallet shows as the deposit address and whose key it holds | Every operation; its countersignature of every checkpoint; API `Access` tokens; `Redeem` and `BankWithdraw` | `startClose`, and `claimTo` as its claims' beneficiary; a close's claim pays it unless `claimTo` names another |
| The owner             | The casino                                                                                         | Every checkpoint it produces                                                                                | `startClose`, `withdrawHouse`                                                                                  |

Every signature the contract checks is recovered with `ecrecover`, so it must come from an externally owned account: a
contract account can deposit, but cannot sign for a channel of its own. `deposit`, `withdraw`, `challengeClose`,
`finalizeClose`, `claim` and `fundBankroll` are open to anyone, which lets a watchtower or any
relayer pay out, defend and collect for a player.
