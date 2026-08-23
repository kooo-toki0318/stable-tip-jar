// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClaimLinkEscrow} from "../src/ClaimLinkEscrow.sol";

contract ClaimLinkEscrowMessageTest is Test {
    ClaimLinkEscrow private escrow;
    address private sender;
    address private claimSigner;

    function setUp() public {
        escrow = new ClaimLinkEscrow();
        sender = makeAddr("sender");
        claimSigner = makeAddr("claim signer");
        vm.deal(sender, 10 ether);
    }

    function testCreateWithMessageStoresPublicMessage() public {
        vm.prank(sender);
        bytes32 linkId = escrow.createClaimLink{value: 1 ether}(
            claimSigner,
            "Thanks for helping with the project!"
        );

        assertEq(
            escrow.getMessage(linkId),
            "Thanks for helping with the project!"
        );
        ClaimLinkEscrow.Payment memory payment = escrow.getPayment(linkId);
        assertEq(payment.sender, sender);
        assertEq(payment.claimSigner, claimSigner);
        assertEq(payment.amount, 1 ether);
        assertEq(
            uint256(payment.status),
            uint256(ClaimLinkEscrow.PaymentStatus.Active)
        );
    }

    function testLegacyCreateStillStoresEmptyMessage() public {
        vm.prank(sender);
        bytes32 linkId =
            escrow.createClaimLink{value: 1 ether}(claimSigner);

        assertEq(escrow.getMessage(linkId), "");
    }

    function testAcceptsExactly280MessageBytes() public {
        string memory message = string(new bytes(280));

        vm.prank(sender);
        bytes32 linkId =
            escrow.createClaimLink{value: 1 ether}(claimSigner, message);

        assertEq(bytes(escrow.getMessage(linkId)).length, 280);
    }

    function testRejects281MessageBytes() public {
        string memory message = string(new bytes(281));

        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClaimLinkEscrow.MessageTooLong.selector,
                281
            )
        );
        escrow.createClaimLink{value: 1 ether}(claimSigner, message);
    }
}
