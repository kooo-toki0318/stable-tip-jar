import type { Address, EIP1193Provider } from "viem";

let isolatedRequestDepth = 0;

export function isIsolatedWalletRequestActive(): boolean {
  return isolatedRequestDepth > 0;
}

export async function withIsolatedWalletRequest<T>(
  request: () => Promise<T>,
): Promise<T> {
  isolatedRequestDepth += 1;
  try {
    return await request();
  } finally {
    window.setTimeout(() => {
      isolatedRequestDepth = Math.max(0, isolatedRequestDepth - 1);
    }, 0);
  }
}

export type InjectedWallet = {
  id: string;
  name: string;
  icon?: string;
  rdns?: string;
  provider: EIP1193Provider;
};

type ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

type ProviderDetail = {
  info: ProviderInfo;
  provider: EIP1193Provider;
};

export function listenForInjectedWallets(
  onWallets: (wallets: InjectedWallet[]) => void,
): () => void {
  const discovered = new Map<string, InjectedWallet>();
  const publish = () => onWallets([...discovered.values()]);
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<ProviderDetail>).detail;
    if (!detail?.provider || !detail.info?.uuid) return;
    discovered.set(detail.info.uuid, {
      id: detail.info.uuid,
      name: detail.info.name,
      icon: detail.info.icon.startsWith("data:image/")
        ? detail.info.icon
        : undefined,
      rdns: detail.info.rdns,
      provider: detail.provider,
    });
    publish();
  };

  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  const fallbackTimer = window.setTimeout(() => {
    if (discovered.size === 0 && window.ethereum) {
      discovered.set("legacy-injected", {
        id: "legacy-injected",
        name: "Browser Wallet",
        provider: window.ethereum,
      });
      publish();
    }
  }, 250);

  return () => {
    window.clearTimeout(fallbackTimer);
    window.removeEventListener("eip6963:announceProvider", announce);
  };
}

export function discoverInjectedWallets(timeoutMs = 400): Promise<InjectedWallet[]> {
  return new Promise((resolve) => {
    let latest: InjectedWallet[] = [];
    const stop = listenForInjectedWallets((wallets) => {
      latest = wallets;
    });
    window.setTimeout(() => {
      stop();
      resolve(latest);
    }, timeoutMs);
  });
}

export async function revokeInjectedWallet(wallet: InjectedWallet): Promise<void> {
  await withIsolatedWalletRequest(() =>
    wallet.provider.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    }),
  );
}

export async function connectInjectedWallet(wallet: InjectedWallet): Promise<{
  address: Address;
  chainId: number;
}> {
  try {
    await withIsolatedWalletRequest(() =>
      wallet.provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      }),
    );
  } catch (error) {
    const code = (error as { code?: number } | null)?.code;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    const unsupported =
      code === -32601 || code === 4200 || message.includes("not supported");
    if (!unsupported) throw error;
  }

  const accounts = (await withIsolatedWalletRequest(() =>
    wallet.provider.request({
      method: "eth_requestAccounts",
    }),
  )) as Address[];
  if (!accounts[0]) throw new Error("No wallet account was selected.");
  const chainId = Number.parseInt(
    (await wallet.provider.request({ method: "eth_chainId" })) as string,
    16,
  );
  return { address: accounts[0], chainId };
}

export async function switchProviderChain(
  provider: EIP1193Provider,
  chainId: number,
  addChain: {
    chainName: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    rpcUrls: string[];
    blockExplorerUrls: string[];
  },
): Promise<void> {
  const requestedChainId = `0x${chainId.toString(16)}`;
  try {
    await withIsolatedWalletRequest(() =>
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: requestedChainId }],
      }),
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? Number((error as { code: unknown }).code)
        : null;
    if (code !== 4902) throw error;
    await withIsolatedWalletRequest(() =>
      provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: requestedChainId, ...addChain }],
      }),
    );
  }
}

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<ProviderDetail>;
    "eip6963:requestProvider": Event;
  }
}
