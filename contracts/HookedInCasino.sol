// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice One trusted casino owner signs balances and controls the shared bankroll.
/// Players must challenge stale closures within 7 days to protect their latest balance, and anyone can dispute a
/// casino bet the owner's quote covers for them until the quote expires, which keeps its win from the owner as far as
/// house cash is free. Anyone can buy collateral the owner offers for a channel, which protects its winnings from the
/// owner. A channel is an account's and its index, the number of the account's channels whose close started before it:
/// the account's current channel takes play and money from the start, with nothing to open.
contract HookedInCasino {
    // How long a close takes newer evidence, and how long the casino has to settle a casino bet disputed in it before
    // it counts as won: long enough for a player away from the wallet, or a casino that is down, to answer.
    uint256 public constant CHALLENGE_PERIOD = 7 days;
    // Every deposit, and every signed balance, deposited and withdrawn total, is below 2^96 wei, as is every stake,
    // prize and quoted virtual bankroll: no realistic number of claims can overflow the uint256 aggregate debt and block
    // a finalization or a withdrawal, and a disputed bet's Kelly condition fits in 256 bits.
    uint256 public constant MAX_BALANCE = 1 << 96;
    uint8 private constant STATUS_ACTIVE = 0;
    uint8 private constant STATUS_CLOSING = 1;
    uint8 private constant STATUS_FINALIZED = 2;
    uint256 private constant KIND_NONE = 0;
    uint256 private constant KIND_CASINO_BET = 1;
    uint256 private constant KIND_DEBIT = 2;
    uint256 private constant KIND_CREDIT = 3;
    uint256 private constant KIND_DEPOSIT = 4;
    uint256 private constant KIND_WITHDRAWAL = 5;
    uint256 private constant KIND_LOCK_IN = 6;
    bytes32 public constant OUTCOME_DOMAIN = keccak256("HOOKEDIN/OUTCOME");
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant STATE_TYPEHASH = keccak256(
        "Checkpoint(address player,uint256 index,uint256 sequence,bytes32 previousStateHash,bytes32 transitionHash,uint256 balance,uint256 deposited,uint256 withdrawn)"
    );
    bytes32 constant OP_TYPEHASH = keccak256(
        "Operation(bytes32 previousStateHash,uint256 kind,uint256 amount,address recipient,uint256 fee,uint64 chance,uint256 prize,bytes32 round,bytes32 seedHash,bytes32 memo)"
    );
    bytes32 constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 previousStateHash,bytes32 round,uint256 virtualBankroll,uint256 expiresAt)"
    );
    bytes32 constant OFFER_TYPEHASH =
        keccak256("CollateralOffer(address player,uint256 index,uint256 amount,uint256 price,uint256 expiresAt)");
    // The struct hash of the all-zero operation: the one encoding of "no step".
    bytes32 constant EMPTY_OPERATION =
        keccak256(abi.encode(OP_TYPEHASH, bytes32(0), 0, 0, address(0), 0, 0, 0, bytes32(0), bytes32(0), bytes32(0)));
    // The same authority signs settlement evidence and withdraws house funds.
    // It can create winnings claims; no separate key can make those promises safe.
    // Historical signatures remain valid for the lifetime of this deployment.
    address public immutable owner;

    /// What the owner cannot withdraw and no winnings are paid out of: every channel's deposits and collateral, and every
    /// claim's protected part.
    uint256 public protectedFunds;
    uint256 public unpaidWinnings;
    /// Every claim's winnings, in the order the claims were recorded: the queue house cash pays them in.
    uint256 public queuedWinnings;
    /// What every collateral offer bought has paid.
    uint256 public collateralSales;
    bool transient private entered;

    /// A balance of the channel `index` of the account `player`. `deposited` is how much of the channel's on-chain
    /// deposits the balance has taken in and `withdrawn` how much it has paid out in withdrawals and lock-ins. A close adds
    /// the deposits not taken in and the withdrawals not yet claims.
    struct Checkpoint {
        address player;
        uint256 index;
        uint256 sequence;
        bytes32 previousStateHash;
        bytes32 transitionHash;
        uint256 balance;
        uint256 deposited;
        uint256 withdrawn;
    }

    /// The contract settles money: a casino bet, a debit, a credit, a deposit, a withdrawal or a lock-in. The hash
    /// of the checkpoint it follows names its channel and its place. What an operation means to the wallet and the casino
    /// (its name, its game, what it pays into or collects from) is the hash `memo`, which the contract does not read.
    struct Operation {
        bytes32 previousStateHash;
        uint256 kind;
        uint256 amount;
        // The address a withdrawal pays; zero for any other kind, a lock-in going into the account's own channel.
        address recipient;
        // What a withdrawal or a lock-in pays the casino for sending it to this contract, out of the balance.
        uint256 fee;
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

    /// The owner's quote for the casino bet that follows a checkpoint: the bet's round, the virtual bankroll it is
    /// admitted against, and until when it can be disputed. The operation names the checkpoint and the round.
    struct Quote {
        uint256 virtualBankroll;
        uint256 expiresAt;
        bytes signature;
    }

    /// An account's channel. The account signs every operation and checkpoint on it. It starts from its zero checkpoint,
    /// which needs no signature, and holds nothing on-chain until money or a close comes to it.
    struct Channel {
        uint64 deadline;
        uint8 status;
        // Everything ever deposited into the channel: what a state is owed is worked out from it.
        uint256 deposited;
        // The deposits the contract still holds for the channel, which withdrawals are paid out of first, each only out of
        // those its checkpoint took in.
        uint256 principal;
        // House cash locked into the channel by the collateral offers bought for it and by its disputes: it pays the
        // channel's withdrawals what its deposits do not, before house cash does, and its close what it is owed above them.
        // The owner cannot withdraw it, and what the close is not owed returns to house cash.
        uint256 collateral;
        // Everything the channel's withdrawals have made into claims, which it records in order: a withdrawal is recorded
        // once this has passed the `withdrawn` of the checkpoint it follows.
        uint256 claimed;
        uint256 closingSequence;
        bytes32 closingHash;
        uint256 closingBalance;
        // The prize of the casino bet the close disputes, until evidence at its sequence settles it, and kept by a close
        // that finalized with it won; 0 with none.
        uint256 disputedPrize;
        // The part of `collateral` the dispute locked, until evidence settles the bet; 0 with none.
        uint256 disputeHold;
    }

    /// What the contract owes, and to whom: a finalized channel's close, under `channelId`, or a withdrawal or a lock-in,
    /// under the hash of its operation. The beneficiary is the account it is owed to, which may redirect it. A recipient
    /// that is this contract is the beneficiary's current channel: what the claim pays goes into it as deposits. One paid
    /// in full at once, and a close owed nothing, leave no claim.
    struct Claim {
        address beneficiary;
        address recipient;
        uint256 protectedRemaining;
        uint256 winningsRemaining;
        // Where the claim's winnings end in the queue: `queuedWinnings` once they joined it; 0 with no winnings.
        uint256 queueEnd;
    }

    mapping(address => mapping(uint256 => Channel)) public channels;
    mapping(bytes32 => Claim) public claims;
    /// How many of an account's channels have started closing: the index of its current one.
    mapping(address => uint256) public channelIndex;
    /// The owner's collateral offers bought, each once, by the hash the owner signed.
    mapping(bytes32 => bool) public offersBought;
    event ChannelDeposit(address indexed player, uint256 indexed index, uint256 amount, uint256 deposited);
    event CollateralBought(
        address indexed player, uint256 indexed index, bytes32 indexed offer, uint256 amount, uint256 price
    );
    event Withdrawal(
        bytes32 indexed withdrawalId, address indexed player, uint256 indexed index, address recipient, uint256 amount
    );
    event CloseStarted(address indexed player, uint256 indexed index, uint256 sequence, bytes32 stateHash, uint256 deadline);
    event CloseChallenged(address indexed player, uint256 indexed index, uint256 sequence, bytes32 stateHash);
    // The close's new deadline, and the evidence the dispute brought: all the casino needs to settle the bet at its
    // sequence.
    event BetDisputed(address indexed player, uint256 indexed index, uint256 deadline, Evidence evidence);
    event CloseFinalized(
        address indexed player,
        uint256 indexed index,
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

    /// The ID of a channel's close in `claims`, and how anything off-chain keys a channel.
    function channelId(address player, uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encode(player, index));
    }

    // The account's current channel, active: the one after the last whose close started, which takes play and money.
    function _current(address player, uint256 index) private view returns (Channel storage c) {
        c = channels[player][index];
        if (c.status != STATUS_ACTIVE || index != channelIndex[player]) revert InvalidState();
    }

    // Anyone may deposit into any account's current channel. The balance takes the money in with a deposit operation the
    // casino signs; until then a close adds it to what the channel is owed.
    function deposit(address player) external payable nonReentrant {
        if (player == address(0) || player == address(this) || msg.value == 0) revert InvalidTerms();
        _deposit(player, msg.value);
    }

    // An account's current channel is never closing: a close that starts moves the account to its next one.
    function _deposit(address player, uint256 amount) private {
        uint256 index = channelIndex[player];
        Channel storage c = channels[player][index];
        if (c.deposited + amount >= MAX_BALANCE) revert InvalidTerms();
        c.deposited += amount;
        c.principal += amount;
        protectedFunds += amount;
        emit ChannelDeposit(player, index, amount, c.deposited);
    }

    function fundBankroll() external payable nonReentrant {
        if (msg.value == 0) revert InvalidTerms();
        emit BankrollFunded(msg.sender, msg.value);
    }

    // What no deposit and no unpaid winning is owed.
    function withdrawableHouse() public view returns (uint256) {
        uint256 owed = protectedFunds + unpaidWinnings;
        return address(this).balance > owed ? address(this).balance - owed : 0;
    }

    function withdrawHouse(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0) || amount == 0) revert InvalidTerms();
        if (amount > withdrawableHouse()) revert InsufficientBalance();
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit HouseWithdrawal(recipient, amount);
    }

    // Anyone buys collateral the owner offers for an account's current channel or a closing one, once and before the
    // offer expires: the price joins house cash, and the amount moves from house cash into the channel's collateral. It
    // adds nothing to what the channel is owed. An offer at no price is collateral the owner gives.
    function buyCollateral(address player, uint256 index, uint256 amount, uint256 expiresAt, bytes calldata signature)
        external
        payable
        nonReentrant
    {
        // The buyer pays the price: paying anything else is buying an offer the owner did not sign.
        bytes32 offer = _digest(keccak256(abi.encode(OFFER_TYPEHASH, player, index, amount, msg.value, expiresAt)));
        if (_signer(offer, signature) != owner) revert Unauthorized();
        Channel storage c = channels[player][index];
        if (
            offersBought[offer] || block.timestamp > expiresAt
                || (c.status == STATUS_ACTIVE ? index != channelIndex[player] : c.status != STATUS_CLOSING)
        ) revert InvalidState();
        if (amount > withdrawableHouse()) revert InsufficientBalance();
        offersBought[offer] = true;
        c.collateral += amount;
        protectedFunds += amount;
        collateralSales += msg.value;
        emit CollateralBought(player, index, offer, amount, msg.value);
    }

    // Anyone may have a withdrawal or a lock-in recorded: an operation the account signed, followed by the checkpoint the
    // casino signed after it, on the account's current channel or a closing one. It becomes a claim once, in the order the
    // account signed its channel's withdrawals and lock-ins, until the channel is finalized: out of the deposits its
    // checkpoint took in first, then the channel's collateral, and the rest winnings in the queue behind every claim
    // before it. What house cash reaches is paid at once: a withdrawal to its recipient, and a lock-in into the account's
    // current channel as deposits. The claim keeps the rest, or all of a withdrawal if its recipient refuses the payment,
    // for anyone to collect. One never recorded comes back with the close, which is owed what the channel's states
    // withdrew and did not make claims.
    function withdraw(Evidence calldata evidence) external nonReentrant {
        Operation calldata op = evidence.step.operation;
        bool lockIn = op.kind == KIND_LOCK_IN;
        if (op.kind != KIND_WITHDRAWAL && !lockIn) revert InvalidTerms();
        (Checkpoint memory s, bytes32 id) = _derive(evidence.base, _signedBase(evidence), evidence.step, false);
        Channel storage c = channels[s.player][s.index];
        if (c.status != STATUS_CLOSING) _current(s.player, s.index);
        // Every earlier withdrawal of the channel is a claim already, and this one is not; and a checkpoint pays out only
        // deposits the chain holds.
        if (c.claimed != evidence.base.withdrawn || s.deposited > c.deposited) revert InvalidState();
        c.claimed += op.amount;
        // Recorded during a close, the close owes that much less.
        if (c.status == STATUS_CLOSING) c.closingBalance = op.amount < c.closingBalance ? c.closingBalance - op.amount : 0;
        // A deposit its checkpoint did not take in stays the channel's, for its close. Recorded in order, the withdrawals
        // before it drew on no more than this checkpoint took in, unless the owner signed two histories.
        uint256 available = c.principal + s.deposited > c.deposited ? c.principal + s.deposited - c.deposited : 0;
        uint256 deposits = op.amount < available ? op.amount : available;
        uint256 collateral = op.amount - deposits < c.collateral ? op.amount - deposits : c.collateral;
        uint256 protectedAmount = deposits + collateral;
        uint256 winnings = op.amount - protectedAmount;
        c.principal -= deposits;
        c.collateral -= collateral;
        // A dispute's hold is part of the collateral, never more than what is left of it.
        if (c.disputeHold > c.collateral) c.disputeHold = c.collateral;
        unpaidWinnings += winnings;
        queuedWinnings += winnings;
        // A lock-in is paid into the account's current channel.
        address recipient = lockIn ? address(this) : op.recipient;
        emit Withdrawal(id, s.player, s.index, recipient, op.amount);
        uint256 reached = _reached(queuedWinnings, winnings);
        if (_send(id, s.player, recipient, protectedAmount, reached)) (protectedAmount, winnings) = (0, winnings - reached);
        if (protectedAmount + winnings != 0) {
            claims[id] = Claim(s.player, recipient, protectedAmount, winnings, winnings != 0 ? queuedWinnings : 0);
        }
    }

    // The checkpoint a step leads to from its base, and the hash of its operation. Every field an operation kind does not
    // use must be zero, so each signed operation has exactly one meaning and one encoding. A disputed casino bet has no
    // secret and no casino signature yet, and counts as won.
    function _derive(Checkpoint calldata base, bytes32 baseHash, Step calldata step, bool disputed)
        private
        view
        returns (Checkpoint memory next, bytes32 operationHash)
    {
        Operation calldata op = step.operation;
        if (op.previousStateHash != baseHash) revert InvalidState();
        operationHash = hashOperation(op);
        if (_signer(operationHash, step.authorization) != base.player) revert Unauthorized();
        next = base;
        next.sequence = base.sequence + 1;
        next.previousStateHash = baseHash;
        next.transitionHash = keccak256(abi.encode(operationHash, step.secret));
        bool casinoBet = op.kind == KIND_CASINO_BET;
        bool withdrawal = op.kind == KIND_WITHDRAWAL;
        bool pays = withdrawal || op.kind == KIND_LOCK_IN;
        if (op.amount == 0 || op.amount >= MAX_BALANCE || op.fee >= MAX_BALANCE) revert InvalidTerms();
        // Only a withdrawal names a recipient, never nobody and never this contract, and only it and a lock-in pay a fee.
        if (
            (withdrawal ? op.recipient == address(0) || op.recipient == address(this) : op.recipient != address(0))
                || (!pays && op.fee != 0)
        ) revert InvalidTerms();
        // A casino bet names two hashes: its round, the hash of a secret the casino fixed first, and the hash
        // of a seed. Only that secret and that seed settle it, and every bet on one round and seed
        // shares one outcome. Whoever holds one of the two cannot know the outcome before both are out.
        // Any other kind leaves all of it zero.
        if (
            casinoBet
                ? op.chance == 0 || op.prize == 0 || op.prize >= MAX_BALANCE
                    || (
                        disputed
                            ? step.secret != bytes32(0) || step.casinoSignature.length != 0
                            : keccak256(abi.encodePacked(step.secret)) != op.round
                    ) || keccak256(abi.encodePacked(step.seed)) != op.seedHash
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
            // The stake is paid to enter; a casino bet pays its prize when the outcome is below its chance. A withdrawal or
            // a lock-in pays its fee as well.
            if (op.amount + op.fee > base.balance) revert InvalidTerms();
            next.balance -= op.amount + op.fee;
            if (pays) next.withdrawn += op.amount;
            if (
                casinoBet
                    && (disputed || uint64(uint256(keccak256(abi.encode(OUTCOME_DOMAIN, step.seed, step.secret)))) < op.chance)
            ) {
                next.balance += op.prize;
            }
        } else {
            revert InvalidTerms();
        }
        _bounded(next);
        if (!disputed && _signer(hashState(next), step.casinoSignature) != owner) revert InvalidState();
    }

    // The evidence's base: the channel's zero checkpoint, which carries no signature, or one its account and the owner
    // signed. The account is the one the checkpoint names.
    function _signedBase(Evidence calldata evidence) private view returns (bytes32 h) {
        Checkpoint calldata base = evidence.base;
        if (base.player == address(0)) revert InvalidTerms();
        h = hashState(base);
        if (h == hashState(Checkpoint(base.player, base.index, 0, bytes32(0), bytes32(0), 0, 0, 0))) {
            if (evidence.playerSignature.length != 0 || evidence.casinoSignature.length != 0) revert InvalidTerms();
        } else if (_signer(h, evidence.playerSignature) != base.player || _signer(h, evidence.casinoSignature) != owner) {
            revert Unauthorized();
        }
    }

    function _bounded(Checkpoint memory s) private pure {
        if (s.balance >= MAX_BALANCE || s.deposited >= MAX_BALANCE || s.withdrawn >= MAX_BALANCE) {
            revert InvalidState();
        }
    }

    function supported(Evidence calldata evidence) public view returns (Checkpoint memory result) {
        bytes32 h = _signedBase(evidence);
        if (evidence.step.operation.kind == KIND_NONE) {
            // A checkpoint-only proof carries the canonical empty step: one meaning, one encoding.
            Step calldata step = evidence.step;
            if (
                step.authorization.length != 0 || step.casinoSignature.length != 0 || step.secret != bytes32(0)
                    || step.seed != bytes32(0)
                    || _operationStruct(step.operation) != EMPTY_OPERATION
            ) revert InvalidTerms();
            result = evidence.base;
            _bounded(result);
        } else {
            (result,) = _derive(evidence.base, h, evidence.step, false);
        }
    }

    // Whether a virtual bankroll admits a casino bet: the Kelly condition of its two outcomes with no commission, as
    // the casino's admission rule states it. A bet that pays no more than its stake costs the bankroll nothing.
    function _admits(uint256 bankroll, uint256 stake, uint256 chance, uint256 prize) private pure returns (bool) {
        if (prize <= stake) return bankroll + stake > prize;
        uint256 win = prize - stake;
        return win < bankroll && (bankroll - win) * stake * 2 ** 64 >= bankroll * chance * prize;
    }

    // What a supported state is owed: its balance, the deposits it has not taken in, and what it withdrew that is not yet a
    // claim, less what the channel's claims took that it did not withdraw and what it took in that the chain does not
    // hold; never below nothing. Every signed state can close.
    function _owed(Checkpoint memory s) private view returns (uint256) {
        Channel storage c = channels[s.player][s.index];
        uint256 owed = s.balance + c.deposited + s.withdrawn;
        uint256 taken = s.deposited + c.claimed;
        return owed > taken ? owed - taken : 0;
    }

    // A close of the account's current channel ends it at once for the account: its next channel takes play and money
    // from then on, while this one closes. Only the account or the owner starts one.
    function startClose(Evidence calldata evidence) external nonReentrant {
        Checkpoint memory s = supported(evidence);
        Channel storage c = _current(s.player, s.index);
        if (msg.sender != s.player && msg.sender != owner) revert Unauthorized();
        c.status = STATUS_CLOSING;
        channelIndex[s.player] += 1;
        c.deadline = uint64(block.timestamp + CHALLENGE_PERIOD);
        c.closingSequence = s.sequence;
        c.closingHash = hashState(s);
        c.closingBalance = _owed(s);
        emit CloseStarted(s.player, s.index, s.sequence, c.closingHash, c.deadline);
    }

    function challengeClose(Evidence calldata evidence) external nonReentrant {
        Checkpoint memory s = supported(evidence);
        Channel storage c = channels[s.player][s.index];
        // Only strictly newer evidence changes the proposed closing state, but a disputed casino bet is settled by
        // evidence at its own sequence: the casino's signed result of it, or of the operation the account signed there
        // instead.
        if (
            c.status != STATUS_CLOSING || block.timestamp >= c.deadline || s.sequence < c.closingSequence
                || (s.sequence == c.closingSequence && c.disputedPrize == 0)
        ) {
            revert InvalidState();
        }
        c.closingSequence = s.sequence;
        c.closingHash = hashState(s);
        c.closingBalance = _owed(s);
        c.disputedPrize = 0;
        // Settled, a disputed bet's hold returns to house cash but for what the close is now owed above the channel's
        // deposits and its other collateral.
        uint256 hold = c.disputeHold;
        uint256 rest = c.principal + c.collateral - hold;
        uint256 kept = c.closingBalance > rest ? c.closingBalance - rest : 0;
        if (kept < hold) {
            c.collateral -= hold - kept;
            protectedFunds -= hold - kept;
        }
        c.disputeHold = 0;
        emit CloseChallenged(s.player, s.index, s.sequence, c.closingHash);
    }

    // A casino bet the casino has not settled, which its quote covers: anyone disputes it before the quote expires, which
    // closes the channel with it or challenges its close. It counts as won until evidence at its sequence settles it,
    // which the casino has a challenge period from the dispute to send. What winning it adds above the channel's deposits
    // and collateral moves from house cash into its collateral, its hold, as far as house cash is free, so the owner
    // cannot take it while the casino settles the bet.
    function dispute(Evidence calldata evidence, Quote calldata quote) external nonReentrant {
        Step calldata step = evidence.step;
        Operation calldata op = step.operation;
        if (op.kind != KIND_CASINO_BET) revert InvalidTerms();
        (Checkpoint memory s,) = _derive(evidence.base, _signedBase(evidence), step, true);
        bytes32 quoteHash =
            keccak256(abi.encode(QUOTE_TYPEHASH, op.previousStateHash, op.round, quote.virtualBankroll, quote.expiresAt));
        if (_signer(_digest(quoteHash), quote.signature) != owner) revert Unauthorized();
        if (
            block.timestamp > quote.expiresAt || quote.virtualBankroll >= MAX_BALANCE
                || !_admits(quote.virtualBankroll, op.amount, op.chance, op.prize)
        ) revert InvalidTerms();
        Channel storage c = channels[s.player][s.index];
        if (c.status == STATUS_ACTIVE) {
            _current(s.player, s.index);
            c.status = STATUS_CLOSING;
            channelIndex[s.player] += 1;
        } else if (c.status != STATUS_CLOSING || block.timestamp >= c.deadline || s.sequence <= c.closingSequence) {
            revert InvalidState();
        }
        c.deadline = uint64(block.timestamp + CHALLENGE_PERIOD);
        c.closingSequence = s.sequence;
        c.closingHash = hashState(s);
        c.closingBalance = _owed(s);
        c.disputedPrize = op.prize;
        uint256 held = c.principal + c.collateral;
        uint256 hold = op.prize > op.amount ? op.prize - op.amount : 0;
        if (held + hold > c.closingBalance) hold = c.closingBalance > held ? c.closingBalance - held : 0;
        if (hold > withdrawableHouse()) hold = withdrawableHouse();
        c.collateral += hold;
        c.disputeHold += hold;
        protectedFunds += hold;
        emit BetDisputed(s.player, s.index, c.deadline, evidence);
    }

    // Finalization only establishes debt, owed to the player; collection is an independent transaction.
    function finalizeClose(address player, uint256 index) external nonReentrant {
        Channel storage c = channels[player][index];
        if (c.status != STATUS_CLOSING || block.timestamp < c.deadline) revert InvalidState();
        c.status = STATUS_FINALIZED;
        bytes32 stateHash = c.closingHash;
        uint256 balance = c.closingBalance;
        // The deposits pay first and the collateral the rest; what neither pays is winnings.
        uint256 held = c.principal + c.collateral;
        uint256 protectedAmount = balance < held ? balance : held;
        uint256 winnings = balance - protectedAmount;
        protectedFunds = protectedFunds - held + protectedAmount;
        // The claim holds the protected amount from here on, and its winnings join the queue behind every claim before it. A
        // close owed nothing leaves no claim.
        (c.principal, c.collateral, c.disputeHold) = (0, 0, 0);
        unpaidWinnings += winnings;
        queuedWinnings += winnings;
        if (balance != 0) {
            claims[channelId(player, index)] =
                Claim(player, player, protectedAmount, winnings, winnings != 0 ? queuedWinnings : 0);
        }
        emit CloseFinalized(player, index, stateHash, balance, protectedAmount, winnings);
    }

    /// What collecting a claim pays now: its protected amount, and as much of its winnings as house cash reaches.
    function collectable(bytes32 id) external view returns (uint256) {
        Claim storage k = claims[id];
        return k.protectedRemaining + _reached(k.queueEnd, k.winningsRemaining);
    }

    // How much of `winnings`, ending at `queueEnd` in the winnings queue, house cash reaches. It pays the queue in order:
    // all of it but the unpaid winnings at its end that it cannot cover.
    function _reached(uint256 queueEnd, uint256 winnings) private view returns (uint256) {
        uint256 cash = address(this).balance - protectedFunds;
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
        uint256 protectedAmount = k.protectedRemaining;
        uint256 winnings = _reached(k.queueEnd, k.winningsRemaining);
        (k.protectedRemaining, k.winningsRemaining) = (0, k.winningsRemaining - winnings);
        if (!_send(id, k.beneficiary, k.recipient, protectedAmount, winnings)) revert TransferFailed();
    }

    // Pays a claim's protected amount and winnings: into its beneficiary's current channel when the recipient is this contract,
    // and otherwise sent with 100,000 gas, whatever the recipient returns left uncopied so it costs the sender nothing.
    // Says whether the recipient took it; a refusal leaves all of it owed.
    function _send(bytes32 id, address beneficiary, address recipient, uint256 protectedAmount, uint256 winnings)
        private
        returns (bool ok)
    {
        uint256 amount = protectedAmount + winnings;
        if (amount == 0) return true;
        protectedFunds -= protectedAmount;
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
        else (protectedFunds, unpaidWinnings) = (protectedFunds + protectedAmount, unpaidWinnings + winnings);
    }

}
