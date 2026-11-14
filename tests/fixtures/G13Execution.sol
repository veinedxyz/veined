// SPDX-License-Identifier: UNLICENSED
// G13 SYNTHETIC_TEST_ONLY contracts for the in-memory EVM simulation tests (never deployed anywhere).
pragma solidity ^0.8.20;

contract TestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address holder, uint256 amount) {
        balanceOf[holder] = amount;
        emit Transfer(address(0), holder, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// Pulls exactly `amount` and pays `out` to `recipient`.
contract FairRouter {
    function swap(address tokenIn, address tokenOut, uint256 amount, uint256 out, address recipient) external {
        TestToken(tokenIn).transferFrom(msg.sender, address(this), amount);
        TestToken(tokenOut).transfer(recipient, out);
    }
}

/// Pulls everything the allowance permits, whatever `amount` says.
contract GreedyRouter {
    function swap(address tokenIn, address tokenOut, uint256 amount, uint256 out, address recipient) external {
        uint256 a = TestToken(tokenIn).allowance(msg.sender, address(this));
        uint256 b = TestToken(tokenIn).balanceOf(msg.sender);
        TestToken(tokenIn).transferFrom(msg.sender, address(this), a < b ? a : b);
        TestToken(tokenOut).transfer(recipient, out);
        amount;
    }
}

/// Pulls `amount` but keeps the output instead of paying the recipient.
contract RedirectRouter {
    function swap(address tokenIn, address tokenOut, uint256 amount, uint256 out, address recipient) external {
        TestToken(tokenIn).transferFrom(msg.sender, address(this), amount);
        TestToken(tokenOut).transfer(address(this), out);
        recipient;
    }
}
