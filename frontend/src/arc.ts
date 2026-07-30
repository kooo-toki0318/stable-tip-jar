import { defineChain, getAddress, type Address, type Chain } from "viem";

export type ArcNetworkKey = "testnet" | "mainnet";

export type ArcNetworkConfig = {
  key: ArcNetworkKey;
  label: string;
  chain: Chain;
  contractAddress: Address;
  browserRpcUrl: string;
  faucetUrl?: string;
};

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 1,
    },
  },
  testnet: true,
});

const testnetContractAddress = getAddress(
  import.meta.env.VITE_ARC_TIP_JAR_ADDRESS ??
    "0x44FD57BaeaAC3D2F0a20a8032840E00bd44E8668",
);

export const arcTestnetConfig: ArcNetworkConfig = {
  key: "testnet",
  label: "Arc Testnet",
  chain: arcTestnet,
  contractAddress: testnetContractAddress,
  browserRpcUrl: "/rpc",
  faucetUrl: "https://faucet.circle.com",
};

// Arc Mainnet is not publicly available yet. Once its official network details
// and a deployed Tip Jar address are provided, these environment variables make
// the existing network selector and wallet switching flow Mainnet-ready.
const mainnetChainId = Number(import.meta.env.VITE_ARC_MAINNET_CHAIN_ID);
const mainnetRpcUrl = import.meta.env.VITE_ARC_MAINNET_RPC_URL;
const mainnetExplorerUrl = import.meta.env.VITE_ARC_MAINNET_EXPLORER_URL;
const mainnetContractAddress = import.meta.env.VITE_ARC_MAINNET_TIP_JAR_ADDRESS;

const arcMainnetConfig: ArcNetworkConfig | null =
  Number.isSafeInteger(mainnetChainId) &&
  mainnetChainId > 0 &&
  mainnetRpcUrl &&
  mainnetExplorerUrl &&
  mainnetContractAddress
    ? {
        key: "mainnet",
        label: "Arc Mainnet",
        chain: defineChain({
          id: mainnetChainId,
          name: "Arc Mainnet",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: { default: { http: [mainnetRpcUrl] } },
          blockExplorers: {
            default: { name: "ArcScan", url: mainnetExplorerUrl },
          },
        }),
        contractAddress: getAddress(mainnetContractAddress),
        browserRpcUrl: mainnetRpcUrl,
      }
    : null;

export const arcNetworks: Record<ArcNetworkKey, ArcNetworkConfig | null> = {
  testnet: arcTestnetConfig,
  mainnet: arcMainnetConfig,
};

export function getArcNetworkByChainId(
  chainId: number,
): ArcNetworkConfig | null {
  return Object.values(arcNetworks).find(
    (network) => network?.chain.id === chainId,
  ) ?? null;
}
