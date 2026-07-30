// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArcTipJar
/// @notice Sends native USDC tips to recipient-specific jars on Arc.
/// @dev Arc native USDC uses 18 decimals when sent as msg.value.
contract ArcTipJar {
    error ZeroTip();
    error MessageTooLong();
    error InvalidRecipient();
    error NothingToClaim();
    error TransferFailed();
    error ReentrantCall();
    error TipNotFound();

    struct Tip {
        address sender;
        uint256 amount;
        uint256 timestamp;
        string message;
    }

    struct Claim {
        uint256 amount;
        uint256 timestamp;
    }

    uint256 public totalTipsReceived;
    uint256 public totalClaimed;
    mapping(address recipient => uint256 amount) public claimableBalance;
    mapping(address recipient => uint256 count) public claimableTipCount;
    mapping(address recipient => uint256 amount) public receivedByRecipient;
    mapping(address recipient => uint256 amount) public claimedByRecipient;
    mapping(address recipient => Tip[]) private _recipientTips;
    mapping(address recipient => Claim[]) private _recipientClaims;
    bool private _entered;

    event TipReceived(address indexed sender, address indexed recipient, uint256 amount, string message);
    event Claimed(address indexed recipient, uint256 amount);

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    /// @notice Send a tip to a recipient with an optional message.
    function tip(address recipient, string calldata message) external payable {
        _recordTip(recipient, message);
    }

    /// @notice A plain transfer creates a self-tip for the sender.
    receive() external payable {
        _recordTip(msg.sender, "");
    }

    function recipientTipCount(address recipient) external view returns (uint256) {
        return _recipientTips[recipient].length;
    }

    function getRecipientTip(address recipient, uint256 index)
        external
        view
        returns (address sender, uint256 amount, uint256 timestamp, string memory message)
    {
        if (index >= _recipientTips[recipient].length) revert TipNotFound();
        Tip storage storedTip = _recipientTips[recipient][index];
        return (storedTip.sender, storedTip.amount, storedTip.timestamp, storedTip.message);
    }

    function recipientClaimCount(address recipient) external view returns (uint256) {
        return _recipientClaims[recipient].length;
    }

    function getRecipientClaim(address recipient, uint256 index)
        external
        view
        returns (uint256 amount, uint256 timestamp)
    {
        if (index >= _recipientClaims[recipient].length) revert TipNotFound();
        Claim storage storedClaim = _recipientClaims[recipient][index];
        return (storedClaim.amount, storedClaim.timestamp);
    }

    /// @notice Claim the caller's entire recipient-specific jar balance.
    function claim() external nonReentrant {
        uint256 amount = claimableBalance[msg.sender];
        if (amount == 0) revert NothingToClaim();

        claimableBalance[msg.sender] = 0;
        claimableTipCount[msg.sender] = 0;
        claimedByRecipient[msg.sender] += amount;
        totalClaimed += amount;
        _recipientClaims[msg.sender].push(Claim({amount: amount, timestamp: block.timestamp}));

        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit Claimed(msg.sender, amount);
    }

    function _recordTip(address recipient, string memory message) private {
        if (recipient == address(0)) revert InvalidRecipient();
        if (msg.value == 0) revert ZeroTip();
        if (bytes(message).length > 280) revert MessageTooLong();

        totalTipsReceived += msg.value;
        claimableBalance[recipient] += msg.value;
        claimableTipCount[recipient] += 1;
        receivedByRecipient[recipient] += msg.value;
        _recipientTips[recipient].push(
            Tip({sender: msg.sender, amount: msg.value, timestamp: block.timestamp, message: message})
        );

        emit TipReceived(msg.sender, recipient, msg.value, message);
    }
}
