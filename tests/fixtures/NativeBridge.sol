// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Synthetic test contract. It is not ONEbridge and must never be deployed publicly.
contract NativeBridgeFixture {
  event Initiated(uint256 indexed destinationChain,uint256 indexed index,address recipient,uint256 amount);
  function bridgeToken(uint256 destinationChain,address token,address recipient,uint256 amount,uint256 networkFee,uint256 serviceFee,bytes calldata extraData) external payable returns(bool) {
    require(destinationChain==31338 && token==address(1),"route");
    require(amount>0 && recipient!=address(0) && extraData.length==0,"intent");
    require(msg.value==amount+networkFee+serviceFee,"exact value");
    emit Initiated(destinationChain,7,recipient,amount);
    return true;
  }
}
