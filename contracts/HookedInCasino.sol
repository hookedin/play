// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice One trusted casino owner signs balances and controls the shared bankroll.
/// Players must challenge stale closures within 24 hours to protect their latest balance.
contract HookedInCasino {
    uint256 public constant PROBABILITY_SCALE = 1 << 64;
    uint256 public constant CHALLENGE_PERIOD = 24 hours;
    // Every deposit and signed balance is below 2^128 wei, so no realistic number of
    // finalized claims can overflow the uint256 aggregate debt and block finalization.
    uint256 public constant MAX_BALANCE = 1 << 128;
    uint8 private constant STATUS_UNOPENED = 0;
    uint8 private constant STATUS_OPEN = 1;
    uint8 private constant STATUS_CLOSING = 2;
    uint8 private constant STATUS_FINALIZED = 3;
    uint256 private constant KIND_NONE = 0;
    uint256 private constant KIND_BET = 1;
    uint256 private constant KIND_PAYMENT = 2;
    uint256 private constant KIND_TRANSFER = 4;
    uint256 private constant KIND_RECEIVE = 5;
    // A match stake leaves the channel for the casino's escrow; its payout returns whatever the
    // match's oracle awarded. The casino attests both, as it attests a transfer's matching debit.
    bytes32 public constant OUTCOME_DOMAIN = keccak256("HOOKEDIN/OUTCOME");
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant STATE_TYPEHASH = keccak256(
        "Checkpoint(bytes32 channelId,uint256 sequence,bytes32 previousStateHash,bytes32 transitionHash,uint256 balance)"
    );
    bytes32 constant OP_TYPEHASH = keccak256(
        "Operation(bytes32 channelId,bytes32 previousStateHash,uint256 sequence,uint256 kind,uint256 amount,Prize[] prizes,bytes32 seed,bytes32 roundHead,bytes32 operationId,address developer,bytes32 counterparty)Prize(uint256 rangeStart,uint256 rangeEnd,uint256 payout)"
    );
    bytes32 constant PRIZE_TYPEHASH = keccak256("Prize(uint256 rangeStart,uint256 rangeEnd,uint256 payout)");
    uint256 public constant MAX_PRIZES = 64;
    // The struct hash of the all-zero operation: the one encoding of "no step".
    bytes32 constant EMPTY_OPERATION = keccak256(
        abi.encode(OP_TYPEHASH, bytes32(0), bytes32(0), 0, 0, 0, keccak256(""), bytes32(0), bytes32(0), bytes32(0), address(0), bytes32(0))
    );
    bytes32 constant CLOSE_TYPEHASH = keccak256("Close(bytes32 channelId,bytes32 stateHash)");
    // The same authority signs settlement evidence and withdraws house funds.
    // It can create winnings claims; no separate key can make those promises safe.
    // Historical signatures remain valid for the lifetime of this deployment.
    address public immutable owner;

    uint256 public protectedPrincipal;
    uint256 public unpaidWinnings;
    bool transient private entered;

    struct Checkpoint {
        bytes32 channelId;
        uint256 sequence;
        bytes32 previousStateHash;
        bytes32 transitionHash;
        uint256 balance;
    }

    /// A bet pays `payout` when its round's outcome falls in [rangeStart, rangeEnd).
    /// Prizes may overlap: every prize that contains the outcome pays.
    struct Prize {
        uint256 rangeStart;
        uint256 rangeEnd;
        uint256 payout;
    }

    struct Operation {
        bytes32 channelId;
        bytes32 previousStateHash;
        uint256 sequence;
        uint256 kind;
        uint256 amount;
        Prize[] prizes;
        bytes32 seed;
        bytes32 roundHead;
        bytes32 operationId;
        address developer;
        bytes32 counterparty;
    }

    struct Step {
        Operation operation;
        bytes authorization;
        bytes32 preimage;
        bytes casinoSignature;
    }

    struct Evidence {
        Checkpoint base;
        bytes playerSignature;
        bytes casinoSignature;
        Step step;
    }

    struct Channel {
        address player;
        uint64 deadline;
        uint8 status;
        address signer;
        uint256 deposit;
        bytes32 initialHash;
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
    mapping(address => bytes32) public activeChannel;
    mapping(bytes32 => bool) public withdrawals;
    mapping(bytes32 => uint256) public allocatedWinnings;
    mapping(bytes32 => bytes32) public nextClaim;
    bytes32 public firstClaim;
    bytes32 private lastClaim;
    uint256 public reservedWinnings;
    event ChannelOpened(bytes32 indexed channelId, address indexed player, uint256 deposit);
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
    event HouseWithdrawal(bytes32 indexed withdrawalId, address indexed recipient, uint256 amount);
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
        bytes32[] memory prizes = new bytes32[](v.prizes.length);
        for (uint256 i = 0; i < prizes.length; i++) {
            prizes[i] = keccak256(abi.encode(PRIZE_TYPEHASH, v.prizes[i]));
        }
        return keccak256(
            abi.encode(
                OP_TYPEHASH, v.channelId, v.previousStateHash, v.sequence, v.kind, v.amount,
                keccak256(abi.encodePacked(prizes)), v.seed, v.roundHead, v.operationId, v.developer, v.counterparty
            )
        );
    }

    function hashOperation(Operation calldata v) public view returns (bytes32) {
        return _digest(_operationStruct(v));
    }

    function hashClose(bytes32 channelId, bytes32 stateHash) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(CLOSE_TYPEHASH, channelId, stateHash)));
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

    function openChannel(address signer) external payable nonReentrant returns (bytes32 channelId) {
        if (signer == address(0) || msg.value == 0 || msg.value >= MAX_BALANCE) revert InvalidTerms();
        channelId = keccak256(abi.encode(msg.sender, signer, msg.value));
        if (channels[channelId].status != STATUS_UNOPENED || activeChannel[msg.sender] != bytes32(0))
            revert Unauthorized();
        Checkpoint memory initial =
            Checkpoint(channelId, 0, bytes32(0), bytes32(0), msg.value);
        channels[channelId] =
            Channel(msg.sender, 0, STATUS_OPEN, signer, msg.value, hashState(initial), 0, bytes32(0), 0);
        activeChannel[msg.sender] = channelId;
        protectedPrincipal += msg.value;
        emit ChannelOpened(channelId, msg.sender, msg.value);
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
        uint256 cash = address(this).balance - protectedPrincipal;
        return cash > unpaidWinnings ? cash - unpaidWinnings : 0;
    }

    // Stable IDs also prevent a retried developer cash payout from paying twice.
    function withdrawHouse(bytes32 withdrawalId, address payable recipient, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (withdrawalId == bytes32(0) || withdrawals[withdrawalId]) revert InvalidTerms();
        if (recipient == address(0) || recipient == address(this) || amount == 0) revert InvalidTerms();
        if (amount > withdrawableHouse()) revert InsufficientBalance();
        withdrawals[withdrawalId] = true;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit HouseWithdrawal(withdrawalId, recipient, amount);
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
        if (
            op.channelId != base.channelId || op.previousStateHash != baseHash
                || op.sequence != base.sequence + 1 || op.operationId == bytes32(0)
        ) revert InvalidState();
        address expected = channels[base.channelId].signer;
        bytes32 operationHash = hashOperation(op);
        if (expected == address(0) || _signer(operationHash, step.authorization) != expected) {
            revert Unauthorized();
        }
        next = base;
        next.sequence = op.sequence;
        next.previousStateHash = baseHash;
        next.transitionHash = keccak256(abi.encode(operationHash, step.preimage));
        bool wager = op.kind == KIND_BET;
        bool credit = op.kind == KIND_RECEIVE;
        // A transfer and its credit name the other side: another channel, or a match.
        bool linked = credit || op.kind == KIND_TRANSFER;
        // A bet names its round: the preimage must open the signed round head, whichever
        // channel owns that chain. Every bet on one round and seed shares one outcome.
        // A transfer into a match may carry its seat's seed, for a pot that is settled as a bet.
        if (
            (wager ? op.prizes.length == 0 || op.prizes.length > MAX_PRIZES || op.seed == bytes32(0)
                    || op.roundHead == bytes32(0) || op.developer == address(0)
                    || keccak256(abi.encodePacked(step.preimage)) != op.roundHead
                : op.prizes.length != 0 || (op.seed != bytes32(0) && op.kind != KIND_TRANSFER) || op.roundHead != bytes32(0)
                    || op.developer != address(0) || step.preimage != bytes32(0))
                || op.amount == 0 || op.amount >= MAX_BALANCE
                || (linked ? op.counterparty == bytes32(0) || op.counterparty == base.channelId : op.counterparty != bytes32(0))
        ) revert InvalidTerms();
        if (credit) {
            // The casino attests the matching debit. Principal and liquidity do not move.
            next.balance += op.amount;
        } else if (wager || linked || op.kind == KIND_PAYMENT) {
            // The stake is paid to enter; every prize whose range holds the outcome pays out.
            if (op.amount > base.balance) revert InvalidTerms();
            next.balance -= op.amount;
            if (wager) {
                uint256 outcome = uint64(uint256(keccak256(abi.encode(OUTCOME_DOMAIN, op.seed, step.preimage))));
                for (uint256 i = 0; i < op.prizes.length; i++) {
                    Prize calldata prize = op.prizes[i];
                    if (
                        prize.rangeStart >= prize.rangeEnd || prize.rangeEnd > PROBABILITY_SCALE || prize.payout == 0
                            || prize.payout >= MAX_BALANCE
                    ) revert InvalidTerms();
                    if (outcome >= prize.rangeStart && outcome < prize.rangeEnd) next.balance += prize.payout;
                }
            }
        } else {
            revert InvalidTerms();
        }
        if (next.balance >= MAX_BALANCE) revert InvalidTerms();
        if (_signer(hashState(next), step.casinoSignature) != owner) {
            revert InvalidState();
        }
    }

    function supported(Evidence calldata evidence) public view returns (Checkpoint memory result) {
        Channel storage c = channels[evidence.base.channelId];
        if (c.status == STATUS_UNOPENED) revert InvalidState();
        bytes32 h = hashState(evidence.base);
        if (
            h != c.initialHash
                && (_signer(h, evidence.playerSignature) != c.signer || _signer(h, evidence.casinoSignature) != owner)
        ) revert Unauthorized();
        if (evidence.step.operation.kind == KIND_NONE) {
            // A checkpoint-only proof carries the canonical empty step: one meaning, one encoding.
            Step calldata step = evidence.step;
            if (
                step.authorization.length != 0 || step.casinoSignature.length != 0 || step.preimage != bytes32(0)
                    || _operationStruct(step.operation) != EMPTY_OPERATION
            ) revert InvalidTerms();
            result = evidence.base;
        } else {
            result = _derive(evidence.base, h, evidence.step);
        }
        if (result.balance >= MAX_BALANCE) revert InvalidState();
    }

    function cooperativeClose(
        Evidence calldata evidence,
        bytes calldata playerSignature,
        bytes calldata casinoSignature
    ) external nonReentrant {
        Checkpoint memory s = supported(evidence);
        Channel storage c = channels[s.channelId];
        bytes32 stateHash = hashState(s);
        if (c.status != STATUS_OPEN && c.status != STATUS_CLOSING) revert InvalidState();
        if (
            c.status == STATUS_CLOSING
                && (block.timestamp >= c.deadline
                    || s.sequence < c.closingSequence
                    || (s.sequence == c.closingSequence && stateHash != c.closingHash))
        ) revert InvalidState();
        bytes32 digest = hashClose(s.channelId, stateHash);
        if (_signer(digest, playerSignature) != c.player || _signer(digest, casinoSignature) != owner) {
            revert Unauthorized();
        }
        _finalize(s.channelId, stateHash, s.balance);
    }

    function startClose(Evidence calldata evidence) external nonReentrant {
        Checkpoint memory s = supported(evidence);
        Channel storage c = channels[s.channelId];
        if (c.status != STATUS_OPEN || (msg.sender != c.player && msg.sender != owner)) revert Unauthorized();
        if (block.timestamp > type(uint64).max - CHALLENGE_PERIOD) revert InvalidState();
        c.status = STATUS_CLOSING;
        c.deadline = uint64(block.timestamp + CHALLENGE_PERIOD);
        c.closingSequence = s.sequence;
        c.closingHash = hashState(s);
        c.closingBalance = s.balance;
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
        c.closingBalance = s.balance;
        emit CloseChallenged(s.channelId, s.sequence, c.closingHash);
    }

    function finalizeClose(bytes32 channelId) external nonReentrant {
        Channel storage c = channels[channelId];
        if (c.status != STATUS_CLOSING || block.timestamp < c.deadline) revert InvalidState();
        _finalize(channelId, c.closingHash, c.closingBalance);
    }

    // Finalization only establishes debt. Collection is an independent transaction.
    function _finalize(bytes32 channelId, bytes32 stateHash, uint256 balance) private {
        Channel storage c = channels[channelId];
        c.status = STATUS_FINALIZED;
        activeChannel[c.player] = bytes32(0);
        uint256 principal = balance < c.deposit ? balance : c.deposit;
        protectedPrincipal = protectedPrincipal - c.deposit + principal;
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
