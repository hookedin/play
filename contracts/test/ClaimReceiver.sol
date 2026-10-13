// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "../HookedInCasino.sol";
contract ClaimReceiver {
    HookedInCasino immutable casino;
    address immutable controller;
    uint256 public mode = 1;
    bytes32 public channelId;
    bool public reentryRejected;
    uint256 public stored;
    mapping(uint256 => uint256) public kept;
    constructor(HookedInCasino target) { casino=target; controller=msg.sender; }
    function setMode(uint256 value) external { require(msg.sender==controller);mode=value; }
    function close(HookedInCasino.Evidence calldata evidence) external {require(msg.sender==controller);channelId=casino.channelId(evidence.base.player, evidence.base.index);casino.startClose(evidence);}
    function redirect(bytes32 id, address recipient) external { require(msg.sender==controller); casino.claimTo(id, recipient); }
    function collectTwice(bytes32 id) external { require(msg.sender==controller); casino.claim(id); casino.claim(id); }
    receive() external payable {
        if(mode==1)revert("recipient unavailable");
        if(mode==2){try casino.claim(channelId){reentryRejected=false;}catch{reentryRejected=true;}}
        if(mode==3){assembly { invalid() }} // Consume the entire forwarded gas budget.
        if(mode==4){assembly { return(0, 150000) }} // Accept, returning as much data as the gas allows.
        if(mode==5 && tx.gasprice!=0){assembly { invalid() }} // Accept only in a gas estimate, which runs at no gas price.
        if(mode==6){for(uint256 i=0;i<8;i++)kept[stored++]=1;} // Accept, spending more gas than a recorded withdrawal gives.
    }
}
