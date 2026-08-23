// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {ClaimLinkEscrow} from "../src/ClaimLinkEscrow.sol";

contract ClaimLinkEscrowHandler is Test {
    ClaimLinkEscrow public immutable escrow;

    uint256 public activeLiability;
    uint256 public forcedFunds;
    uint256 public createdCount;
    uint256 public settledCount;

    bytes32[] private _linkIds;
    mapping(bytes32 linkId => uint256 signerKey) private _signerKeys;

    constructor(ClaimLinkEscrow escrow_) {
        escrow = escrow_;
    }

    function create(uint256 rawSenderKey, uint256 rawSignerKey, uint96 rawAmount) external {
        uint256 senderKey = bound(rawSenderKey, 1, SECP256K1_ORDER - 1);
        uint256 signerKey = bound(rawSignerKey, 1, SECP256K1_ORDER - 1);
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000e18);
        address sender = vm.addr(senderKey);
        address claimSigner = vm.addr(signerKey);
        bytes32 linkId = escrow.computeLinkId(sender, claimSigner);
        (,,,, ClaimLinkEscrow.PaymentStatus status) = escrow.payments(linkId);
        if (status != ClaimLinkEscrow.PaymentStatus.Unset) return;

        vm.deal(sender, amount);
        vm.prank(sender);
        escrow.createClaimLink{value: amount}(claimSigner);

        _linkIds.push(linkId);
        _signerKeys[linkId] = signerKey;
        activeLiability += amount;
        createdCount += 1;
    }

    function claim(uint256 rawIndex, uint256 rawRecipientKey) external {
        if (_linkIds.length == 0) return;
        bytes32 linkId = _linkIds[rawIndex % _linkIds.length];
        (,, uint256 amount, uint256 expiresAt, ClaimLinkEscrow.PaymentStatus status) = escrow.payments(linkId);
        if (status != ClaimLinkEscrow.PaymentStatus.Active || block.timestamp >= expiresAt) return;

        uint256 recipientKey = bound(rawRecipientKey, 1, SECP256K1_ORDER - 1);
        address recipient = vm.addr(recipientKey);
        bytes32 digest = escrow.claimDigest(linkId, recipient);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_signerKeys[linkId], digest);

        vm.prank(recipient);
        escrow.claim(linkId, abi.encodePacked(r, s, v));

        activeLiability -= amount;
        settledCount += 1;
    }

    function refund(uint256 rawIndex) external {
        if (_linkIds.length == 0) return;
        bytes32 linkId = _linkIds[rawIndex % _linkIds.length];
        (address sender,, uint256 amount, uint256 expiresAt, ClaimLinkEscrow.PaymentStatus status) =
            escrow.payments(linkId);
        if (status != ClaimLinkEscrow.PaymentStatus.Active) return;
        if (block.timestamp < expiresAt) vm.warp(expiresAt);

        vm.prank(sender);
        escrow.refund(linkId);

        activeLiability -= amount;
        settledCount += 1;
    }

    function forceBalance(uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 0, 1_000_000e18);
        vm.deal(address(escrow), address(escrow).balance + amount);
        forcedFunds += amount;
    }

    function storedActiveLiability() external view returns (uint256 total) {
        for (uint256 index; index < _linkIds.length; ++index) {
            (,, uint256 amount,, ClaimLinkEscrow.PaymentStatus status) = escrow.payments(_linkIds[index]);
            if (status == ClaimLinkEscrow.PaymentStatus.Active) total += amount;
        }
    }
}

contract ClaimLinkEscrowInvariantTest is StdInvariant, Test {
    ClaimLinkEscrow private escrow;
    ClaimLinkEscrowHandler private handler;

    function setUp() public {
        escrow = new ClaimLinkEscrow();
        handler = new ClaimLinkEscrowHandler(escrow);
        targetContract(address(handler));
    }

    function invariantEscrowBalanceCoversEveryActivePayment() public view {
        assertGe(address(escrow).balance, handler.activeLiability());
        assertEq(address(escrow).balance, handler.activeLiability() + handler.forcedFunds());
    }

    function invariantTrackedLiabilityMatchesPermanentPaymentRecords() public view {
        assertEq(handler.storedActiveLiability(), handler.activeLiability());
        assertLe(handler.settledCount(), handler.createdCount());
    }
}
