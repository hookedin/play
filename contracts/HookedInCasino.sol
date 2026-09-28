// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice One trusted casino owner signs balances and controls the shared bankroll.
/// Players must challenge stale closures within 24 hours to protect their latest balance.
contract HookedInCasino {
    uint256 public constant CHALLENGE_PERIOD = 24 hours;
    // Every deposit, signed balance and withdrawn total is below 2^128 wei, so no realistic number of
    // finalized claims can overflow the uint256 aggregate debt and block finalization.
    uint256 public constant MAX_BALANCE = 1 << 128;
    uint8 private constant STATUS_UNOPENED = 0;
    uint8 private constant STATUS_OPEN = 1;
    uint8 private constant STATUS_CLOSING = 2;
    uint8 private constant STATUS_FINALIZED = 3;
    uint256 private constant KIND_NONE = 0;
    uint256 private constant KIND_CASINO_BET = 1;
    uint256 private constant KIND_DEBIT = 2;
    uint256 private constant KIND_CREDIT = 3;
    uint256 private constant KIND_DEPOSIT = 4;
    uint256 private constant KIND_WITHDRAWAL = 5;
    uint256 private constant KIND_TRANSFER = 6;
    bytes32 public constant OUTCOME_DOMAIN = keccak256("HOOKEDIN/OUTCOME");
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant STATE_TYPEHASH = keccak256(
        "Checkpoint(bytes32 channelId,uint256 sequence,bytes32 previousStateHash,bytes32 transitionHash,uint256 balance,uint256 deposited,uint256 withdrawn)"
    );
    bytes32 constant OP_TYPEHASH = keccak256(
        "Operation(bytes32 channelId,bytes32 previousStateHash,uint256 sequence,uint256 kind,uint256 amount,address recipient,uint64 chance,uint256 prize,bytes32 round,bytes32 seedHash,bytes32 memo)"
    );
    // The struct hash of the all-zero operation: the one encoding of "no step".
    bytes32 constant EMPTY_OPERATION =
        keccak256(abi.encode(OP_TYPEHASH, bytes32(0), bytes32(0), 0, 0, 0, address(0), 0, 0, bytes32(0), bytes32(0), bytes32(0)));
    // The same authority signs settlement evidence and withdraws house funds.
    // It can create winnings claims; no separate key can make those promises safe.
    // Historical signatures remain valid for the lifetime of this deployment.
    address public immutable owner;

    uint256 public protectedPrincipal;
    uint256 public unpaidWinnings;
    bool transient private entered;

    /// `deposited` is how much of the channel's on-chain deposits the balance has taken in, and `withdrawn` how much it
    /// has paid out in withdrawals and transfers. A close adds the deposits not taken in, and the withdrawals not paid.
    struct Checkpoint {
        bytes32 channelId;
        uint256 sequence;
        bytes32 previousStateHash;
        bytes32 transitionHash;
        uint256 balance;
        uint256 deposited;
        uint256 withdrawn;
    }

    /// The contract settles money: a casino bet, a debit, a credit, a deposit, a withdrawal or a transfer. What an operation
    /// means to the wallet and the casino (its name, its game, what it pays into or collects from) is the hash `memo`,
    /// which the contract does not read.
    struct Operation {
        bytes32 channelId;
        bytes32 previousStateHash;
        uint256 sequence;
        uint256 kind;
        uint256 amount;
        // Whom a withdrawal pays, or whose current channel a transfer deposits into.
        address recipient;
        // A casino bet pays `prize` when its round's 64-bit outcome is below `chance`.
        uint64 chance;
        uint256 prize;
        bytes32 round;
        bytes32 seedHash;
        bytes32 memo;
    }

    struct Step {
        Operation operation;
        bytes authorization;
        bytes32 seed;
        bytes32 secret;
        bytes casinoSignature;
    }

    struct Evidence {
        Checkpoint base;
        bytes playerSignature;
        bytes casinoSignature;
        Step step;
    }

    /// An account's channel. The account signs every operation and checkpoint on it. It starts from its zero checkpoint,
    /// which needs no signature.
    struct Channel {
        address player;
        uint64 deadline;
        uint8 status;
        // Everything ever deposited into the channel: what a state is owed is worked out from it.
        uint256 deposited;
        // The deposits the contract still holds for the channel, which withdrawals are paid out of first.
        uint256 principal;
        // Everything the contract has paid out of the channel in withdrawals and transfers.
        uint256 paidOut;
        uint256 closingSequence;
        bytes32 closingHash;
        uint256 closingBalance;
    }

    struct Claim {
        address recipient;
        bytes32 stateHash;
        uint256 amount;
        uint256 protectedRemaining;
        uint256 winningsRemaining;
        uint256 finalizedAt;
    }

    mapping(bytes32 => Channel) public channels;
    mapping(bytes32 => Claim) private _claims;
    /// How many of an account's channels have started closing: the number of its current one.
    mapping(address => uint256) public channelIndex;
    /// Whether a withdrawal or transfer, by the hash of its operation, has been paid.
    mapping(bytes32 => bool) public withdrawals;
    mapping(bytes32 => uint256) public allocatedWinnings;
    mapping(bytes32 => bytes32) public nextClaim;
    bytes32 public firstClaim;
    bytes32 private lastClaim;
    uint256 public reservedWinnings;
    event ChannelOpened(bytes32 indexed channelId, address indexed player);
    event ChannelDeposit(bytes32 indexed channelId, uint256 amount, uint256 deposited);
    event Withdrawal(bytes32 indexed withdrawalId, bytes32 indexed channelId, address indexed recipient, uint256 amount);
    event CloseStarted(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash, uint256 deadline);
    event CloseChallenged(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash);
    event ClaimEstablished(
        bytes32 indexed channelId,
        address indexed beneficiary,
        bytes32 stateHash,
        uint256 amount,
        uint256 protectedAmount,
        uint256 winnings
    );
    event ClaimPayment(bytes32 indexed channelId, address indexed beneficiary, uint256 amount, uint256 totalPaid);
    event ClaimShortfall(bytes32 indexed channelId, uint256 remaining);
    event BankrollFunded(address indexed funder, uint256 amount);
    event HouseWithdrawal(address indexed recipient, uint256 amount);
    event WinningsAllocated(bytes32 indexed channelId, uint256 amount);
    event ClaimRecipientChanged(bytes32 indexed channelId, address indexed recipient);
    error Unauthorized();
    error InvalidTerms();
    error InvalidState();
    error InsufficientBalance();
    error TransferFailed();
    error Reentrancy();
    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }
    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor() {
        owner = msg.sender;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("HookedIn"), keccak256("1"), block.chainid, address(this)));
    }

    function _digest(bytes32 h) private view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), h));
    }

    function hashState(Checkpoint memory v) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(STATE_TYPEHASH, v)));
    }

    function _operationStruct(Operation calldata v) private pure returns (bytes32) {
        return keccak256(abi.encode(OP_TYPEHASH, v));
    }

    function hashOperation(Operation calldata v) public view returns (bytes32) {
        return _digest(_operationStruct(v));
    }

    function _signer(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert Unauthorized();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || (v != 27 && v != 28)) {
            revert Unauthorized();
        }
        address result = ecrecover(digest, v, r, s);
        if (result == address(0)) revert Unauthorized();
        return result;
    }

    /// An account's current channel: its first, or the one after the last whose close started.
    function channelOf(address player) public view returns (bytes32) {
        return keccak256(abi.encode(player, channelIndex[player]));
    }

    // Anyone may deposit into any account's channel, and an account's first deposit opens it. The balance takes the
    // money in with a deposit operation the casino signs; until then a close adds it to what the channel is owed.
    function deposit(address player) external payable nonReentrant {
        if (player == address(0) || player == address(this) || msg.value == 0) revert InvalidTerms();
        _deposit(player, msg.value);
    }

    // An account's current channel is never closing: a close that starts moves the account to its next one.
    function _deposit(address player, uint256 amount) private {
        bytes32 channelId = channelOf(player);
        Channel storage c = channels[channelId];
        if (c.status == STATUS_UNOPENED) {
            c.player = player;
            c.status = STATUS_OPEN;
            emit ChannelOpened(channelId, player);
        }
        if (c.deposited + amount >= MAX_BALANCE) revert InvalidTerms();
        c.deposited += amount;
        c.principal += amount;
        protectedPrincipal += amount;
        emit ChannelDeposit(channelId, amount, c.deposited);
    }

    function fundBankroll() external payable nonReentrant {
        if (msg.value == 0) revert InvalidTerms();
        emit BankrollFunded(msg.sender, msg.value);
        _allocate(8);
    }

    function houseCash() public view returns (uint256) {
        return address(this).balance - protectedPrincipal - reservedWinnings;
    }

    function withdrawableHouse() public view returns (uint256) {
        uint256 owed = protectedPrincipal + unpaidWinnings;
        return address(this).balance > owed ? address(this).balance - owed : 0;
    }

    function withdrawHouse(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0) || recipient == address(this) || amount == 0) revert InvalidTerms();
        if (amount > withdrawableHouse()) revert InsufficientBalance();
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit HouseWithdrawal(recipient, amount);
    }

    // Anyone may have a withdrawal or a transfer paid: an operation the account signed, followed by the checkpoint the
    // casino signed after it. Each is paid once, until its channel is finalized: out of the channel's deposits first and
    // house cash for the rest, all or nothing. Short of house cash it reverts, and can be sent again once there is cash;
    // one never paid comes back with the close, which is owed what the channel's states withdrew and it did not pay. A
    // withdrawal pays its recipient; a transfer deposits into the recipient's current channel.
    function withdraw(Evidence calldata evidence) external nonReentrant {
        Operation calldata op = evidence.step.operation;
        if (op.kind != KIND_WITHDRAWAL && op.kind != KIND_TRANSFER) revert InvalidTerms();
        Checkpoint memory s = supported(evidence);
        Channel storage c = channels[s.channelId];
        if (c.status != STATUS_OPEN && c.status != STATUS_CLOSING) revert InvalidState();
        bytes32 withdrawalId = hashOperation(op);
        if (withdrawals[withdrawalId]) revert InvalidState();
        withdrawals[withdrawalId] = true;
        c.paidOut += op.amount;
        // Paid during a close, the close owes that much less.
        if (c.status == STATUS_CLOSING) c.closingBalance = op.amount < c.closingBalance ? c.closingBalance - op.amount : 0;
        uint256 fromDeposits = op.amount < c.principal ? op.amount : c.principal;
        if (op.amount - fromDeposits > withdrawableHouse()) revert InsufficientBalance();
        c.principal -= fromDeposits;
        protectedPrincipal -= fromDeposits;
        emit Withdrawal(withdrawalId, s.channelId, op.recipient, op.amount);
        if (op.kind == KIND_TRANSFER) {
            _deposit(op.recipient, op.amount);
        } else {
            (bool ok,) = op.recipient.call{value: op.amount}("");
            if (!ok) revert TransferFailed();
        }
    }

    function derive(Checkpoint calldata base, Step calldata step) public view returns (Checkpoint memory next) {
        return _derive(base, hashState(base), step);
    }

    // Every field an operation kind does not use must be zero, so each signed
    // operation has exactly one meaning and one encoding.
    function _derive(Checkpoint calldata base, bytes32 baseHash, Step calldata step)
        private
        view
        returns (Checkpoint memory next)
    {
        Operation calldata op = step.operation;
        if (op.channelId != base.channelId || op.previousStateHash != baseHash || op.sequence != base.sequence + 1) {
            revert InvalidState();
        }
        address expected = channels[base.channelId].player;
        bytes32 operationHash = hashOperation(op);
        if (expected == address(0) || _signer(operationHash, step.authorization) != expected) {
            revert Unauthorized();
        }
        next = base;
        next.sequence = op.sequence;
        next.previousStateHash = baseHash;
        next.transitionHash = keccak256(abi.encode(operationHash, step.secret));
        bool casinoBet = op.kind == KIND_CASINO_BET;
        bool pays = op.kind == KIND_WITHDRAWAL || op.kind == KIND_TRANSFER;
        // A casino bet names two hashes: its round, the hash of a secret the casino fixed first, and the hash
        // of a seed. Only that secret and that seed settle it, and every bet on one round and seed
        // shares one outcome. Whoever holds one of the two cannot know the outcome before both are out.
        // Every field another kind does not use must be zero; only a withdrawal or a transfer names a recipient.
        if (
            (casinoBet ? op.chance == 0 || op.prize == 0 || op.prize >= MAX_BALANCE || op.seedHash == bytes32(0)
                    || op.round == bytes32(0)
                    || keccak256(abi.encodePacked(step.secret)) != op.round
                    || keccak256(abi.encodePacked(step.seed)) != op.seedHash
                : op.chance != 0 || op.prize != 0 || op.seedHash != bytes32(0) || op.round != bytes32(0)
                    || step.secret != bytes32(0) || step.seed != bytes32(0))
                || (pays ? op.recipient == address(0) || op.recipient == address(this) : op.recipient != address(0))
                || op.amount == 0 || op.amount >= MAX_BALANCE
        ) revert InvalidTerms();
        if (op.kind == KIND_CREDIT) {
            // The casino attests what the credit collects. Principal and liquidity do not move.
            next.balance += op.amount;
        } else if (op.kind == KIND_DEPOSIT) {
            // The balance takes in money deposited on-chain; a close checks it was.
            next.balance += op.amount;
            next.deposited += op.amount;
        } else if (casinoBet || op.kind == KIND_DEBIT || pays) {
            // The stake is paid to enter; a casino bet pays its prize when the outcome is below its chance.
            if (op.amount > base.balance) revert InvalidTerms();
            next.balance -= op.amount;
            if (pays) next.withdrawn += op.amount;
            if (casinoBet && uint64(uint256(keccak256(abi.encode(OUTCOME_DOMAIN, step.seed, step.secret)))) < op.chance) {
                next.balance += op.prize;
            }
        } else {
            revert InvalidTerms();
        }
        if (next.balance >= MAX_BALANCE || next.withdrawn >= MAX_BALANCE) revert InvalidTerms();
        if (_signer(hashState(next), step.casinoSignature) != owner) {
            revert InvalidState();
        }
    }

    function supported(Evidence calldata evidence) public view returns (Checkpoint memory result) {
        Channel storage c = channels[evidence.base.channelId];
        if (c.status == STATUS_UNOPENED) revert InvalidState();
        bytes32 h = hashState(evidence.base);
        // The channel's zero checkpoint needs no signature; any other is signed by both sides.
        if (
            h != hashState(Checkpoint(evidence.base.channelId, 0, bytes32(0), bytes32(0), 0, 0, 0))
                && (_signer(h, evidence.playerSignature) != c.player || _signer(h, evidence.casinoSignature) != owner)
        ) revert Unauthorized();
        if (evidence.step.operation.kind == KIND_NONE) {
            // A checkpoint-only proof carries the canonical empty step: one meaning, one encoding.
            Step calldata step = evidence.step;
            if (
                step.authorization.length != 0 || step.casinoSignature.length != 0 || step.secret != bytes32(0)
                    || step.seed != bytes32(0)
                    || _operationStruct(step.operation) != EMPTY_OPERATION
            ) revert InvalidTerms();
            result = evidence.base;
        } else {
            result = _derive(evidence.base, h, evidence.step);
        }
        if (result.balance >= MAX_BALANCE || result.withdrawn >= MAX_BALANCE) revert InvalidState();
    }

    // What a supported state is owed: its balance, the deposits it has not taken in, and what it withdrew that the
    // contract has not paid, less what the contract paid out that it did not withdraw; never below nothing. A state that
    // has taken in more than was deposited closes nothing.
    function _owed(Checkpoint memory s) private view returns (uint256) {
        Channel storage c = channels[s.channelId];
        if (s.deposited > c.deposited) revert InvalidState();
        uint256 owed = s.balance + c.deposited - s.deposited + s.withdrawn;
        return owed > c.paidOut ? owed - c.paidOut : 0;
    }

    // A close ends the channel at once for the account: its next deposit opens its next channel, while this one closes.
    function startClose(Evidence calldata evidence) external nonReentrant {
        Checkpoint memory s = supported(evidence);
        Channel storage c = channels[s.channelId];
        if (c.status != STATUS_OPEN || (msg.sender != c.player && msg.sender != owner)) revert Unauthorized();
        if (block.timestamp > type(uint64).max - CHALLENGE_PERIOD) revert InvalidState();
        c.status = STATUS_CLOSING;
        channelIndex[c.player] += 1;
        c.deadline = uint64(block.timestamp + CHALLENGE_PERIOD);
        c.closingSequence = s.sequence;
        c.closingHash = hashState(s);
        c.closingBalance = _owed(s);
        emit CloseStarted(s.channelId, s.sequence, c.closingHash, c.deadline);
    }

    function challengeClose(Evidence calldata evidence) external nonReentrant {
        Checkpoint memory s = supported(evidence);
        Channel storage c = channels[s.channelId];
        // Only strictly newer evidence changes the proposed closing state.
        if (c.status != STATUS_CLOSING || block.timestamp >= c.deadline || s.sequence <= c.closingSequence) {
            revert InvalidState();
        }
        c.closingSequence = s.sequence;
        c.closingHash = hashState(s);
        c.closingBalance = _owed(s);
        emit CloseChallenged(s.channelId, s.sequence, c.closingHash);
    }

    // Finalization only establishes debt, owed to the player; collection is an independent transaction.
    function finalizeClose(bytes32 channelId) external nonReentrant {
        Channel storage c = channels[channelId];
        if (c.status != STATUS_CLOSING || block.timestamp < c.deadline) revert InvalidState();
        c.status = STATUS_FINALIZED;
        bytes32 stateHash = c.closingHash;
        uint256 balance = c.closingBalance;
        uint256 principal = balance < c.principal ? balance : c.principal;
        protectedPrincipal = protectedPrincipal - c.principal + principal;
        // The claim holds the principal from here on.
        c.principal = 0;
        unpaidWinnings += balance - principal;
        _claims[channelId] = Claim(c.player, stateHash, balance, principal, balance - principal, block.timestamp);
        if (balance > principal) {
            if (lastClaim == bytes32(0)) firstClaim = channelId;
            else nextClaim[lastClaim] = channelId;
            lastClaim = channelId;
        }
        emit ClaimEstablished(channelId, c.player, stateHash, balance, principal, balance - principal);
    }

    function claims(bytes32 channelId) external view returns (
        address beneficiary, bytes32 stateHash, uint256 amount, uint256 paid,
        uint256 protectedRemaining, uint256 winningsRemaining, uint256 finalizedAt
    ) {
        Claim storage c = _claims[channelId];
        return (channels[channelId].player, c.stateHash, c.amount, _paid(c), c.protectedRemaining, c.winningsRemaining, c.finalizedAt);
    }

    function claimRecipient(bytes32 channelId) external view returns (address) {
        return _claims[channelId].recipient;
    }

    function _paid(Claim storage c) private view returns (uint256) {
        return c.amount - c.protectedRemaining - c.winningsRemaining;
    }

    function claim(bytes32 channelId) external nonReentrant {
        if (channels[channelId].status != STATUS_FINALIZED) revert InvalidState();
        _pay(channelId);
    }

    function claimTo(bytes32 channelId, address recipient) external nonReentrant {
        if (channels[channelId].status != STATUS_FINALIZED || msg.sender != channels[channelId].player) {
            revert Unauthorized();
        }
        if (recipient == address(0) || recipient == address(this)) revert InvalidTerms();
        _claims[channelId].recipient = recipient;
        emit ClaimRecipientChanged(channelId, recipient);
        _pay(channelId);
    }

    // Permissionless bounded allocation. Failed recipients cannot obstruct junior
    // claims: allocated ETH is reserved for the senior claim until it can collect.
    function allocateWinnings(uint256 limit) external nonReentrant {
        if (limit == 0 || limit > 64) revert InvalidTerms();
        _allocate(limit);
    }

    function _allocate(uint256 limit) private {
        uint256 cash = houseCash();
        for (uint256 i; i < limit && firstClaim != bytes32(0) && cash != 0; i++) {
            bytes32 channelId = firstClaim;
            uint256 due = _claims[channelId].winningsRemaining - allocatedWinnings[channelId];
            uint256 amount = due < cash ? due : cash;
            allocatedWinnings[channelId] += amount;
            reservedWinnings += amount;
            cash -= amount;
            emit WinningsAllocated(channelId, amount);
            if (amount == due) {
                firstClaim = nextClaim[channelId];
                if (firstClaim == bytes32(0)) lastClaim = bytes32(0);
                delete nextClaim[channelId];
            } else {
                break;
            }
        }
    }

    // Invariant outside a guarded call: cash >= protectedPrincipal + reservedWinnings.
    // A rejected transfer reverts this collection, preserving every liability and allocation.
    function _pay(bytes32 channelId) private {
        _allocate(8);
        Claim storage c = _claims[channelId];
        uint256 principal = c.protectedRemaining;
        uint256 winnings = allocatedWinnings[channelId];
        uint256 amount = principal + winnings;
        if (amount != 0) {
            c.protectedRemaining = 0;
            c.winningsRemaining -= winnings;
            protectedPrincipal -= principal;
            unpaidWinnings -= winnings;
            allocatedWinnings[channelId] = 0;
            reservedWinnings -= winnings;
            (bool ok,) = payable(c.recipient).call{value: amount, gas: 100000}("");
            if (!ok) revert TransferFailed();
            emit ClaimPayment(channelId, c.recipient, amount, _paid(c));
        }
        uint256 remaining = c.protectedRemaining + c.winningsRemaining;
        if (remaining != 0) emit ClaimShortfall(channelId, remaining);
    }

}
