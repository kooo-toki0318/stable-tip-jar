// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClaimLinkEscrow} from "../src/ClaimLinkEscrow.sol";

/// @dev Mirrors test-vectors/claim-link-eip712-v1.json for frontend/contract interoperability.
contract ClaimLinkEscrowVectorTest is Test {
    uint256 private constant VECTOR_CHAIN_ID = 5_042_002;
    address private constant VECTOR_SENDER = address(0xb1);
    address private constant VECTOR_CLAIM_SIGNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address private constant VECTOR_RECIPIENT = address(0xa1);
    address private constant VECTOR_CONTRACT = address(0xe1);
    bytes32 private constant VECTOR_LINK_ID = 0x53ec4d8588c7559cdf17b9dca112e19bccfe6fe1bd38fd898db60891afe73dd6;
    bytes32 private constant VECTOR_DIGEST = 0xbd0d7fd25e91c4c8d798c807d99a588ad1db15069d311c570ae94a0567196058;

    ClaimLinkEscrow private escrow;

    function setUp() public {
        vm.chainId(VECTOR_CHAIN_ID);

        ClaimLinkEscrow implementation = new ClaimLinkEscrow();
        vm.etch(VECTOR_CONTRACT, address(implementation).code);
        escrow = ClaimLinkEscrow(VECTOR_CONTRACT);

        vm.deal(VECTOR_SENDER, 1e18);
        vm.prank(VECTOR_SENDER);
        bytes32 linkId = escrow.createClaimLink{value: 1e18}(VECTOR_CLAIM_SIGNER);
        assertEq(linkId, VECTOR_LINK_ID);
    }

    function testHardCodedCrossLanguageSignatureClaims() public {
        bytes memory signature =
            hex"966370b095b08c36a37ffc1cab23646b5b57f7d4ae3da4b1f4dae68260beecb825ac7c1a6355d24f110d3d0d1e0b2242de09bef2bc4e7e6d4818160a31f9ca911c";

        assertEq(escrow.claimDigest(VECTOR_LINK_ID, VECTOR_RECIPIENT), VECTOR_DIGEST);
        vm.prank(VECTOR_RECIPIENT);
        escrow.claim(VECTOR_LINK_ID, signature);

        assertEq(VECTOR_RECIPIENT.balance, 1e18);
        ClaimLinkEscrow.Payment memory payment = escrow.getPayment(VECTOR_LINK_ID);
        assertEq(uint256(payment.status), uint256(ClaimLinkEscrow.PaymentStatus.Claimed));
    }

    function testHardCodedSignatureRejectsChangedRecipient() public {
        bytes memory signature =
            hex"966370b095b08c36a37ffc1cab23646b5b57f7d4ae3da4b1f4dae68260beecb825ac7c1a6355d24f110d3d0d1e0b2242de09bef2bc4e7e6d4818160a31f9ca911c";
        address changedRecipient = address(0xa2);

        vm.prank(changedRecipient);
        vm.expectRevert(ClaimLinkEscrow.InvalidSignature.selector);
        escrow.claim(VECTOR_LINK_ID, signature);

        ClaimLinkEscrow.Payment memory payment = escrow.getPayment(VECTOR_LINK_ID);
        assertEq(uint256(payment.status), uint256(ClaimLinkEscrow.PaymentStatus.Active));
    }
}
