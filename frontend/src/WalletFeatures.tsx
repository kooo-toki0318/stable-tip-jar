import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
} from "viem";
import {
  ArbitrumSepolia,
  ArcTestnet,
  BaseSepolia,
  EthereumSepolia,
} from "@circle-fin/app-kit/chains";
import {
  connectInjectedWallet,
  listenForInjectedWallets,
  revokeInjectedWallet,
  withIsolatedWalletRequest,
  type InjectedWallet,
} from "./eip6963";
import { formatUsdc } from "./formatters";
import { arcTestnet } from "./arc";
import type { PasskeyWalletSession } from "./circleWallet";

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return "REQUEST_FAILED";
  const normalized = error.message.toLowerCase();
  if (
    normalized.includes("user rejected") ||
    normalized.includes("user denied")
  ) {
    return "WALLET_REQUEST_REJECTED";
  }
  const firstLine = error.message.split("\n")[0].trim();
  return ["BRIDGE_INPUT_REQUIRED", "BRIDGE_ACCOUNT_CHANGED", "BRIDGE_RPC_CONFIG_MISSING"].includes(
    firstLine,
  )
    ? firstLine
    : "SDK_REQUEST_FAILED";
}

type BridgeSource = {
  key: "ethereum" | "base" | "arbitrum";
  circleChain: "Ethereum_Sepolia" | "Base_Sepolia" | "Arbitrum_Sepolia";
  chainId: number;
  usdcAddress: Address;
};

const BRIDGE_SOURCES: BridgeSource[] = [
  { key: "ethereum", circleChain: "Ethereum_Sepolia", chainId: EthereumSepolia.chainId, usdcAddress: getAddress(EthereumSepolia.usdcAddress) },
  { key: "base", circleChain: "Base_Sepolia", chainId: BaseSepolia.chainId, usdcAddress: getAddress(BaseSepolia.usdcAddress) },
  { key: "arbitrum", circleChain: "Arbitrum_Sepolia", chainId: ArbitrumSepolia.chainId, usdcAddress: getAddress(ArbitrumSepolia.usdcAddress) },
];

const BRIDGE_RPC_URLS: Record<number, string | undefined> = {
  [EthereumSepolia.chainId]: import.meta.env.VITE_BRIDGE_ETHEREUM_SEPOLIA_RPC_URL?.trim(),
  [BaseSepolia.chainId]: import.meta.env.VITE_BRIDGE_BASE_SEPOLIA_RPC_URL?.trim(),
  [ArbitrumSepolia.chainId]: import.meta.env.VITE_BRIDGE_ARBITRUM_SEPOLIA_RPC_URL?.trim(),
  [ArcTestnet.chainId]: import.meta.env.VITE_BRIDGE_ARC_TESTNET_RPC_URL?.trim(),
};

function bridgeRpcUrl(chainId: number): string {
  const rpcUrl = BRIDGE_RPC_URLS[chainId];
  if (!rpcUrl) throw new Error("BRIDGE_RPC_CONFIG_MISSING");
  return rpcUrl;
}

function bridgeRpcConfigured(): boolean {
  return [EthereumSepolia.chainId, BaseSepolia.chainId, ArbitrumSepolia.chainId, ArcTestnet.chainId]
    .every((chainId) => Boolean(BRIDGE_RPC_URLS[chainId]));
}

type BridgeEstimateView = {
  fees: Array<{ type: string; amount: string | null; token: string }>;
  gasFees: Array<{ name: string; token: string; amount: string | null }>;
  expiresAt: number;
  receivedAmount: string;
  totalFeeAmount: string;
};

type StoredBridgeResult = {
  result: unknown;
  kit: unknown;
  retryable: boolean;
};

