// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcTipJar} from "../src/ArcTipJar.sol";

contract ArcTipJarTest is Test {
    uint256 private constant ONE_USDC_NATIVE = 1e18;

    ArcTipJar private jar;
    address private owner;
    address private alice;
    address private bob;
    address private recipient;

    event TipReceived(address indexed sender, uint256 amount, string message);
    event Withdrawal(address indexed recipient, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        owner = makeAddr("owner");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        recipient = makeAddr("recipient");

        vm.prank(owner);
        jar = new ArcTipJar();

        vm.deal(alice, 10 * ONE_USDC_NATIVE);
        vm.deal(bob, 10 * ONE_USDC_NATIVE);
    }

    function testOwnerIsDeployer() public view {
        assertEq(jar.owner(), owner);
    }

    function testOwnershipTransferRequiresAcceptance() public {
        vm.expectEmit(true, true, false, true, address(jar));
        emit OwnershipTransferStarted(owner, alice);

        vm.prank(owner);
        jar.transferOwnership(alice);

        assertEq(jar.owner(), owner);
        assertEq(jar.pendingOwner(), alice);

        vm.expectEmit(true, true, false, true, address(jar));
        emit OwnershipTransferred(owner, alice);

        vm.prank(alice);
        jar.acceptOwnership();

        assertEq(jar.owner(), alice);
        assertEq(jar.pendingOwner(), address(0));
    }

    function testOnlyOwnerCanStartOwnershipTransfer() public {
        vm.prank(alice);
        vm.expectRevert(ArcTipJar.OnlyOwner.selector);
        jar.transferOwnership(bob);
    }

    function testOwnershipCannotBeTransferredToZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ArcTipJar.InvalidRecipient.selector);
        jar.transferOwnership(address(0));
    }

    function testOnlyPendingOwnerCanAcceptOwnership() public {
        vm.prank(owner);
        jar.transferOwnership(alice);

        vm.prank(bob);
        vm.expectRevert(ArcTipJar.NoPendingOwner.selector);
        jar.acceptOwnership();
    }

    function testTipRecordsMessageAndTotals() public {
        uint256 amount = 2 * ONE_USDC_NATIVE;
        string memory message = "Thanks for building on Arc";

        vm.expectEmit(true, false, false, true, address(jar));
        emit TipReceived(alice, amount, message);

        vm.prank(alice);
        jar.tip{value: amount}(message);

        assertEq(address(jar).balance, amount);
        assertEq(jar.totalTipsReceived(), amount);
        assertEq(jar.tipsByAddress(alice), amount);
        assertEq(jar.tipCount(), 1);

        (address sender, uint256 storedAmount, uint256 timestamp, string memory storedMessage) = jar.getTip(0);

        assertEq(sender, alice);
        assertEq(storedAmount, amount);
        assertEq(timestamp, block.timestamp);
        assertEq(storedMessage, message);
    }

    function testPlainTransferCreatesTipWithoutMessage() public {
        uint256 amount = ONE_USDC_NATIVE / 2;

        vm.prank(bob);
        (bool success,) = address(jar).call{value: amount}("");

        assertTrue(success);
        assertEq(jar.tipCount(), 1);

        (address sender, uint256 storedAmount,, string memory message) = jar.getTip(0);

        assertEq(sender, bob);
        assertEq(storedAmount, amount);
        assertEq(message, "");
    }

    function testZeroTipReverts() public {
        vm.prank(alice);
        vm.expectRevert(ArcTipJar.ZeroTip.selector);
        jar.tip("");
    }

    function testMessageLongerThan280BytesReverts() public {
        string memory longMessage = new string(281);

        vm.prank(alice);
        vm.expectRevert(ArcTipJar.MessageTooLong.selector);
        jar.tip{value: ONE_USDC_NATIVE}(longMessage);
    }

    function testOnlyOwnerCanWithdraw() public {
        vm.prank(alice);
        jar.tip{value: ONE_USDC_NATIVE}("tip");

        vm.prank(alice);
        vm.expectRevert(ArcTipJar.OnlyOwner.selector);
        jar.withdraw(payable(recipient), ONE_USDC_NATIVE);
    }

    function testOwnerCanWithdrawPartOfBalance() public {
        uint256 tipAmount = 3 * ONE_USDC_NATIVE;
        uint256 withdrawalAmount = 2 * ONE_USDC_NATIVE;

        vm.prank(alice);
        jar.tip{value: tipAmount}("tip");

        vm.expectEmit(true, false, false, true, address(jar));
        emit Withdrawal(recipient, withdrawalAmount);

        vm.prank(owner);
        jar.withdraw(payable(recipient), withdrawalAmount);

        assertEq(recipient.balance, withdrawalAmount);
        assertEq(address(jar).balance, tipAmount - withdrawalAmount);
        assertEq(jar.totalWithdrawn(), withdrawalAmount);
    }

    function testOwnerCanWithdrawAll() public {
        vm.prank(alice);
        jar.tip{value: ONE_USDC_NATIVE}("one");

        vm.prank(bob);
        jar.tip{value: 2 * ONE_USDC_NATIVE}("two");

        vm.prank(owner);
        jar.withdrawAll(payable(recipient));

        assertEq(recipient.balance, 3 * ONE_USDC_NATIVE);
        assertEq(address(jar).balance, 0);
        assertEq(jar.totalWithdrawn(), 3 * ONE_USDC_NATIVE);
    }

    function testUnknownTipIndexReverts() public {
        vm.expectRevert(ArcTipJar.TipNotFound.selector);
        jar.getTip(0);
    }
}
