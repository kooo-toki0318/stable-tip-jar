import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  toHex,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
} from "viem";
import { arcTipJarAbi } from "./abi";
import {
  formatCount,
  formatEpochSeconds,
  formatPercentage,
  formatUpdatedTime,
  formatUsdc,
} from "./formatters";
import { getSupportedLanguage } from "./i18n";
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

type UiMessage = {
  key: string;
  values?: Record<string, string | number>;
};

type ClipboardFeedback = {
  targetId: string;
  message: UiMessage;
  success: boolean;
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
  if (copied) {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
        <path d="m5 12.5 4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
      <rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

const RPC_MIN_INTERVAL_MS = 250;
let rpcQueue: Promise<void> = Promise.resolve();
let lastRpcRequestAt = 0;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function withRpcQueue<T>(request: () => Promise<T>): Promise<T> {
  const runRequest = async () => {
    const elapsed = Date.now() - lastRpcRequestAt;
    if (elapsed < RPC_MIN_INTERVAL_MS) {
      await wait(RPC_MIN_INTERVAL_MS - elapsed);
    }
    lastRpcRequestAt = Date.now();
    return request();
  };
  const queuedRequest = rpcQueue.then(runRequest, runRequest);
  rpcQueue = queuedRequest.then(
    () => undefined,
    () => undefined,
  );
  return queuedRequest;
}

type ActivityTransaction = {
  index: number;
  transactionHash: Hash;
};

type ActivityLog = {
  blockNumber: number;
  logIndex: number;
  transactionHash: Hash;
  data: Hex;
  topics: [Hex, ...Hex[]];
  timestamp: string | null;
};

type ActivityResponse = {
  sentTipCount: number;
  sentTips: ActivityLog[];
  receivedTipTransactions: ActivityTransaction[];
  claimTransactions: ActivityTransaction[];
};

async function loadAccountActivity(
  address: Address,
  network: ArcNetworkKey,
  bypassCache = false,
): Promise<ActivityResponse> {
  const query = new URLSearchParams({ address, network });
  if (bypassCache) query.set("refresh", String(Date.now()));
  const response = await fetch(`/api/activity?${query}`, {
    cache: bypassCache ? "no-store" : "default",
  });
  const payload = (await response.json()) as ActivityResponse & {
    code?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.code ?? payload.error ?? "INDEXER_UNAVAILABLE");
  }
  return payload;
}

function decodeSentTip(log: ActivityLog): Tip | null {
  if (!log.timestamp || !log.transactionHash || log.topics.length === 0) return null;
  try {
    const decoded = decodeEventLog({
      abi: arcTipJarAbi,
      data: log.data,
      topics: log.topics,
      strict: true,
    });
    if (decoded.eventName !== "TipReceived") return null;
    return {
      index: BigInt(log.blockNumber) * 100_000n + BigInt(log.logIndex),
      sender: decoded.args.sender,
      recipient: decoded.args.recipient,
      amount: decoded.args.amount,
      timestamp: BigInt(log.timestamp),
      message: decoded.args.message,
      txHash: log.transactionHash,
    };
  } catch {
    return null;
  }
}

function getErrorUiMessage(
  error: unknown,
  fallbackKey = "status.error.withDetail",
): UiMessage {
  if (error instanceof Error) {
    const detail = error.message.split("\n")[0];
    const normalizedDetail = detail.toLowerCase();
    if (
      normalizedDetail.includes("user rejected") ||
      normalizedDetail.includes("user denied")
    ) {
      return { key: "status.error.walletRequestRejected" };
    }
    if (detail === "INDEXER_NOT_CONFIGURED") {
      return { key: "status.refresh.historyIndexerNotConfigured" };
    }
    return { key: fallbackKey, values: { error: detail } };
  }
  return { key: "status.error.generic" };
}

export default function App() {
  const { t, i18n } = useTranslation();
  const language = getSupportedLanguage(i18n.resolvedLanguage ?? i18n.language);
  const locale = language === "ja" ? "ja-JP" : "en-US";
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [selectedNetworkKey, setSelectedNetworkKey] =
    useState<ArcNetworkKey>("testnet");
  const [recipientInput, setRecipientInput] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [amountPercentage, setAmountPercentage] = useState(0);
  const [message, setMessage] = useState(() => t("send.defaultMessage"));
  const [stats, setStats] = useState<JarStats>(emptyStats);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [receivedTips, setReceivedTips] = useState<Tip[]>([]);
  const [sentTips, setSentTips] = useState<Tip[]>([]);
  const [sentTipCount, setSentTipCount] = useState(0);
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [receivedTipTxHashes, setReceivedTipTxHashes] = useState<Record<string, Hash>>({});
  const [claimTxHashes, setClaimTxHashes] = useState<Record<string, Hash>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSentHistoryLoading, setIsSentHistoryLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isContractReady, setIsContractReady] = useState(false);
  const [walletStatus, setWalletStatus] = useState<UiMessage | null>(null);
  const [jarStatus, setJarStatus] = useState<UiMessage | null>(null);
  const [sendStatus, setSendStatus] = useState<UiMessage | null>(null);
  const [sentHistoryError, setSentHistoryError] = useState<UiMessage | null>(null);
  const [claimStatus, setClaimStatus] = useState<UiMessage | null>(null);
  const [recipientNotice, setRecipientNotice] = useState<UiMessage | null>(null);
  const [isRecipientHighlighted, setIsRecipientHighlighted] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [mobileView, setMobileView] = useState<"send" | "jar">("send");
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshCooldownUntil, setRefreshCooldownUntil] = useState(0);
  const refreshAllPromiseRef = useRef<Promise<void> | null>(null);
  const [sendTxHash, setSendTxHash] = useState<Hash | null>(null);
  const [claimTxHash, setClaimTxHash] = useState<Hash | null>(null);
  const [clipboardFeedback, setClipboardFeedback] =
    useState<ClipboardFeedback | null>(null);
  const copiedTargetId = clipboardFeedback?.success
    ? clipboardFeedback.targetId
    : null;
  const amountInputRef = useRef<HTMLInputElement>(null);
  const networkSwitchButtonRef = useRef<HTMLButtonElement>(null);
  const recipientInputRef = useRef<HTMLInputElement>(null);
  const clipboardFeedbackTimeoutRef = useRef<number | null>(null);
  const recipientHighlightTimeoutRef = useRef<number | null>(null);

  const selectedNetwork = arcNetworks[selectedNetworkKey] ?? arcNetworks.testnet!;
  const { chain, contractAddress } = selectedNetwork;
  const activeDataContextRef = useRef("");
  const activeDataContext = `${selectedNetwork.key}:${account ?? "disconnected"}`;
  activeDataContextRef.current = activeDataContext;
  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain,
        transport: http(selectedNetwork.browserRpcUrl, { retryCount: 0 }),
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
    ? t("send.cta.confirming")
    : !isContractReady
      ? isLoading
        ? t("send.cta.loadingContract")
        : t("send.cta.jarUnavailable")
      : parsedTipAmount === null
        ? t("send.cta.enterAmount")
        : exceedsSpendableBalance
          ? t("send.cta.insufficientBalance")
          : messageBytes > 280
            ? t("send.cta.shortenMessage")
            : !recipientInput
              ? t("send.cta.enterRecipient")
              : !recipientAddress
                ? t("send.cta.checkRecipient")
                : t("send.cta.sendAmount", { amount: formatUsdc(parsedTipAmount, locale) });
  const receivedTipsWithTransactions = useMemo(
    () =>
      receivedTips.map((tip) => ({
        ...tip,
        txHash: receivedTipTxHashes[tip.index.toString()] ?? null,
      })),
    [receivedTipTxHashes, receivedTips],
  );
  const claimsWithTransactions = useMemo(
    () =>
      claims.map((claim) => ({
        ...claim,
        txHash: claimTxHashes[claim.index.toString()] ?? null,
      })),
    [claimTxHashes, claims],
  );
  const remainingAfterTip =
    walletBalance !== null && parsedTipAmount !== null && walletBalance >= parsedTipAmount
      ? walletBalance - parsedTipAmount
      : null;

  const refreshData = useCallback(async () => {
    if (!account) return;
    const requestContext = activeDataContextRef.current;
    const isCurrentRequest = () => activeDataContextRef.current === requestContext;
    setIsLoading(true);
    setJarStatus(null);
    let refreshSucceeded = true;
    try {
      const jarAddress = account;
      const contract = { address: contractAddress, abi: arcTipJarAbi } as const;
      const [balance, claimableCount, totalReceived, totalClaimed, tipCount, claimCount] =
        await withRpcQueue(() =>
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
          const tipResults = await withRpcQueue(() =>
            publicClient.multicall({
              allowFailure: false,
              contracts: tipIndexes.map((index) => ({
                ...contract,
                functionName: "getRecipientTip" as const,
                args: [jarAddress, index] as const,
              })),
            }),
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
              txHash: null,
            })),
          );
        }
      } catch (error) {
        refreshSucceeded = false;
        if (isCurrentRequest()) {
          setJarStatus(getErrorUiMessage(error, "status.refresh.latestTipsFailed"));
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
          const claimResults = await withRpcQueue(() =>
            publicClient.multicall({
              allowFailure: false,
              contracts: claimIndexes.map((index) => ({
                ...contract,
                functionName: "getRecipientClaim" as const,
                args: [jarAddress, index] as const,
              })),
            }),
          );
          if (!isCurrentRequest()) return;
          setClaims(
            claimResults.map(([claimAmount, timestamp], offset): ClaimRecord => ({
              index: claimIndexes[offset],
              amount: claimAmount,
              timestamp,
              txHash: null,
            })),
          );
        }
      } catch (error) {
        refreshSucceeded = false;
        if (isCurrentRequest()) {
          setJarStatus(getErrorUiMessage(error, "status.refresh.claimHistoryFailed"));
        }
      }
      if (refreshSucceeded && isCurrentRequest()) setLastUpdatedAt(new Date());
    } catch (error) {
      refreshSucceeded = false;
      if (isCurrentRequest()) {
        setJarStatus(getErrorUiMessage(error, "status.refresh.jarDataFailed"));
      }
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
    return refreshSucceeded && isCurrentRequest();
  }, [account, contractAddress, publicClient]);
  const refreshWalletBalance = useCallback(async () => {
    if (!account) {
      setWalletBalance(null);
      return;
    }

    const requestContext = activeDataContextRef.current;
    try {
      const nextBalance = await withRpcQueue(() =>
        publicClient.getBalance({ address: account }),
      );
      if (activeDataContextRef.current === requestContext) setWalletBalance(nextBalance);
    } catch {
      if (activeDataContextRef.current === requestContext) setWalletBalance(null);
    }
  }, [account, publicClient]);
  const refreshActivity = useCallback(async (bypassCache = false) => {
    if (!account) {
      setSentTips([]);
      setSentTipCount(0);
      setReceivedTipTxHashes({});
      setClaimTxHashes({});
      setIsSentHistoryLoading(false);
      setSentHistoryError(null);
      return;
    }

    const requestContext = activeDataContextRef.current;
    setIsSentHistoryLoading(true);
    setSentHistoryError(null);
    try {
      const activity = await loadAccountActivity(
        account,
        selectedNetworkKey,
        bypassCache,
      );
      if (activeDataContextRef.current !== requestContext) return;
      setSentTipCount(activity.sentTipCount);
      setSentTips(
        activity.sentTips.flatMap((log): Tip[] => {
          const tip = decodeSentTip(log);
          return tip ? [tip] : [];
        }),
      );
      setReceivedTipTxHashes(
        Object.fromEntries(
          activity.receivedTipTransactions.map(({ index, transactionHash }) => [
            String(index),
            transactionHash,
          ]),
        ),
      );
      setClaimTxHashes(
        Object.fromEntries(
          activity.claimTransactions.map(({ index, transactionHash }) => [
            String(index),
            transactionHash,
          ]),
        ),
      );
    } catch (error) {
      if (activeDataContextRef.current === requestContext) {
        setSentHistoryError(
          getErrorUiMessage(error, "status.refresh.sentHistoryFailed"),
        );
      }
    } finally {
      if (activeDataContextRef.current === requestContext) {
        setIsSentHistoryLoading(false);
      }
    }
  }, [account, selectedNetworkKey]);
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
      setJarStatus(null);
      setSentHistoryError(null);
      await Promise.all([
        refreshData(),
        refreshWalletBalance(),
        refreshActivity(true),
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
    document.documentElement.lang = language;
    document.title = t("brand.name");
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = t("hero.disconnectedDescription");
  }, [language, t]);

  useEffect(() => () => {
    if (clipboardFeedbackTimeoutRef.current !== null) {
      globalThis.clearTimeout(clipboardFeedbackTimeoutRef.current);
    }
    if (recipientHighlightTimeoutRef.current !== null) {
      globalThis.clearTimeout(recipientHighlightTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    setStats(emptyStats);
    setWalletBalance(null);
    setReceivedTips([]);
    setClaims([]);
    setJarStatus(null);
    setSendStatus(null);
    setSendTxHash(null);
    setRecipientNotice(null);
    setIsRecipientHighlighted(false);
    setIsSending(false);
    setClaimStatus(null);
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
    setReceivedTipTxHashes({});
    setClaimTxHashes({});
    setSentHistoryError(null);
    setSendTxHash(null);
    if (account) void refreshActivity();
  }, [account, refreshActivity, selectedNetworkKey]);
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
      setRecipientNotice(null);
      setIsRecipientHighlighted(false);
      setSendStatus(null);
      setWalletStatus(null);
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
      setWalletStatus({ key: "status.wallet.providerMissing" });
      return;
    }

    setIsConnecting(true);
    setWalletStatus(null);
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
        setWalletStatus({
          key: "status.wallet.connectedWithoutSwitch",
          values: { network: detectedNetwork.chain.name },
        });
      } else {
        await switchToNetwork(selectedNetwork);
        setWalletStatus({
          key: "status.wallet.connectedAndSwitched",
          values: { network: selectedNetwork.chain.name },
        });
      }
    } catch (error) {
      setWalletStatus(getErrorUiMessage(error));
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
      setRecipientNotice(null);
      setIsRecipientHighlighted(false);
      setSendTxHash(null);
      setClaimTxHash(null);
      setSendStatus(null);
      setClaimStatus(null);
      setJarStatus(null);
      setSentHistoryError(null);
      setWalletStatus({ key: "status.wallet.disconnected" });
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
    setWalletStatus(null);
    try {
      await switchToNetwork(selectedNetwork);
      setWalletStatus({
        key: "status.wallet.switched",
        values: { network: selectedNetwork.chain.name },
      });
    } catch (error) {
      setWalletStatus(getErrorUiMessage(error, "status.wallet.switchFailed"));
    }
  }

  async function selectNetwork(nextKey: ArcNetworkKey) {
    const nextNetwork = arcNetworks[nextKey];
    if (!nextNetwork) return;

    setSelectedNetworkKey(nextKey);
    setWalletStatus(null);
    setSendStatus(null);
    setSendTxHash(null);
    setClaimTxHash(null);
    if (account && chainId !== nextNetwork.chain.id) {
      try {
        await switchToNetwork(nextNetwork);
        setWalletStatus({
          key: "status.wallet.switched",
          values: { network: nextNetwork.chain.name },
        });
      } catch (error) {
        setWalletStatus(getErrorUiMessage(error, "status.wallet.switchFailed"));
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

  function clearRecipientFeedback() {
    setRecipientNotice(null);
    setIsRecipientHighlighted(false);
  }

  function useConnectedWalletAsRecipient() {
    if (!account) return;
    setRecipientInput(account);
    clearRecipientFeedback();
    setSendStatus(null);
  }

  async function copyToClipboard(
    value: string,
    targetId: string,
    successKey: string,
  ) {
    try {
      await navigator.clipboard.writeText(value);
      setClipboardFeedback({
        targetId,
        message: { key: successKey },
        success: true,
      });
      if (clipboardFeedbackTimeoutRef.current !== null) {
        globalThis.clearTimeout(clipboardFeedbackTimeoutRef.current);
      }
      clipboardFeedbackTimeoutRef.current = globalThis.setTimeout(() => {
        setClipboardFeedback((current) =>
          current?.targetId === targetId ? null : current,
        );
        clipboardFeedbackTimeoutRef.current = null;
      }, 1_500);
    } catch (error) {
      setClipboardFeedback({
        targetId,
        message: getErrorUiMessage(error, "status.error.copyFailed"),
        success: false,
      });
      if (clipboardFeedbackTimeoutRef.current !== null) {
        globalThis.clearTimeout(clipboardFeedbackTimeoutRef.current);
      }
      clipboardFeedbackTimeoutRef.current = globalThis.setTimeout(() => {
        setClipboardFeedback((current) =>
          current?.targetId === targetId ? null : current,
        );
        clipboardFeedbackTimeoutRef.current = null;
      }, 3_000);
    }
  }

  function prepareTipBack(sender: Address) {
    if (!account || sender.toLowerCase() === account.toLowerCase()) return;

    setRecipientInput(sender);
    setRecipientNotice({
      key: "send.recipientFeedback.selected",
      values: { address: shortAddress(sender) },
    });
    setSendStatus(null);
    setSendTxHash(null);
    setMobileView("send");
    setIsRecipientHighlighted(false);

    globalThis.requestAnimationFrame(() => {
      setIsRecipientHighlighted(true);
      if (recipientHighlightTimeoutRef.current !== null) {
        globalThis.clearTimeout(recipientHighlightTimeoutRef.current);
      }
      recipientHighlightTimeoutRef.current = globalThis.setTimeout(() => {
        setIsRecipientHighlighted(false);
        recipientHighlightTimeoutRef.current = null;
      }, 1_500);

      globalThis.requestAnimationFrame(() => {
        const amountInput = amountInputRef.current;
        const nextAction = amountInput ?? networkSwitchButtonRef.current;
        if (!nextAction) return;

        nextAction.focus({ preventScroll: true });
        amountInput?.select();
        const rect = nextAction.getBoundingClientRect();
        const topOffset = globalThis.innerWidth <= 820 ? 150 : 96;
        const isOutsideView =
          rect.top < topOffset || rect.bottom > globalThis.innerHeight - 24;
        if (isOutsideView) {
          const reduceMotion = globalThis.matchMedia(
            "(prefers-reduced-motion: reduce)",
          ).matches;
          nextAction.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "center",
          });
        }
      });
    });
  }

  async function sendTip(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSendStatus(null);
    setSendTxHash(null);

    if (!window.ethereum || !account) {
      setSendStatus({ key: "status.send.walletRequired" });
      return;
    }
    if (!isCorrectNetwork) {
      setSendStatus({ key: "status.send.wrongNetwork", values: { network: chain.name } });
      return;
    }
    if (!isContractReady) {
      setSendStatus({ key: "status.send.contractLoading" });
      return;
    }
    if (!recipientAddress) {
      setSendStatus({ key: "status.send.invalidRecipient" });
      return;
    }
    if (messageBytes > 280) {
      setSendStatus({ key: "status.send.messageTooLong" });
      return;
    }
    if (parsedTipAmount === null) {
      setSendStatus({ key: "status.send.invalidAmount" });
      return;
    }
    if (exceedsSpendableBalance) {
      setSendStatus({ key: "status.send.amountExceedsBalance" });
      return;
    }

    setRecipientNotice(null);
    setIsRecipientHighlighted(false);
    const operationContext = activeDataContextRef.current;
    const isCurrentOperation = () =>
      activeDataContextRef.current === operationContext;
    setIsSending(true);
    setSendStatus({ key: "status.send.confirmInWallet" });
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
      setSendStatus({ key: "status.send.submitted" });
      await publicClient.waitForTransactionReceipt({ hash });
      if (!isCurrentOperation()) return;
      setSendStatus({ key: "status.send.confirmed", values: { network: chain.name } });
      setAmount("0.01");
      setAmountPercentage(0);
      setMessage("");
      await Promise.all([
        refreshData(),
        refreshWalletBalance(),
        refreshActivity(true),
      ]);
    } catch (error) {
      if (isCurrentOperation()) setSendStatus(getErrorUiMessage(error));
    } finally {
      if (isCurrentOperation()) setIsSending(false);
    }
  }
  async function claimTips() {
    setClaimStatus(null);
    setClaimTxHash(null);

    if (!window.ethereum || !account) {
      setClaimStatus({ key: "status.claim.walletRequired" });
      return;
    }
    if (!isCorrectNetwork) {
      setClaimStatus({ key: "status.claim.wrongNetwork", values: { network: chain.name } });
      return;
    }
    if (stats.balance === 0n) {
      setClaimStatus({ key: "status.claim.nothingAvailable" });
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
      setClaimStatus({ key: "status.claim.submitted" });
      await publicClient.waitForTransactionReceipt({ hash });
      if (!isCurrentOperation()) return;
      setClaimStatus({ key: "status.claim.confirmed", values: { network: chain.name } });
      await Promise.all([
        refreshData(),
        refreshWalletBalance(),
        refreshActivity(true),
      ]);
    } catch (error) {
      if (isCurrentOperation()) setClaimStatus(getErrorUiMessage(error));
    } finally {
      if (isCurrentOperation()) setIsClaiming(false);
    }
  }

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {clipboardFeedback
          ? t(clipboardFeedback.message.key, clipboardFeedback.message.values)
          : ""}
      </span>

      <header className="site-header">
        <div className="topbar page-shell">
          <a className="brand" href="#top" aria-label={t("brand.homeAria")}>
            <span className="brand-mark">A</span>
            <span>{t("brand.name")}</span>
          </a>

          <div className="header-actions">
            <a href={contractExplorerUrl} target="_blank" rel="noreferrer">
              {t("header.contract")}
            </a>

            <label className="network-select-label">
              <span className="sr-only">{t("header.networkLabel")}</span>
              <select
                aria-label={t("header.networkLabel")}
                value={selectedNetworkKey}
                onChange={(event) =>
                  void selectNetwork(event.target.value as ArcNetworkKey)
                }
              >
                <option value="testnet">{t("header.testnet")}</option>
                <option value="mainnet" disabled={!arcNetworks.mainnet}>
                  {arcNetworks.mainnet
                    ? t("header.mainnet")
                    : t("header.mainnetSoon")}
                </option>
              </select>
            </label>

            <label className="language-select-label">
              <span className="sr-only">{t("language.label")}</span>
              <select
                aria-label={t("language.selectAria")}
                value={language}
                onChange={(event) => void i18n.changeLanguage(event.target.value)}
              >
                <option value="ja">JA</option>
                <option value="en">EN</option>
              </select>
            </label>

            <a
              href="https://github.com/kooo-toki0318/arc-tip-jar"
              target="_blank"
              rel="noreferrer"
            >
              {t("header.github")}
            </a>

            <button
              className={"wallet-button " + (account ? "connected" : "")}
              type="button"
              onClick={account ? disconnectWallet : connectWallet}
              disabled={isConnecting}
              aria-label={
                account
                  ? t("header.disconnectWalletAria", { address: account })
                  : t("header.connectWalletAria")
              }
              title={account ?? undefined}
            >
              {account ? (
                <>
                  <span className="wallet-address">{shortAddress(account)}</span>
                  <span className="wallet-separator" aria-hidden="true">·</span>
                  <span className="wallet-action">{t("header.disconnect")}</span>
                </>
              ) : isConnecting ? (
                t("header.connecting")
              ) : (
                t("header.connectWallet")
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="page-shell">
        {walletStatus && (
          <div className="wallet-notice" role="status" aria-live="polite">
            <span>{t(walletStatus.key, walletStatus.values)}</span>
            <button
              type="button"
              aria-label={t("header.dismissWalletStatusAria")}
              onClick={() => setWalletStatus(null)}
            >
              ×
            </button>
          </div>
        )}

        <section id="top" className={"hero " + (account ? "hero-connected" : "")}>
          <div className="eyebrow">
            {t("brand.builtOn", { network: chain.name.toUpperCase() })}
          </div>
          <h1>
            {account ? (
              <>
                <span>{t("hero.connectedTitleLine1")}</span>
                <br />
                {t("hero.connectedTitleLine2")}
              </>
            ) : (
              <>
                {t("hero.disconnectedTitleLine1")}
                <br />
                {t("hero.disconnectedTitleLine2")}
              </>
            )}
          </h1>
          <p className="hero-copy">
            {account
              ? t("hero.connectedDescription", {
                  address: shortAddress(account),
                })
              : t("hero.disconnectedDescription")}
          </p>
        </section>

        {!account ? (
          <section className="onboarding-panel" aria-labelledby="onboarding-title">
            <div className="onboarding-heading">
              <div>
                <span className="section-label">{t("onboarding.sectionLabel")}</span>
                <h2 id="onboarding-title">{t("onboarding.title")}</h2>
              </div>
              <span className="network-pill neutral">
                {t("onboarding.walletNotConnected")}
              </span>
            </div>

            <div className="onboarding-primary">
              <button
                className="onboarding-connect"
                type="button"
                onClick={() => void connectWallet()}
                disabled={isConnecting}
              >
                {isConnecting
                  ? t("header.connecting")
                  : t("header.connectWallet")}
              </button>
              <small>{t("onboarding.walletSupport")}</small>
            </div>

            <ol className="onboarding-steps">
              <li>
                <span>1</span>
                <div>
                  <strong>{t("onboarding.connectTitle")}</strong>
                  <small>{t("onboarding.connectDescription")}</small>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>{t("onboarding.recipientTitle")}</strong>
                  <small>{t("onboarding.recipientDescription")}</small>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>{t("onboarding.sendTitle")}</strong>
                  <small>{t("onboarding.sendDescription")}</small>
                </div>
              </li>
            </ol>

            {selectedNetwork.faucetUrl && (
              <a
                className="onboarding-faucet"
                href={selectedNetwork.faucetUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("onboarding.faucetLink")}
              </a>
            )}
          </section>
        ) : (
          <>
            <div className="mobile-tabs" aria-label={t("navigation.viewsAria")}>
              <button
                type="button"
                aria-pressed={mobileView === "send"}
                className={mobileView === "send" ? "active" : ""}
                onClick={() => setMobileView("send")}
              >
                {t("navigation.send")}
              </button>
              <button
                type="button"
                aria-pressed={mobileView === "jar"}
                className={mobileView === "jar" ? "active" : ""}
                onClick={() => setMobileView("jar")}
              >
                {t("navigation.myJar")}
              </button>
            </div>

            <div className="connected-dashboard">
              <section
                id="jar-summary"
                className={
                  "stats-grid mobile-jar-pane " +
                  (mobileView !== "jar" ? "mobile-pane-inactive" : "")
                }
                aria-label={t("jar.statisticsAria")}
              >
                <article className="stat-card claim-card">
                  <div className="stat-heading-row">
                    <span>{t("jar.claimableNow")}</span>
                    <span className="owner-chip">{shortAddress(account)}</span>
                  </div>

                  <strong>
                    {isLoading && !isContractReady ? (
                      <span
                        className="skeleton-value"
                        aria-label={t("common.loading")}
                      />
                    ) : (
                      t("common.usdcAmount", {
                        amount: formatUsdc(stats.balance, locale),
                      })
                    )}
                  </strong>

                  <small className="tip-count-detail">
                    {isLoading && !isContractReady ? (
                      <span
                        className="skeleton-text"
                        aria-label={t("jar.loadingTipCountAria")}
                      />
                    ) : (
                      t(
                        stats.claimableCount === 1n
                          ? "jar.currentTip_one"
                          : "jar.currentTip_other",
                        { count: formatCount(stats.claimableCount, locale) },
                      )
                    )}
                  </small>

                  <button
                    className="claim-button"
                    type="button"
                    onClick={() =>
                      isCorrectNetwork
                        ? void claimTips()
                        : void switchToSelectedNetwork()
                    }
                    disabled={
                      isClaiming ||
                      (isCorrectNetwork &&
                        (!isContractReady || stats.balance === 0n))
                    }
                  >
                    {isClaiming
                      ? t("claim.claiming")
                      : !isCorrectNetwork
                        ? t("claim.switchToClaim", { network: chain.name })
                        : !isContractReady
                          ? isLoading
                            ? t("claim.loadingJar")
                            : t("claim.jarUnavailable")
                          : stats.balance === 0n
                            ? t("claim.nothingToClaim")
                            : t("claim.claimAll")}
                  </button>

                  {claimStatus && (
                    <p
                      className="claim-status"
                      role="status"
                      aria-live="polite"
                    >
                      {t(claimStatus.key, claimStatus.values)}
                    </p>
                  )}

                  {claimTxHash && (
                    <div className="operation-transaction compact">
                      <span>{shortHash(claimTxHash)}</span>
                      <button
                        className="copy-button"
                        type="button"
                        aria-label={t("transaction.copyClaimAria")}
                        title={
                          copiedTargetId ===
                          "claim-current:" + claimTxHash
                            ? t("transaction.copiedTitle")
                            : t("transaction.copyTitle")
                        }
                        onClick={() =>
                          void copyToClipboard(
                            claimTxHash,
                            "claim-current:" + claimTxHash,
                            "common.copied",
                          )
                        }
                      >
                        <CopyIcon
                          copied={
                            copiedTargetId ===
                            "claim-current:" + claimTxHash
                          }
                        />
                      </button>
                      <a
                        href={
                          (chain.blockExplorers?.default.url ?? "") +
                          "/tx/" +
                          claimTxHash
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("common.arcScan")}
                      </a>
                    </div>
                  )}

                  <details className="claim-history-details">
                    <summary>
                      <span>{t("claim.historyTitle")}</span>
                      <strong>{formatCount(stats.claimCount, locale)}</strong>
                    </summary>

                    {isLoading ? (
                      <p className="muted">{t("claim.historyLoading")}</p>
                    ) : claims.length === 0 ? (
                      <p className="muted">{t("claim.historyEmpty")}</p>
                    ) : (
                      <ol className="claim-list compact-list">
                        {claimsWithTransactions.map((claim) => (
                          <li key={claim.index.toString()}>
                            <div className="history-main">
                              <strong>
                                {t("common.usdcAmount", {
                                  amount: formatUsdc(claim.amount, locale),
                                })}
                              </strong>
                              <time
                                dateTime={new Date(
                                  Number(claim.timestamp) * 1000,
                                ).toISOString()}
                              >
                                {formatEpochSeconds(claim.timestamp, locale)}
                              </time>
                            </div>

                            {claim.txHash && (
                              <div className="history-transaction">
                                <span className="transaction-hash-copy">
                                  <span>{shortHash(claim.txHash)}</span>
                                  <button
                                    className="copy-button"
                                    type="button"
                                    aria-label={t("transaction.copyClaimAria")}
                                    title={
                                      copiedTargetId ===
                                      "claim-history:" + claim.index.toString()
                                        ? t("transaction.copiedTitle")
                                        : t("transaction.copyTitle")
                                    }
                                    onClick={() =>
                                      void copyToClipboard(
                                        claim.txHash!,
                                        "claim-history:" +
                                          claim.index.toString(),
                                        "common.copied",
                                      )
                                    }
                                  >
                                    <CopyIcon
                                      copied={
                                        copiedTargetId ===
                                        "claim-history:" +
                                          claim.index.toString()
                                      }
                                    />
                                  </button>
                                </span>
                                <a
                                  href={
                                    (chain.blockExplorers?.default.url ?? "") +
                                    "/tx/" +
                                    claim.txHash
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {t("common.arcScan")}
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
                    <span>{t("jar.lifetimeReceived")}</span>
                    <span className="owner-chip">{t("jar.myJar")}</span>
                  </div>

                  <strong>
                    {isLoading && !isContractReady ? (
                      <span
                        className="skeleton-value"
                        aria-label={t("common.loading")}
                      />
                    ) : (
                      t("common.usdcAmount", {
                        amount: formatUsdc(stats.totalReceived, locale),
                      })
                    )}
                  </strong>

                  <small className="tip-count-detail">
                    {isLoading && !isContractReady ? (
                      <span
                        className="skeleton-text"
                        aria-label={t("jar.loadingTipCountAria")}
                      />
                    ) : (
                      t(
                        stats.tipCount === 1n
                          ? "jar.lifetimeTip_one"
                          : "jar.lifetimeTip_other",
                        { count: formatCount(stats.tipCount, locale) },
                      )
                    )}
                  </small>
                  <p className="stat-description">
                    {t("jar.lifetimeDescription")}
                  </p>
                </article>
              </section>

              <article
                id="send-panel"
                className={
                  "panel tip-panel mobile-send-pane " +
                  (mobileView !== "send" ? "mobile-pane-inactive" : "")
                }
              >
                <div className="panel-heading">
                  <div>
                    <span className="section-label">
                      {t("send.sectionLabel")}
                    </span>
                    <h2>{t("send.title")}</h2>
                  </div>
                  <span
                    className={
                      "network-pill " +
                      (isCorrectNetwork ? "online" : "warning")
                    }
                  >
                    {isCorrectNetwork
                      ? chain.name
                      : t("send.switchToNetwork", { network: chain.name })}
                  </span>
                </div>

                <div className="wallet-balance-row">
                  <span>{t("send.connectedBalance")}</span>
                  <strong>
                    {walletBalance !== null
                      ? t("common.usdcAmount", {
                          amount: formatUsdc(walletBalance, locale),
                        })
                      : t("common.unavailable")}
                  </strong>
                  <small>
                    {t("send.balanceAvailable", { network: chain.name })}
                  </small>
                </div>

                {recipientNotice && (
                  <div
                    id="recipient-notice"
                    className="recipient-notice"
                    role="status"
                    aria-live="polite"
                  >
                    <strong>
                      {t(recipientNotice.key, recipientNotice.values)}
                    </strong>
                    <small>{t("send.recipientFeedback.hint")}</small>
                  </div>
                )}

                {isCorrectNetwork && !isLoading && !isContractReady && (
                  <div className="panel-alert contract-alert" role="alert">
                    <p>{t("send.jarUnavailableMessage")}</p>
                    <button
                      type="button"
                      onClick={() => void refreshAllData()}
                      disabled={
                        isRefreshingAll ||
                        isLoading ||
                        isSentHistoryLoading ||
                        Date.now() < refreshCooldownUntil
                      }
                    >
                      {Date.now() < refreshCooldownUntil
                        ? t("send.tryAgainShortly")
                        : t("send.retryJarData")}
                    </button>
                  </div>
                )}

                {!isCorrectNetwork ? (
                  <div className="connect-state compact-state">
                    <p>{t("send.wrongNetworkMessage")}</p>
                    <button
                      ref={networkSwitchButtonRef}
                      type="button"
                      onClick={() => void switchToSelectedNetwork()}
                    >
                      {t("send.switchToNetwork", { network: chain.name })}
                    </button>
                  </div>
                ) : (
                  <form onSubmit={sendTip}>
                    <label htmlFor="amount">{t("send.amountLabel")}</label>
                    <div className="amount-input">
                      <input
                        ref={amountInputRef}
                        id="amount"
                        inputMode="decimal"
                        value={amount}
                        onChange={(event) => {
                          setAmount(event.target.value);
                          setAmountPercentage(0);
                          setSendStatus(null);
                        }}
                        placeholder={t("send.amountPlaceholder")}
                        required
                      />
                      <span>USDC</span>
                    </div>

                    <div
                      className="amount-presets"
                      aria-label={t("send.amountPresetsAria")}
                    >
                      {["1", "5", "10"].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={amount === preset ? "active" : ""}
                          aria-pressed={amount === preset}
                          onClick={() => {
                            setPresetAmount(preset);
                            setSendStatus(null);
                          }}
                        >
                          {t("common.usdcAmount", {
                            amount: formatUsdc(parseUnits(preset, 18), locale),
                          })}
                        </button>
                      ))}
                    </div>

                    <div className="percentage-control">
                      <div>
                        <span>{t("send.spendablePercentage")}</span>
                        <strong>
                          {formatPercentage(
                            amountPercentage,
                            locale,
                            amountPercentage % 1 === 0 ? 0 : 2,
                          )}
                        </strong>
                      </div>
                      <input
                        aria-label={t("send.walletPercentageAria")}
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={Math.round(amountPercentage)}
                        onChange={(event) => {
                          setAmountFromPercentage(Number(event.target.value));
                          setSendStatus(null);
                        }}
                        disabled={!walletBalance || walletBalance === 0n}
                      />
                      <div className="range-labels">
                        <span>{t("send.rangeMinimum")}</span>
                        <span>{t("send.rangeMaximum")}</span>
                      </div>
                    </div>

                    <label htmlFor="message">{t("send.messageLabel")}</label>
                    <textarea
                      id="message"
                      value={message}
                      onChange={(event) => {
                        setMessage(event.target.value);
                        setSendStatus(null);
                      }}
                      placeholder={t("send.messagePlaceholder")}
                      rows={4}
                      aria-invalid={messageBytes > 280}
                      aria-describedby="message-byte-count"
                    />
                    <div
                      id="message-byte-count"
                      className={
                        "byte-count " + (messageBytes > 280 ? "invalid" : "")
                      }
                    >
                      {t("send.messageByteCount", {
                        count: formatCount(messageBytes, locale),
                      })}
                    </div>

                    <div className="field-heading">
                      <label htmlFor="recipient">
                        {t("send.recipientLabel")}
                      </label>
                      <button
                        className="inline-action"
                        type="button"
                        onClick={useConnectedWalletAsRecipient}
                      >
                        {t("send.useMyAddress")}
                      </button>
                    </div>
                    <input
                      ref={recipientInputRef}
                      className={
                        "address-input " +
                        (recipientInput && !recipientAddress ? "invalid " : "") +
                        (isRecipientHighlighted
                          ? "recipient-highlighted"
                          : "")
                      }
                      id="recipient"
                      value={recipientInput}
                      onChange={(event) => {
                        setRecipientInput(event.target.value.trim());
                        clearRecipientFeedback();
                        setSendStatus(null);
                      }}
                      placeholder={t("send.recipientPlaceholder")}
                      spellCheck={false}
                      required
                      aria-invalid={Boolean(
                        recipientInput && !recipientAddress,
                      )}
                      aria-describedby={
                        recipientInput && !recipientAddress
                          ? "recipient-error"
                          : recipientNotice
                            ? "recipient-notice"
                            : undefined
                      }
                    />
                    {recipientInput && !recipientAddress && (
                      <p
                        id="recipient-error"
                        className="field-error"
                        role="alert"
                      >
                        {t("send.invalidRecipient")}
                      </p>
                    )}

                    {canSendTip &&
                      recipientAddress &&
                      parsedTipAmount !== null && (
                        <div
                          className="send-review"
                          aria-label={t("send.summaryAria")}
                        >
                          <div>
                            <span>{t("send.readyToSend")}</span>
                            <strong>
                              {t("common.usdcAmount", {
                                amount: formatUsdc(
                                  parsedTipAmount,
                                  locale,
                                ),
                              })}
                            </strong>
                          </div>
                          <small>
                            {remainingAfterTip !== null
                              ? t("send.summaryRecipientWithBalance", {
                                  address: shortAddress(recipientAddress),
                                  balance: formatUsdc(
                                    remainingAfterTip,
                                    locale,
                                  ),
                                })
                              : t("send.summaryRecipient", {
                                  address: shortAddress(recipientAddress),
                                })}
                          </small>
                        </div>
                      )}

                    <button
                      className="primary-button"
                      type="submit"
                      disabled={!canSendTip || isSending}
                    >
                      {sendButtonLabel}
                    </button>

                    {sendStatus && (
                      <p
                        className="status-message operation-status"
                        role="status"
                        aria-live="polite"
                      >
                        {t(sendStatus.key, sendStatus.values)}
                      </p>
                    )}

                    {sendTxHash && (
                      <div className="operation-transaction">
                        <span>{shortHash(sendTxHash)}</span>
                        <button
                          className="copy-button"
                          type="button"
                          aria-label={t("transaction.copySendAria")}
                          title={
                            copiedTargetId ===
                            "send-current:" + sendTxHash
                              ? t("transaction.copiedTitle")
                              : t("transaction.copyTitle")
                          }
                          onClick={() =>
                            void copyToClipboard(
                              sendTxHash,
                              "send-current:" + sendTxHash,
                              "common.copied",
                            )
                          }
                        >
                          <CopyIcon
                            copied={
                              copiedTargetId ===
                              "send-current:" + sendTxHash
                            }
                          />
                        </button>
                        <a
                          href={
                            (chain.blockExplorers?.default.url ?? "") +
                            "/tx/" +
                            sendTxHash
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("common.viewOnArcScan")}
                        </a>
                      </div>
                    )}
                  </form>
                )}

                {selectedNetwork.faucetUrl && (
                  <a
                    className="faucet-button"
                    href={selectedNetwork.faucetUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("send.faucetLink")}
                  </a>
                )}

                <details className="send-history-details">
                  <summary>
                    <span>{t("sentHistory.title")}</span>
                    <strong>{formatCount(sentTipCount, locale)}</strong>
                  </summary>

                  {sentHistoryError && (
                    <p className="panel-error" role="alert">
                      {t(sentHistoryError.key, sentHistoryError.values)}
                    </p>
                  )}

                  {isSentHistoryLoading ? (
                    <p className="muted">{t("sentHistory.loading")}</p>
                  ) : sentTips.length === 0 ? (
                    <p className="muted">{t("sentHistory.empty")}</p>
                  ) : (
                    <ol className="tip-list compact-list">
                      {sentTips.map((tip) => (
                        <li key={tip.txHash ?? tip.index.toString()}>
                          <div className="history-main">
                            <strong>
                              {t("common.usdcAmount", {
                                amount: formatUsdc(tip.amount, locale),
                              })}
                            </strong>
                            <time
                              dateTime={new Date(
                                Number(tip.timestamp) * 1000,
                              ).toISOString()}
                            >
                              {formatEpochSeconds(tip.timestamp, locale)}
                            </time>
                          </div>
                          <span className="tip-recipient">
                            {t("sentHistory.to", {
                              address: shortAddress(tip.recipient),
                            })}
                          </span>
                          {tip.message && <p>{tip.message}</p>}

                          {tip.txHash && (
                            <div className="history-transaction">
                              <span>{shortHash(tip.txHash)}</span>
                              <button
                                className="copy-button"
                                type="button"
                                aria-label={t("transaction.copySendAria")}
                                title={
                                  copiedTargetId ===
                                  "sent-history:" + tip.txHash
                                    ? t("transaction.copiedTitle")
                                    : t("transaction.copyTitle")
                                }
                                onClick={() =>
                                  void copyToClipboard(
                                    tip.txHash!,
                                    "sent-history:" + tip.txHash,
                                    "common.copied",
                                  )
                                }
                              >
                                <CopyIcon
                                  copied={
                                    copiedTargetId ===
                                    "sent-history:" + tip.txHash
                                  }
                                />
                              </button>
                              <a
                                href={
                                  (chain.blockExplorers?.default.url ?? "") +
                                  "/tx/" +
                                  tip.txHash
                                }
                                target="_blank"
                                rel="noreferrer"
                              >
                                {t("common.arcScan")}
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
                className={
                  "panel recent-panel mobile-jar-pane " +
                  (mobileView !== "jar" ? "mobile-pane-inactive" : "")
                }
              >
                <div className="panel-heading recent-heading">
                  <div>
                    <span className="section-label">
                      {t("latestTips.sectionLabel")}
                    </span>
                    <h2>{t("latestTips.title")}</h2>
                    <small className="updated-at">
                      {lastUpdatedAt
                        ? t("refresh.updatedAt", {
                            time: formatUpdatedTime(lastUpdatedAt, locale),
                          })
                        : t("refresh.waitingForFirstSync")}
                    </small>
                  </div>

                  <button
                    className="text-button refresh-button"
                    type="button"
                    onClick={() => void refreshAllData()}
                    disabled={
                      isRefreshingAll ||
                      isLoading ||
                      isSentHistoryLoading ||
                      Date.now() < refreshCooldownUntil
                    }
                  >
                    {isRefreshingAll || isLoading || isSentHistoryLoading
                      ? t("refresh.refreshing")
                      : Date.now() < refreshCooldownUntil
                        ? t("refresh.upToDate")
                        : t("refresh.refreshAll")}
                  </button>
                </div>

                {jarStatus && (
                  <div className="panel-alert" role="alert">
                    <p>{t(jarStatus.key, jarStatus.values)}</p>
                    <button
                      type="button"
                      onClick={() => void refreshAllData()}
                      disabled={
                        isRefreshingAll ||
                        isLoading ||
                        isSentHistoryLoading ||
                        Date.now() < refreshCooldownUntil
                      }
                    >
                      {t("common.retry")}
                    </button>
                  </div>
                )}

                {isLoading && receivedTips.length === 0 ? (
                  <div
                    className="skeleton-list"
                    aria-label={t("refresh.loadingOnchainDataAria")}
                  >
                    <span />
                    <span />
                    <span />
                  </div>
                ) : receivedTips.length === 0 ? (
                  <p className="muted">{t("latestTips.empty")}</p>
                ) : (
                  <ol className="tip-list">
                    {receivedTipsWithTransactions.map((tip) => (
                      <li key={tip.index.toString()}>
                        <div className="tip-main">
                          <strong>
                            {t("common.usdcAmount", {
                              amount: formatUsdc(tip.amount, locale),
                            })}
                          </strong>

                          <div className="tip-sender-row">
                            <span>
                              {t("latestTips.from", {
                                address: shortAddress(tip.sender),
                              })}
                            </span>
                            <button
                              className="copy-button sender-copy-button"
                              type="button"
                              aria-label={t("latestTips.copySenderAria", {
                                address: tip.sender,
                              })}
                              title={
                                copiedTargetId ===
                                "sender-address:" + tip.index.toString()
                                  ? t("latestTips.senderCopiedTitle")
                                  : t("latestTips.copySenderTitle")
                              }
                              onClick={() =>
                                void copyToClipboard(
                                  tip.sender,
                                  "sender-address:" + tip.index.toString(),
                                  "latestTips.senderCopiedTitle",
                                )
                              }
                            >
                              <CopyIcon
                                copied={
                                  copiedTargetId ===
                                  "sender-address:" + tip.index.toString()
                                }
                              />
                            </button>
                          </div>
                        </div>

                        <p>{tip.message || t("latestTips.directTransfer")}</p>

                        <div className="tip-card-actions">
                          <time
                            dateTime={new Date(
                              Number(tip.timestamp) * 1000,
                            ).toISOString()}
                          >
                            {formatEpochSeconds(tip.timestamp, locale)}
                          </time>

                          {tip.sender.toLowerCase() !== account.toLowerCase() && (
                            <button
                              className="tip-back-button"
                              type="button"
                              aria-label={t("latestTips.tipThisPersonAria", {
                                address: tip.sender,
                              })}
                              onClick={() => prepareTipBack(tip.sender)}
                            >
                              {t("latestTips.tipThisPerson")}
                            </button>
                          )}
                        </div>

                        {tip.txHash && (
                          <div className="history-transaction">
                            <span>{shortHash(tip.txHash)}</span>
                            <button
                              className="copy-button"
                              type="button"
                              aria-label={t("transaction.copyReceivedAria")}
                              title={
                                copiedTargetId ===
                                "received-history:" + tip.txHash
                                  ? t("transaction.copiedTitle")
                                  : t("transaction.copyTitle")
                              }
                              onClick={() =>
                                void copyToClipboard(
                                  tip.txHash!,
                                  "received-history:" + tip.txHash,
                                  "common.copied",
                                )
                              }
                            >
                              <CopyIcon
                                copied={
                                  copiedTargetId ===
                                  "received-history:" + tip.txHash
                                }
                              />
                            </button>
                            <a
                              href={
                                (chain.blockExplorers?.default.url ?? "") +
                                "/tx/" +
                                tip.txHash
                              }
                              target="_blank"
                              rel="noreferrer"
                            >
                              {t("common.arcScan")}
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
          <span>
            {chain.testnet
              ? t("footer.testnetDisclaimer")
              : t("footer.mainnetDescription")}
          </span>
          <a href={contractExplorerUrl} target="_blank" rel="noreferrer">
            {shortAddress(contractAddress)} ↗
          </a>
        </footer>
      </main>
    </>
  );
}
