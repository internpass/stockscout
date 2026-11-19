// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StockScout FeeSplitter
/// @notice Receives USDC research fees paid to the StockScout agent (via x402) and
///         splits every payment by the published rule:
///           30% -> agent operations wallet
///           70% -> tokenized-stock allocation vault (accumulates toward stock purchases)
/// @dev Minimal by design: no admin withdrawal path for the allocation share, no
///      upgradeability, no external calls beyond ERC-20 transfers. Deploy target:
///      Base Sepolia for the Stocks Maxxing demo; mainnet deployment reuses the
///      same bytecode with mainnet USDC.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract FeeSplitter {
    IERC20 public immutable usdc;
    address public immutable opsWallet;
    address public immutable allocationVault;

    uint256 public constant OPS_BPS = 3000; // 30%
    uint256 public constant BPS = 10_000;

    uint256 public totalReceived;
    uint256 public totalOps;
    uint256 public totalAllocated;

    event FeeReceived(address indexed payer, uint256 amount, string ticker);
    event FeeSplit(uint256 opsAmount, uint256 allocationAmount);

    constructor(address _usdc, address _opsWallet, address _allocationVault) {
        require(_usdc != address(0) && _opsWallet != address(0) && _allocationVault != address(0), "zero address");
        usdc = IERC20(_usdc);
        opsWallet = _opsWallet;
        allocationVault = _allocationVault;
    }

    /// @notice Split the contract's whole USDC balance by the 30/70 rule.
    /// @dev Anyone may call this; funds can only ever go to the two fixed wallets.
    function distribute() external {
        uint256 bal = usdc.balanceOf(address(this));
        require(bal > 0, "nothing to distribute");
        uint256 opsAmount = (bal * OPS_BPS) / BPS;
        uint256 allocationAmount = bal - opsAmount;
        totalReceived += bal;
        totalOps += opsAmount;
        totalAllocated += allocationAmount;
        require(usdc.transfer(opsWallet, opsAmount), "ops transfer failed");
        require(usdc.transfer(allocationVault, allocationAmount), "allocation transfer failed");
        emit FeeSplit(opsAmount, allocationAmount);
    }

    /// @notice Log a research-fee payment against a ticker (called by the payer's
    ///         settlement flow after transferring USDC to this contract).
    function notePayment(uint256 amount, string calldata ticker) external {
        emit FeeReceived(msg.sender, amount, ticker);
    }
}
