// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Test-only forced ETH: creation and destruction happen in one transaction.
contract ForceFunding {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}
