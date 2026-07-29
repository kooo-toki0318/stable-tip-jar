# ArcTipJar deployment notes

Copy `src`, `test`, and `script` into an existing Foundry project.

## Clean up the previous demo

```bash
rm -f src/ArcBuildProof.sol
rm -f test/ArcBuildProof.t.sol
rm -f script/DeployArcBuildProof.s.sol
```

## Build and test

```bash
forge fmt
forge build
forge test -vvv
```

## Arc Testnet RPC

```bash
export ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
cast chain-id --rpc-url "$ARC_TESTNET_RPC_URL"
```

Expected chain ID: `5042002`.

## Simulate deployment

```bash
forge script script/DeployArcTipJar.s.sol:DeployArcTipJar \
  --rpc-url "$ARC_TESTNET_RPC_URL" \
  --account deployer
```

## Broadcast deployment

```bash
forge script script/DeployArcTipJar.s.sol:DeployArcTipJar \
  --rpc-url "$ARC_TESTNET_RPC_URL" \
  --account deployer \
  --broadcast
```

Save the deployed address:

```bash
export ARC_TIP_JAR_ADDRESS=0xYOUR_DEPLOYED_ADDRESS
```

## Send a 0.01 native-USDC tip with a message

Arc native USDC uses 18 decimals for `msg.value`, so `0.01 USDC` is
`10000000000000000` native units.

```bash
cast send "$ARC_TIP_JAR_ADDRESS" \
  "tip(string)" \
  "First tip on Arc" \
  --value 10000000000000000 \
  --rpc-url "$ARC_TESTNET_RPC_URL" \
  --account deployer
```

## Read data

```bash
cast call "$ARC_TIP_JAR_ADDRESS" \
  "tipCount()(uint256)" \
  --rpc-url "$ARC_TESTNET_RPC_URL"

cast call "$ARC_TIP_JAR_ADDRESS" \
  "getTip(uint256)(address,uint256,uint256,string)" \
  0 \
  --rpc-url "$ARC_TESTNET_RPC_URL"

cast call "$ARC_TIP_JAR_ADDRESS" \
  "jarBalance()(uint256)" \
  --rpc-url "$ARC_TESTNET_RPC_URL"
```

## Withdraw all tips

```bash
DEPLOYER_ADDRESS=$(cast wallet address --account deployer)

cast send "$ARC_TIP_JAR_ADDRESS" \
  "withdrawAll(address)" \
  "$DEPLOYER_ADDRESS" \
  --rpc-url "$ARC_TESTNET_RPC_URL" \
  --account deployer
```
