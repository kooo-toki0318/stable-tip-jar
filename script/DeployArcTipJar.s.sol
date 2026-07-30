// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcTipJar} from "../src/ArcTipJar.sol";

contract DeployArcTipJar is Script {
    function run() external returns (ArcTipJar jar) {
        uint256 expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        require(block.chainid == expectedChainId, "Unexpected chain ID");

        vm.startBroadcast();
        jar = new ArcTipJar();
        vm.stopBroadcast();

        console2.log("Recipient ArcTipJar deployed at:", address(jar));
    }
}
