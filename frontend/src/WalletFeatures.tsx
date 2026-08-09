import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  formatUnits,
  isAddressEqual,
  parseUnits,
  type Address,
  type EIP1193Provider,
} from "viem";
import { withIsolatedWalletRequest } from "./eip6963";

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
  return ["BRIDGE_INPUT_REQUIRED", "BRIDGE_ACCOUNT_CHANGED"].includes(
    firstLine,
  )
    ? firstLine
    : "SDK_REQUEST_FAILED";
}

type BridgeSource = {
  key: "ethereum" | "base" | "arbitrum";
  circleChain: "Ethereum_Sepolia" | "Base_Sepolia" | "Arbitrum_Sepolia";
};

const BRIDGE_SOURCES: BridgeSource[] = [
  { key: "ethereum", circleChain: "Ethereum_Sepolia" },
  { key: "base", circleChain: "Base_Sepolia" },
  { key: "arbitrum", circleChain: "Arbitrum_Sepolia" },
];

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
  const { t } = useTranslation();
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
  const estimateFingerprintRef = useRef("");
  const estimateRequestRef = useRef(0);
  const source = BRIDGE_SOURCES.find((item) => item.key === sourceKey)!;
  const inputFingerprint = sourceKey + ":" + amount + ":" + speed + ":" + walletAddress;

  let parsedAmount: bigint | null = null;
  try {
    const parsed = parseUnits(amount, 6);
    parsedAmount = parsed > 0n ? parsed : null;
  } catch {
    parsedAmount = null;
  }
  const inputsReady = parsedAmount !== null;

  useEffect(() => {
    setEstimate(null);
    estimateFingerprintRef.current = "";
    setRawResult(null);
    setProgress([]);
    setStatus(null);
  }, [inputFingerprint]);

  useEffect(() => {
    if (!inputsReady || working !== null) {
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
    if (!inputsReady) throw new Error("BRIDGE_INPUT_REQUIRED");
    await assertActiveAccount();
    const [
      { AppKit, TransferSpeed, isRetryableError },
      { createViemAdapterFromProvider },
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
    const adapter = await createViemAdapterFromProvider({ provider });
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
            disabled={!estimateValid || working !== null || estimating}
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
