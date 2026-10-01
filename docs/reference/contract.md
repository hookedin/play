---
title: The contract
description: HookedInCasino function by function, with its constants, readable storage, callers, effects, reverts, events and custom errors.
sidebar:
  order: 3
---

[HookedInCasino](../../contracts/HookedInCasino.sol) holds every ETH deposit and the house's bankroll, and settles a
channel and pays its withdrawals on the evidence its account and the casino signed. It settles money and reads nothing
else: what an operation means is its `memo`, which the contract never reads. The structures and hashes it checks are on
[Signed messages](signed-messages.md); how a player closes and collects is in
[Closing and claims](../wallet/closing-and-claims.md).

## Build

The wallet accepts only the runtime pinned in [client/contract-artifact.ts](../../client/contract-artifact.ts), with the
immutable `owner` filled in; [verify a release](deployment.md#verify-a-release) compiles it again.

The constructor takes no arguments and makes the deploying account `owner`, which is immutable. There is no upgrade,
pause or ownership transfer. There is no `receive` or `fallback` function, so a plain ETH transfer reverts: ETH enters
through `deposit`, `fundBankroll` and `buyCollateral`, and any ETH forced in counts as house cash. It leaves through `withdraw`, `claim`,
`claimTo` and `withdrawHouse`. Every function that changes state holds a transient reentrancy guard.

## Constants

| Getter               | Type      | Value                                                                                                                      |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CHALLENGE_PERIOD()` | `uint256` | 86,400: the challenge window, in seconds                                                                                   |
| `MAX_BALANCE()`      | `uint256` | 2^96: every deposit, amount, fee, prize, balance, `deposited`, `withdrawn`, `loan` and quoted virtual bankroll is below it |
| `OUTCOME_DOMAIN()`   | `bytes32` | `keccak256("HOOKEDIN/OUTCOME")`, `0xede2fdd26760847d3c92bb2ebf4da0fdbdf441ed687b86dc1257f1962e3857ff`                      |

## Storage

| Getter                         | Returns                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner()`                      | `address`: the casino, which signs every checkpoint and alone withdraws the house's money                                                                                                                                 |
| `protectedFunds()`             | `uint256`: the `principal` and `collateral` of open and closing channels, plus the claims' `protectedRemaining`                                                                                                           |
| `unpaidWinnings()`             | `uint256`: the unpaid winnings of claims                                                                                                                                                                                  |
| `queuedWinnings()`             | `uint256`: the winnings of every claim so far, in the order the claims were recorded: the [winnings queue](#the-winnings-queue)                                                                                           |
| `collateralSales()`            | `uint256`: what every [collateral](#collateral) offer bought has paid                                                                                                                                                     |
| `channels(bytes32 channelId)`  | `(address player, uint64 deadline, uint8 status, uint256 deposited, uint256 principal, uint256 collateral, uint256 claimed, uint256 closingSequence, bytes32 closingHash, uint256 closingBalance, uint256 disputedPrize)` |
| `channelIndex(address player)` | `uint256`: how many of the account's channels have started closing, and so the index of its current one                                                                                                                   |
| `claims(bytes32 id)`           | `(address beneficiary, address recipient, uint256 protectedRemaining, uint256 winningsRemaining, uint256 queueEnd)`                                                                                                       |
| `offersBought(bytes32 offer)`  | `bool`: whether the [collateral offer](#collateral) whose hash the owner signed has been bought                                                                                                                           |

A channel's fields:

| Field                                              | Meaning                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `player`                                           | The account, which signs everything on the channel                                                                                                                                   |
| `deadline`                                         | The end of the challenge window while the channel is closing, in Unix seconds; 0 before                                                                                              |
| `status`                                           | 0 unopened, 1 open, 2 closing, 3 finalized                                                                                                                                           |
| `deposited`                                        | Everything ever deposited into the channel, from which what a checkpoint is [owed](#finalization) is worked out                                                                      |
| `principal`                                        | The deposits the contract holds for the channel: every deposit as it arrives, less what [withdrawals](#withdrawals) took of them; 0 once finalized, its claim holding them           |
| `collateral`                                       | House cash the [collateral](#collateral) bought for the channel locks into it, less what withdrawals took of it; 0 once finalized                                                    |
| `claimed`                                          | Everything the channel's [withdrawals and transfers](#withdrawals) have made into claims                                                                                             |
| `closingSequence`, `closingHash`, `closingBalance` | The checkpoint a close proposes, then the one it finalized, and what it is [owed](#finalization); a [disputed](#disputes) casino bet's is the checkpoint it leads to, counted as won |
| `disputedPrize`                                    | The prize of the casino bet the close disputes, until it is settled, and kept by a close that finalized with it won; 0 with none                                                     |

A claim's fields:

| Field                | Meaning                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beneficiary`        | The account it is owed to, a transfer's being the account it goes into; it alone may redirect the claim with `claimTo`. Zero where there is no claim                                                                               |
| `recipient`          | Whom collecting pays: a close's account, a withdrawal's `recipient` or, for a transfer, the contract, until `claimTo` names another; the contract itself is the beneficiary's current channel, which takes the payment as deposits |
| `protectedRemaining` | The protected amount still to pay, which `protectedFunds` counts                                                                                                                                                                   |
| `winningsRemaining`  | The winnings still to pay, which `unpaidWinnings` counts                                                                                                                                                                           |
| `queueEnd`           | Where the claim's winnings end in the [winnings queue](#the-winnings-queue): `queuedWinnings` once they joined it; 0 for a claim with no winnings                                                                                  |

A close's claim is under its channel's ID, recorded at [finalization](#finalization) when the close is owed something; a
withdrawal's or a transfer's is under its ID, the hash of its operation, recorded by `withdraw`
([withdrawals](#withdrawals)) for what stays owed of it: one paid in full at once leaves no claim, its channel's
`claimed` alone recording it. A close's amount and what is paid of it are the channel's `closingBalance` and
`closingBalance − protectedRemaining − winningsRemaining`.

## Views

| Function                       | Returns                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domainSeparator()`            | The EIP-712 domain separator of this deployment on this chain                                                                                                                                                                                                      |
| `hashState(Checkpoint)`        | A checkpoint's digest, its state hash                                                                                                                                                                                                                              |
| `hashOperation(Operation)`     | An operation's digest                                                                                                                                                                                                                                              |
| `channelOf(address player)`    | The account's current channel, `keccak256(abi.encode(player, channelIndex(player)))`, which is never closing                                                                                                                                                       |
| `withdrawableHouse()`          | `max(0, balance − protectedFunds − unpaidWinnings)`: what no deposit and no unpaid winning is owed, which `withdrawHouse` can pay, `buyCollateral` locks, and `withdraw` pays at once beyond what a withdrawal draws of its channel's `principal` and `collateral` |
| `supported(Evidence evidence)` | The checkpoint `evidence` proves                                                                                                                                                                                                                                   |
| `collectable(bytes32 id)`      | What `claim` pays now: the claim's `protectedRemaining`, and as much of its winnings as house cash reaches in the [winnings queue](#the-winnings-queue)                                                                                                            |

### `supported`

Returns the checkpoint that `evidence` proves: with the [empty step](signed-messages.md#evidence), its `base`, and
otherwise the checkpoint its step produces from `base`. A casino bet takes `amount` from the balance and adds `prize`
when the step's [outcome](signed-messages.md#the-outcome) is below `chance`; a debit takes `amount`; a withdrawal or a
transfer takes it, the `loan` and its `fee`, adds it to `withdrawn` and sets `loan` to 0; a credit adds it; a deposit
adds it to both `balance` and `deposited`; and a loan adds it to both `balance` and `loan`. Whether the channel holds
what a checkpoint has `deposited` is for a close to check. The channel's zero checkpoint,
`(channelId, 0, 0x0, 0x0, 0, 0, 0, 0)`, is its [base](signed-messages.md#the-base) and needs no signature. It reverts:

- `InvalidState` when the channel was never opened.
- `Unauthorized` when `base` is not the channel's zero checkpoint and is not signed by both the account
  (`playerSignature`) and the owner (`casinoSignature`).
- `InvalidTerms` when the step's kind is 0 and the step is not the empty step.
- `InvalidState` when the operation does not follow `base`: another `channelId`, a `previousStateHash` that is not
  `hashState(base)`, or a `sequence` that is not the base's plus one.
- `Unauthorized` when `authorization` is not the account's signature of the operation. A signature that is not 65
  bytes, has a high `s` or a `v` other than 27 or 28 is refused the same way.
- `InvalidTerms` when the operation breaks [the transition rules](signed-messages.md#transitions), or its kind is not
  1 to 7. A `chance` is a `uint64`, so its type keeps it below 2^64.
- `InvalidState` when `casinoSignature` is not the owner's signature of the next checkpoint (`Unauthorized` when it is
  malformed).
- `InvalidState` when the result's `balance`, `deposited`, `withdrawn` or `loan` is at least 2^96.

## Functions that change state

| Function                                                                                       | Caller                   | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Reverts                                                                                                                                                                                                                                                                                                                                                                                                                     | Events                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `deposit(address player) payable`                                                              | Anyone                   | Adds the value to the `deposited` and `principal` of the account's current channel, `channelOf(player)`, and to `protectedFunds`; an unopened channel opens, with `player` as its account                                                                                                                                                                                                                                                                                                                                                                                                                                             | `InvalidTerms`: `player` is zero or the contract, the value is 0, or the channel's `deposited` would reach 2^96                                                                                                                                                                                                                                                                                                             | `ChannelOpened` when it opens the channel, `ChannelDeposit` |
| `fundBankroll() payable`                                                                       | Anyone                   | Adds the value to house cash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `InvalidTerms`: the value is 0                                                                                                                                                                                                                                                                                                                                                                                              | `BankrollFunded`                                            |
| `buyCollateral(bytes32 channelId, uint256 amount, uint256 expiresAt, bytes signature) payable` | Anyone                   | [Buys](#collateral) the owner's offer of `amount` of collateral for the channel at the price the value pays: adds the value to house cash and `collateralSales`, and moves `amount` of house cash into the channel's `collateral` and `protectedFunds`                                                                                                                                                                                                                                                                                                                                                                                | `Unauthorized`: `signature` is not the owner's signature of the offer with the value as its price. `InvalidState`: the offer was bought, the block's time is past `expiresAt`, or the channel is neither open nor closing. `InsufficientBalance`: `amount` exceeds `withdrawableHouse()`                                                                                                                                    | `CollateralBought`                                          |
| `withdrawHouse(address payable recipient, uint256 amount)`                                     | The owner                | Sends `amount` of the house's money to `recipient` with all the gas left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `Unauthorized`: not the owner. `InvalidTerms`: `recipient` is zero, or `amount` is 0. `InsufficientBalance`: `amount` exceeds `withdrawableHouse()`. `TransferFailed`: `recipient` refused the payment, as the contract itself does; nothing changes                                                                                                                                                                        | `HouseWithdrawal`                                           |
| `withdraw(Evidence evidence)`                                                                  | Anyone                   | [Records](#withdrawals) the withdrawal or transfer that is the step of `evidence` as a claim under its ID, once, and adds its amount to the channel's `claimed`; during a close it lowers `closingBalance` by as much, to no less than 0. It pays at once what the deposits its checkpoint took in, of the channel's `principal`, its `collateral` and house cash cover: a withdrawal to its recipient in one call with 100,000 gas whose return data is not copied, a transfer as deposits into the current channel of the account it names; the claim keeps the rest, or all of a withdrawal when its recipient refuses the payment | `InvalidTerms`: the step is neither a withdrawal nor a transfer. `supported`'s. `InvalidState`: the channel is finalized, the withdrawal is not the next of its channel to record (one signed before it is not a claim yet, or this one is), or its checkpoint took in more than the channel's `deposited`                                                                                                                  | `Withdrawal`; `ClaimPayment` when it pays                   |
| `startClose(Evidence evidence)`                                                                | The account or the owner | Proposes the checkpoint `supported(evidence)` returns: status closing, `deadline` the block's time plus 24 hours, `closingBalance` what the checkpoint is [owed](#finalization); `channelIndex(player)` rises by one, so the account's next deposit opens its next channel                                                                                                                                                                                                                                                                                                                                                            | `supported`'s. `InvalidState`: the channel is not open. `Unauthorized`: the caller is neither                                                                                                                                                                                                                                                                                                                               | `CloseStarted`                                              |
| `challengeClose(Evidence evidence)`                                                            | Anyone                   | Swaps the proposed checkpoint, and what it is owed, for one with a higher sequence, or, while a casino bet is [disputed](#disputes), for one at its sequence, which settles it and releases its prize; the deadline does not move                                                                                                                                                                                                                                                                                                                                                                                                     | `supported`'s. `InvalidState`: the channel is not closing, the deadline has passed, or the sequence is not above `closingSequence`, or below it while a bet is disputed                                                                                                                                                                                                                                                     | `CloseChallenged`                                           |
| `dispute(Evidence evidence, Quote quote)`                                                      | Anyone                   | [Disputes](#disputes) the casino bet that is the step of `evidence`, which `quote` covers: proposes the checkpoint it leads to as won, and what it is [owed](#finalization), and sets `deadline` to the block's time plus 24 hours; on an open channel it starts the close, and `channelIndex(player)` rises by one                                                                                                                                                                                                                                                                                                                   | `InvalidTerms`: the step is not a casino bet, carries a secret or a casino signature, the quote has expired, its virtual bankroll is not below 2^96, or it does not admit the bet. `Unauthorized`: `quote` is not the owner's signature. `supported`'s for `base` and the operation. `InvalidState`: the channel is neither open nor closing, a close's deadline has passed, or the sequence is not above `closingSequence` | `BetDisputed`                                               |
| `finalizeClose(bytes32 channelId)`                                                             | Anyone                   | [Finalizes](#finalization) on the proposed checkpoint; a casino bet still disputed stays won, its prize joins the claim, and `disputedPrize` keeps it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `InvalidState`: the channel is not closing, or the deadline has not come                                                                                                                                                                                                                                                                                                                                                    | `CloseFinalized`                                            |
| `claim(bytes32 id)`                                                                            | Anyone                   | Pays `collectable(id)`, the claim's `protectedRemaining` and whatever of its winnings house cash reaches, to its recipient in one call with 100,000 gas, or into the beneficiary's current channel as deposits when the recipient is the contract                                                                                                                                                                                                                                                                                                                                                                                     | `InvalidState`: there is no claim under `id`. `TransferFailed`: the recipient refused the payment; nothing changes                                                                                                                                                                                                                                                                                                          | `ClaimPayment` when it pays                                 |
| `claimTo(bytes32 id, address recipient)`                                                       | The beneficiary          | Sets the claim's recipient, then pays as `claim`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `Unauthorized`: there is no claim under `id`, or the caller is not its beneficiary. `InvalidTerms`: `recipient` is zero. `TransferFailed`                                                                                                                                                                                                                                                                                   | `ClaimRecipientChanged`, then as `claim`                    |

While a channel is closing, a challenge is possible until the deadline, and from the deadline on only `finalizeClose`
is. A challenge never extends the window; a dispute sets it to 24 hours from the dispute, which is the time the casino
has to settle the disputed bet. A dispute only ever enters at a higher sequence, and only until its quote's `expiresAt`,
which the contract takes as the casino signed it: a day after signing, by the casino's rule. The window moves only that
far.

Every signature the contract checks is recovered with `ecrecover`, so it must come from an externally owned account: a
contract account can deposit, but cannot sign for a channel of its own. `deposit`, `withdraw`, `challengeClose`,
`dispute`, `finalizeClose`, `claim` and `fundBankroll` are open to anyone, which lets a watchtower or any relayer pay
out, defend, dispute and collect for a player.

### Disputes

The casino signs a [quote](signed-messages.md#quotes) for every channel's next casino bet, and must settle every bet
its quote covers. `dispute` takes one it has not settled: evidence whose `base` is the checkpoint the bet follows and
whose step is the bet with its `authorization` and `seed`, no `secret` and an empty `casinoSignature`, and the quote's
`virtualBankroll`, `expiresAt` and `signature`, as `Quote`; the operation names the quote's channel, checkpoint and
round. The contract checks that the owner signed the quote, that the block's time is not past `expiresAt`, and that the
virtual bankroll admits the bet by the casino's Kelly rule with no commission
([economics](economics.md#a-casino-bet-is-one-wager)). Anyone can send it with the account's evidence: the account, its
[watchtower](../wallet/keys-and-recovery.md#the-watchtower) or any relayer. On an open channel it starts the close, as
`startClose` does; on a closing one it challenges the close.

The disputed bet counts as won: the close proposes the checkpoint it leads to with its prize paid, owed
[as any](#finalization). The casino settles it with `challengeClose` and evidence at its sequence: its signed result of
the bet, on the round's secret, or of the operation the account signed there instead. Newer evidence settles it too. A
bet still disputed at the deadline finalizes as won, and its winnings join the [winnings queue](#the-winnings-queue)
then, as any close's do. Until then the prize is owed no more than any winning not yet recorded: house cash stays the
owner's.

### Withdrawals

A withdrawal (kind 5) is an operation the account signs that takes `amount` from the balance and names a `recipient`;
the balance pays it at once, in the checkpoint the casino signs after it, with its `loan` back and its `fee`, what it
pays the casino for sending it to the contract: the fee leaves the balance, nothing pays it out, and so it stays house
cash. A transfer (kind 6) is a withdrawal whose `recipient` is an account, and differs only in where it pays, below.
`withdraw` records one on evidence whose step is that operation, with the casino's signature of that checkpoint, and
anyone may send it:

- It makes each withdrawal a claim once, under the hash of its operation, until the channel is finalized, whatever
  checkpoint a close proposes: `claims` holds what stays owed of it, and `Withdrawal` says from which channel, to whom
  and how much.
- It records a channel's withdrawals in the order the account signed them: one only once the channel's `claimed` equals
  the `withdrawn` of the checkpoint it follows. The order decides what each takes of the channel's `principal`, so no
  sender can make a later withdrawal, a lock-in above all, take what an earlier one was due.
- It pays out only deposits the chain holds: a checkpoint that took in more than the channel's `deposited` records no
  withdrawal.
- It adds the amount to the channel's `claimed`, and during a close takes it off `closingBalance`, to no less than 0.
- The claim's protected amount is first `min(amount, principal − (deposited − s.deposited))`, with the channel's `principal`
  and `deposited` and the checkpoint `s` after it: out of the channel's `principal`, but only the deposits its
  checkpoint took in, so a deposit that arrives before it is recorded stays the channel's. The channel's `collateral`
  pays what of the amount they do not, as far as it goes. It leaves what is at risk unchanged; the rest is winnings,
  which join the [winnings queue](#the-winnings-queue) behind every earlier claim. The account, the claim's beneficiary,
  can redirect it with `claimTo`.
- It pays the recipient at once what is covered, in one call with 100,000 gas; what is not stays owed, for anyone to
  collect with `claim`. A recipient that refuses the payment leaves all of it owed: recording never depends on the
  recipient, so nobody sends a withdrawal twice.
- A transfer pays into the current channel of the account it names instead, as deposits, adding to its `deposited` and
  `principal`, and no ETH leaves the contract. What stays owed is a claim whose beneficiary is that account and whose
  recipient is the contract. A transfer to the account itself locks the balance in.

A withdrawal never recorded comes back with the close, to the account and not its recipient: a checkpoint counts what
its balance has `withdrawn`, and a close is owed what of it did not become a claim ([finalization](#finalization)).

### Finalization

A checkpoint `s` is owed its balance, the deposits it has not taken in and what it withdrew that is not yet a claim,
less its loan, what the channel's claims took that it did not withdraw and what it took in that the chain does not
hold: `owed = max(0, s.balance + deposited − s.deposited + s.withdrawn − claimed − s.loan)`, with the channel's
`deposited` and `claimed`. So a close repays the loan first, and what it cannot repay is forgiven; a close on a
checkpoint older than a recorded withdrawal is owed that much less, and so is one that took in more than the channel's
`deposited`: every signed checkpoint can close. A close records what its checkpoint is owed as `closingBalance`.

`finalizeClose` finalizes the channel. Its claim's protected amount is `min(owed, principal + collateral)`, with the
channel's `principal` and `collateral`, the deposits paying first, and its winnings the rest of `owed`:
`protectedFunds` falls by the channel's `principal` and `collateral` less the protected amount, which returns to house
cash, and `unpaidWinnings` rises by the winnings. The claim, under the channel's ID, records the account as its
beneficiary and recipient, and the protected amount and winnings still to pay; a close owed nothing records none. The channel
keeps the checkpoint and what it is owed. The winnings join the end of the [winnings queue](#the-winnings-queue).
Finalization moves no ETH: collecting is a separate call.

### Collateral

The owner signs [offers](signed-messages.md#collateral-offers) of collateral for a channel, and anyone buys one with
`buyCollateral`, once and before its `expiresAt`, paying its price as the value: any other value is an offer the owner
did not sign. The price joins house cash and `collateralSales`, and `amount` of house cash moves into the channel's
`collateral`, which `protectedFunds` counts, so the owner can no longer withdraw it. It adds nothing to what the
channel is [owed](#finalization). A [withdrawal](#withdrawals) draws on it after the deposits its checkpoint took in, a
lock-in so making it the account's deposits, and a close is paid out of it what the deposits do not cover; what the
close is not owed returns to house cash. So withdrawals use collateral up, and it lasts no longer than the channel,
which the owner can start closing at any time. An offer at no price is collateral the owner gives. An offer locks only house
cash nothing else is owed, `withdrawableHouse()`, so it takes nothing a claim counts on, and one that house cash no
longer covers reverts and costs its buyer nothing but the fee.

## The winnings queue

A claim's protected amount is deposits and collateral the contract held for its channel, so `claim` pays it at once. Its winnings are owed
from house cash, in one queue in the order the claims were recorded, a withdrawal's by `withdraw` and a close's at
finalization: `queuedWinnings` is the queue so far, and each claim's winnings are one stretch of it. House cash, the
contract's ETH less `protectedFunds`, covers the queue from the front: every unpaid winning but those at its end
that it falls short of, `max(0, unpaidWinnings − house cash)`. A claim collects what of its winnings is covered in one
call, however far back it waits (`collectable`), and collecting leaves the cash covering every other claim as it was, so
a recipient that refuses payment keeps its share without holding up the claims behind it. `withdrawHouse` pays only what
exceeds `protectedFunds` and every unpaid winning, and a withdrawal's winnings join the end of the queue, so no
withdrawal, the owner's or a player's, takes cash a claim is owed, and what the queue has covered stays covered.

## Events

The first indexed topic is `withdrawalId` in `Withdrawal`, `claimId` in `ClaimPayment` and `ClaimRecipientChanged`, and
`channelId` in every other event that has one.

| Event                                                                                                                                                  | Emitted by                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChannelOpened(bytes32 indexed channelId, address indexed player)`                                                                                     | `deposit`, when it opens the channel                                                                                                                                                     |
| `ChannelDeposit(bytes32 indexed channelId, uint256 amount, uint256 deposited)`                                                                         | `deposit`, and a claim paid into a channel; `deposited` is the channel's `deposited` afterwards                                                                                          |
| `CollateralBought(bytes32 indexed channelId, bytes32 indexed offer, uint256 amount, uint256 price)`                                                    | `buyCollateral`; `offer` is the hash the owner signed                                                                                                                                    |
| `Withdrawal(bytes32 indexed withdrawalId, bytes32 indexed channelId, address indexed recipient, uint256 amount)`                                       | `withdraw`, when it records a withdrawal or a transfer; `withdrawalId` is the hash of its operation, its claim's ID, `channelId` the channel it is from, and `recipient` the operation's |
| `CloseStarted(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash, uint256 deadline)`                                                       | `startClose`                                                                                                                                                                             |
| `CloseChallenged(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash)`                                                                      | `challengeClose`                                                                                                                                                                         |
| `BetDisputed(bytes32 indexed channelId, Evidence evidence)`                                                                                            | `dispute`; `evidence` is what it brought, all the casino needs to settle the bet                                                                                                         |
| `CloseFinalized(bytes32 indexed channelId, address indexed beneficiary, bytes32 stateHash, uint256 amount, uint256 protectedAmount, uint256 winnings)` | `finalizeClose`; `beneficiary` is the account, the claim's                                                                                                                               |
| `ClaimPayment(bytes32 indexed claimId, address indexed recipient, uint256 amount)`                                                                     | Every payment of a claim: `withdraw` at once, and `claim` and `claimTo` when they pay; `recipient` is the address paid, the contract for a channel                                       |
| `BankrollFunded(address indexed funder, uint256 amount)`                                                                                               | `fundBankroll`                                                                                                                                                                           |
| `HouseWithdrawal(address indexed recipient, uint256 amount)`                                                                                           | `withdrawHouse`                                                                                                                                                                          |
| `ClaimRecipientChanged(bytes32 indexed claimId, address indexed recipient)`                                                                            | `claimTo`                                                                                                                                                                                |

## Custom errors

| Error                   | Raised when                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `Unauthorized()`        | The caller or a signature lacks the authority the call needs              |
| `InvalidTerms()`        | An argument or a signed field breaks the rules                            |
| `InvalidState()`        | The channel, its evidence, a claim or the time is not what the call needs |
| `InsufficientBalance()` | `withdrawableHouse()` is short of a house withdrawal or of collateral     |
| `TransferFailed()`      | A recipient refused a house withdrawal or a collection                    |
| `Reentrancy()`          | A guarded function was entered again during a call                        |
