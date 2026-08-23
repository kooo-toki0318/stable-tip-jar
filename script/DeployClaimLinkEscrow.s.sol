// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ClaimLinkEscrow} from "../src/ClaimLinkEscrow.sol";

contract DeployClaimLinkEscrow is Script {
    uint256 private constant ARC_TESTNET_CHAIN_ID = 5_042_002;

    function run() external returns (ClaimLinkEscrow escrow) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Arc Testnet only");

        vm.startBroadcast();
        escrow = new ClaimLinkEscrow();
        vm.stopBroadcast();

        console2.log("ClaimLinkEscrow deployed at:", address(escrow));
    }
}
