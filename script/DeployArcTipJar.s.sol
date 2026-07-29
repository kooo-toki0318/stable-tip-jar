// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcTipJar} from "../src/ArcTipJar.sol";

contract DeployArcTipJar is Script {
    function run() external returns (ArcTipJar jar) {
        uint256 expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        address expectedOwner = vm.envAddress("DEPLOYER_ADDRESS");

        require(block.chainid == expectedChainId, "Unexpected chain ID");

        vm.startBroadcast();
        jar = new ArcTipJar();
        vm.stopBroadcast();

        require(jar.owner() == expectedOwner, "Unexpected owner");

        console2.log("ArcTipJar deployed at:", address(jar));
        console2.log("Owner:", jar.owner());
    }
}
