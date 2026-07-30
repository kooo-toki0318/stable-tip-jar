import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddress,
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

type ClaimRecord = {
  index: bigint;
  amount: bigint;
  timestamp: bigint;
};

type JarStats = {
  balance: bigint;
  totalReceived: bigint;
  totalClaimed: bigint;
  claimableCount: bigint;
  tipCount: bigint;
  claimCount: bigint;
};

const emptyStats: JarStats = {
  balance: 0n,
  totalReceived: 0n,
  totalClaimed: 0n,
  claimableCount: 0n,
  tipCount: 0n,
  claimCount: 0n,
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

async function withRpcRetry<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const isRateLimited = message.includes("too many requests") || message.includes("429");
      if (!isRateLimited || attempt === 2) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error("RPC request failed after retries.");
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
  const [recipientInput, setRecipientInput] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [amountPercentage, setAmountPercentage] = useState(0);
  const [message, setMessage] = useState("Thanks for building on Arc!");
  const [stats, setStats] = useState<JarStats>(emptyStats);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [tips, setTips] = useState<Tip[]>([]);
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isContractReady, setIsContractReady] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [txHash, setTxHash] = useState<Hash | null>(null);

  const selectedNetwork = arcNetworks[selectedNetworkKey] ?? arcNetworks.testnet!;
  const { chain, contractAddress } = selectedNetwork;
  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain,
        transport: http(selectedNetwork.browserRpcUrl),
      }),
    [chain, selectedNetwork.browserRpcUrl],
  );
  const isCorrectNetwork = chainId === chain.id;
  const gasReserve = parseUnits("0.01", 18);
  const spendableBalance =
    walletBalance && walletBalance > gasReserve ? walletBalance - gasReserve : 0n;
  const recipientAddress = useMemo(
    () => (isAddress(recipientInput) ? getAddress(recipientInput) : null),
    [recipientInput],
  );
  const canClaim =
    account !== null &&
    recipientAddress !== null &&
    account.toLowerCase() === recipientAddress.toLowerCase();
  const contractExplorerUrl = `${chain.blockExplorers?.default.url}/address/${contractAddress}`;
  const messageBytes = useMemo(
    () => new TextEncoder().encode(message).length,
    [message],
  );

  const refreshData = useCallback(async () => {
    if (!account || !recipientAddress) return;
    setIsLoading(true);
    try {
      const contract = { address: contractAddress, abi: arcTipJarAbi } as const;
      const [balance, claimableCount, totalReceived, totalClaimed, tipCount, claimCount] =
        await withRpcRetry(() =>
          publicClient.multicall({
            allowFailure: false,
            contracts: [
              { ...contract, functionName: "claimableBalance", args: [recipientAddress] },
              { ...contract, functionName: "claimableTipCount", args: [recipientAddress] },
              { ...contract, functionName: "receivedByRecipient", args: [recipientAddress] },
              { ...contract, functionName: "claimedByRecipient", args: [recipientAddress] },
              { ...contract, functionName: "recipientTipCount", args: [recipientAddress] },
              { ...contract, functionName: "recipientClaimCount", args: [recipientAddress] },
            ],
          }),
        );

      setStats({ balance, claimableCount, totalReceived, totalClaimed, tipCount, claimCount });
      setIsContractReady(true);

      const readableCount = tipCount > 100n ? 100n : tipCount;
      const indexes = Array.from(
        { length: Number(readableCount) },
        (_, offset) => tipCount - 1n - BigInt(offset),
      );

      try {
        if (indexes.length === 0) {
          setTips([]);
        } else {
          const tipResults = await withRpcRetry(() =>
            publicClient.multicall({
              allowFailure: false,
              contracts: indexes.map((index) => ({
                ...contract,
                functionName: "getRecipientTip" as const,
                args: [recipientAddress, index] as const,
              })),
            }),
          );

          const loadedTips = tipResults.map(
            ([sender, tipAmount, timestamp, tipMessage], offset): Tip => ({
              index: indexes[offset],
              sender,
              amount: tipAmount,
              timestamp,
              message: tipMessage,
            }),
          );
          setTips(loadedTips.slice(0, 8));
        }
      } catch (error) {
        setTips([]);
        setStatus(`Contract connected, but recent tips could not be loaded: ${getErrorMessage(error)}`);
      }

      try {
        const visibleClaimCount = claimCount > 8n ? 8n : claimCount;
        const claimIndexes = Array.from(
          { length: Number(visibleClaimCount) },
          (_, offset) => claimCount - 1n - BigInt(offset),
        );

        if (claimIndexes.length === 0) {
          setClaims([]);
        } else {
          const claimResults = await withRpcRetry(() =>
            publicClient.multicall({
              allowFailure: false,
              contracts: claimIndexes.map((index) => ({
                ...contract,
                functionName: "getRecipientClaim" as const,
                args: [recipientAddress, index] as const,
              })),
            }),
          );
          setClaims(
            claimResults.map(([amount, timestamp], offset): ClaimRecord => ({
              index: claimIndexes[offset],
              amount,
              timestamp,
            })),
          );
        }
      } catch (error) {
        setClaims([]);
        setStatus(`Contract connected, but claim history could not be loaded: ${getErrorMessage(error)}`);
      }
    } catch (error) {
      setIsContractReady(false);
      setClaims([]);
      setStatus(`Could not load contract data: ${getErrorMessage(error)}`);
    } finally {
      setIsLoading(false);
    }
  }, [account, contractAddress, publicClient, recipientAddress]);

  const refreshWalletBalance = useCallback(async () => {
    if (!account) {
      setWalletBalance(null);
      return;
    }

    try {
      setWalletBalance(await withRpcRetry(() => publicClient.getBalance({ address: account })));
    } catch {
      setWalletBalance(null);
    }
  }, [account, publicClient]);

  const syncWalletState = useCallback(async () => {
    if (!window.ethereum) return;
    if (window.localStorage.getItem("arc-tip-jar-disconnected") === "true") {
      setAccount(null);
      setChainId(null);
      return;
    }

    const [accounts, walletChainId] = await Promise.all([
      window.ethereum.request({ method: "eth_accounts" }) as Promise<Address[]>,
      window.ethereum.request({ method: "eth_chainId" }) as Promise<string>,
    ]);

    setAccount(accounts[0] ?? null);
    setRecipientInput((current) => current || accounts[0] || "");
    const nextChainId = Number.parseInt(walletChainId, 16);
    setChainId(nextChainId);
    const detectedNetwork = getArcNetworkByChainId(nextChainId);
    if (detectedNetwork) setSelectedNetworkKey(detectedNetwork.key);
  }, []);

  useEffect(() => {
    void syncWalletState();
  }, [syncWalletState]);

  useEffect(() => {
    if (account && recipientAddress) {
      void refreshData();
      return;
    }

    setStats(emptyStats);
    setTips([]);
    setClaims([]);
    setIsContractReady(false);
    setIsLoading(false);
  }, [account, recipientAddress, refreshData]);

  useEffect(() => {
    void refreshWalletBalance();
  }, [refreshWalletBalance]);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = (args[0] ?? []) as Address[];
      if (
        accounts.length > 0 &&
        window.localStorage.getItem("arc-tip-jar-disconnected") === "true"
      ) {
        return;
      }
      setAccount(accounts[0] ?? null);
      setRecipientInput((current) => current || accounts[0] || "");
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

      window.localStorage.removeItem("arc-tip-jar-disconnected");
      setAccount(accounts[0] ?? null);
      setRecipientInput((current) => current || accounts[0] || "");
      const walletChainId = Number.parseInt(
        (await window.ethereum.request({ method: "eth_chainId" })) as string,
        16,
      );
      setChainId(walletChainId);

      const detectedNetwork = getArcNetworkByChainId(walletChainId);
      if (detectedNetwork) {
        setSelectedNetworkKey(detectedNetwork.key);
        setStatus(`Connected on ${detectedNetwork.chain.name}. Network was not changed.`);
      } else {
        await switchToNetwork(selectedNetwork);
        setStatus(`Wallet was automatically switched to ${selectedNetwork.chain.name}.`);
      }
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsConnecting(false);
    }
  }

  async function disconnectWallet() {
    const provider = window.ethereum;
    try {
      if (provider) {
        const request = provider.request as unknown as (args: {
          method: string;
          params?: readonly unknown[];
        }) => Promise<unknown>;
        await request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        });
      }
    } catch {
      // Not every injected wallet supports permission revocation. The dApp can
      // still end its local session and reconnect explicitly when requested.
    } finally {
      window.localStorage.setItem("arc-tip-jar-disconnected", "true");
      setAccount(null);
      setChainId(null);
      setRecipientInput("");
      setTxHash(null);
      setStatus("Wallet disconnected from this dApp.");
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

  function setPresetAmount(nextAmount: string) {
    setAmount(nextAmount);
    if (spendableBalance === 0n) {
      setAmountPercentage(0);
      return;
    }
    const value = parseUnits(nextAmount, 18);
    const percentage = Number((value * 10_000n) / spendableBalance) / 100;
    setAmountPercentage(Math.min(100, Math.max(0, percentage)));
  }

  function setAmountFromPercentage(percentage: number) {
    setAmountPercentage(percentage);
    if (spendableBalance === 0n) {
      setAmount("0");
      return;
    }
    const value = (spendableBalance * BigInt(percentage)) / 100n;
    setAmount(formatUnits(value, 18));
  }

  function useConnectedWalletAsRecipient() {
    if (!account) return;
    setRecipientInput(account);
    setStatus("");
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
    if (!recipientAddress) {
      setStatus("Enter a valid recipient wallet address.");
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
        args: [recipientAddress, message],
        value,
      });

      setTxHash(hash);
      setStatus("Transaction submitted. Waiting for confirmation…");

      await publicClient.waitForTransactionReceipt({ hash });
      setStatus(`Tip confirmed on ${chain.name}.`);
      setAmount("0.01");
      setAmountPercentage(0);
      setMessage("");
      await Promise.all([refreshData(), refreshWalletBalance()]);
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsSending(false);
    }
  }

  async function claimTips() {
    setStatus("");
    setTxHash(null);

    if (!window.ethereum || !account || !canClaim) {
      setStatus("Connect the recipient wallet to claim its collected tips.");
      return;
    }
    if (!isCorrectNetwork) {
      setStatus(`Switch to ${chain.name} before claiming tips.`);
      return;
    }
    if (stats.balance === 0n) {
      setStatus("There are no tips available to claim.");
      return;
    }

    setIsClaiming(true);
    try {
      const walletClient = createWalletClient({
        account,
        chain,
        transport: custom(window.ethereum),
      });
      const hash = await walletClient.writeContract({
        address: contractAddress,
        abi: arcTipJarAbi,
        functionName: "claim",
      });

      setTxHash(hash);
      setStatus("Claim submitted. Waiting for confirmation…");
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus(`Claim confirmed on ${chain.name}.`);
      await Promise.all([refreshData(), refreshWalletBalance()]);
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsClaiming(false);
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
            onClick={account ? disconnectWallet : connectWallet}
            disabled={isConnecting}
          >
            {account
              ? `Disconnect ${shortAddress(account)}`
              : isConnecting
                ? "Connecting…"
                : "Connect wallet"}
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
        <article className="stat-card claim-card">
          <span>Tips available to claim</span>
          <strong>{account && !isLoading ? formatUsdc(stats.balance) : "—"} USDC</strong>
          <small className="tip-count-detail">
            {account && recipientAddress && !isLoading ? (
              <><strong>${stats.claimableCount.toString()}</strong> current tip${stats.claimableCount === 1n ? "" : "s"}</>
            ) : (
              "Connect a wallet and choose a recipient"
            )}
          </small>
          {canClaim && (
            <button
              className="claim-button"
              type="button"
              onClick={() => void claimTips()}
              disabled={isClaiming || stats.balance === 0n || !isCorrectNetwork}
            >
              {isClaiming ? "Claiming…" : "Claim all tips"}
            </button>
          )}
        </article>
        <article className="stat-card">
          <span>Total tips received</span>
          <strong>{account && !isLoading ? formatUsdc(stats.totalReceived) : "—"} USDC</strong>
          <small className="tip-count-detail">
            {account && recipientAddress && !isLoading ? (
              <><strong>${stats.tipCount.toString()}</strong> lifetime tip${stats.tipCount === 1n ? "" : "s"}</>
            ) : (
              "Connect a wallet and choose a recipient"
            )}
          </small>
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

          <div className="wallet-balance-row">
            <span>Connected wallet balance</span>
            <strong>
              {account && walletBalance !== null
                ? `${formatUsdc(walletBalance)} USDC`
                : "—"}
            </strong>
            <small>{account ? `Available on ${chain.name} for tips and gas` : "Connect a wallet to view its balance"}</small>
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
              <div className="field-heading">
                <label htmlFor="recipient">Recipient wallet</label>
                <button
                  className="inline-action"
                  type="button"
                  onClick={useConnectedWalletAsRecipient}
                >
                  Use my address
                </button>
              </div>
              <input
                className={`address-input ${recipientInput && !recipientAddress ? "invalid" : ""}`}
                id="recipient"
                value={recipientInput}
                onChange={(event) => setRecipientInput(event.target.value.trim())}
                placeholder="0x…"
                spellCheck={false}
                required
              />
              {recipientInput && !recipientAddress && (
                <p className="field-error">Enter a valid EVM wallet address.</p>
              )}

              <label htmlFor="amount">Amount</label>
              <div className="amount-input">
                <input
                  id="amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setAmountPercentage(0);
                  }}
                  placeholder="0.01"
                  required
                />
                <span>USDC</span>
              </div>

              <div className="amount-presets" aria-label="Tip amount presets">
                {["1", "5", "10"].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setPresetAmount(preset)}
                  >
                    ${preset} USDC
                  </button>
                ))}
              </div>

              <div className="percentage-control">
                <div>
                  <span>Spendable balance percentage</span>
                  <strong>${amountPercentage.toFixed(amountPercentage % 1 === 0 ? 0 : 2)}%</strong>
                </div>
                <input
                  aria-label="Wallet balance percentage"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={Math.round(amountPercentage)}
                  onChange={(event) => setAmountFromPercentage(Number(event.target.value))}
                  disabled={!walletBalance || walletBalance === 0n}
                />
                <div className="range-labels"><span>0%</span><span>100% (keeps 0.01 for gas)</span></div>
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
                disabled={isSending || messageBytes > 280}
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

          {!account ? (
            <p className="muted">Connect a wallet to view recent activity.</p>
          ) : !recipientAddress ? (
            <p className="muted">Enter a recipient address to view their activity.</p>
          ) : isLoading ? (
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

      <section className="panel claims-panel" aria-label="Claim history">
        <div className="panel-heading">
          <div>
            <span className="section-label">CLAIM HISTORY</span>
            <h2>Latest claims</h2>
          </div>
          {account && recipientAddress && !isLoading && (
            <span className="claim-total">${stats.claimCount.toString()} total</span>
          )}
        </div>

        {!account ? (
          <p className="muted">Connect a wallet to view claim history.</p>
        ) : !recipientAddress ? (
          <p className="muted">Enter a recipient address to view their claims.</p>
        ) : isLoading ? (
          <p className="muted">Loading claim history…</p>
        ) : claims.length === 0 ? (
          <p className="muted">No claims yet.</p>
        ) : (
          <ol className="claim-list">
            {claims.map((claim) => (
              <li key={claim.index.toString()}>
                <div>
                  <strong>{formatUsdc(claim.amount)} USDC</strong>
                  <span>Claim #{claim.index.toString()}</span>
                </div>
                <time dateTime={new Date(Number(claim.timestamp) * 1000).toISOString()}>
                  {new Date(Number(claim.timestamp) * 1000).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        )}
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
