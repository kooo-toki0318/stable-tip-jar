// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArcTipJar
/// @notice Accepts Arc's native USDC as tips and records an optional message.
/// @dev Arc's native gas asset uses 18 decimals when sent as msg.value.
contract ArcTipJar {
    error OnlyOwner();
    error ZeroTip();
    error MessageTooLong();
    error InvalidRecipient();
    error ZeroWithdrawal();
    error InsufficientBalance();
    error TransferFailed();
    error ReentrantCall();
    error TipNotFound();
    error NoPendingOwner();

    struct Tip {
        address sender;
        uint256 amount;
        uint256 timestamp;
        string message;
    }

    address public owner;
    address public pendingOwner;
    uint256 public totalTipsReceived;
    uint256 public totalWithdrawn;
    mapping(address sender => uint256 amount) public tipsByAddress;

    Tip[] private _tips;
    bool private _entered;

    event TipReceived(address indexed sender, uint256 amount, string message);

    event Withdrawal(address indexed recipient, uint256 amount);

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Start a two-step ownership transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidRecipient();

        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept ownership after being nominated by the current owner.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NoPendingOwner();

        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);

        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    /// @notice Send a tip with an optional message.
    /// @param message A UTF-8 message up to 280 bytes.
    function tip(string calldata message) external payable {
        _recordTip(message);
    }

    /// @notice Plain native-USDC transfers are also accepted as tips.
    receive() external payable {
        _recordTip("");
    }

    /// @notice Number of tips recorded by the contract.
    function tipCount() external view returns (uint256) {
        return _tips.length;
    }

    /// @notice Read a tip by its zero-based index.
    function getTip(uint256 index)
        external
        view
        returns (address sender, uint256 amount, uint256 timestamp, string memory message)
    {
        if (index >= _tips.length) revert TipNotFound();

        Tip storage storedTip = _tips[index];
        return (storedTip.sender, storedTip.amount, storedTip.timestamp, storedTip.message);
    }

    /// @notice Current native-USDC balance held by the jar.
    function jarBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Withdraw a specified amount to a recipient.
    function withdraw(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        _withdraw(recipient, amount);
    }

    /// @notice Withdraw the entire jar balance to a recipient.
    function withdrawAll(address payable recipient) external onlyOwner nonReentrant {
        _withdraw(recipient, address(this).balance);
    }

    function _recordTip(string memory message) private {
        if (msg.value == 0) revert ZeroTip();
        if (bytes(message).length > 280) revert MessageTooLong();

        totalTipsReceived += msg.value;
        tipsByAddress[msg.sender] += msg.value;
        _tips.push(Tip({sender: msg.sender, amount: msg.value, timestamp: block.timestamp, message: message}));

        emit TipReceived(msg.sender, msg.value, message);
    }

    function _withdraw(address payable recipient, uint256 amount) private {
        if (recipient == address(0)) revert InvalidRecipient();
        if (amount == 0) revert ZeroWithdrawal();
        if (amount > address(this).balance) revert InsufficientBalance();

        totalWithdrawn += amount;

        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();

        emit Withdrawal(recipient, amount);
    }
}
