// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcTipJar} from "../src/ArcTipJar.sol";

contract ArcTipJarTest is Test {
    uint256 private constant ONE_USDC_NATIVE = 1e18;

    ArcTipJar private jar;
    address private alice;
    address private bob;
    address private recipient;

    event TipReceived(address indexed sender, address indexed recipient, uint256 amount, string message);
    event Claimed(address indexed recipient, uint256 amount);

    function setUp() public {
        jar = new ArcTipJar();
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        recipient = makeAddr("recipient");
        vm.deal(alice, 10 * ONE_USDC_NATIVE);
        vm.deal(bob, 10 * ONE_USDC_NATIVE);
    }

    function testTipCreditsSelectedRecipient() public {
        vm.expectEmit(true, true, false, true, address(jar));
        emit TipReceived(alice, recipient, 2 * ONE_USDC_NATIVE, "thank you");

        vm.prank(alice);
        jar.tip{value: 2 * ONE_USDC_NATIVE}(recipient, "thank you");

        assertEq(jar.claimableBalance(recipient), 2 * ONE_USDC_NATIVE);
        assertEq(jar.receivedByRecipient(recipient), 2 * ONE_USDC_NATIVE);
        assertEq(jar.claimableTipCount(recipient), 1);
        assertEq(jar.recipientTipCount(recipient), 1);
        assertEq(jar.totalTipsReceived(), 2 * ONE_USDC_NATIVE);

        (address sender, uint256 amount,, string memory message) = jar.getRecipientTip(recipient, 0);
        assertEq(sender, alice);
        assertEq(amount, 2 * ONE_USDC_NATIVE);
        assertEq(message, "thank you");
    }

    function testRecipientsHaveIndependentJars() public {
        vm.prank(alice);
        jar.tip{value: ONE_USDC_NATIVE}(recipient, "for recipient");
        vm.prank(bob);
        jar.tip{value: 2 * ONE_USDC_NATIVE}(alice, "for alice");

        assertEq(jar.claimableBalance(recipient), ONE_USDC_NATIVE);
        assertEq(jar.claimableBalance(alice), 2 * ONE_USDC_NATIVE);
        assertEq(jar.recipientTipCount(recipient), 1);
        assertEq(jar.recipientTipCount(alice), 1);
    }

    function testRecipientClaimsOwnJar() public {
        vm.prank(alice);
        jar.tip{value: 3 * ONE_USDC_NATIVE}(recipient, "tip");

        vm.expectEmit(true, false, false, true, address(jar));
        emit Claimed(recipient, 3 * ONE_USDC_NATIVE);
        vm.prank(recipient);
        jar.claim();

        assertEq(recipient.balance, 3 * ONE_USDC_NATIVE);
        assertEq(jar.claimableBalance(recipient), 0);
        assertEq(jar.claimableTipCount(recipient), 0);
        assertEq(jar.claimedByRecipient(recipient), 3 * ONE_USDC_NATIVE);
        assertEq(jar.totalClaimed(), 3 * ONE_USDC_NATIVE);
        assertEq(jar.recipientClaimCount(recipient), 1);
        (uint256 claimedAmount, uint256 claimedAt) = jar.getRecipientClaim(recipient, 0);
        assertEq(claimedAmount, 3 * ONE_USDC_NATIVE);
        assertEq(claimedAt, block.timestamp);
        assertEq(jar.receivedByRecipient(recipient), 3 * ONE_USDC_NATIVE);
        assertEq(jar.recipientTipCount(recipient), 1);
    }

    function testClaimHistoryAccumulatesPerRecipient() public {
        vm.prank(alice);
        jar.tip{value: ONE_USDC_NATIVE}(recipient, "first");
        vm.prank(recipient);
        jar.claim();

        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        jar.tip{value: 2 * ONE_USDC_NATIVE}(recipient, "second");
        vm.prank(recipient);
        jar.claim();

        assertEq(jar.recipientClaimCount(recipient), 2);
        (uint256 firstAmount,) = jar.getRecipientClaim(recipient, 0);
        (uint256 secondAmount, uint256 secondTimestamp) = jar.getRecipientClaim(recipient, 1);
        assertEq(firstAmount, ONE_USDC_NATIVE);
        assertEq(secondAmount, 2 * ONE_USDC_NATIVE);
        assertEq(secondTimestamp, block.timestamp);
    }

    function testAnotherWalletCannotClaimRecipientsJar() public {
        vm.prank(alice);
        jar.tip{value: ONE_USDC_NATIVE}(recipient, "tip");

        vm.prank(bob);
        vm.expectRevert(ArcTipJar.NothingToClaim.selector);
        jar.claim();

        assertEq(jar.claimableBalance(recipient), ONE_USDC_NATIVE);
    }

    function testSelfTipCanBeClaimed() public {
        vm.prank(alice);
        jar.tip{value: ONE_USDC_NATIVE}(alice, "self");
        vm.prank(alice);
        jar.claim();

        assertEq(alice.balance, 10 * ONE_USDC_NATIVE);
        assertEq(jar.claimableBalance(alice), 0);
    }

    function testPlainTransferCreatesSelfTip() public {
        vm.prank(alice);
        (bool success,) = address(jar).call{value: ONE_USDC_NATIVE}("");

        assertTrue(success);
        assertEq(jar.claimableBalance(alice), ONE_USDC_NATIVE);
        assertEq(jar.recipientTipCount(alice), 1);
    }

    function testZeroRecipientReverts() public {
        vm.prank(alice);
        vm.expectRevert(ArcTipJar.InvalidRecipient.selector);
        jar.tip{value: ONE_USDC_NATIVE}(address(0), "tip");
    }

    function testZeroTipReverts() public {
        vm.prank(alice);
        vm.expectRevert(ArcTipJar.ZeroTip.selector);
        jar.tip(recipient, "tip");
    }

    function testMessageLongerThan280BytesReverts() public {
        vm.prank(alice);
        vm.expectRevert(ArcTipJar.MessageTooLong.selector);
        jar.tip{value: ONE_USDC_NATIVE}(recipient, new string(281));
    }

    function testClaimWithNoBalanceReverts() public {
        vm.prank(recipient);
        vm.expectRevert(ArcTipJar.NothingToClaim.selector);
        jar.claim();
    }

    function testUnknownRecipientTipReverts() public {
        vm.expectRevert(ArcTipJar.TipNotFound.selector);
        jar.getRecipientTip(recipient, 0);
    }
}