export function BridgePanel({
  walletAddress,
  provider,
  onComplete,
}: {
  walletAddress: Address;
  provider: EIP1193Provider;
  onComplete: () => void | Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language).startsWith("ja")
    ? "ja-JP" : "en-US";
  const [sourceKey, setSourceKey] = useState<BridgeSource["key"]>("ethereum");
  const [amount, setAmount] = useState("");
  const [speed, setSpeed] = useState<"FAST" | "SLOW">("FAST");
  const [estimate, setEstimate] = useState<BridgeEstimateView | null>(null);
  const [rawResult, setRawResult] = useState<StoredBridgeResult | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [working, setWorking] = useState<"bridge" | "retry" | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [estimateRefresh, setEstimateRefresh] = useState(0);
  const [sourceBalance, setSourceBalance] = useState<bigint | null>(null);
  const [sourceBalanceLoading, setSourceBalanceLoading] = useState(true);
  const [sourceBalanceError, setSourceBalanceError] = useState(false);
  const [sourceBalanceRefresh, setSourceBalanceRefresh] = useState(0);
  const estimateFingerprintRef = useRef("");
  const estimateRequestRef = useRef(0);
  const balanceRequestRef = useRef(0);
  const source = BRIDGE_SOURCES.find((item) => item.key === sourceKey)!;
  const rpcConfigured = bridgeRpcConfigured();
  const inputFingerprint = sourceKey + ":" + amount + ":" + speed + ":" + walletAddress;

  let parsedAmount: bigint | null = null;
  try {
    const parsed = parseUnits(amount, 6);
    parsedAmount = parsed > 0n ? parsed : null;
  } catch {
    parsedAmount = null;
  }
  const exceedsSourceBalance =
    parsedAmount !== null &&
    sourceBalance !== null &&
    parsedAmount > sourceBalance;
  const inputsReady = rpcConfigured && parsedAmount !== null && !exceedsSourceBalance;

  useEffect(() => {
    const requestId = ++balanceRequestRef.current;
    setSourceBalance(null);
    setSourceBalanceLoading(true);
    setSourceBalanceError(false);
    let rpcUrl: string;
    try {
      rpcUrl = bridgeRpcUrl(source.chainId);
    } catch {
      setSourceBalanceError(true);
      setSourceBalanceLoading(false);
      return;
    }
    const client = createPublicClient({
      transport: http(rpcUrl, { retryCount: 0 }),
    });
    void client
      .readContract({
        address: source.usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      })
      .then((balance) => {
        if (requestId === balanceRequestRef.current) setSourceBalance(balance);
      })
      .catch(() => {
        if (requestId === balanceRequestRef.current) setSourceBalanceError(true);
      })
      .finally(() => {
        if (requestId === balanceRequestRef.current) setSourceBalanceLoading(false);
      });
    return () => {
      if (requestId === balanceRequestRef.current) balanceRequestRef.current += 1;
    };
  }, [source.chainId, source.usdcAddress, walletAddress, sourceBalanceRefresh]);

  useEffect(() => {
    setEstimate(null);
    estimateFingerprintRef.current = "";
    setRawResult(null);
    setProgress([]);
    setStatus(null);
  }, [inputFingerprint]);

  useEffect(() => {
    if (!inputsReady || working !== null) {
      if (!inputsReady) {
        estimateRequestRef.current += 1;
        setEstimate(null);
        estimateFingerprintRef.current = "";
      }
      setEstimating(false);
      return;
    }
    const requestId = ++estimateRequestRef.current;
    const timeout = window.setTimeout(() => {
      void estimateBridge(requestId);
    }, 600);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [inputFingerprint, estimateRefresh, inputsReady, working]);

  useEffect(() => {
    if (!estimate || estimate.expiresAt <= Date.now()) return;
    const timeout = window.setTimeout(() => {
      setEstimateRefresh((current) => current + 1);
    }, Math.max(0, estimate.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [estimate]);

  async function assertActiveAccount() {
    const accounts = (await provider.request({ method: "eth_accounts" })) as Address[];
    if (!accounts[0] || !isAddressEqual(accounts[0], walletAddress)) {
      throw new Error("BRIDGE_ACCOUNT_CHANGED");
    }
  }

  async function buildBridge() {
    if (!rpcConfigured) throw new Error("BRIDGE_RPC_CONFIG_MISSING");
    if (!inputsReady) throw new Error("BRIDGE_INPUT_REQUIRED");
    await assertActiveAccount();
    const [
      { AppKit, TransferSpeed, isRetryableError },
      { ViemAdapter },
    ] = await Promise.all([
      import("@circle-fin/app-kit"),
      import("@circle-fin/adapter-viem-v2"),
    ]);
    const kit = new AppKit({
      disableAnalytics: true,
      disableErrorReporting: true,
    });
    kit.on("*", (payload) => {
      const method =
        typeof payload === "object" && payload && "method" in payload
          ? String(payload.method)
          : "bridge.progress";
      setProgress((items) =>
        items.includes(method) ? items : [...items, method],
      );
    });
    const adapter = new ViemAdapter(
      {
        getPublicClient: ({ chain }) =>
          createPublicClient({
            chain,
            transport: http(bridgeRpcUrl(chain.id), { retryCount: 0 }),
          }),
        getWalletClient: ({ chain }) =>
          createWalletClient({
            account: walletAddress,
            chain,
            transport: custom(provider),
          }),
      },
      {
        addressContext: "user-controlled",
        supportedChains: [EthereumSepolia, BaseSepolia, ArbitrumSepolia, ArcTestnet],
      },
    );
    const params = {
      from: { adapter, chain: source.circleChain },
      to: {
        chain: "Arc_Testnet" as const,
        recipientAddress: walletAddress,
        useForwarder: true as const,
      },
      amount,
      token: "USDC" as const,
      config: {
        transferSpeed:
          speed === "FAST" ? TransferSpeed.FAST : TransferSpeed.SLOW,
        batchTransactions: false,
      },
    };
    return { kit, adapter, params, isRetryableError };
  }

  async function estimateBridge(requestId: number) {
    setEstimating(true);
    setStatus(null);
    try {
      const { kit, params } = await buildBridge();
      const result = await withIsolatedWalletRequest(() =>
        kit.estimateBridge(params),
      );
      if (requestId !== estimateRequestRef.current) return;
      const feeAmount = result.fees.reduce((total, fee) => {
        if (!fee.amount || fee.token !== "USDC") return total;
        try {
          return total + parseUnits(fee.amount, 6);
        } catch {
          return total;
        }
      }, 0n);
      const inputAmount = parseUnits(amount, 6);
      const nextEstimate: BridgeEstimateView = {
        fees: result.fees.map(({ type, amount: value, token }) => ({
          type,
          amount: value,
          token,
        })),
        gasFees: result.gasFees.map(({ name, token, fees }) => ({
          name,
          token,
          amount: fees?.fee ?? null,
        })),
        expiresAt: Date.now() + 60_000,
        receivedAmount: formatUnits(
          inputAmount > feeAmount ? inputAmount - feeAmount : 0n,
          6,
        ),
        totalFeeAmount: formatUnits(feeAmount, 6),
      };
      estimateFingerprintRef.current = inputFingerprint;
      setEstimate(nextEstimate);
    } catch (error) {
      if (requestId !== estimateRequestRef.current) return;
      setEstimate(null);
      setStatus(t("bridge.error", { error: cleanError(error) }));
    } finally {
      if (requestId === estimateRequestRef.current) setEstimating(false);
    }
  }

  const estimateValid = Boolean(
    estimate &&
      estimate.expiresAt > Date.now() &&
      estimateFingerprintRef.current === inputFingerprint,
  );

  async function executeBridge() {
    if (!estimateValid) {
      setStatus(t("bridge.estimateExpired"));
      setEstimateRefresh((current) => current + 1);
      return;
    }
    setWorking("bridge");
    setStatus(null);
    setProgress(["bridge.start"]);
    try {
      const { kit, params, isRetryableError } = await buildBridge();
      const result = await withIsolatedWalletRequest(() => kit.bridge(params));
      const retryable =
        result.state === "error" &&
        result.steps.some((step) =>
          Boolean(step.error && isRetryableError(step.error)),
        );
      setRawResult({ result, kit, retryable });
      setProgress(result.steps.map((step) => step.name + ":" + step.state));
      if (result.state === "success") {
        setStatus(t("bridge.success"));
        setSourceBalanceRefresh((current) => current + 1);
        await onComplete();
      } else {
        setStatus(t("bridge.softError"));
      }
    } catch (error) {
      setStatus(t("bridge.error", { error: cleanError(error) }));
    } finally {
      setWorking(null);
    }
  }

  async function retryBridge() {
    if (!rawResult) return;
    setWorking("retry");
    setStatus(null);
    try {
      const { adapter, isRetryableError } = await buildBridge();
      const kit = rawResult.kit as Awaited<ReturnType<typeof buildBridge>>["kit"];
      const previousResult = rawResult.result as Parameters<typeof kit.retryBridge>[0];
      const result = await withIsolatedWalletRequest(() =>
        kit.retryBridge(previousResult, { from: adapter }),
      );
      const retryable =
        result.state === "error" &&
        result.steps.some((step) =>
          Boolean(step.error && isRetryableError(step.error)),
        );
      setRawResult({ result, kit, retryable });
      setProgress(result.steps.map((step) => step.name + ":" + step.state));
      if (result.state === "success") {
        setStatus(t("bridge.success"));
        setSourceBalanceRefresh((current) => current + 1);
        await onComplete();
      } else {
        setStatus(t("bridge.softError"));
      }
    } catch (error) {
      setStatus(t("bridge.error", { error: cleanError(error) }));
    } finally {
      setWorking(null);
    }
  }

  function progressLabel(item: string): string {
    const normalized = item.toLowerCase();
    const stage = normalized.includes("approve")
      ? "approve"
      : normalized.includes("burn")
        ? "burn"
        : normalized.includes("attest")
          ? "attestation"
          : normalized.includes("mint") || normalized.includes("forward")
            ? "mint"
            : "processing";
    const state = normalized.includes("success")
      ? "success"
      : normalized.includes("error")
        ? "error"
        : "pending";
    return t("bridge.progressStep", {
      stage: t("bridge.stage." + stage),
      state: t("bridge.state." + state),
    });
  }

  return (
    <section className="feature-panel bridge-panel" aria-labelledby="bridge-title">
      <div className="feature-heading bridge-heading">
        <div>
          <span className="section-label">{t("bridge.sectionLabel")}</span>
          <h2 id="bridge-title">{t("bridge.title")}</h2>
        </div>
        <span className="network-pill online">CCTP</span>
      </div>
      <p>{t("bridge.description")}</p>
      {!rpcConfigured && (
        <p className="feature-warning">{t("bridge.rpcConfigMissing")}</p>
      )}

      <div className="bridge-workspace">
        <div className="bridge-form-card">
          <div className="bridge-address-card">
            <span>{t("bridge.connectedWallet")}</span>
            <strong>{walletAddress.slice(0, 8) + "…" + walletAddress.slice(-6)}</strong>
            <small>{t("bridge.sameAddressHint")}</small>
          </div>

          <div className="bridge-fields">
            <label>
              <span>{t("bridge.source")}</span>
              <select
                value={sourceKey}
                onChange={(event) => setSourceKey(event.target.value as BridgeSource["key"])}
                disabled={working !== null}
              >
                <option value="ethereum">Ethereum Sepolia</option>
                <option value="base">Base Sepolia</option>
                <option value="arbitrum">Arbitrum Sepolia</option>
              </select>
            </label>
            <div className="bridge-source-balance" aria-live="polite">
              <span>
                {t("bridge.sourceBalance", {
                  network: t("bridge.sourceName." + sourceKey),
                })}
              </span>
              <strong>
                {sourceBalanceLoading
                  ? t("common.loading")
                  : sourceBalance === null
                    ? "—"
                    : formatUsdc(sourceBalance * 1_000_000_000_000n, locale) + " USDC"}
              </strong>
              <button
                type="button"
                className={sourceBalanceLoading ? "balance-refresh-icon spinning" : "balance-refresh-icon"}
                onClick={() => setSourceBalanceRefresh((current) => current + 1)}
                disabled={!rpcConfigured || sourceBalanceLoading}
                aria-label={t("bridge.refreshBalanceAria")}
                title={t("bridge.refreshBalance")}
              >
                <span aria-hidden="true">↻</span>
              </button>
              {sourceBalanceError && (
                <small>
                  {t(rpcConfigured ? "bridge.sourceBalanceError" : "bridge.rpcConfigMissingShort")}
                </small>
              )}
            </div>
            <label>
              <span>{t("bridge.amount")}</span>
              <div className="bridge-amount-input">
                <input
                  inputMode="decimal"
                  value={amount}
                  placeholder="10"
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={working !== null}
                />
                <strong>USDC</strong>
              </div>
            </label>
            <label>
              <span>{t("bridge.speed")}</span>
              <select
                value={speed}
                onChange={(event) => setSpeed(event.target.value as "FAST" | "SLOW")}
                disabled={working !== null}
              >
                <option value="FAST">{t("bridge.fast")}</option>
                <option value="SLOW">{t("bridge.standard")}</option>
              </select>
            </label>
          </div>

          <div className="bridge-route-summary" aria-label={t("bridge.routeSummaryAria")}>
            <div>
              <span>{t("bridge.from")}</span>
              <strong>{t("bridge.sourceName." + sourceKey)}</strong>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <span>{t("bridge.to")}</span>
              <strong>Arc Testnet</strong>
            </div>
          </div>
        </div>

        <aside className="bridge-estimate-card" aria-live="polite">
          <div className="estimate-card-heading">
            <div>
              <span className="section-label">{t("bridge.estimateTitle")}</span>
              <h3>{t("bridge.reviewTitle")}</h3>
            </div>
            <div className="estimate-heading-actions">
              {estimating && <span className="estimate-loading">{t("bridge.estimating")}</span>}
              <button
                className={estimating ? "estimate-refresh spinning" : "estimate-refresh"}
                type="button"
                aria-label={t("bridge.refreshEstimateAria")}
                title={t("bridge.refreshEstimate")}
                onClick={() => setEstimateRefresh((current) => current + 1)}
                disabled={!inputsReady || working !== null || estimating}
              >
                <span aria-hidden="true">↻</span>
              </button>
            </div>
          </div>

          {exceedsSourceBalance && (
            <p className="bridge-balance-warning">{t("bridge.insufficientBalance")}</p>
          )}
          {!inputsReady ? (
            <div className="estimate-empty">
              <span aria-hidden="true">≈</span>
              <p>{t("bridge.autoEstimateHint")}</p>
            </div>
          ) : estimating && !estimate ? (
            <div className="estimate-skeleton" aria-label={t("bridge.estimating")}>
              <span /><span /><span />
            </div>
          ) : estimate ? (
            <>
              <dl className="estimate-summary">
                <div>
                  <dt>{t("bridge.sendAmount")}</dt>
                  <dd>{amount} USDC</dd>
                </div>
                <div>
                  <dt>{t("bridge.totalCctpFees")}</dt>
                  <dd>{estimate.totalFeeAmount} USDC</dd>
                </div>
                <div className="estimate-total">
                  <dt>{t("bridge.received")}</dt>
                  <dd>{estimate.receivedAmount} USDC</dd>
                </div>
              </dl>
              <div className="fee-breakdown">
                <strong>{t("bridge.breakdown")}</strong>
                <ul>
                  {estimate.fees.map((fee, index) => (
                    <li key={fee.type + "-" + index}>
                      <span>{fee.type}</span>
                      <strong>{fee.amount ?? "—"} {fee.token}</strong>
                    </li>
                  ))}
                  {estimate.gasFees.map((fee, index) => (
                    <li key={fee.name + "-" + index}>
                      <span>{t("bridge.gasLabel", { name: fee.name })}</span>
                      <strong>{fee.amount ?? "—"} {fee.token}</strong>
                    </li>
                  ))}
                </ul>
              </div>
              <small className="estimate-validity">{t("bridge.autoRefresh")}</small>
            </>
          ) : (
            <div className="estimate-empty error">
              <p>{status ?? t("bridge.autoEstimateFailed")}</p>
            </div>
          )}

          <button
            className="bridge-submit"
            type="button"
            onClick={() => void executeBridge()}
            disabled={!inputsReady || !estimateValid || working !== null || estimating}
          >
            {working === "bridge" ? t("bridge.bridging") : t("bridge.execute")}
          </button>
          {rawResult?.retryable && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => void retryBridge()}
              disabled={working !== null}
            >
              {working === "retry" ? t("bridge.retrying") : t("bridge.retry")}
            </button>
          )}
        </aside>
      </div>

      {progress.length > 0 && (
        <ol className="bridge-progress" aria-label={t("bridge.progressAria")} aria-live="polite">
          {progress.map((item, index) => (
            <li key={item + "-" + index}>{progressLabel(item)}</li>
          ))}
        </ol>
      )}
      {status && estimate && (
        <p className="feature-status" role="status" aria-live="polite">{status}</p>
      )}
      <small>{t("bridge.noAutoSwitch")}</small>
    </section>
  );
}
const ARC_GAS_RESERVE = parseUnits("0.01", 18);
const arcFundsClient = createPublicClient({
  chain: arcTestnet,
  transport: http("/rpc", { retryCount: 0 }),
});

function injectedWalletName(provider: EIP1193Provider): string {
  const flags = provider as EIP1193Provider & {
    isMetaMask?: boolean;
    isRabby?: boolean;
  };
  if (flags.isRabby) return "Rabby";
  if (flags.isMetaMask) return "MetaMask";
  return "Browser Wallet";
}

function transferError(error: unknown): string {
  if (!(error instanceof Error)) return "REQUEST_FAILED";
  const normalized = error.message.toLowerCase();
  if (normalized.includes("user rejected") || normalized.includes("user denied")) {
    return "WALLET_REQUEST_REJECTED";
  }
  return error.message.split("\n")[0].trim() || "REQUEST_FAILED";
}

export function PasskeyFundsModal({
  open,
  session,
  onClose,
  onBalanceChanged,
}: {
  open: boolean;
  session: PasskeyWalletSession;
  onClose: () => void;
  onBalanceChanged: () => void | Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language).startsWith("ja")
    ? "ja-JP" : "en-US";
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [injectedWallets, setInjectedWallets] = useState<InjectedWallet[]>([]);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<InjectedWallet | null>(null);
  const [provider, setProvider] = useState<EIP1193Provider | null>(null);
  const [browserAddress, setBrowserAddress] = useState<Address | null>(null);
  const [browserWalletName, setBrowserWalletName] = useState("");
  const [browserBalance, setBrowserBalance] = useState<bigint | null>(null);
  const [passkeyBalance, setPasskeyBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [working, setWorking] = useState<"connect" | "deposit" | "withdraw" | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [transactionHash, setTransactionHash] = useState<Hash | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  async function refreshBalances(nextBrowserAddress = browserAddress) {
    setLoadingBalances(true);
    try {
      const [nextPasskeyBalance, nextBrowserBalance] = await Promise.all([
        arcFundsClient.getBalance({ address: session.address }),
        nextBrowserAddress
          ? arcFundsClient.getBalance({ address: nextBrowserAddress })
          : Promise.resolve(null),
      ]);
      setPasskeyBalance(nextPasskeyBalance);
      setBrowserBalance(nextBrowserBalance);
    } catch {
      setStatus(t("passkeyFunds.balanceError"));
    } finally {
      setLoadingBalances(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setTab("deposit");
    setAmount("");
    setStatus(null);
    setTransactionHash(null);
    setShowWalletPicker(false);
    setSelectedWallet(null);
    setProvider(null);
    setBrowserAddress(null);
    setBrowserWalletName("");
    setBrowserBalance(null);
    void refreshBalances(null);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open, session.address]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && working === null) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, working, onClose]);

  useEffect(() => {
    if (!open) return;
    setInjectedWallets([]);
    return listenForInjectedWallets(setInjectedWallets);
  }, [open]);

  if (!open) return null;

  let parsedAmount: bigint | null = null;
  try {
    const parsed = parseUnits(amount, 18);
    parsedAmount = parsed > 0n ? parsed : null;
  } catch {
    parsedAmount = null;
  }
  const browserSpendable =
    browserBalance === null || browserBalance <= ARC_GAS_RESERVE
      ? 0n
      : browserBalance - ARC_GAS_RESERVE;
  const availableBalance = tab === "deposit" ? browserSpendable : (passkeyBalance ?? 0n);
  const amountValid =
    parsedAmount !== null &&
    parsedAmount <= availableBalance &&
    browserAddress !== null;

  async function connectBrowserWallet(wallet: InjectedWallet) {
    const injected = wallet.provider;
    setWorking("connect");
    setStatus(null);
    setTransactionHash(null);
    try {
      const connected = await connectInjectedWallet(wallet);
      const nextAddress = getAddress(connected.address);
      setSelectedWallet(wallet);
      setProvider(injected);
      setBrowserAddress(nextAddress);
      setBrowserWalletName(injectedWalletName(injected));
      setShowWalletPicker(false);
      await refreshBalances(nextAddress);
    } catch (error) {
      setStatus(t("passkeyFunds.error", { error: transferError(error) }));
    } finally {
      setWorking(null);
    }
  }

  async function disconnectBrowserWallet() {
    if (selectedWallet) {
      try {
        await revokeInjectedWallet(selectedWallet);
      } catch {
        // Some injected wallets do not support permission revocation.
      }
    }
    setSelectedWallet(null);
    setProvider(null);
    setBrowserAddress(null);
    setBrowserWalletName("");
    setBrowserBalance(null);
    setAmount("");
    setStatus(null);
    setTransactionHash(null);
    setShowWalletPicker(false);
  }

  async function ensureArcNetwork(walletProvider: EIP1193Provider) {
    const chainId = (await walletProvider.request({ method: "eth_chainId" })) as string;
    if (Number.parseInt(chainId, 16) === arcTestnet.id) return;
    try {
      await walletProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + arcTestnet.id.toString(16) }],
      });
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? Number((error as { code: unknown }).code)
          : null;
      if (code !== 4902) throw error;
      await walletProvider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x" + arcTestnet.id.toString(16),
          chainName: arcTestnet.name,
          nativeCurrency: arcTestnet.nativeCurrency,
          rpcUrls: [...arcTestnet.rpcUrls.default.http],
          blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
        }],
      });
    }
  }

  async function submitTransfer() {
    if (!amountValid || !parsedAmount || !browserAddress) return;
    setWorking(tab);
    setStatus(null);
    setTransactionHash(null);
    try {
      let hash: Hash;
      if (tab === "deposit") {
        if (!provider) return;
        await ensureArcNetwork(provider);
        const walletClient = createWalletClient({
          account: browserAddress,
          chain: arcTestnet,
          transport: custom(provider),
        });
        hash = await walletClient.sendTransaction({
          to: session.address,
          value: parsedAmount,
        });
        const receipt = await arcFundsClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("TRANSFER_REVERTED");
      } else {
        const receipt = await session.sendNative({
          to: browserAddress,
          value: parsedAmount,
        });
        hash = receipt.transactionHash;
      }
      setTransactionHash(hash);
      setAmount("");
      setStatus(t("passkeyFunds.success." + tab));
      await refreshBalances(browserAddress);
      await onBalanceChanged();
    } catch (error) {
      setStatus(t("passkeyFunds.error", { error: transferError(error) }));
    } finally {
      setWorking(null);
    }
  }

  function setMaximumAmount() {
    setAmount(formatUnits(availableBalance, 18));
  }

  return (
    <div
      className="wallet-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && working === null) onClose();
      }}
    >
      <section
        className="wallet-modal funds-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="passkey-funds-title"
      >
        <div className="wallet-modal-header">
          <div>
            <span className="section-label">{t("passkeyFunds.eyebrow")}</span>
            <h2 id="passkey-funds-title">{t("passkeyFunds.title")}</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="wallet-modal-close"
            type="button"
            aria-label={t("walletModal.closeAria")}
            onClick={onClose}
            disabled={working !== null}
          >×</button>
        </div>

        <div className="wallet-modal-body funds-modal-body">
          <div className="funds-tabs" role="tablist" aria-label={t("passkeyFunds.tabsAria")}>
            {(["deposit", "withdraw"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={tab === item ? "active" : ""}
                onClick={() => {
                  setTab(item);
                  setAmount("");
                  setStatus(null);
                  setTransactionHash(null);
                }}
                disabled={working !== null}
              >
                {t("passkeyFunds.tab." + item)}
              </button>
            ))}
          </div>

          <p className="wallet-modal-lead">{t("passkeyFunds.description." + tab)}</p>

          {browserAddress ? (
            <div className="funds-browser-wallet">
              <div>
                <span>{browserWalletName}</span>
                <code>{browserAddress.slice(0, 8) + "…" + browserAddress.slice(-6)}</code>
              </div>
              <button type="button" onClick={() => void disconnectBrowserWallet()} disabled={working !== null}>
                {t("passkeyFunds.disconnect")}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="funds-connect"
                onClick={() => setShowWalletPicker((current) => !current)}
                disabled={working !== null}
                aria-expanded={showWalletPicker}
              >
                {working === "connect"
                  ? t("header.connecting")
                  : t("passkeyFunds.connectBrowser")}
              </button>
              {showWalletPicker && (
                injectedWallets.length > 0 ? (
                  <div className="wallet-picker funds-wallet-picker">
                    {injectedWallets.map((wallet) => (
                      <button
                        key={wallet.id}
                        type="button"
                        className="wallet-choice"
                        onClick={() => void connectBrowserWallet(wallet)}
                        disabled={working !== null}
                      >
                        {wallet.icon ? (
                          <img src={wallet.icon} width="28" height="28" alt="" />
                        ) : (
                          <span className="wallet-method-icon" aria-hidden="true">◈</span>
                        )}
                        <span>
                          <strong>{wallet.name}</strong>
                          <small>{wallet.rdns ?? t("walletModal.browser.injected")}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="feature-warning">{t("passkeyFunds.browserMissing")}</p>
                )
              )}
            </>
          )}

          <div className="funds-balance-grid" aria-live="polite">
            <div>
              <span>{t("passkeyFunds.browserBalance")}</span>
              <strong>
                {loadingBalances && browserBalance === null
                  ? t("common.loading")
                  : browserBalance === null
                    ? "—"
                    : formatUsdc(browserBalance, locale) + " USDC"}
              </strong>
              <small>{t("passkeyFunds.reserveNote")}</small>
            </div>
            <div>
              <span>{t("passkeyFunds.passkeyBalance")}</span>
              <strong>
                {loadingBalances && passkeyBalance === null
                  ? t("common.loading")
                  : passkeyBalance === null
                    ? "—"
                    : formatUsdc(passkeyBalance, locale) + " USDC"}
              </strong>
              <small>{session.address.slice(0, 8) + "…" + session.address.slice(-6)}</small>
            </div>
          </div>

          <label className="funds-amount-label">
            <span>{t("passkeyFunds.amount")}</span>
            <div className="funds-amount-input">
              <input
                inputMode="decimal"
                value={amount}
                placeholder="0.00"
                onChange={(event) => setAmount(event.target.value)}
                disabled={working !== null || !browserAddress}
              />
              <button
                type="button"
                onClick={setMaximumAmount}
                disabled={working !== null || !browserAddress || availableBalance === 0n}
              >
                {t("passkeyFunds.max")}
              </button>
              <strong>USDC</strong>
            </div>
          </label>

          {parsedAmount !== null && parsedAmount > availableBalance && (
            <p className="bridge-balance-warning">{t("passkeyFunds.insufficient")}</p>
          )}

          <button
            type="button"
            className="funds-submit"
            onClick={() => void submitTransfer()}
            disabled={!amountValid || working !== null}
          >
            {working === tab
              ? t("passkeyFunds.working." + tab)
              : t("passkeyFunds.action." + tab)}
          </button>

          {status && (
            <div className="wallet-modal-status funds-status" role="status" aria-live="polite">
              <span>{status}</span>
              {transactionHash && (
                <a
                  href={arcTestnet.blockExplorers.default.url + "/tx/" + transactionHash}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("passkeyFunds.viewTransaction")} ↗
                </a>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
