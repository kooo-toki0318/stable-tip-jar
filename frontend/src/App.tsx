import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  toHex,
  type Address,
  type EIP1193Provider,
  type Hash,
} from "viem";
import { arcTipJarAbi } from "./abi";
import {
  arcNetworks,
  getArcNetworkByChainId,
  type ArcNetworkConfig,
  type ArcNetworkKey,
} from "./arc";

type BrowserEthereumProvider = EIP1193Provider;

declare global {
  interface Window {
    ethereum?: BrowserEthereumProvider;
  }
}

type Tip = {
  index: bigint;
  sender: Address;
  amount: bigint;
  timestamp: bigint;
  message: string;
};

type JarStats = {
  balance: bigint;
  totalReceived: bigint;
  totalWithdrawn: bigint;
  tipCount: bigint;
};

const emptyStats: JarStats = {
  balance: 0n,
  totalReceived: 0n,
  totalWithdrawn: 0n,
  tipCount: 0n,
};

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsdc(value: bigint): string {
  const numeric = Number(formatUnits(value, 18));
  return numeric.toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("User rejected")) {
      return "The wallet request was rejected.";
    }
    return error.message.split("\n")[0];
  }
  return "Something went wrong.";
}

export default function App() {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [selectedNetworkKey, setSelectedNetworkKey] =
    useState<ArcNetworkKey>("testnet");
  const [amount, setAmount] = useState("0.01");
  const [message, setMessage] = useState("Thanks for building on Arc!");
  const [stats, setStats] = useState<JarStats>(emptyStats);
  const [tips, setTips] = useState<Tip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isContractReady, setIsContractReady] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [txHash, setTxHash] = useState<Hash | null>(null);

  const selectedNetwork = arcNetworks[selectedNetworkKey] ?? arcNetworks.testnet!;
  const { chain, contractAddress } = selectedNetwork;
  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain,
        transport: http(chain.rpcUrls.default.http[0]),
      }),
    [chain],
  );
  const isCorrectNetwork = chainId === chain.id;
  const contractExplorerUrl = `${chain.blockExplorers?.default.url}/address/${contractAddress}`;
  const messageBytes = useMemo(
    () => new TextEncoder().encode(message).length,
    [message],
  );

  const refreshData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [rpcChainId, bytecode] = await Promise.all([
        publicClient.getChainId(),
        publicClient.getCode({ address: contractAddress }),
      ]);

      if (rpcChainId !== chain.id) {
        throw new Error(
          `RPC returned chain ID ${rpcChainId}; expected ${chain.id}.`,
        );
      }
      if (!bytecode || bytecode === "0x") {
        throw new Error(
          `No contract is deployed at ${contractAddress} on ${chain.name}.`,
        );
      }

      const [balance, totalReceived, totalWithdrawn, tipCount] =
        await Promise.all([
          publicClient.readContract({
            address: contractAddress,
            abi: arcTipJarAbi,
            functionName: "jarBalance",
          }),
          publicClient.readContract({
            address: contractAddress,
            abi: arcTipJarAbi,
            functionName: "totalTipsReceived",
          }),
          publicClient.readContract({
            address: contractAddress,
            abi: arcTipJarAbi,
            functionName: "totalWithdrawn",
          }),
          publicClient.readContract({
            address: contractAddress,
            abi: arcTipJarAbi,
            functionName: "tipCount",
          }),
        ]);

      setStats({ balance, totalReceived, totalWithdrawn, tipCount });
      setIsContractReady(true);

      const visibleCount = tipCount > 8n ? 8n : tipCount;
      const indexes = Array.from(
        { length: Number(visibleCount) },
        (_, offset) => tipCount - 1n - BigInt(offset),
      );

      const recentTips = await Promise.all(
        indexes.map(async (index): Promise<Tip> => {
          const [sender, tipAmount, timestamp, tipMessage] =
            await publicClient.readContract({
              address: contractAddress,
              abi: arcTipJarAbi,
              functionName: "getTip",
              args: [index],
            });

          return {
            index,
            sender,
            amount: tipAmount,
            timestamp,
            message: tipMessage,
          };
        }),
      );

      setTips(recentTips);
    } catch (error) {
      setIsContractReady(false);
      setStatus(`Could not load contract data: ${getErrorMessage(error)}`);
    } finally {
      setIsLoading(false);
    }
  }, [chain.id, chain.name, contractAddress, publicClient]);

  const syncWalletState = useCallback(async () => {
    if (!window.ethereum) return;

    const [accounts, walletChainId] = await Promise.all([
      window.ethereum.request({ method: "eth_accounts" }) as Promise<Address[]>,
      window.ethereum.request({ method: "eth_chainId" }) as Promise<string>,
    ]);

    setAccount(accounts[0] ?? null);
    const nextChainId = Number.parseInt(walletChainId, 16);
    setChainId(nextChainId);
    const detectedNetwork = getArcNetworkByChainId(nextChainId);
    if (detectedNetwork) setSelectedNetworkKey(detectedNetwork.key);
  }, []);

  useEffect(() => {
    void refreshData();
    void syncWalletState();
  }, [refreshData, syncWalletState]);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = (args[0] ?? []) as Address[];
      setAccount(accounts[0] ?? null);
    };

    const handleChainChanged = (...args: unknown[]) => {
      const nextChainId = Number.parseInt(args[0] as string, 16);
      setChainId(nextChainId);
      const detectedNetwork = getArcNetworkByChainId(nextChainId);
      if (detectedNetwork) setSelectedNetworkKey(detectedNetwork.key);
    };

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);

    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  async function connectWallet() {
    if (!window.ethereum) {
      setStatus("Install an injected EVM wallet such as MetaMask or Rabby.");
      return;
    }

    setIsConnecting(true);
    setStatus("");
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as Address[];

      setAccount(accounts[0] ?? null);
      const walletChainId = Number.parseInt(
        (await window.ethereum.request({ method: "eth_chainId" })) as string,
        16,
      );
      setChainId(walletChainId);

      const detectedNetwork = getArcNetworkByChainId(walletChainId);
      if (detectedNetwork) {
        setSelectedNetworkKey(detectedNetwork.key);
      } else {
        await switchToNetwork(selectedNetwork);
      }
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsConnecting(false);
    }
  }

  async function switchToNetwork(network: ArcNetworkConfig) {
    if (!window.ethereum) return;

    const requestedChainId = toHex(network.chain.id);
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: requestedChainId }],
      });
      setChainId(network.chain.id);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? Number((error as { code: unknown }).code)
          : null;

      if (code !== 4902) throw error;

      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: requestedChainId,
            chainName: network.chain.name,
            nativeCurrency: network.chain.nativeCurrency,
            rpcUrls: [...network.chain.rpcUrls.default.http],
            blockExplorerUrls: network.chain.blockExplorers
              ? [network.chain.blockExplorers.default.url]
              : undefined,
          },
        ],
      });
      setChainId(network.chain.id);
    }
  }

  async function selectNetwork(nextKey: ArcNetworkKey) {
    const nextNetwork = arcNetworks[nextKey];
    if (!nextNetwork) return;

    setSelectedNetworkKey(nextKey);
    setStatus("");
    setTxHash(null);
    if (account && chainId !== nextNetwork.chain.id) {
      try {
        await switchToNetwork(nextNetwork);
      } catch (error) {
        setStatus(getErrorMessage(error));
      }
    }
  }

  async function sendTip(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("");
    setTxHash(null);

    if (!window.ethereum || !account) {
      setStatus("Connect your wallet first.");
      return;
    }
    if (!isCorrectNetwork) {
      setStatus(`Switch to ${chain.name} before sending a tip.`);
      return;
    }
    if (!isContractReady) {
      setStatus(
        `The configured contract could not be verified on ${chain.name}. Refresh and try again.`,
      );
      return;
    }
    if (messageBytes > 280) {
      setStatus("The message must be 280 bytes or fewer.");
      return;
    }

    let value: bigint;
    try {
      value = parseUnits(amount, 18);
      if (value <= 0n) throw new Error("Amount must be greater than zero.");
    } catch {
      setStatus("Enter a valid USDC amount greater than zero.");
      return;
    }

    setIsSending(true);
    try {
      const walletClient = createWalletClient({
        account,
        chain,
        transport: custom(window.ethereum),
      });

      const hash = await walletClient.writeContract({
        address: contractAddress,
        abi: arcTipJarAbi,
        functionName: "tip",
        args: [message],
        value,
      });

      setTxHash(hash);
      setStatus("Transaction submitted. Waiting for confirmation…");

      await publicClient.waitForTransactionReceipt({ hash });
      setStatus(`Tip confirmed on ${chain.name}.`);
      setAmount("0.01");
      setMessage("");
      await refreshData();
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Arc Tip Jar home">
          <span className="brand-mark">A</span>
          <span>Arc Tip Jar</span>
        </a>
        <div className="header-actions">
          <a href={contractExplorerUrl} target="_blank" rel="noreferrer">
            Contract
          </a>
          <label className="network-select-label">
            <span className="sr-only">Arc network</span>
            <select
              aria-label="Arc network"
              value={selectedNetworkKey}
              onChange={(event) =>
                void selectNetwork(event.target.value as ArcNetworkKey)
              }
            >
              <option value="testnet">Arc Testnet</option>
              <option value="mainnet" disabled={!arcNetworks.mainnet}>
                Arc Mainnet{arcNetworks.mainnet ? "" : " (Coming soon)"}
              </option>
            </select>
          </label>
          <a
            href="https://github.com/kooo-toki0318/arc-tip-jar"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <button
            className="wallet-button"
            type="button"
            onClick={connectWallet}
            disabled={isConnecting}
          >
            {account ? shortAddress(account) : isConnecting ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      </header>

      <section id="top" className="hero">
        <div className="eyebrow">BUILT ON {chain.name.toUpperCase()}</div>
        <h1>Send a tiny thank-you.<br />Keep it onchain.</h1>
        <p className="hero-copy">
          Tip native USDC, attach a message, and leave a public contribution
          record on Arc.
        </p>
      </section>

      <section className="stats-grid" aria-label="Tip jar statistics">
        <article className="stat-card">
          <span>Current balance</span>
          <strong>{isLoading ? "—" : formatUsdc(stats.balance)} USDC</strong>
        </article>
        <article className="stat-card">
          <span>Total received</span>
          <strong>{isLoading ? "—" : formatUsdc(stats.totalReceived)} USDC</strong>
        </article>
        <article className="stat-card">
          <span>Onchain tips</span>
          <strong>{isLoading ? "—" : stats.tipCount.toString()}</strong>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel tip-panel">
          <div className="panel-heading">
            <div>
              <span className="section-label">SEND A TIP</span>
              <h2>Support the jar</h2>
            </div>
            <span className={`network-pill ${isCorrectNetwork ? "online" : ""}`}>
              {isCorrectNetwork ? `${chain.name} connected` : `${chain.name} required`}
            </span>
          </div>

          {!account ? (
            <div className="connect-state">
              <p>Connect a wallet to send native {chain.testnet ? "testnet " : ""}USDC.</p>
              <button type="button" onClick={connectWallet} disabled={isConnecting}>
                {isConnecting ? "Connecting…" : "Connect wallet"}
              </button>
            </div>
          ) : !isCorrectNetwork ? (
            <div className="connect-state">
              <p>Your wallet is connected to another network.</p>
              <button type="button" onClick={() => void switchToNetwork(selectedNetwork)}>
                Switch to {chain.name}
              </button>
            </div>
          ) : (
            <form onSubmit={sendTip}>
              <label htmlFor="amount">Amount</label>
              <div className="amount-input">
                <input
                  id="amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.01"
                  required
                />
                <span>USDC</span>
              </div>

              <label htmlFor="message">Onchain message</label>
              <textarea
                id="message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Leave a short message"
                rows={4}
              />
              <div className={`byte-count ${messageBytes > 280 ? "invalid" : ""}`}>
                {messageBytes} / 280 bytes
              </div>

              <button
                className="primary-button"
                type="submit"
                disabled={isSending || !isContractReady || messageBytes > 280}
              >
                {isSending ? "Sending…" : "Send tip"}
              </button>
            </form>
          )}

          {selectedNetwork.faucetUrl && (
            <a
              className="faucet-button"
              href={selectedNetwork.faucetUrl}
              target="_blank"
              rel="noreferrer"
            >
              Get testnet USDC from the official Circle Faucet ↗
            </a>
          )}
          {status && <p className="status-message">{status}</p>}
          {txHash && (
            <a
              className="transaction-link"
              href={`${chain.blockExplorers?.default.url}/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction on ArcScan ↗
            </a>
          )}
        </article>

        <article className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <span className="section-label">RECENT ACTIVITY</span>
              <h2>Latest tips</h2>
            </div>
            <button className="text-button" type="button" onClick={refreshData}>
              Refresh
            </button>
          </div>

          {isLoading ? (
            <p className="muted">Loading onchain data…</p>
          ) : tips.length === 0 ? (
            <p className="muted">No tips yet. Be the first one.</p>
          ) : (
            <ol className="tip-list">
              {tips.map((tip) => (
                <li key={tip.index.toString()}>
                  <div className="tip-main">
                    <strong>{formatUsdc(tip.amount)} USDC</strong>
                    <span>{shortAddress(tip.sender)}</span>
                  </div>
                  <p>{tip.message || "Direct transfer"}</p>
                  <time dateTime={new Date(Number(tip.timestamp) * 1000).toISOString()}>
                    {new Date(Number(tip.timestamp) * 1000).toLocaleString()}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </article>
      </section>

      <footer>
        <span>{chain.testnet ? "Experimental testnet dApp. Testnet USDC has no real-world value." : "Arc Tip Jar on Mainnet."}</span>
        <a href={contractExplorerUrl} target="_blank" rel="noreferrer">
          {shortAddress(contractAddress)} ↗
        </a>
      </footer>
    </main>
  );
}
