// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClaimLinkEscrow} from "../src/ClaimLinkEscrow.sol";

contract ClaimLinkEscrowInterfaceTest is Test {
    ClaimLinkEscrow private escrow;

    function setUp() public {
        escrow = new ClaimLinkEscrow();
    }

    function testEip712DomainMatchesClientSigningContract() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = escrow.eip712Domain();

        assertEq(fields, hex"0f");
        assertEq(name, "ClaimLinkEscrow");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(escrow));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    function testGetPaymentReturnsStoredStruct() public {
        address sender = makeAddr("sender");
        address claimSigner = makeAddr("claim signer");
        vm.deal(sender, 1e18);
        vm.prank(sender);
        bytes32 linkId = escrow.createClaimLink{value: 1e18}(claimSigner);

        ClaimLinkEscrow.Payment memory payment = escrow.getPayment(linkId);

        assertEq(payment.sender, sender);
        assertEq(payment.claimSigner, claimSigner);
        assertEq(payment.amount, 1e18);
        assertEq(payment.expiresAt, block.timestamp + 7 days);
        assertEq(uint256(payment.status), uint256(ClaimLinkEscrow.PaymentStatus.Active));
    }
}
