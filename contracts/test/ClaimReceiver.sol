// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "../HookedInCasino.sol";
contract ClaimReceiver {
    HookedInCasino immutable casino;
    address immutable controller;
    uint256 public mode = 1;
    bytes32 public channelId;
    bool public reentryRejected;
    constructor(HookedInCasino target) { casino=target; controller=msg.sender; }
    function setMode(uint256 value) external { require(msg.sender==controller);mode=value; }
    function open(address signer) external payable {require(msg.sender==controller);channelId=casino.openChannel{value:msg.value}(signer);}
    function close(HookedInCasino.Evidence calldata evidence) external {require(msg.sender==controller);casino.startClose(evidence);}
    function redirect(bytes32 id, address recipient) external { require(msg.sender==controller); casino.claimTo(id, recipient); }
    function collectTwice(bytes32 id) external { require(msg.sender==controller); casino.claim(id); casino.claim(id); }
    receive() external payable {
        if(mode==1)revert("recipient unavailable");
        if(mode==2){try casino.claim(channelId){reentryRejected=false;}catch{reentryRejected=true;}}
        if(mode==3){assembly { invalid() }} // Consume the entire forwarded gas budget.
    }
}
