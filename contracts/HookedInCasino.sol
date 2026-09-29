// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice One trusted casino owner signs balances and controls the shared bankroll.
/// Players must challenge stale closures within 24 hours to protect their latest balance.
contract HookedInCasino {
    uint256 public constant CHALLENGE_PERIOD = 24 hours;
    // Every deposit, and every signed balance, deposited and withdrawn total, is below 2^128 wei, so no realistic
    // number of claims can overflow the uint256 aggregate debt and block a finalization or a withdrawal.
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
    /// Every claim's winnings, in the order the claims were recorded: the queue house cash pays them in.
    uint256 public queuedWinnings;
    bool transient private entered;

    /// `deposited` is how much of the channel's on-chain deposits the balance has taken in, and `withdrawn` how much it
    /// has paid out in withdrawals. A close adds the deposits not taken in, and the withdrawals not yet claims.
    struct Checkpoint {
        bytes32 channelId;
        uint256 sequence;
        bytes32 previousStateHash;
        bytes32 transitionHash;
        uint256 balance;
        uint256 deposited;
        uint256 withdrawn;
    }

    /// The contract settles money: a casino bet, a debit, a credit, a deposit or a withdrawal. What an operation means to
    /// the wallet and the casino (its name, its game, what it pays into or collects from) is the hash `memo`,
    /// which the contract does not read.
    struct Operation {
        bytes32 channelId;
        bytes32 previousStateHash;
        uint256 sequence;
        uint256 kind;
        uint256 amount;
        // Whom a withdrawal pays.
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
        // Everything the channel's withdrawals have made into claims, which it records in order: a withdrawal is recorded
        // once this has passed the `withdrawn` of the checkpoint it follows.
        uint256 claimed;
        uint256 closingSequence;
        bytes32 closingHash;
        uint256 closingBalance;
    }

    /// What the contract owes, and to whom: a finalized channel's close, under the channel's ID, or a withdrawal, under
    /// the hash of its operation. The beneficiary is the account, which may redirect it. A recipient that is this contract
    /// is the beneficiary's current channel: what the claim pays goes into it as deposits. A withdrawal paid in full at
    /// once, and a close owed nothing, leave no claim.
    struct Claim {
        address beneficiary;
        address recipient;
        uint256 protectedRemaining;
        uint256 winningsRemaining;
        // Where the claim's winnings end in the queue: `queuedWinnings` once they joined it; 0 with no winnings.
        uint256 queueEnd;
    }

    mapping(bytes32 => Channel) public channels;
    mapping(bytes32 => Claim) public claims;
    /// How many of an account's channels have started closing: the number of its current one.
    mapping(address => uint256) public channelIndex;
    event ChannelOpened(bytes32 indexed channelId, address indexed player);
    event ChannelDeposit(bytes32 indexed channelId, uint256 amount, uint256 deposited);
    event Withdrawal(bytes32 indexed withdrawalId, bytes32 indexed channelId, address indexed recipient, uint256 amount);
    event CloseStarted(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash, uint256 deadline);
    event CloseChallenged(bytes32 indexed channelId, uint256 sequence, bytes32 stateHash);
    event CloseFinalized(
        bytes32 indexed channelId,
        address indexed beneficiary,
        bytes32 stateHash,
        uint256 amount,
        uint256 protectedAmount,
        uint256 winnings
    );
    event ClaimPayment(bytes32 indexed claimId, address indexed recipient, uint256 amount);
    event BankrollFunded(address indexed funder, uint256 amount);
    event HouseWithdrawal(address indexed recipient, uint256 amount);
    event ClaimRecipientChanged(bytes32 indexed claimId, address indexed recipient);
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
    }

    // What no deposit and no unpaid winning is owed.
    function withdrawableHouse() public view returns (uint256) {
        uint256 owed = protectedPrincipal + unpaidWinnings;
        return address(this).balance > owed ? address(this).balance - owed : 0;
    }

    function withdrawHouse(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0) || amount == 0) revert InvalidTerms();
        if (amount > withdrawableHouse()) revert InsufficientBalance();
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit HouseWithdrawal(recipient, amount);
    }

    // Anyone may have a withdrawal recorded: an operation the account signed, followed by the checkpoint the casino signed
    // after it. It becomes a claim once, in the order the account signed its channel's withdrawals, until the channel is
    // finalized: out of the channel's deposits first, and the rest winnings in the queue behind every claim before it.
    // What house cash reaches is paid to its recipient at once; the claim keeps the rest, or all of it if the recipient
    // refuses the payment, for anyone to collect. One never recorded comes back with the close, which is owed what the
    // channel's states withdrew and did not make claims. A withdrawal to this contract locks the balance in: it goes into
    // the account's current channel as deposits.
    function withdraw(Evidence calldata evidence) external nonReentrant {
        Operation calldata op = evidence.step.operation;
        if (op.kind != KIND_WITHDRAWAL) revert InvalidTerms();
        Checkpoint memory s = supported(evidence);
        Channel storage c = channels[s.channelId];
        // Every earlier withdrawal of the channel is a claim already, and this one is not; and a checkpoint pays out only
        // deposits the chain holds.
        if (c.status == STATUS_FINALIZED || c.claimed != evidence.base.withdrawn || s.deposited > c.deposited) {
            revert InvalidState();
        }
        bytes32 id = hashOperation(op);
        c.claimed += op.amount;
        // Recorded during a close, the close owes that much less.
        if (c.status == STATUS_CLOSING) c.closingBalance = op.amount < c.closingBalance ? c.closingBalance - op.amount : 0;
        uint256 principal = op.amount < c.principal ? op.amount : c.principal;
        uint256 winnings = op.amount - principal;
        c.principal -= principal;
        unpaidWinnings += winnings;
        queuedWinnings += winnings;
        emit Withdrawal(id, s.channelId, op.recipient, op.amount);
        uint256 reached = _reached(queuedWinnings, winnings);
        if (_send(id, c.player, op.recipient, principal, reached)) (principal, winnings) = (0, winnings - reached);
        if (principal + winnings != 0) {
            claims[id] = Claim(c.player, op.recipient, principal, winnings, winnings != 0 ? queuedWinnings : 0);
        }
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
        bytes32 operationHash = hashOperation(op);
        if (_signer(operationHash, step.authorization) != channels[base.channelId].player) revert Unauthorized();
        next = base;
        next.sequence = op.sequence;
        next.previousStateHash = baseHash;
        next.transitionHash = keccak256(abi.encode(operationHash, step.secret));
        bool casinoBet = op.kind == KIND_CASINO_BET;
        bool pays = op.kind == KIND_WITHDRAWAL;
        if (op.amount == 0 || op.amount >= MAX_BALANCE) revert InvalidTerms();
        // Only a withdrawal names a recipient, and never nobody.
        if (pays ? op.recipient == address(0) : op.recipient != address(0)) revert InvalidTerms();
        // A casino bet names two hashes: its round, the hash of a secret the casino fixed first, and the hash
        // of a seed. Only that secret and that seed settle it, and every bet on one round and seed
        // shares one outcome. Whoever holds one of the two cannot know the outcome before both are out.
        // Any other kind leaves all of it zero.
        if (
            casinoBet
                ? op.chance == 0 || op.prize == 0 || op.prize >= MAX_BALANCE || op.round == bytes32(0)
                    || op.seedHash == bytes32(0) || keccak256(abi.encodePacked(step.secret)) != op.round
                    || keccak256(abi.encodePacked(step.seed)) != op.seedHash
                : op.chance != 0 || op.prize != 0 || op.round != bytes32(0) || op.seedHash != bytes32(0)
                    || step.secret != bytes32(0) || step.seed != bytes32(0)
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
        if (result.balance >= MAX_BALANCE || result.deposited >= MAX_BALANCE || result.withdrawn >= MAX_BALANCE) {
            revert InvalidState();
        }
    }

    // What a supported state is owed: its balance, the deposits it has not taken in, and what it withdrew that is not yet a
    // claim, less what the channel's claims took that it did not withdraw and what it took in that the chain does not
    // hold; never below nothing. Every signed state can close.
    function _owed(Checkpoint memory s) private view returns (uint256) {
        Channel storage c = channels[s.channelId];
        uint256 owed = s.balance + c.deposited + s.withdrawn;
        uint256 taken = s.deposited + c.claimed;
        return owed > taken ? owed - taken : 0;
    }

    // A close ends the channel at once for the account: its next deposit opens its next channel, while this one closes.
    function startClose(Evidence calldata evidence) external nonReentrant {
        Checkpoint memory s = supported(evidence);
        Channel storage c = channels[s.channelId];
        if (c.status != STATUS_OPEN || block.timestamp > type(uint64).max - CHALLENGE_PERIOD) revert InvalidState();
        if (msg.sender != c.player && msg.sender != owner) revert Unauthorized();
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
        uint256 winnings = balance - principal;
        protectedPrincipal = protectedPrincipal - c.principal + principal;
        // The claim holds the principal from here on, and its winnings join the queue behind every claim before it. A
        // close owed nothing leaves no claim.
        c.principal = 0;
        unpaidWinnings += winnings;
        queuedWinnings += winnings;
        if (balance != 0) claims[channelId] = Claim(c.player, c.player, principal, winnings, winnings != 0 ? queuedWinnings : 0);
        emit CloseFinalized(channelId, c.player, stateHash, balance, principal, winnings);
    }

    /// What collecting a claim pays now: its principal, and as much of its winnings as house cash reaches.
    function collectable(bytes32 id) external view returns (uint256) {
        Claim storage k = claims[id];
        return k.protectedRemaining + _reached(k.queueEnd, k.winningsRemaining);
    }

    // How much of `winnings`, ending at `queueEnd` in the winnings queue, house cash reaches. It pays the queue in order:
    // all of it but the unpaid winnings at its end that it cannot cover.
    function _reached(uint256 queueEnd, uint256 winnings) private view returns (uint256) {
        uint256 cash = address(this).balance - protectedPrincipal;
        uint256 reached = queuedWinnings - (unpaidWinnings > cash ? unpaidWinnings - cash : 0);
        uint256 waiting = queueEnd > reached ? queueEnd - reached : 0;
        return winnings > waiting ? winnings - waiting : 0;
    }

    function claim(bytes32 id) external nonReentrant {
        if (claims[id].beneficiary == address(0)) revert InvalidState();
        _pay(id);
    }

    function claimTo(bytes32 id, address recipient) external nonReentrant {
        Claim storage k = claims[id];
        if (k.beneficiary == address(0) || msg.sender != k.beneficiary) revert Unauthorized();
        if (recipient == address(0)) revert InvalidTerms();
        k.recipient = recipient;
        emit ClaimRecipientChanged(id, recipient);
        _pay(id);
    }

    // Collecting pays what is covered of a claim: only the covered front of the queue collects, and what it collects
    // leaves the cash covering the rest as it was, so a recipient that refuses payment keeps its share without holding up
    // the claims behind it. A refused collection reverts.
    function _pay(bytes32 id) private {
        Claim storage k = claims[id];
        uint256 principal = k.protectedRemaining;
        uint256 winnings = _reached(k.queueEnd, k.winningsRemaining);
        (k.protectedRemaining, k.winningsRemaining) = (0, k.winningsRemaining - winnings);
        if (!_send(id, k.beneficiary, k.recipient, principal, winnings)) revert TransferFailed();
    }

    // Pays a claim's principal and winnings: into its beneficiary's current channel when the recipient is this contract,
    // and otherwise sent with 100,000 gas, whatever the recipient returns left uncopied so it costs the sender nothing.
    // Says whether the recipient took it; a refusal leaves all of it owed.
    function _send(bytes32 id, address beneficiary, address recipient, uint256 principal, uint256 winnings)
        private
        returns (bool ok)
    {
        uint256 amount = principal + winnings;
        if (amount == 0) return true;
        protectedPrincipal -= principal;
        unpaidWinnings -= winnings;
        if (recipient == address(this)) {
            _deposit(beneficiary, amount);
            ok = true;
        } else {
            assembly ("memory-safe") {
                ok := call(100000, recipient, amount, 0, 0, 0, 0)
            }
        }
        if (ok) emit ClaimPayment(id, recipient, amount);
        else (protectedPrincipal, unpaidWinnings) = (protectedPrincipal + principal, unpaidWinnings + winnings);
    }

}
