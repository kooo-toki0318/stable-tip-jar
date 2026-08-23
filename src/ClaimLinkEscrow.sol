// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title ClaimLinkEscrow
/// @notice Holds one-time native USDC payments that can be claimed with a link secret.
/// @dev Arc native USDC uses 18 decimals when sent as msg.value.
contract ClaimLinkEscrow is EIP712, ReentrancyGuard {
    error ZeroAmount();
    error InvalidClaimSigner();
    error LinkAlreadyExists(bytes32 linkId);
    error PaymentNotActive(bytes32 linkId);
    error ClaimExpired(uint256 expiresAt);
    error RefundNotAvailable(uint256 expiresAt);
    error UnauthorizedSender();
    error InvalidSignature();
    error TransferFailed();
    error SenderLinkIndexOutOfBounds(address sender, uint256 index);

    enum PaymentStatus {
        Unset,
        Active,
        Claimed,
        Refunded
    }

    struct Payment {
        address sender;
        address claimSigner;
        uint256 amount;
        uint256 expiresAt;
        PaymentStatus status;
    }

    string public constant EIP712_NAME = "ClaimLinkEscrow";
    string public constant EIP712_VERSION = "1";
    uint256 public constant LINK_DURATION = 7 days;
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(bytes32 linkId,address recipient)");

    mapping(bytes32 linkId => Payment payment) public payments;
    mapping(address sender => bytes32[] linkIds) private _senderLinks;

    event ClaimLinkCreated(
        bytes32 indexed linkId, address indexed sender, address indexed claimSigner, uint256 amount, uint256 expiresAt
    );
    event ClaimLinkClaimed(bytes32 indexed linkId, address indexed recipient, uint256 amount);
    event ClaimLinkRefunded(bytes32 indexed linkId, address indexed sender, uint256 amount);

    constructor() EIP712(EIP712_NAME, EIP712_VERSION) {}

    /// @notice Creates a one-time payment link funded with native USDC.
    /// @param claimSigner Address derived from the link's ephemeral private key.
    /// @return linkId Deterministic identifier for this sender and claim signer.
    function createClaimLink(address claimSigner) external payable returns (bytes32 linkId) {
        if (msg.value == 0) revert ZeroAmount();
        if (claimSigner == address(0)) revert InvalidClaimSigner();

        linkId = computeLinkId(msg.sender, claimSigner);
        if (payments[linkId].status != PaymentStatus.Unset) revert LinkAlreadyExists(linkId);

        uint256 expiresAt = block.timestamp + LINK_DURATION;
        payments[linkId] = Payment({
            sender: msg.sender,
            claimSigner: claimSigner,
            amount: msg.value,
            expiresAt: expiresAt,
            status: PaymentStatus.Active
        });
        _senderLinks[msg.sender].push(linkId);

        emit ClaimLinkCreated(linkId, msg.sender, claimSigner, msg.value, expiresAt);
    }

    /// @notice Claims an active payment to the caller.
    /// @dev The signature is bound to both linkId and msg.sender through EIP-712.
    function claim(bytes32 linkId, bytes calldata signature) external nonReentrant {
        Payment storage payment = payments[linkId];
        if (payment.status != PaymentStatus.Active) revert PaymentNotActive(linkId);
        if (block.timestamp >= payment.expiresAt) revert ClaimExpired(payment.expiresAt);

        bytes32 digest = claimDigest(linkId, msg.sender);
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (recoverError != ECDSA.RecoverError.NoError || recovered != payment.claimSigner) {
            revert InvalidSignature();
        }

        uint256 amount = payment.amount;
        payment.status = PaymentStatus.Claimed;

        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit ClaimLinkClaimed(linkId, msg.sender, amount);
    }

    /// @notice Refunds an expired active payment to its original sender.
    function refund(bytes32 linkId) external nonReentrant {
        Payment storage payment = payments[linkId];
        if (payment.status != PaymentStatus.Active) revert PaymentNotActive(linkId);
        if (msg.sender != payment.sender) revert UnauthorizedSender();
        if (block.timestamp < payment.expiresAt) revert RefundNotAvailable(payment.expiresAt);

        uint256 amount = payment.amount;
        payment.status = PaymentStatus.Refunded;

        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit ClaimLinkRefunded(linkId, msg.sender, amount);
    }

    function getPayment(bytes32 linkId) external view returns (Payment memory) {
        return payments[linkId];
    }

    function computeLinkId(address sender, address claimSigner) public pure returns (bytes32) {
        return keccak256(abi.encode(sender, claimSigner));
    }

    function claimDigest(bytes32 linkId, address recipient) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, linkId, recipient)));
    }

    function senderLinkCount(address sender) external view returns (uint256) {
        return _senderLinks[sender].length;
    }

    function senderLinkAt(address sender, uint256 index) external view returns (bytes32) {
        if (index >= _senderLinks[sender].length) revert SenderLinkIndexOutOfBounds(sender, index);
        return _senderLinks[sender][index];
    }
}
