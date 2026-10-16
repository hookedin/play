---
title: The contract
description: HookedInCasino function by function, with its constants, readable storage, callers, effects, reverts, events and custom errors.
sidebar:
  order: 3
---

[HookedInCasino](../../contracts/HookedInCasino.sol) holds every ETH deposit and the house's bankroll, and settles a
channel and pays its withdrawals on the evidence its account and the casino signed. It settles money alone: what an
operation means is its `memo`, which the contract never reads. The structures and hashes it checks are on [Signed
messages](signed-messages.md); how a player closes and collects is in [Closing and
claims](../wallet/closing-and-claims.md).

## Build

The wallet accepts only the runtime pinned in [protocol/contract-artifact.ts](../../protocol/contract-artifact.ts), with
the immutables `signer` and `treasury` filled in; [verify a release](deployment.md#verify-a-release) compiles it again.

The constructor, `constructor(address signer_, address treasury_, uint256 payoutLimit_)`, which anyone can deploy, sets
the [payout limit](#the-payout-limit) and two immutable keys: `signer`, the casino's, on its server, and `treasury`,
kept off it. It reverts `InvalidTerms` when either key is zero, when they are the same address, or when the limit is not
below 2^96. There is no upgrade, pause or change of either key. There is no `receive` or `fallback` function, so a plain
ETH transfer reverts: ETH enters through `deposit`, `fundBankroll` and `buyCollateral`, and any ETH forced in counts as
house cash; it leaves through `withdraw`, `claim`, `claimTo` and `withdrawHouse`. Every function that changes state but
`setPayoutLimit`, which calls nothing, holds a transient reentrancy guard.

## Constants

| Getter               | Type      | Value                                                                                                              |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `CHALLENGE_PERIOD()` | `uint256` | 604,800 seconds: the challenge window, and the time the casino has to settle a [disputed](#disputes) casino bet    |
| `MAX_BALANCE()`      | `uint256` | 2^96: every deposit, amount, fee, prize, balance, `deposited`, `withdrawn` and quoted virtual bankroll is below it |
| `OUTCOME_DOMAIN()`   | `bytes32` | `keccak256("HOOKEDIN/OUTCOME")`, `0xede2fdd26760847d3c92bb2ebf4da0fdbdf441ed687b86dc1257f1962e3857ff`              |

## Storage

| Getter                                    | Returns                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signer()`                                | `address`: the casino's key, which signs every checkpoint, quote and collateral offer                                                                                                                                          |
| `treasury()`                              | `address`: the key that alone withdraws house cash and sets the payout limit                                                                                                                                                   |
| `payoutLimit()`                           | `uint256`: the most house cash that becomes players' money in a day ([the payout limit](#the-payout-limit))                                                                                                                    |
| `protectedFunds()`                        | `uint256`: the `principal` and `collateral` of active and closing channels, plus the claims' `protectedRemaining`                                                                                                              |
| `unpaidWinnings()`                        | `uint256`: the unpaid winnings of claims                                                                                                                                                                                       |
| `queuedWinnings()`                        | `uint256`: the winnings of every claim so far, in the order the claims were recorded: the [winnings queue](#the-winnings-queue)                                                                                                |
| `collateralSales()`                       | `uint256`: what every [collateral](#collateral) offer bought has paid                                                                                                                                                          |
| `channels(address player, uint256 index)` | `(uint64 deadline, uint8 status, uint256 deposited, uint256 principal, uint256 collateral, uint256 claimed, uint256 closingSequence, bytes32 closingHash, uint256 closingBalance, uint256 disputedPrize, uint256 disputeHold)` |
| `channelIndex(address player)`            | `uint256`: how many of the account's channels have started closing, and so the index of its current one                                                                                                                        |
| `claims(bytes32 id)`                      | `(address beneficiary, address recipient, uint256 protectedRemaining, uint256 winningsRemaining, uint256 queueEnd)`                                                                                                            |
| `offersBought(bytes32 offer)`             | `bool`: whether the [collateral offer](#collateral) whose hash the signer signed has been bought                                                                                                                               |

A [channel](../overview/how-it-works.md#channels) is an account's and its index. Its fields are all 0 until money or a
close comes to it:

| Field                                              | Meaning                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deadline`                                         | The end of the challenge window while the channel is closing, in Unix seconds; 0 before                                                                                              |
| `status`                                           | 0 active, 1 closing, 2 finalized                                                                                                                                                     |
| `deposited`                                        | Everything ever deposited into the channel, from which what a checkpoint is [owed](#finalization) is worked out                                                                      |
| `principal`                                        | The deposits the contract holds for the channel: every deposit as it arrives, less what [withdrawals](#withdrawals) took of them; 0 once finalized, its claim holding them           |
| `collateral`                                       | House cash the [collateral](#collateral) bought for the channel and its [disputes](#disputes) lock into it, less what withdrawals took of it; 0 once finalized                       |
| `claimed`                                          | Everything the channel's [withdrawals and lock-ins](#withdrawals) have made into claims                                                                                              |
| `closingSequence`, `closingHash`, `closingBalance` | The checkpoint a close proposes, then the one it finalized, and what it is [owed](#finalization); a [disputed](#disputes) casino bet's is the checkpoint it leads to, counted as won |
| `disputedPrize`                                    | The prize of the casino bet the close disputes, until it is settled, and kept by a close that finalized with it won; 0 with none                                                     |
| `disputeHold`                                      | The part of `collateral` the close's [dispute](#disputes) locked, until a challenge settles the bet; 0 with none                                                                     |

A claim's fields:

| Field                | Meaning                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beneficiary`        | The account it is owed to; it alone may redirect the claim with `claimTo`. Zero where there is no claim                                                                                                                           |
| `recipient`          | Whom collecting pays: a close's account, a withdrawal's `recipient` or, for a lock-in, the contract, until `claimTo` names another; the contract itself is the beneficiary's current channel, which takes the payment as deposits |
| `protectedRemaining` | The protected amount still to pay, which `protectedFunds` counts                                                                                                                                                                  |
| `winningsRemaining`  | The winnings still to pay, which `unpaidWinnings` counts                                                                                                                                                                          |
| `queueEnd`           | Where the claim's winnings end in the [winnings queue](#the-winnings-queue): `queuedWinnings` once they joined it; 0 for a claim with no winnings                                                                                 |

A close's claim is under its channel's ID, `channelId(player, index)`, recorded at [finalization](#finalization) when
the close is owed something; a withdrawal's or a lock-in's is under its ID, the hash of its operation, recorded by
[`withdraw`](#withdrawals) for what stays owed of it: one paid in full at once leaves no claim, its channel's `claimed`
alone recording it. A close's amount and what is paid of it are the channel's `closingBalance` and
`closingBalance − protectedRemaining − winningsRemaining`.

## Views

| Function                                   | Returns                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domainSeparator()`                        | The EIP-712 domain separator of this deployment on this chain                                                                                                                                                                                                                   |
| `hashState(Checkpoint)`                    | A checkpoint's digest, its state hash                                                                                                                                                                                                                                           |
| `hashOperation(Operation)`                 | An operation's digest                                                                                                                                                                                                                                                           |
| `channelId(address player, uint256 index)` | `keccak256(abi.encode(player, index))`: the ID of the channel's close in `claims`, and how anything off-chain keys the channel                                                                                                                                                  |
| `withdrawableHouse()`                      | `max(0, balance − protectedFunds − unpaidWinnings)`: what no deposit and no unpaid winning is owed, which `withdrawHouse` can pay, `buyCollateral` and `dispute` lock, and `withdraw` pays at once beyond what a withdrawal draws of its channel's `principal` and `collateral` |
| `supported(Evidence evidence)`             | The checkpoint `evidence` proves                                                                                                                                                                                                                                                |
| `collectable(bytes32 id)`                  | What `claim` pays now: the claim's `protectedRemaining`, and as much of its winnings as house cash reaches in the [winnings queue](#the-winnings-queue) and the [payout limit](#the-payout-limit) allows                                                                        |
| `payoutAllowance()`                        | What the [payout limit](#the-payout-limit) allows now                                                                                                                                                                                                                           |

### `supported`

Returns the checkpoint that `evidence` proves: with the [empty step](signed-messages.md#evidence), its `base`, and
otherwise the checkpoint its step produces from `base` by [the transitions](signed-messages.md#transitions), a casino
bet paying its `prize` when the step's [outcome](signed-messages.md#the-outcome) is below `chance`. Whether the channel
holds what a checkpoint has `deposited` is for a close to check. A channel's zero checkpoint,
`(player, index, 0, 0x0, 0x0, 0, 0, 0)`, is its [base](signed-messages.md#the-base) and carries no signature. It
reverts:

- `InvalidTerms` when `base` names the zero address as its account.
- `Unauthorized` when `base` is not its channel's zero checkpoint and is not signed by both the account it names
  (`playerSignature`) and the signer (`casinoSignature`).
- `InvalidTerms` when `base` is the channel's zero checkpoint and either signature is not empty.
- `InvalidTerms` when the step's kind is 0 and the step is not the empty step.
- `InvalidState` when the operation does not follow `base`: its `previousStateHash` is not `hashState(base)`.
- `Unauthorized` when `authorization` is not the signature of the account `base` names. A signature that is not 65
  bytes, has a high `s` or a `v` other than 27 or 28 is refused the same way.
- `InvalidTerms` when the operation breaks [the transition rules](signed-messages.md#transitions), or its kind is not 1
  to 6. A `chance` is a `uint64`, so its type keeps it below 2^64.
- `InvalidState` when `casinoSignature` is not the signer's signature of the next checkpoint (`Unauthorized` when it is
  malformed).
- `InvalidState` when the result's `balance`, `deposited` or `withdrawn` is at least 2^96.

## Functions that change state

| Function                                                                                                   | Caller                    | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Reverts                                                                                                                                                                                                                                                                                                                                                                                                                                         | Events                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `deposit(address player) payable`                                                                          | Anyone                    | Adds the value to the `deposited` and `principal` of the account's current channel, the one at `channelIndex(player)`, and to `protectedFunds`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `InvalidTerms`: `player` is zero or the contract, the value is 0, or the channel's `deposited` would reach 2^96                                                                                                                                                                                                                                                                                                                                 | `ChannelDeposit`, `ChannelChanged`, `TotalsChanged`                                  |
| `fundBankroll() payable`                                                                                   | Anyone                    | Adds the value to house cash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `InvalidTerms`: the value is 0                                                                                                                                                                                                                                                                                                                                                                                                                  | `BankrollFunded`                                                                     |
| `buyCollateral(address player, uint256 index, uint256 amount, uint256 expiresAt, bytes signature) payable` | Anyone                    | [Buys](#collateral) the signer's offer of `amount` of collateral for the channel at the price the value pays: adds the value to house cash and `collateralSales`, and moves `amount` of house cash into the channel's `collateral` and `protectedFunds`, out of what the [payout limit](#the-payout-limit) allows                                                                                                                                                                                                                                                                                                                                                                        | `Unauthorized`: `signature` is not the signer's signature of the offer with the value as its price. `InvalidState`: the offer was bought, the block's time is past `expiresAt`, or the channel is neither the account's current one nor closing. `InsufficientBalance`: `amount` exceeds `withdrawableHouse()` or `payoutAllowance()`                                                                                                           | `CollateralBought`, `ChannelChanged`, `TotalsChanged`                                |
| `withdrawHouse(address payable recipient, uint256 amount)`                                                 | The treasury              | Sends `amount` of the house's money to `recipient` with all the gas left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `Unauthorized`: not the treasury. `InvalidTerms`: `recipient` is zero, or `amount` is 0. `InsufficientBalance`: `amount` exceeds `withdrawableHouse()`. `TransferFailed`: `recipient` refused the payment, as the contract itself does; nothing changes                                                                                                                                                                                         | `HouseWithdrawal`                                                                    |
| `setPayoutLimit(uint256 limit)`                                                                            | The treasury              | Sets the [payout limit](#the-payout-limit) to `limit`, keeping what is left of what it allows up to `limit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `Unauthorized`: not the treasury. `InvalidTerms`: `limit` is not below 2^96                                                                                                                                                                                                                                                                                                                                                                     | `PayoutLimitSet`                                                                     |
| `withdraw(Evidence evidence)`                                                                              | Anyone                    | [Records](#withdrawals) the withdrawal or lock-in that is the step of `evidence` as a claim under its ID, once, and adds its amount to the channel's `claimed`; during a close it lowers `closingBalance` by as much, to no less than 0. It pays at once what the deposits its checkpoint took in, of the channel's `principal`, its `collateral` and house cash cover, house cash as far as the [payout limit](#the-payout-limit) allows: a withdrawal to its recipient in one call with 100,000 gas whose return data is not copied, a lock-in as deposits into the account's current channel; the claim keeps the rest, or all of a withdrawal when its recipient refuses the payment | `InvalidTerms`: the step is neither a withdrawal nor a lock-in. `supported`'s. `InvalidState`: the channel is neither the account's current one nor closing, the withdrawal is not the next of its channel to record (one signed before it is not a claim yet, or this one is), or its checkpoint took in more than the channel's `deposited`                                                                                                   | `Withdrawal`, `ChannelChanged`, a [payment](#events)'s when it pays, `TotalsChanged` |
| `startClose(Evidence evidence)`                                                                            | The account or the signer | Proposes the checkpoint `supported(evidence)` returns: status closing, `deadline` the block's time plus 7 days, `closingBalance` what the checkpoint is [owed](#finalization); `channelIndex(player)` rises by one, so the account's next channel takes play and money from then on                                                                                                                                                                                                                                                                                                                                                                                                      | `supported`'s. `InvalidState`: the channel is not the account's current one. `Unauthorized`: the caller is neither                                                                                                                                                                                                                                                                                                                              | `CloseStarted`, `ChannelChanged`                                                     |
| `challengeClose(Evidence evidence)`                                                                        | Anyone                    | Swaps the proposed checkpoint, and what it is owed, for one with a higher sequence, or, while a casino bet is [disputed](#disputes), for one at its sequence, which settles it, releases its prize and returns its `disputeHold` to house cash, and to what the [payout limit](#the-payout-limit) allows, but for what the close is then owed above the channel's `principal` and other collateral; it never moves the deadline                                                                                                                                                                                                                                                          | `supported`'s. `InvalidState`: the channel is not closing, the deadline has come, or the sequence is not above `closingSequence`, or below it while a bet is disputed                                                                                                                                                                                                                                                                           | `CloseChallenged`, `ChannelChanged`, `TotalsChanged`                                 |
| `dispute(Evidence evidence, Quote quote)`                                                                  | Anyone                    | [Disputes](#disputes) the casino bet that is the step of `evidence`, which `quote` covers: proposes the checkpoint it leads to as won, and what it is [owed](#finalization), and sets `deadline` to the block's time plus 7 days; locks what winning the bet adds into the channel's `collateral`, as far as `withdrawableHouse()` and `payoutAllowance()` go; on the account's current channel it starts the close, and `channelIndex(player)` rises by one                                                                                                                                                                                                                             | `InvalidTerms`: the step is not a casino bet, carries a secret or a casino signature, the quote has expired, its virtual bankroll is not below 2^96, or it does not admit the bet. `Unauthorized`: `quote` is not the signer's signature. `supported`'s for `base` and the operation. `InvalidState`: the channel is neither the account's current one nor closing, a close's deadline has come, or the sequence is not above `closingSequence` | `BetDisputed`, `ChannelChanged`, `TotalsChanged`                                     |
| `finalizeClose(address player, uint256 index)`                                                             | Anyone                    | [Finalizes](#finalization) on the proposed checkpoint; a casino bet still disputed stays won, its prize joins the claim, and `disputedPrize` keeps it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `InvalidState`: the channel is not closing, or the deadline has not come                                                                                                                                                                                                                                                                                                                                                                        | `CloseFinalized`, `ChannelChanged`, `TotalsChanged`                                  |
| `claim(bytes32 id)`                                                                                        | Anyone                    | Pays `collectable(id)`, the claim's `protectedRemaining` and whatever of its winnings house cash reaches and the payout limit allows, to its recipient in one call with all the gas its caller gives, or into the beneficiary's current channel as deposits when the recipient is the contract                                                                                                                                                                                                                                                                                                                                                                                           | `InvalidState`: there is no claim under `id`. `TransferFailed`: the recipient refused the payment; nothing changes                                                                                                                                                                                                                                                                                                                              | A [payment](#events)'s when it pays, `TotalsChanged`                                 |
| `claimTo(bytes32 id, address recipient)`                                                                   | The beneficiary           | Sets the claim's recipient, then pays as `claim`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `Unauthorized`: there is no claim under `id`, or the caller is not its beneficiary. `InvalidTerms`: `recipient` is zero. `TransferFailed`                                                                                                                                                                                                                                                                                                       | `ClaimRecipientChanged`, then as `claim`                                             |

Every signature the contract checks is recovered with `ecrecover`, so it must come from an externally owned account: a
contract account can deposit, but cannot sign for a channel of its own.

### Disputes

`dispute` takes a casino bet a [quote](signed-messages.md#quotes) covers that the casino has not settled: evidence whose
`base` is the checkpoint the bet follows and whose step is the bet's [disputed step](signed-messages.md#evidence), with
its `authorization` and `seed`, no `secret` and an empty `casinoSignature`, and the quote's `virtualBankroll`,
`expiresAt` and `signature`, as `Quote`; the operation names the quote's checkpoint and round. The contract checks that
the signer signed the quote, that the block's time is not past `expiresAt`, and that the virtual bankroll admits the bet
by the casino's Kelly rule with no commission ([economics](economics.md#a-casino-bet-is-one-wager)). Anyone can send it,
the account's [watchtower](../wallet/keys-and-recovery.md#the-watchtower) or any relayer among them. On the account's
current channel it starts the close, as `startClose` does; on a closing one it challenges the close.

The contract takes `expiresAt` as the signer signed it, a day after signing by the casino's rule. So the casino, which
holds every bet the account signed, can still quote an older checkpoint and dispute the bet after it, which holds a
stale close open a week longer for every bet above it, until somebody challenges it with the latest evidence.

The disputed bet counts as won: the close proposes the checkpoint it leads to with its prize paid, [owed](#finalization)
as any. The casino settles it with `challengeClose` before the deadline, `CHALLENGE_PERIOD` after the dispute, and
evidence at its sequence: its signed result of the bet, on the round's secret, or of the operation the account signed
there instead. Newer evidence settles it too. A bet still disputed at the deadline finalizes as won.

The dispute moves what winning the bet adds into the channel's [collateral](#collateral), as its `disputeHold`: the
prize less the stake, no more than the close's `closingBalance` exceeds the channel's `principal` and `collateral`, and
no more than `withdrawableHouse()` or `payoutAllowance()`, so it never reverts for want of either; a treasury that
withdraws house cash first, or a limit spent, leaves the win to the [winnings queue](#the-winnings-queue). The challenge
that settles the bet returns the hold to house cash, and to what the payout limit allows, but for what the close is then
owed above the channel's `principal` and other collateral, which stays collateral until the close is final. A bet nobody
settles is paid out of the hold as the claim's protected amount.

### Withdrawals

A withdrawal (kind 5) or a lock-in (kind 6) leaves the balance in the checkpoint the casino signs after it
([transitions](signed-messages.md#transitions)). Its `fee` stays in the channel's `principal` until the close, which is
not owed it, and then becomes house cash. `withdraw` records one on evidence whose step is that operation, sent by
anyone:

- It records a withdrawal from the account's current channel or a closing one, each once, until the channel is
  finalized, whatever checkpoint a close proposes.
- It records a channel's withdrawals in the order the account signed them: one only once the channel's `claimed` equals
  the `withdrawn` of the checkpoint it follows. The order decides what each takes of the channel's `principal`, so no
  sender can make a later withdrawal, a lock-in above all, take what an earlier one was due. It pays out only deposits
  the chain holds: a checkpoint that took in more than the channel's `deposited` records no withdrawal.
- Of the amount, the channel's `principal` pays first, but only the deposits its checkpoint took in,
  `min(amount, max(0, principal − (deposited − s.deposited)))` with the channel's `principal` and `deposited` and the
  checkpoint `s` after it, so a deposit that arrives before it is recorded stays the channel's. The channel's
  `collateral` pays what they do not, as far as it goes, and the rest is winnings, which join the [winnings
  queue](#the-winnings-queue) behind every earlier claim.
- It pays at once what is covered, in one call with 100,000 gas, so the recipient cannot spend the gas recording needs;
  creating a new account is the sender's to pay, beside those 100,000. What is not stays owed, for anyone to collect
  with `claim`, which sends all the gas its caller gives. A recipient that refuses the payment, or needs more gas to
  take it, leaves all of it owed: recording never depends on the recipient.
- A lock-in pays into the account's current channel instead, as deposits, so no ETH leaves the contract and all it pays
  becomes deposits. What stays owed is a claim whose recipient is the contract.

A withdrawal never recorded comes back with the close, to the account and not its recipient: a close is owed what its
checkpoint has `withdrawn` that did not become a claim ([finalization](#finalization)).

### Finalization

A checkpoint `s` is owed its balance, the deposits it has not taken in and what it withdrew that is not yet a claim,
less what the channel's claims took that it did not withdraw and what it took in that the chain does not hold:
`owed = max(0, s.balance + deposited − s.deposited + s.withdrawn − claimed)`, with the channel's `deposited` and
`claimed`. So a close on a checkpoint older than a recorded withdrawal is owed that much less, and so is one that took
in more than the channel's `deposited`: every signed checkpoint can close. A close records what its checkpoint is owed
as `closingBalance`.

`finalizeClose` finalizes the channel. Its claim's protected amount is `min(owed, principal + collateral)`, with the
channel's `principal` and `collateral`, the deposits paying first, and its winnings the rest of `owed`, which join the
end of the [winnings queue](#the-winnings-queue): `protectedFunds` falls by the channel's `principal` and `collateral`
less the protected amount, which returns to house cash, and `unpaidWinnings` rises by the winnings. The claim names the
account as its beneficiary and recipient, and the channel keeps the checkpoint and what it is owed. Finalization moves
no ETH.

### Collateral

The signer signs [offers](signed-messages.md#collateral-offers) of collateral for a channel, which anyone buys with
`buyCollateral`, paying the price as the value: any other value is an offer the signer did not sign. Collateral counts
in `protectedFunds`, so the treasury cannot withdraw it, and adds nothing to what the channel is [owed](#finalization).
It pays a [withdrawal](#withdrawals) and a [close](#finalization) what the deposits do not, and what the close is not
owed returns to house cash ([what that means for a player](../wallet/closing-and-claims.md#collateral)). An offer at no
price is collateral the signer gives, and a [dispute](#disputes) locks some too. An offer locks only house cash nothing
else is owed, as far as the [payout limit](#the-payout-limit) allows, so it takes nothing a claim counts on; one that
house cash or the limit does not allow when it is mined reverts, costing its buyer nothing but gas.

## The winnings queue

A claim's protected amount is deposits and collateral the contract held for its channel, so `claim` pays it at once. Its
winnings are owed from house cash, in one queue in the order the claims were recorded: `queuedWinnings` is the queue so
far, and each claim's winnings are one stretch of it. House cash, the contract's ETH less `protectedFunds`, covers the
queue from the front: every unpaid winning but those at its end that it falls short of,
`max(0, unpaidWinnings − house cash)`. A claim collects what of its winnings is covered, as far as the [payout
limit](#the-payout-limit) allows, in one call however far back it waits (`collectable`), and collecting leaves the cash
covering every other claim as it was, so a recipient that refuses payment keeps its share without holding up the claims
behind it. `withdrawHouse` pays only what exceeds `protectedFunds` and every unpaid winning, and new winnings join the
end of the queue, so no withdrawal, the treasury's or a player's, takes cash a claim is owed, and what the queue has
covered stays covered.

## The payout limit

`payoutLimit` is the most house cash that becomes players' money in a day, in any of three ways: winnings paid, by
`withdraw` at once, a lock-in's included, and by `claim` and `claimTo`; collateral bought with `buyCollateral`; and a
[dispute](#disputes)'s hold. Each takes from `payoutAllowance()`, which refills continuously at `payoutLimit` a day, up
to one day's worth. Winnings it does not allow stay in their claim and are paid as it refills, which `collectable`
counts; an offer for more than it allows reverts `InsufficientBalance`; and a dispute holds no more than it allows. A
hold the challenge settling its bet releases returns to the allowance too, up to the limit. A claim's protected amount
is paid whatever the limit.

The treasury sets the limit with `setPayoutLimit`, which keeps what is left of the allowance, up to the new limit: a
limit of 0 stops every payout of house cash at once, and a raised one starts from what was left and refills. The
signer's signatures stay valid for the lifetime of the deployment, so the limit bounds the house cash a stolen or
misused signer key can take in a day ([what you trust the casino
for](../overview/trust-model.md#what-you-trust-the-casino-for)).

## Events

Every change to a channel emits `ChannelChanged` with the whole channel as it stands afterwards, after the event that
says what changed, and every call that changes `protectedFunds`, `unpaidWinnings` or `collateralSales` ends with one
`TotalsChanged` holding all three, so an observer follows every channel and the contract's sums from its events alone,
and house cash from its balance. A payment of a claim into a channel emits `ChannelDeposit` and `ChannelChanged` for it,
then `ClaimPayment`.

| Event                                                                                                                                         | Emitted by                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChannelChanged(address indexed player, uint256 indexed index, Channel channel)`                                                              | Every change to a channel: `deposit`, `buyCollateral`, `withdraw`, `startClose`, `challengeClose`, `dispute`, `finalizeClose`, and a claim paid into a channel; `channel` is the channel as `channels(player, index)` returns it afterwards |
| `TotalsChanged(uint256 protectedFunds, uint256 unpaidWinnings, uint256 collateralSales)`                                                      | The end of `deposit`, `buyCollateral`, `withdraw`, `challengeClose`, `dispute`, `finalizeClose`, `claim` and `claimTo`: the three sums afterwards                                                                                           |
| `ChannelDeposit(address indexed player, uint256 indexed index, uint256 amount)`                                                               | `deposit`, and a claim paid into a channel                                                                                                                                                                                                  |
| `CollateralBought(address indexed player, uint256 indexed index, bytes32 indexed offer, uint256 amount, uint256 price)`                       | `buyCollateral`; `offer` is the hash the signer signed                                                                                                                                                                                      |
| `Withdrawal(bytes32 indexed withdrawalId, address indexed player, uint256 indexed index, address recipient, uint256 amount)`                  | `withdraw`, when it records a withdrawal or a lock-in; `withdrawalId` is the hash of its operation, its claim's ID, `player` and `index` the channel it is from, and `recipient` whom it pays, the contract for a lock-in                   |
| `CloseStarted(address indexed player, uint256 indexed index)`                                                                                 | `startClose`                                                                                                                                                                                                                                |
| `CloseChallenged(address indexed player, uint256 indexed index)`                                                                              | `challengeClose`                                                                                                                                                                                                                            |
| `BetDisputed(address indexed player, uint256 indexed index, Evidence evidence)`                                                               | `dispute`; `evidence` is what it brought, all the casino needs to settle the bet                                                                                                                                                            |
| `CloseFinalized(address indexed player, uint256 indexed index, bytes32 stateHash, uint256 amount, uint256 protectedAmount, uint256 winnings)` | `finalizeClose`; the account is the claim's beneficiary                                                                                                                                                                                     |
| `ClaimPayment(bytes32 indexed claimId, address indexed recipient, uint256 amount)`                                                            | Every payment of a claim: `withdraw` at once, and `claim` and `claimTo` when they pay; `recipient` is the address paid, the contract for a channel                                                                                          |
| `BankrollFunded(address indexed funder, uint256 amount)`                                                                                      | `fundBankroll`                                                                                                                                                                                                                              |
| `HouseWithdrawal(address indexed recipient, uint256 amount)`                                                                                  | `withdrawHouse`                                                                                                                                                                                                                             |
| `PayoutLimitSet(uint256 limit)`                                                                                                               | `setPayoutLimit`                                                                                                                                                                                                                            |
| `ClaimRecipientChanged(bytes32 indexed claimId, address indexed recipient)`                                                                   | `claimTo`                                                                                                                                                                                                                                   |

## Custom errors

| Error                   | Raised when                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Unauthorized()`        | The caller or a signature lacks the authority the call needs                                                |
| `InvalidTerms()`        | An argument or a signed field breaks the rules                                                              |
| `InvalidState()`        | The channel, its evidence, a claim or the time is not what the call needs                                   |
| `InsufficientBalance()` | `withdrawableHouse()` is short of a house withdrawal or of collateral, or `payoutAllowance()` of collateral |
| `TransferFailed()`      | A recipient refused a house withdrawal or a collection                                                      |
| `Reentrancy()`          | A guarded function was entered again during a call                                                          |
