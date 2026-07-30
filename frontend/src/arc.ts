import { defineChain, getAddress, type Address } from "viem";

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
  testnet: true,
});

const configuredAddress =
  import.meta.env.VITE_ARC_TIP_JAR_ADDRESS ??
  "0x8549ac9926F4669DB44D66978f810A84f525D1e2";

export const contractAddress: Address = getAddress(configuredAddress);
export const explorerAddressUrl = `${arcTestnet.blockExplorers.default.url}/address/${contractAddress}`;
