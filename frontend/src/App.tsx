import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  recipient: Address;
  amount: bigint;
  timestamp: bigint;
  message: string;
  txHash: Hash | null;
};

type ClaimRecord = {
  index: bigint;
  amount: bigint;
  timestamp: bigint;
  txHash: Hash | null;
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

function shortHash(hash: Hash): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function CopyIcon({ copied }: { copied: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
      <title>{copied ? "Copied" : "Copy transaction hash"}</title>
      <rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function formatUsdc(value: bigint): string {
  const numeric = Number(formatUnits(value, 18));
  return numeric.toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

const RPC_MIN_INTERVAL_MS = 600;
let rpcQueue: Promise<void> = Promise.resolve();
let lastRpcRequestAt = 0;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function executeRpcWithRetry<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const elapsed = Date.now() - lastRpcRequestAt;
    if (elapsed < RPC_MIN_INTERVAL_MS) {
      await wait(RPC_MIN_INTERVAL_MS - elapsed);
    }
    lastRpcRequestAt = Date.now();

    try {
      return await request();
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const isTransient =
        message.includes("too many requests") ||
        message.includes("rate limit exceeded") ||
        message.includes("request limit reached") ||
        message.includes("-32005") ||
        message.includes("-32011") ||
        message.includes("429") ||
        message.includes("502") ||
        message.includes("503") ||
        message.includes("504") ||
        message.includes("failed to fetch") ||
        message.includes("network error");
      if (!isTransient || attempt === 3) throw error;
      await wait(1_000 * 2 ** attempt);
    }
  }
  throw new Error("RPC request failed after retries.");
}

async function withRpcRetry<T>(request: () => Promise<T>): Promise<T> {
  const queuedRequest = rpcQueue.then(
    () => executeRpcWithRetry(request),
    () => executeRpcWithRetry(request),
  );
  rpcQueue = queuedRequest.then(
    () => undefined,
    () => undefined,
  );
  return queuedRequest;
}

const MAX_LOG_BLOCK_RANGE = 10_000n;

async function getContractEventsInChunks<T>(
  fromBlock: bigint,
  toBlock: bigint,
  getEvents: (chunkFromBlock: bigint, chunkToBlock: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
  const events: T[] = [];
  for (
    let chunkFromBlock = fromBlock;
    chunkFromBlock <= toBlock;
    chunkFromBlock += MAX_LOG_BLOCK_RANGE
  ) {
    const chunkToBlock =
      chunkFromBlock + MAX_LOG_BLOCK_RANGE - 1n < toBlock
        ? chunkFromBlock + MAX_LOG_BLOCK_RANGE - 1n
        : toBlock;
    const chunkEvents = await withRpcRetry(() =>
      getEvents(chunkFromBlock, chunkToBlock),
    );
    events.push(...chunkEvents);
  }
  return events;
}

function createCachedLoader<T>(load: () => Promise<T>) {
  let cachedRequest: Promise<T> | null = null;

  return {
    load() {
      if (!cachedRequest) {
        const request = load().catch((error) => {
          if (cachedRequest === request) cachedRequest = null;
          throw error;
        });
        cachedRequest = request;
      }
      return cachedRequest;
    },
    invalidate() {
      cachedRequest = null;
    },
  };
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
  const [receivedTips, setReceivedTips] = useState<Tip[]>([]);
  const [sentTips, setSentTips] = useState<Tip[]>([]);
  const [sentTipCount, setSentTipCount] = useState(0);
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSentHistoryLoading, setIsSentHistoryLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isContractReady, setIsContractReady] = useState(false);
  const [walletStatus, setWalletStatus] = useState("");
  const [jarStatus, setJarStatus] = useState("");
  const [sendStatus, setSendStatus] = useState("");
  const [sentHistoryError, setSentHistoryError] = useState("");
  const [claimStatus, setClaimStatus] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [mobileView, setMobileView] = useState<"send" | "jar">("send");
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshCooldownUntil, setRefreshCooldownUntil] = useState(0);
  const refreshAllPromiseRef = useRef<Promise<void> | null>(null);
  const [sendTxHash, setSendTxHash] = useState<Hash | null>(null);
  const [claimTxHash, setClaimTxHash] = useState<Hash | null>(null);
  const [copiedHash, setCopiedHash] = useState<Hash | null>(null);

  const selectedNetwork = arcNetworks[selectedNetworkKey] ?? arcNetworks.testnet!;
  const { chain, contractAddress } = selectedNetwork;
  const activeDataContextRef = useRef("");
  const activeDataContext = `${selectedNetwork.key}:${account ?? "disconnected"}`;
  activeDataContextRef.current = activeDataContext;
  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain,
        transport: http(selectedNetwork.browserRpcUrl),
      }),
    [chain, selectedNetwork.browserRpcUrl],
  );
  const contractEventLoader = useMemo(
    () =>
      createCachedLoader(async () => {
        const historyToBlock = await withRpcRetry(() => publicClient.getBlockNumber());
        return getContractEventsInChunks(
          selectedNetwork.contractDeploymentBlock,
          historyToBlock,
          (fromBlock, toBlock) =>
            publicClient.getContractEvents({
              address: contractAddress,
              abi: arcTipJarAbi,
              fromBlock,
              toBlock,
              strict: true,
            }),
        );
      }),
    [contractAddress, publicClient, selectedNetwork.contractDeploymentBlock],
  );
  const isCorrectNetwork = chainId === chain.id;
  const gasReserve = parseUnits("0.01", 18);
  const spendableBalance =
    walletBalance && walletBalance > gasReserve ? walletBalance - gasReserve : 0n;
  const recipientAddress = useMemo(
    () => (isAddress(recipientInput) ? getAddress(recipientInput) : null),
    [recipientInput],
  );
  const contractExplorerUrl = `${chain.blockExplorers?.default.url}/address/${contractAddress}`;
  const messageBytes = useMemo(
    () => new TextEncoder().encode(message).length,
    [message],
  );
  const parsedTipAmount = useMemo(() => {
    try {
      const value = parseUnits(amount, 18);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  }, [amount]);
  const exceedsSpendableBalance =
    parsedTipAmount !== null &&
    walletBalance !== null &&
    parsedTipAmount > spendableBalance;
  const canSendTip =
    account !== null &&
    isCorrectNetwork &&
    isContractReady &&
    parsedTipAmount !== null &&
    !exceedsSpendableBalance &&
    recipientAddress !== null &&
    messageBytes <= 280;
  const sendButtonLabel = isSending
    ? "Confirming tip…"
    : !isContractReady
      ? isLoading
        ? "Loading contract…"
        : "Jar unavailable · Refresh"
      : parsedTipAmount === null
        ? "Enter an amount"
        : exceedsSpendableBalance
          ? "Insufficient spendable balance"
          : messageBytes > 280
            ? "Shorten the message"
            : !recipientInput
              ? "Enter a recipient"
              : !recipientAddress
                ? "Check recipient address"
                : `Send ${formatUsdc(parsedTipAmount)} USDC`;
  const remainingAfterTip =
    walletBalance !== null && parsedTipAmount !== null && walletBalance >= parsedTipAmount
      ? walletBalance - parsedTipAmount
      : null;

  const refreshData = useCallback(async () => {
    if (!account) return;
    const requestContext = activeDataContextRef.current;
    const isCurrentRequest = () => activeDataContextRef.current === requestContext;
    setIsLoading(true);
    setJarStatus("");
    let refreshSucceeded = true;
    try {
      const jarAddress = account;
      const contract = { address: contractAddress, abi: arcTipJarAbi } as const;
      const [balance, claimableCount, totalReceived, totalClaimed, tipCount, claimCount] =
        await withRpcRetry(() =>
          publicClient.multicall({
            allowFailure: false,
            contracts: [
              { ...contract, functionName: "claimableBalance", args: [jarAddress] },
              { ...contract, functionName: "claimableTipCount", args: [jarAddress] },
              { ...contract, functionName: "receivedByRecipient", args: [jarAddress] },
              { ...contract, functionName: "claimedByRecipient", args: [jarAddress] },
              { ...contract, functionName: "recipientTipCount", args: [jarAddress] },
              { ...contract, functionName: "recipientClaimCount", args: [jarAddress] },
            ],
          }),
        );

      if (!isCurrentRequest()) return;
      setStats({ balance, claimableCount, totalReceived, totalClaimed, tipCount, claimCount });
      setIsContractReady(true);

      try {
        const visibleTipCount = tipCount > 8n ? 8n : tipCount;
        const tipIndexes = Array.from(
          { length: Number(visibleTipCount) },
          (_, offset) => tipCount - 1n - BigInt(offset),
        );

        if (tipIndexes.length === 0) {
          setReceivedTips([]);
        } else {
          const [tipResults, contractEvents] = await Promise.all([
            withRpcRetry(() =>
              publicClient.multicall({
                allowFailure: false,
                contracts: tipIndexes.map((index) => ({
                  ...contract,
                  functionName: "getRecipientTip" as const,
                  args: [jarAddress, index] as const,
                })),
              }),
            ),
            contractEventLoader.load(),
          ]);
          const receivedLogs = contractEvents.filter(
            (log) =>
              log.eventName === "TipReceived" &&
              log.args.recipient.toLowerCase() === jarAddress.toLowerCase(),
          );
          if (!isCurrentRequest()) return;
          setReceivedTips(
            tipResults.map(([sender, tipAmount, timestamp, tipMessage], offset): Tip => ({
              index: tipIndexes[offset],
              sender,
              recipient: jarAddress,
              amount: tipAmount,
              timestamp,
              message: tipMessage,
              txHash: receivedLogs[Number(tipIndexes[offset])]?.transactionHash ?? null,
            })),
          );
        }
      } catch (error) {
        refreshSucceeded = false;
        if (isCurrentRequest()) {
          setJarStatus(`Latest tips could not be refreshed. Showing the last loaded data. ${getErrorMessage(error)}`);
        }
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
                args: [jarAddress, index] as const,
              })),
            }),
          );
          const claimLogs = (await contractEventLoader.load()).filter(
            (log) =>
              log.eventName === "Claimed" &&
              log.args.recipient.toLowerCase() === jarAddress.toLowerCase(),
          );
          if (!isCurrentRequest()) return;
          setClaims(
            claimResults.map(([claimAmount, timestamp], offset): ClaimRecord => ({
              index: claimIndexes[offset],
              amount: claimAmount,
              timestamp,
              txHash: claimLogs[Number(claimIndexes[offset])]?.transactionHash ?? null,
            })),
          );
        }
      } catch (error) {
        refreshSucceeded = false;
        if (isCurrentRequest()) {
          setJarStatus(`Claim history could not be refreshed. Showing the last loaded data. ${getErrorMessage(error)}`);
        }
      }
      if (refreshSucceeded && isCurrentRequest()) setLastUpdatedAt(new Date());
    } catch (error) {
      refreshSucceeded = false;
      if (isCurrentRequest()) {
        setJarStatus(`Jar data could not be refreshed. Showing the last loaded data. ${getErrorMessage(error)}`);
      }
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
    return refreshSucceeded && isCurrentRequest();
  }, [account, contractAddress, contractEventLoader, publicClient]);
  const refreshWalletBalance = useCallback(async () => {
    if (!account) {
      setWalletBalance(null);
      return;
    }

    const requestContext = activeDataContextRef.current;
    try {
      const nextBalance = await withRpcRetry(() =>
        publicClient.getBalance({ address: account }),
      );
      if (activeDataContextRef.current === requestContext) setWalletBalance(nextBalance);
    } catch {
      if (activeDataContextRef.current === requestContext) setWalletBalance(null);
    }
  }, [account, publicClient]);
  const refreshSentHistory = useCallback(async () => {
    if (!account) {
      setSentTips([]);
      setSentTipCount(0);
      setIsSentHistoryLoading(false);
      setSentHistoryError("");
      return;
    }

    const requestContext = activeDataContextRef.current;
    setIsSentHistoryLoading(true);
    setSentHistoryError("");
    try {
      const sentLogs = (await contractEventLoader.load()).filter(
        (log) =>
          log.eventName === "TipReceived" &&
          log.args.sender.toLowerCase() === account.toLowerCase(),
      );
      if (activeDataContextRef.current !== requestContext) return;
      setSentTipCount(sentLogs.length);
      const latestSentLogs = sentLogs.slice(-8).reverse();
      const sentTipHistory = latestSentLogs.flatMap((log): Tip[] => {
        if (
          log.eventName !== "TipReceived" ||
          log.blockTimestamp === null ||
          log.blockTimestamp === undefined ||
          !log.transactionHash
        ) return [];
        return [{
          index: BigInt(log.logIndex ?? 0),
          sender: log.args.sender,
          recipient: log.args.recipient,
          amount: log.args.amount,
          timestamp: log.blockTimestamp,
          message: log.args.message,
          txHash: log.transactionHash,
        }];
      });
      setSentTips(sentTipHistory);
    } catch (error) {
      if (activeDataContextRef.current === requestContext) {
        setSentHistoryError(`Sent history could not be refreshed. ${getErrorMessage(error)}`);
      }
    } finally {
      if (activeDataContextRef.current === requestContext) {
        setIsSentHistoryLoading(false);
      }
    }
  }, [account, contractEventLoader]);
  async function refreshAllData() {
    if (!account || isLoading || isSentHistoryLoading) return;
    if (refreshAllPromiseRef.current) return refreshAllPromiseRef.current;
    if (Date.now() < refreshCooldownUntil) return;

    const request = (async () => {
      setIsRefreshingAll(true);
      const cooldownUntil = Date.now() + 10_000;
      setRefreshCooldownUntil(cooldownUntil);
      globalThis.setTimeout(() => {
        setRefreshCooldownUntil((current) =>
          current === cooldownUntil ? 0 : current,
        );
      }, 10_000);
      setJarStatus("");
      setSentHistoryError("");
      contractEventLoader.invalidate();
      await Promise.all([
        refreshData(),
        refreshWalletBalance(),
        refreshSentHistory(),
      ]);
    })();

    refreshAllPromiseRef.current = request;
    try {
      await request;
    } finally {
      if (refreshAllPromiseRef.current === request) {
        refreshAllPromiseRef.current = null;
      }
      setIsRefreshingAll(false);
    }
  }

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
    setRecipientInput(accounts[0] ?? "");
    const nextChainId = Number.parseInt(walletChainId, 16);
    setChainId(nextChainId);
    const detectedNetwork = getArcNetworkByChainId(nextChainId);
    if (detectedNetwork) setSelectedNetworkKey(detectedNetwork.key);
  }, []);

  useEffect(() => {
    void syncWalletState();
  }, [syncWalletState]);

  useEffect(() => {
    setStats(emptyStats);
    setWalletBalance(null);
    setReceivedTips([]);
    setClaims([]);
    setJarStatus("");
    setSendStatus("");
    setSendTxHash(null);
    setIsSending(false);
    setClaimStatus("");
    setClaimTxHash(null);
    setIsClaiming(false);
    setLastUpdatedAt(null);
    setIsContractReady(false);

    if (account) {
      setIsLoading(true);
      void refreshData();
    } else {
      setIsLoading(false);
      setMobileView("send");
    }
  }, [account, refreshData, selectedNetworkKey]);

  useEffect(() => {
    void refreshWalletBalance();
  }, [refreshWalletBalance]);

  useEffect(() => {
    setSentTips([]);
    setSentTipCount(0);
    setSentHistoryError("");
    setSendTxHash(null);
    if (account) void refreshSentHistory();
  }, [account, refreshSentHistory, selectedNetworkKey]);
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
      setRecipientInput(accounts[0] ?? "");
      setSendStatus("");
      setWalletStatus("");
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
      setWalletStatus("Open this site in MetaMask or Rabby, or install an injected EVM wallet.");
      return;
    }

    setIsConnecting(true);
    setWalletStatus("");
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as Address[];
      const nextAccount = accounts[0] ?? null;

      window.localStorage.removeItem("arc-tip-jar-disconnected");
      setAccount(nextAccount);
      setRecipientInput(nextAccount ?? "");
      const walletChainId = Number.parseInt(
        (await window.ethereum.request({ method: "eth_chainId" })) as string,
        16,
      );
      setChainId(walletChainId);

      const detectedNetwork = getArcNetworkByChainId(walletChainId);
      if (detectedNetwork) {
        setSelectedNetworkKey(detectedNetwork.key);
        setWalletStatus(`Connected on ${detectedNetwork.chain.name}. Your network was not changed.`);
      } else {
        await switchToNetwork(selectedNetwork);
        setWalletStatus(`Connected and switched to ${selectedNetwork.chain.name}.`);
      }
    } catch (error) {
      setWalletStatus(getErrorMessage(error));
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
      // Not every injected wallet supports permission revocation. Ending the
      // local dApp session still prevents automatic reconnection.
    } finally {
      window.localStorage.setItem("arc-tip-jar-disconnected", "true");
      setAccount(null);
      setChainId(null);
      setRecipientInput("");
      setSendTxHash(null);
      setClaimTxHash(null);
      setSendStatus("");
      setClaimStatus("");
      setJarStatus("");
      setSentHistoryError("");
      setWalletStatus("Wallet disconnected from this dApp.");
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

  async function switchToSelectedNetwork() {
    setWalletStatus("");
    try {
      await switchToNetwork(selectedNetwork);
      setWalletStatus(`Switched to ${selectedNetwork.chain.name}.`);
    } catch (error) {
      setWalletStatus(`Could not switch networks. ${getErrorMessage(error)}`);
    }
  }

  async function selectNetwork(nextKey: ArcNetworkKey) {
    const nextNetwork = arcNetworks[nextKey];
    if (!nextNetwork) return;

    setSelectedNetworkKey(nextKey);
    setWalletStatus("");
    setSendStatus("");
    setSendTxHash(null);
    setClaimTxHash(null);
    if (account && chainId !== nextNetwork.chain.id) {
      try {
        await switchToNetwork(nextNetwork);
        setWalletStatus(`Switched to ${nextNetwork.chain.name}.`);
      } catch (error) {
        setWalletStatus(`Could not switch networks. ${getErrorMessage(error)}`);
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
    setSendStatus("");
  }

  async function copyTransactionHash(hash: Hash) {
    await navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    window.setTimeout(() => setCopiedHash((current) => (current === hash ? null : current)), 1500);
  }

  async function sendTip(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSendStatus("");
    setSendTxHash(null);

    if (!window.ethereum || !account) {
      setSendStatus("Connect your wallet first.");
      return;
    }
    if (!isCorrectNetwork) {
      setSendStatus(`Switch to ${chain.name} before sending a tip.`);
      return;
    }
    if (!isContractReady) {
      setSendStatus("Contract data is still loading. Refresh and try again.");
      return;
    }
    if (!recipientAddress) {
      setSendStatus("Enter a valid recipient wallet address.");
      return;
    }
    if (messageBytes > 280) {
      setSendStatus("The message must be 280 bytes or fewer.");
      return;
    }
    if (parsedTipAmount === null) {
      setSendStatus("Enter a valid USDC amount greater than zero.");
      return;
    }
    if (exceedsSpendableBalance) {
      setSendStatus("The amount exceeds your spendable balance after the gas reserve.");
      return;
    }

    const operationContext = activeDataContextRef.current;
    const isCurrentOperation = () =>
      activeDataContextRef.current === operationContext;
    setIsSending(true);
    setSendStatus("Confirm this transaction in your wallet…");
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
        value: parsedTipAmount,
      });

      if (!isCurrentOperation()) return;
      setSendTxHash(hash);
      setSendStatus("Transaction submitted. Waiting for confirmation…");
      await publicClient.waitForTransactionReceipt({ hash });
      if (!isCurrentOperation()) return;
      setSendStatus(`Tip confirmed on ${chain.name}.`);
      setAmount("0.01");
      setAmountPercentage(0);
      setMessage("");
      contractEventLoader.invalidate();
      await Promise.all([refreshData(), refreshWalletBalance(), refreshSentHistory()]);
    } catch (error) {
      if (isCurrentOperation()) setSendStatus(getErrorMessage(error));
    } finally {
      if (isCurrentOperation()) setIsSending(false);
    }
  }
  async function claimTips() {
    setClaimStatus("");
    setClaimTxHash(null);

    if (!window.ethereum || !account) {
      setClaimStatus("Connect your wallet to claim its collected tips.");
      return;
    }
    if (!isCorrectNetwork) {
      setClaimStatus(`Switch to ${chain.name} before claiming tips.`);
      return;
    }
    if (stats.balance === 0n) {
      setClaimStatus("There are no tips available to claim.");
      return;
    }

    const operationContext = activeDataContextRef.current;
    const isCurrentOperation = () =>
      activeDataContextRef.current === operationContext;
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

      if (!isCurrentOperation()) return;
      setClaimTxHash(hash);
      setClaimStatus("Claim submitted. Waiting for confirmation…");
      await publicClient.waitForTransactionReceipt({ hash });
      if (!isCurrentOperation()) return;
      setClaimStatus(`Claim confirmed on ${chain.name}.`);
      contractEventLoader.invalidate();
      await Promise.all([refreshData(), refreshWalletBalance()]);
    } catch (error) {
      if (isCurrentOperation()) setClaimStatus(getErrorMessage(error));
    } finally {
      if (isCurrentOperation()) setIsClaiming(false);
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
              <option value="testnet">Testnet</option>
              <option value="mainnet" disabled={!arcNetworks.mainnet}>
                Mainnet{arcNetworks.mainnet ? "" : " · Soon"}
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
              ? "Disconnect"
              : isConnecting
                ? "Connecting…"
                : "Connect wallet"}
          </button>
        </div>
      </header>

      {walletStatus && (
        <div className="wallet-notice" role="status" aria-live="polite">
          <span>{walletStatus}</span>
          <button
            type="button"
            aria-label="Dismiss wallet status"
            onClick={() => setWalletStatus("")}
          >
            ×
          </button>
        </div>
      )}

      <section id="top" className={"hero " + (account ? "hero-connected" : "")}>
        <div className="eyebrow">BUILT ON {chain.name.toUpperCase()}</div>
        <h1>
          {account ? <><span>Send thanks.</span><br />Keep it onchain.</> : <>Send a tiny thank-you.<br />Keep it onchain.</>}
        </h1>
        <p className="hero-copy">
          {account
            ? `Connected as ${shortAddress(account)}. Send a tip or open My jar to manage what you received.`
            : "Tip native USDC, attach a message, and leave a public contribution record on Arc."}
        </p>
      </section>

      {!account ? (
        <section className="onboarding-panel" aria-labelledby="onboarding-title">
          <div className="onboarding-heading">
            <div>
              <span className="section-label">HOW IT WORKS</span>
              <h2 id="onboarding-title">One wallet. One message. Onchain forever.</h2>
            </div>
            <span className="network-pill neutral">Wallet not connected</span>
          </div>
          <div className="onboarding-primary">
            <button
              className="onboarding-connect"
              type="button"
              onClick={() => void connectWallet()}
              disabled={isConnecting}
            >
              {isConnecting ? "Connecting…" : "Connect wallet"}
            </button>
            <small>Works with injected wallets such as MetaMask and Rabby.</small>
          </div>
          <ol className="onboarding-steps">
            <li>
              <span>1</span>
              <div><strong>Connect</strong><small>Approve the request in your wallet.</small></div>
            </li>
            <li>
              <span>2</span>
              <div><strong>Choose a recipient</strong><small>Paste any EVM wallet address.</small></div>
            </li>
            <li>
              <span>3</span>
              <div><strong>Send a tip</strong><small>Add USDC and an onchain message.</small></div>
            </li>
          </ol>
          {selectedNetwork.faucetUrl && (
            <a
              className="onboarding-faucet"
              href={selectedNetwork.faucetUrl}
              target="_blank"
              rel="noreferrer"
            >
              Need test USDC? Open the official Circle Faucet ↗
            </a>
          )}
        </section>
      ) : (
        <>
          <div className="mobile-tabs" aria-label="Tip jar views">
            <button
              type="button"
              aria-pressed={mobileView === "send"}
              className={mobileView === "send" ? "active" : ""}
              onClick={() => setMobileView("send")}
            >
              Send
            </button>
            <button
              type="button"
              aria-pressed={mobileView === "jar"}
              className={mobileView === "jar" ? "active" : ""}
              onClick={() => setMobileView("jar")}
            >
              My jar
            </button>
          </div>

          <div className="connected-dashboard">
            <section
              id="jar-summary"
              className={"stats-grid mobile-jar-pane " + (mobileView !== "jar" ? "mobile-pane-inactive" : "")}
              aria-label="Your tip jar statistics"
            >
              <article className="stat-card claim-card">
                <div className="stat-heading-row">
                  <span>Claimable now</span>
                  <span className="owner-chip">{shortAddress(account)}</span>
                </div>
                <strong>
                  {isLoading && !isContractReady ? <span className="skeleton-value" aria-label="Loading" /> : formatUsdc(stats.balance)} USDC
                </strong>
                <small className="tip-count-detail">
                  {isLoading && !isContractReady ? (
                    <span className="skeleton-text" aria-label="Loading tip count" />
                  ) : (
                    <><strong>{stats.claimableCount.toString()}</strong> current tip{stats.claimableCount === 1n ? "" : "s"}</>
                  )}
                </small>
                <button
                  className="claim-button"
                  type="button"
                  onClick={() => isCorrectNetwork ? void claimTips() : void switchToSelectedNetwork()}
                  disabled={isClaiming || (isCorrectNetwork && (!isContractReady || stats.balance === 0n))}
                >
                  {isClaiming
                    ? "Claiming…"
                    : !isCorrectNetwork
                      ? `Switch to ${chain.name} to claim`
                      : !isContractReady
                        ? isLoading
                          ? "Loading jar…"
                          : "Jar unavailable"
                        : stats.balance === 0n
                          ? "Nothing to claim"
                          : "Claim all tips"}
                </button>
                {claimStatus && <p className="claim-status" role="status" aria-live="polite">{claimStatus}</p>}
                {claimTxHash && (
                  <div className="operation-transaction compact">
                    <span>{shortHash(claimTxHash)}</span>
                    <button className="copy-button" type="button" aria-label="Copy claim transaction hash" title={copiedHash === claimTxHash ? "Copied" : "Copy transaction hash"} onClick={() => void copyTransactionHash(claimTxHash)}>
                      <CopyIcon copied={copiedHash === claimTxHash} />
                    </button>
                    <a href={(chain.blockExplorers?.default.url ?? "") + "/tx/" + claimTxHash} target="_blank" rel="noreferrer">
                      ArcScan ↗
                    </a>
                  </div>
                )}
                <details className="claim-history-details">
                  <summary>
                    <span>Claim history</span>
                    <strong>{stats.claimCount.toString()}</strong>
                  </summary>
                  {isLoading ? (
                    <p className="muted">Loading claim history…</p>
                  ) : claims.length === 0 ? (
                    <p className="muted">No claims yet.</p>
                  ) : (
                    <ol className="claim-list compact-list">
                      {claims.map((claim) => (
                        <li key={claim.index.toString()}>
                          <div className="history-main">
                            <strong>{formatUsdc(claim.amount)} USDC</strong>
                            <time dateTime={new Date(Number(claim.timestamp) * 1000).toISOString()}>
                              {new Date(Number(claim.timestamp) * 1000).toLocaleString()}
                            </time>
                          </div>
                          {claim.txHash && (
                            <div className="history-transaction">
                              <span>{shortHash(claim.txHash)}</span>
                              <button className="copy-button" type="button" aria-label="Copy claim transaction hash" title={copiedHash === claim.txHash ? "Copied" : "Copy transaction hash"} onClick={() => void copyTransactionHash(claim.txHash!)}>
                                <CopyIcon copied={copiedHash === claim.txHash} />
                              </button>
                              <a href={(chain.blockExplorers?.default.url ?? "") + "/tx/" + claim.txHash} target="_blank" rel="noreferrer">
                                ArcScan ↗
                              </a>
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
              </article>

              <article className="stat-card">
                <div className="stat-heading-row">
                  <span>Lifetime received</span>
                  <span className="owner-chip">My jar</span>
                </div>
                <strong>
                  {isLoading && !isContractReady ? <span className="skeleton-value" aria-label="Loading" /> : formatUsdc(stats.totalReceived)} USDC
                </strong>
                <small className="tip-count-detail">
                  {isLoading && !isContractReady ? (
                    <span className="skeleton-text" aria-label="Loading tip count" />
                  ) : (
                    <><strong>{stats.tipCount.toString()}</strong> lifetime tip{stats.tipCount === 1n ? "" : "s"}</>
                  )}
                </small>
                <p className="stat-description">Always tied to your connected wallet—not the recipient in the Send form.</p>
              </article>
            </section>

            <article
              id="send-panel"
              className={"panel tip-panel mobile-send-pane " + (mobileView !== "send" ? "mobile-pane-inactive" : "")}
            >
              <div className="panel-heading">
                <div>
                  <span className="section-label">SEND A TIP</span>
                  <h2>Support the jar</h2>
                </div>
                <span className={"network-pill " + (isCorrectNetwork ? "online" : "warning")}>
                  {isCorrectNetwork ? chain.name : "Switch network"}
                </span>
              </div>

              <div className="wallet-balance-row">
                <span>Connected wallet balance</span>
                <strong>
                  {walletBalance !== null ? formatUsdc(walletBalance) + " USDC" : "Unavailable"}
                </strong>
                <small>Available on {chain.name} for tips and gas</small>
              </div>

              {isCorrectNetwork && !isLoading && !isContractReady && (
                <div className="panel-alert contract-alert" role="alert">
                  <p>Jar data is unavailable, so sending is paused.</p>
                  <button
                    type="button"
                    onClick={() => void refreshAllData()}
                    disabled={isRefreshingAll || isLoading || isSentHistoryLoading || Date.now() < refreshCooldownUntil}
                  >
                    {Date.now() < refreshCooldownUntil ? "Try again shortly" : "Retry jar data"}
                  </button>
                </div>
              )}

              {!isCorrectNetwork ? (
                <div className="connect-state compact-state">
                  <p>Your wallet is connected to another network.</p>
                  <button type="button" onClick={() => void switchToSelectedNetwork()}>
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
                      onChange={(event) => {
                        setAmount(event.target.value);
                        setAmountPercentage(0);
                        setSendStatus("");
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
                        className={amount === preset ? "active" : ""}
                        aria-pressed={amount === preset}
                        onClick={() => {
                          setPresetAmount(preset);
                          setSendStatus("");
                        }}
                      >
                        {preset} USDC
                      </button>
                    ))}
                  </div>

                  <div className="percentage-control">
                    <div>
                      <span>Spendable balance percentage</span>
                      <strong>{amountPercentage.toFixed(amountPercentage % 1 === 0 ? 0 : 2)}%</strong>
                    </div>
                    <input
                      aria-label="Wallet balance percentage"
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={Math.round(amountPercentage)}
                      onChange={(event) => {
                        setAmountFromPercentage(Number(event.target.value));
                        setSendStatus("");
                      }}
                      disabled={!walletBalance || walletBalance === 0n}
                    />
                    <div className="range-labels"><span>0%</span><span>100% · keeps 0.01 for gas</span></div>
                  </div>

                  <label htmlFor="message">Onchain message</label>
                  <textarea
                    id="message"
                    value={message}
                    onChange={(event) => {
                      setMessage(event.target.value);
                      setSendStatus("");
                    }}
                    placeholder="Leave a short message"
                    rows={4}
                    aria-invalid={messageBytes > 280}
                    aria-describedby="message-byte-count"
                  />
                  <div id="message-byte-count" className={"byte-count " + (messageBytes > 280 ? "invalid" : "")}>
                    {messageBytes} / 280 bytes
                  </div>

                  <div className="field-heading">
                    <label htmlFor="recipient">Recipient wallet</label>
                    <button className="inline-action" type="button" onClick={useConnectedWalletAsRecipient}>
                      Use my address
                    </button>
                  </div>
                  <input
                    className={"address-input " + (recipientInput && !recipientAddress ? "invalid" : "")}
                    id="recipient"
                    value={recipientInput}
                    onChange={(event) => {
                      setRecipientInput(event.target.value.trim());
                      setSendStatus("");
                    }}
                    placeholder="0x…"
                    spellCheck={false}
                    required
                    aria-invalid={Boolean(recipientInput && !recipientAddress)}
                    aria-describedby={recipientInput && !recipientAddress ? "recipient-error" : undefined}
                  />
                  {recipientInput && !recipientAddress && (
                    <p id="recipient-error" className="field-error" role="alert">Enter a valid EVM wallet address.</p>
                  )}

                  {canSendTip && recipientAddress && parsedTipAmount !== null && (
                    <div className="send-review" aria-label="Tip summary">
                      <div><span>Ready to send</span><strong>{formatUsdc(parsedTipAmount)} USDC</strong></div>
                      <small>To {shortAddress(recipientAddress)}{remainingAfterTip !== null ? " · Balance after " + formatUsdc(remainingAfterTip) + " USDC" : ""}</small>
                    </div>
                  )}

                  <button className="primary-button" type="submit" disabled={!canSendTip || isSending}>
                    {sendButtonLabel}
                  </button>
                  {sendStatus && (
                    <p className="status-message operation-status" role="status" aria-live="polite">
                      {sendStatus}
                    </p>
                  )}
                  {sendTxHash && (
                    <div className="operation-transaction">
                      <span>{shortHash(sendTxHash)}</span>
                      <button className="copy-button" type="button" aria-label="Copy send transaction hash" title={copiedHash === sendTxHash ? "Copied" : "Copy transaction hash"} onClick={() => void copyTransactionHash(sendTxHash)}>
                        <CopyIcon copied={copiedHash === sendTxHash} />
                      </button>
                      <a href={(chain.blockExplorers?.default.url ?? "") + "/tx/" + sendTxHash} target="_blank" rel="noreferrer">
                        View on ArcScan ↗
                      </a>
                    </div>
                  )}
                </form>
              )}

              {selectedNetwork.faucetUrl && (
                <a className="faucet-button" href={selectedNetwork.faucetUrl} target="_blank" rel="noreferrer">
                  Get testnet USDC from the official Circle Faucet ↗
                </a>
              )}

              <details className="send-history-details">
                <summary>
                  <span>Sent tip history</span>
                  <strong>{sentTipCount}</strong>
                </summary>
                {sentHistoryError && <p className="panel-error" role="alert">{sentHistoryError}</p>}
                {isSentHistoryLoading ? (
                  <p className="muted">Loading sent tips…</p>
                ) : sentTips.length === 0 ? (
                  <p className="muted">No sent tips yet.</p>
                ) : (
                  <ol className="tip-list compact-list">
                    {sentTips.map((tip) => (
                      <li key={tip.txHash ?? tip.index.toString()}>
                        <div className="history-main">
                          <strong>{formatUsdc(tip.amount)} USDC</strong>
                          <time dateTime={new Date(Number(tip.timestamp) * 1000).toISOString()}>
                            {new Date(Number(tip.timestamp) * 1000).toLocaleString()}
                          </time>
                        </div>
                        <span className="tip-recipient">To {shortAddress(tip.recipient)}</span>
                        {tip.message && <p>{tip.message}</p>}
                        {tip.txHash && (
                          <div className="history-transaction">
                            <span>{shortHash(tip.txHash)}</span>
                            <button className="copy-button" type="button" aria-label="Copy send transaction hash" title={copiedHash === tip.txHash ? "Copied" : "Copy transaction hash"} onClick={() => void copyTransactionHash(tip.txHash!)}>
                              <CopyIcon copied={copiedHash === tip.txHash} />
                            </button>
                            <a href={(chain.blockExplorers?.default.url ?? "") + "/tx/" + tip.txHash} target="_blank" rel="noreferrer">
                              ArcScan ↗
                            </a>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </details>
            </article>

            <article
              id="latest-tips-panel"
              className={"panel recent-panel mobile-jar-pane " + (mobileView !== "jar" ? "mobile-pane-inactive" : "")}
            >
              <div className="panel-heading recent-heading">
                <div>
                  <span className="section-label">MY JAR</span>
                  <h2>Latest tips</h2>
                  <small className="updated-at">
                    {lastUpdatedAt ? "Updated " + lastUpdatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Waiting for first sync"}
                  </small>
                </div>
                <button
                  className="text-button refresh-button"
                  type="button"
                  onClick={() => void refreshAllData()}
                  disabled={isRefreshingAll || isLoading || isSentHistoryLoading || Date.now() < refreshCooldownUntil}
                >
                  {isRefreshingAll || isLoading || isSentHistoryLoading
                    ? "Refreshing…"
                    : Date.now() < refreshCooldownUntil
                      ? "Up to date"
                      : "Refresh all"}
                </button>
              </div>

              {jarStatus && (
                <div className="panel-alert" role="alert">
                  <p>{jarStatus}</p>
                  <button type="button" onClick={() => void refreshAllData()} disabled={isRefreshingAll || isLoading || isSentHistoryLoading || Date.now() < refreshCooldownUntil}>Retry</button>
                </div>
              )}

              {isLoading && receivedTips.length === 0 ? (
                <div className="skeleton-list" aria-label="Loading onchain data">
                  <span /><span /><span />
                </div>
              ) : receivedTips.length === 0 ? (
                <p className="muted">No tips received yet.</p>
              ) : (
                <ol className="tip-list">
                  {receivedTips.map((tip) => (
                    <li key={tip.index.toString()}>
                      <div className="tip-main">
                        <strong>{formatUsdc(tip.amount)} USDC</strong>
                        <span>From {shortAddress(tip.sender)}</span>
                      </div>
                      <p>{tip.message || "Direct transfer"}</p>
                      <time dateTime={new Date(Number(tip.timestamp) * 1000).toISOString()}>
                        {new Date(Number(tip.timestamp) * 1000).toLocaleString()}
                      </time>
                      {tip.txHash && (
                        <div className="history-transaction">
                          <span>{shortHash(tip.txHash)}</span>
                          <button className="copy-button" type="button" aria-label="Copy received transaction hash" title={copiedHash === tip.txHash ? "Copied" : "Copy transaction hash"} onClick={() => void copyTransactionHash(tip.txHash!)}>
                            <CopyIcon copied={copiedHash === tip.txHash} />
                          </button>
                          <a href={(chain.blockExplorers?.default.url ?? "") + "/tx/" + tip.txHash} target="_blank" rel="noreferrer">
                            ArcScan ↗
                          </a>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </article>
          </div>
        </>
      )}

      <footer>
        <span>{chain.testnet ? "Experimental testnet dApp. Testnet USDC has no real-world value." : "Arc Tip Jar on Mainnet."}</span>
        <a href={contractExplorerUrl} target="_blank" rel="noreferrer">
          {shortAddress(contractAddress)} ↗
        </a>
      </footer>
    </main>
  );
}
