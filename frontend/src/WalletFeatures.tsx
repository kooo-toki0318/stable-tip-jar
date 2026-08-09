import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createPublicClient,
  custom,
  getAddress,
  isAddress,
  isAddressEqual,
  formatUnits,
  parseUnits,
  type Address,
  type Hash,
  type LocalAccount,
} from "viem";
import { arcTestnet } from "./arc";
import {
  browserWalletToRecoveryAccount,
  createPasskeyWallet,
  createRecoveryMnemonic,
  isCircleConfigured,
  recoverPasskeyWallet,
  recoveryAccountFromMnemonic,
  registerBrowserRecovery,
  verifyRecoveryMapping,
  type PasskeyWalletSession,
} from "./circleWallet";
import {
  connectInjectedWallet,
  listenForInjectedWallets,
  switchProviderChain,
  withIsolatedWalletRequest,
  type InjectedWallet,
} from "./eip6963";

type PublicRecoveryMetadata = {
  method: "browser" | "phrase";
  recoveryAddress: Address;
  walletName?: string;
  walletAddress: Address;
  registrationTransactionHash: Hash;
};

const RECOVERY_METADATA_KEY = "arc-tip-jar-recovery-metadata";

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return "REQUEST_FAILED";
  const normalized = error.message.toLowerCase();
  if (
    normalized.includes("user rejected") ||
    normalized.includes("user denied")
  ) {
    return "WALLET_REQUEST_REJECTED";
  }
  const safeCodes = new Set([
    "CIRCLE_CLIENT_KEY_MISSING",
    "PASSKEY_CREATED_WALLET_INIT_FAILED",
    "USER_OPERATION_REVERTED",
    "RECOVERY_SIGNATURE_MISMATCH",
    "RECOVERY_MAPPING_MISMATCH",
    "RECOVERY_MAPPING_NOT_FOUND",
    "RECOVERY_MAPPING_AMBIGUOUS",
    "RECOVERY_SMART_ACCOUNT_MISMATCH",
    "RECOVERY_SMART_ACCOUNT_NOT_DEPLOYED",
    "RECOVERED_WALLET_MISMATCH",
    "RECOVERY_ACCOUNT_MISMATCH",
    "RECOVERY_WALLET_REQUIRED",
    "BRIDGE_INPUT_REQUIRED",
    "BRIDGE_ACCOUNT_CHANGED",
  ]);
  const firstLine = error.message.split("\n")[0].trim();
  return safeCodes.has(firstLine) ? firstLine : "SDK_REQUEST_FAILED";
}

function WalletPicker({
  wallets,
  selectedId,
  onSelect,
  label,
}: {
  wallets: InjectedWallet[];
  selectedId: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  if (wallets.length === 0) return <p className="muted">{label}</p>;
  return (
    <div className="wallet-picker" role="radiogroup" aria-label={label}>
      {wallets.map((wallet) => (
        <label key={wallet.id} className="wallet-choice">
          <input
            type="radio"
            name={label}
            value={wallet.id}
            checked={wallet.id === selectedId}
            onChange={() => onSelect(wallet.id)}
          />
          {wallet.icon && (
            <img src={wallet.icon} alt="" width="24" height="24" />
          )}
          <span>{wallet.name}</span>
        </label>
      ))}
    </div>
  );
}

export function PasskeyControls({
  session,
  busy,
  onSession,
}: {
  session: PasskeyWalletSession | null;
  busy: boolean;
  onSession: (session: PasskeyWalletSession) => void;
}) {
  const { t } = useTranslation();
  const [working, setWorking] = useState<"register" | "login" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const configured = isCircleConfigured();

  async function open(mode: "register" | "login") {
    setWorking(mode);
    setStatus(null);
    try {
      const next = await createPasskeyWallet(mode);
      onSession(next);
      setStatus(
        t(mode === "register" ? "passkey.created" : "passkey.connected"),
      );
    } catch (error) {
      const code = cleanError(error);
      setStatus(
        code === "PASSKEY_CREATED_WALLET_INIT_FAILED"
          ? t("passkey.createdButInitFailed")
          : t("passkey.error", { error: code }),
      );
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="passkey-controls">
      <div>
        <strong>{t("passkey.title")}</strong>
        <small>{t("passkey.description")}</small>
      </div>
      {!configured && (
        <p className="feature-warning">{t("passkey.notConfigured")}</p>
      )}
      {session && (
        <div className="passkey-session-card">
          <span className="status-light online" aria-hidden="true" />
          <span>
            <strong>{t("passkey.active")}</strong>
            <code>{session.address}</code>
          </span>
        </div>
      )}
      <div className="feature-actions">
        <button
          type="button"
          onClick={() => void open("register")}
          disabled={!configured || busy || working !== null}
        >
          {working === "register" ? t("passkey.working") : t("passkey.create")}
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void open("login")}
          disabled={!configured || busy || working !== null}
        >
          {working === "login" ? t("passkey.working") : t("passkey.login")}
        </button>
      </div>
      {session && <small>{t("passkey.gasSponsored")}</small>}
      {status && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
    </div>
  );
}

function readRecoveryMetadata(): PublicRecoveryMetadata | null {
  try {
    const raw = window.localStorage.getItem(RECOVERY_METADATA_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PublicRecoveryMetadata;
    if (
      !isAddress(parsed.recoveryAddress) ||
      !isAddress(parsed.walletAddress)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function RecoveryPanel({
  passkeySession,
  onRecoveredSession,
}: {
  passkeySession: PasskeyWalletSession | null;
  onRecoveredSession: (session: PasskeyWalletSession) => void;
}) {
  const { t } = useTranslation();
  const [wallets, setWallets] = useState<InjectedWallet[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState("");
  const [method, setMethod] = useState<"browser" | "phrase">("browser");
  const [recoveryAddress, setRecoveryAddress] = useState<Address | null>(null);
  const [metadata, setMetadata] = useState<PublicRecoveryMetadata | null>(() =>
    readRecoveryMetadata(),
  );
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [mnemonicAccount, setMnemonicAccount] = useState<LocalAccount | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState("");
  const [recoveryPhraseInput, setRecoveryPhraseInput] = useState("");
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pendingRecoveredSession, setPendingRecoveredSession] =
    useState<PasskeyWalletSession | null>(null);
  const mnemonicRef = useRef<string | null>(null);
  mnemonicRef.current = mnemonic;

  useEffect(
    () =>
      listenForInjectedWallets((next) => {
        setWallets(next);
        setSelectedWalletId((current) => current || next[0]?.id || "");
      }),
    [],
  );

  useEffect(
    () => () => {
      mnemonicRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (method === "browser" && mnemonic) {
      mnemonicRef.current = null;
      setMnemonic(null);
      setMnemonicAccount(null);
      setConfirmation("");
    }
  }, [method, mnemonic]);

  const selectedWallet = wallets.find(
    (wallet) => wallet.id === selectedWalletId,
  );
  const words = mnemonic?.split(" ") ?? [];
  const confirmationIndexes = [2, 6, 10];
  const expectedConfirmation = confirmationIndexes
    .map((index) => words[index])
    .join(" ");

  async function connectRecoveryWallet(): Promise<{
    wallet: InjectedWallet;
    address: Address;
    chainId: number;
  }> {
    if (!selectedWallet) throw new Error("RECOVERY_WALLET_REQUIRED");
    const connection = await connectInjectedWallet(selectedWallet);
    setRecoveryAddress(connection.address);
    return { wallet: selectedWallet, ...connection };
  }

  async function configureBrowserRecovery() {
    if (!passkeySession) return;
    setWorking(true);
    setStatus(null);
    try {
      const connected = await connectRecoveryWallet();
      const result = await registerBrowserRecovery({
        session: passkeySession,
        provider: connected.wallet.provider,
        recoveryAddress: connected.address,
      });
      const next: PublicRecoveryMetadata = {
        method: "browser",
        recoveryAddress: connected.address,
        walletName: connected.wallet.name,
        walletAddress: result.walletAddress,
        registrationTransactionHash: result.transactionHash,
      };
      window.localStorage.setItem(RECOVERY_METADATA_KEY, JSON.stringify(next));
      setMetadata(next);
      setStatus(t("recovery.configured"));
    } catch (error) {
      setStatus(t("recovery.error", { error: cleanError(error) }));
    } finally {
      setWorking(false);
    }
  }

  function beginPhraseSetup() {
    const generated = createRecoveryMnemonic();
    setMnemonic(generated.mnemonic);
    setMnemonicAccount(generated.account);
    setConfirmation("");
    setStatus(null);
  }

  function clearMnemonic() {
    mnemonicRef.current = null;
    setMnemonic(null);
    setMnemonicAccount(null);
    setConfirmation("");
  }

  async function configurePhraseRecovery() {
    if (!passkeySession || !mnemonicAccount) return;
    if (confirmation.trim().toLowerCase() !== expectedConfirmation) {
      setStatus(t("recovery.phrase.confirmMismatch"));
      return;
    }
    setWorking(true);
    setStatus(null);
    try {
      const receipt = await passkeySession.registerRecovery(
        mnemonicAccount.address,
      );
      const mappingMatches = await verifyRecoveryMapping({
        recoveryAddress: mnemonicAccount.address,
        walletAddress: passkeySession.address,
      });
      if (!mappingMatches) throw new Error("RECOVERY_MAPPING_MISMATCH");
      const next: PublicRecoveryMetadata = {
        method: "phrase",
        recoveryAddress: mnemonicAccount.address,
        walletAddress: passkeySession.address,
        registrationTransactionHash: receipt.transactionHash,
      };
      window.localStorage.setItem(RECOVERY_METADATA_KEY, JSON.stringify(next));
      setMetadata(next);
      setStatus(t("recovery.configured"));
      clearMnemonic();
    } catch (error) {
      setStatus(t("recovery.error", { error: cleanError(error) }));
      clearMnemonic();
    } finally {
      setWorking(false);
    }
  }

  async function recoverWithBrowserWallet() {
    setWorking(true);
    setStatus(null);
    try {
      const connected = await connectRecoveryWallet();
      if (
        metadata &&
        !isAddressEqual(connected.address, metadata.recoveryAddress)
      ) {
        throw new Error("RECOVERY_ACCOUNT_MISMATCH");
      }
      if (connected.chainId !== arcTestnet.id) {
        await switchProviderChain(connected.wallet.provider, arcTestnet.id, {
          chainName: arcTestnet.name,
          nativeCurrency: arcTestnet.nativeCurrency,
          rpcUrls: [...arcTestnet.rpcUrls.default.http],
          blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
        });
      }
      const owner = await browserWalletToRecoveryAccount({
        provider: connected.wallet.provider,
        address: connected.address,
      });
      const result = await recoverPasskeyWallet(owner, metadata?.walletAddress);
      if (
        metadata &&
        !isAddressEqual(result.walletAddress, metadata.walletAddress)
      ) {
        throw new Error("RECOVERED_WALLET_MISMATCH");
      }
      setStatus(t("recovery.recoveredReady"));
      setPendingRecoveredSession(result.session);
    } catch (error) {
      setStatus(t("recovery.error", { error: cleanError(error) }));
    } finally {
      setWorking(false);
    }
  }

  async function recoverWithPhrase() {
    setWorking(true);
    setStatus(null);
    let owner: LocalAccount | null = null;
    try {
      owner = recoveryAccountFromMnemonic(recoveryPhraseInput);
      if (
        metadata &&
        !isAddressEqual(owner.address, metadata.recoveryAddress)
      ) {
        throw new Error("RECOVERY_ACCOUNT_MISMATCH");
      }
      const result = await recoverPasskeyWallet(owner, metadata?.walletAddress);
      if (
        metadata &&
        !isAddressEqual(result.walletAddress, metadata.walletAddress)
      ) {
        throw new Error("RECOVERED_WALLET_MISMATCH");
      }
      setRecoveryPhraseInput("");
      setStatus(t("recovery.recoveredReady"));
      setPendingRecoveredSession(result.session);
    } catch (error) {
      setRecoveryPhraseInput("");
      setStatus(t("recovery.error", { error: cleanError(error) }));
    } finally {
      owner = null;
      setWorking(false);
    }
  }

  return (
    <section className="feature-panel" aria-labelledby="recovery-title">
      <div className="feature-heading">
        <div>
          <span className="section-label">{t("recovery.sectionLabel")}</span>
          <h2 id="recovery-title">{t("recovery.title")}</h2>
        </div>
        <span className="beta-pill">{t("recovery.beta")}</span>
      </div>
      <p>{t("recovery.description")}</p>
      <div className="recovery-warning" role="note">
        {t("recovery.oldPasskeyWarning")}
      </div>

      {!passkeySession && (
        <p className="recovery-lock-note">
          {t("recovery.setupRequiresPasskey")}
        </p>
      )}

      {passkeySession && (
        <div className="recovery-setup">
          <h3>{t("recovery.setupTitle")}</h3>
          <div
            className="method-grid"
            role="radiogroup"
            aria-label={t("recovery.methodAria")}
          >
            <label
              className={
                method === "browser" ? "method-card selected" : "method-card"
              }
            >
              <input
                type="radio"
                name="recovery-method"
                checked={method === "browser"}
                onChange={() => setMethod("browser")}
              />
              <strong>{t("recovery.browser.title")}</strong>
              <small>{t("recovery.recommended")}</small>
            </label>
            <label
              className={
                method === "phrase" ? "method-card selected" : "method-card"
              }
            >
              <input
                type="radio"
                name="recovery-method"
                checked={method === "phrase"}
                onChange={() => setMethod("phrase")}
              />
              <strong>{t("recovery.phrase.title")}</strong>
            </label>
          </div>

          {method === "browser" ? (
            <>
              <WalletPicker
                wallets={wallets}
                selectedId={selectedWalletId}
                onSelect={setSelectedWalletId}
                label={t("recovery.walletPicker")}
              />
              {recoveryAddress && (
                <small>
                  {t("recovery.connectedSigner", { address: recoveryAddress })}
                </small>
              )}
              <button
                type="button"
                onClick={() => void configureBrowserRecovery()}
                disabled={working || !selectedWallet}
              >
                {working
                  ? t("recovery.working")
                  : t("recovery.configureBrowser")}
              </button>
            </>
          ) : !mnemonic ? (
            <button type="button" onClick={beginPhraseSetup} disabled={working}>
              {t("recovery.phrase.generate")}
            </button>
          ) : (
            <div className="phrase-setup">
              <ol
                className="mnemonic-words"
                aria-label={t("recovery.phrase.wordsAria")}
              >
                {words.map((word, index) => (
                  <li key={`${index}-${word}`}>
                    <span>{index + 1}</span>
                    {word}
                  </li>
                ))}
              </ol>
              <p className="feature-warning">
                {t("recovery.phrase.storeOffline")}
              </p>
              <label>
                {t("recovery.phrase.confirmLabel", { positions: "3, 7, 11" })}
                <input
                  value={confirmation}
                  autoComplete="off"
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <div className="feature-actions">
                <button
                  type="button"
                  onClick={() => void configurePhraseRecovery()}
                  disabled={working}
                >
                  {t("recovery.phrase.confirm")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={clearMnemonic}
                >
                  {t("recovery.phrase.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <details
        className="recovery-runbook"
        onToggle={(event) => {
          if (!event.currentTarget.open) setRecoveryPhraseInput("");
        }}
      >
        <summary>{t("recovery.runTitle")}</summary>
        {metadata && (
          <p className="public-metadata">
            {t("recovery.registered", {
              method: t(`recovery.method.${metadata.method}`),
              address: metadata.recoveryAddress,
            })}
          </p>
        )}
        <div className="method-grid">
          <div className="method-card">
            <strong>{t("recovery.browser.title")}</strong>
            <WalletPicker
              wallets={wallets}
              selectedId={selectedWalletId}
              onSelect={setSelectedWalletId}
              label={t("recovery.walletPicker")}
            />
            <button
              type="button"
              onClick={() => void recoverWithBrowserWallet()}
              disabled={working || !selectedWallet}
            >
              {t("recovery.browser.recover")}
            </button>
          </div>
          <div className="method-card">
            <strong>{t("recovery.phrase.title")}</strong>
            <label>
              {t("recovery.phrase.inputLabel")}
              <textarea
                value={recoveryPhraseInput}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setRecoveryPhraseInput(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => void recoverWithPhrase()}
              disabled={
                working || recoveryPhraseInput.trim().split(/\s+/).length !== 12
              }
            >
              {t("recovery.phrase.recover")}
            </button>
          </div>
        </div>
        <small>{t("recovery.sessionIsolation")}</small>
        {pendingRecoveredSession && (
          <button
            type="button"
            onClick={() => {
              onRecoveredSession(pendingRecoveredSession);
              setPendingRecoveredSession(null);
              setStatus(t("recovery.activated"));
            }}
          >
            {t("recovery.useRecovered")}
          </button>
        )}
      </details>
      {status && (
        <p className="feature-status" role="status" aria-live="polite">
          {status}
        </p>
      )}
    </section>
  );
}

type BridgeSource = {
  key: "ethereum" | "base" | "arbitrum";
  chainId: number;
  circleChain: "Ethereum_Sepolia" | "Base_Sepolia" | "Arbitrum_Sepolia";
};

const BRIDGE_SOURCES: BridgeSource[] = [
  { key: "ethereum", chainId: 11155111, circleChain: "Ethereum_Sepolia" },
  { key: "base", chainId: 84532, circleChain: "Base_Sepolia" },
  { key: "arbitrum", chainId: 421614, circleChain: "Arbitrum_Sepolia" },
];

type BridgeEstimateView = {
  fees: Array<{ type: string; amount: string | null; token: string }>;
  gasFees: Array<{ name: string; token: string; amount: string | null }>;
  expiresAt: number;
  receivedAmount: string;
};

export function BridgePanel({
  destinationAddress,
  onComplete,
}: {
  destinationAddress: Address | null;
  onComplete: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [wallets, setWallets] = useState<InjectedWallet[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState("");
  const [sourceKey, setSourceKey] = useState<BridgeSource["key"]>("ethereum");
  const [sourceAddress, setSourceAddress] = useState<Address | null>(null);
  const [amount, setAmount] = useState("");
  const [speed, setSpeed] = useState<"FAST" | "SLOW">("FAST");
  const [estimate, setEstimate] = useState<BridgeEstimateView | null>(null);
  const [rawResult, setRawResult] = useState<unknown>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [working, setWorking] = useState<
    "connect" | "estimate" | "bridge" | "retry" | null
  >(null);
  const [status, setStatus] = useState<string | null>(null);
  const inputFingerprint = `${selectedWalletId}:${sourceKey}:${amount}:${speed}:${destinationAddress ?? ""}`;
  const estimateFingerprintRef = useRef("");

  useEffect(
    () =>
      listenForInjectedWallets((next) => {
        setWallets(next);
        setSelectedWalletId((current) => current || next[0]?.id || "");
      }),
    [],
  );

  useEffect(() => {
    setEstimate(null);
    setRawResult(null);
    setProgress([]);
  }, [inputFingerprint]);

  useEffect(() => {
    if (!estimate || estimate.expiresAt <= Date.now()) return;
    const timeout = window.setTimeout(() => {
      setEstimate((current) =>
        current?.expiresAt === estimate.expiresAt
          ? { ...current, expiresAt: 0 }
          : current,
      );
    }, estimate.expiresAt - Date.now());
    return () => window.clearTimeout(timeout);
  }, [estimate]);

  const selectedWallet = wallets.find(
    (wallet) => wallet.id === selectedWalletId,
  );
  const source = BRIDGE_SOURCES.find((item) => item.key === sourceKey)!;

  async function connectSource() {
    if (!selectedWallet) return;
    setWorking("connect");
    setStatus(null);
    try {
      const connected = await connectInjectedWallet(selectedWallet);
      setSourceAddress(connected.address);
      setStatus(t("bridge.connected", { address: connected.address }));
    } catch (error) {
      setStatus(t("bridge.error", { error: cleanError(error) }));
    } finally {
      setWorking(null);
    }
  }

  async function buildBridge() {
    if (!selectedWallet || !sourceAddress || !destinationAddress || !amount) {
      throw new Error("BRIDGE_INPUT_REQUIRED");
    }
    const current = await connectInjectedWallet(selectedWallet);
    if (!isAddressEqual(current.address, sourceAddress)) {
      throw new Error("BRIDGE_ACCOUNT_CHANGED");
    }
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
    const adapter = await createViemAdapterFromProvider({
      provider: selectedWallet.provider,
      getPublicClient: ({ chain }) =>
        createPublicClient({
          chain,
          transport: custom(selectedWallet.provider),
        }),
    });
    const params = {
      from: { adapter, chain: source.circleChain },
      to: {
        chain: "Arc_Testnet" as const,
        recipientAddress: destinationAddress,
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

  async function estimateBridge() {
    setWorking("estimate");
    setStatus(null);
    try {
      const { kit, params } = await buildBridge();
      const result = await withIsolatedWalletRequest(() =>
        kit.estimateBridge(params),
      );
      const feeAmount = result.fees.reduce((total, fee) => {
        if (!fee.amount) return total;
        try {
          return total + parseUnits(fee.amount, 6);
        } catch {
          return total;
        }
      }, 0n);
      const inputAmount = parseUnits(amount, 6);
      const next: BridgeEstimateView = {
        fees: result.fees.map(({ type, amount: feeAmount, token }) => ({
          type,
          amount: feeAmount,
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
      };
      estimateFingerprintRef.current = inputFingerprint;
      setEstimate(next);
      setStatus(t("bridge.estimateReady"));
    } catch (error) {
      setStatus(t("bridge.error", { error: cleanError(error) }));
    } finally {
      setWorking(null);
    }
  }

  const estimateValid = Boolean(
    estimate &&
      estimate.expiresAt > Date.now() &&
      estimateFingerprintRef.current === inputFingerprint,
  );

  async function executeBridge() {
    if (
      !estimate ||
      estimate.expiresAt <= Date.now() ||
      estimateFingerprintRef.current !== inputFingerprint
    ) {
      setEstimate((current) =>
        current ? { ...current, expiresAt: 0 } : current,
      );
      setStatus(t("bridge.estimateExpired"));
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
      setProgress(result.steps.map((step) => `${step.name}:${step.state}`));
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
    if (
      !rawResult ||
      typeof rawResult !== "object" ||
      !("result" in rawResult) ||
      !("kit" in rawResult)
    )
      return;
    setWorking("retry");
    setStatus(null);
    try {
      const stored = rawResult as {
        result: Awaited<
          ReturnType<Awaited<ReturnType<typeof buildBridge>>["kit"]["bridge"]>
        >;
        kit: Awaited<ReturnType<typeof buildBridge>>["kit"];
      };
      const { adapter, isRetryableError } = await buildBridge();
      const result = await withIsolatedWalletRequest(() =>
        stored.kit.retryBridge(stored.result, { from: adapter }),
      );
      const retryable =
        result.state === "error" &&
        result.steps.some((step) =>
          Boolean(step.error && isRetryableError(step.error)),
        );
      setRawResult({ result, kit: stored.kit, retryable });
      setProgress(result.steps.map((step) => `${step.name}:${step.state}`));
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

  const canRetry = Boolean(
    rawResult &&
      typeof rawResult === "object" &&
      "retryable" in rawResult &&
      (rawResult as { retryable?: boolean }).retryable,
  );

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
      stage: t(`bridge.stage.${stage}`),
      state: t(`bridge.state.${state}`),
    });
  }

  return (
    <section
      className="feature-panel bridge-panel"
      aria-labelledby="bridge-title"
    >
      <div className="feature-heading">
        <div>
          <span className="section-label">{t("bridge.sectionLabel")}</span>
          <h2 id="bridge-title">{t("bridge.title")}</h2>
        </div>
        <span className="network-pill online">CCTP</span>
      </div>
      <p>{t("bridge.description")}</p>
      {!destinationAddress && (
        <p className="feature-warning">{t("bridge.destinationRequired")}</p>
      )}
      <WalletPicker
        wallets={wallets}
        selectedId={selectedWalletId}
        onSelect={(id) => {
          setSelectedWalletId(id);
          setSourceAddress(null);
        }}
        label={t("bridge.walletPicker")}
      />
      <div className="bridge-fields">
        <label>
          {t("bridge.source")}
          <select
            value={sourceKey}
            onChange={(event) => {
              setSourceKey(event.target.value as BridgeSource["key"]);
              setSourceAddress(null);
            }}
          >
            <option value="ethereum">Ethereum Sepolia</option>
            <option value="base">Base Sepolia</option>
            <option value="arbitrum">Arbitrum Sepolia</option>
          </select>
        </label>
        <label>
          {t("bridge.amount")}
          <input
            inputMode="decimal"
            value={amount}
            placeholder="10"
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label>
          {t("bridge.speed")}
          <select
            value={speed}
            onChange={(event) =>
              setSpeed(event.target.value as "FAST" | "SLOW")
            }
          >
            <option value="FAST">{t("bridge.fast")}</option>
            <option value="SLOW">{t("bridge.standard")}</option>
          </select>
        </label>
      </div>
      <p className="bridge-destination">
        {t("bridge.destination", { address: destinationAddress ?? "—" })}
      </p>
      <div className="feature-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => void connectSource()}
          disabled={!selectedWallet || working !== null}
        >
          {working === "connect"
            ? t("bridge.connecting")
            : t("bridge.connectSource")}
        </button>
        <button
          type="button"
          onClick={() => void estimateBridge()}
          disabled={
            !sourceAddress || !destinationAddress || !amount || working !== null
          }
        >
          {working === "estimate"
            ? t("bridge.estimating")
            : t("bridge.estimate")}
        </button>
        <button
          type="button"
          onClick={() => void executeBridge()}
          disabled={!estimateValid || working !== null}
        >
          {working === "bridge" ? t("bridge.bridging") : t("bridge.execute")}
        </button>
        {canRetry && (
          <button
            type="button"
            onClick={() => void retryBridge()}
            disabled={working !== null}
          >
            {working === "retry" ? t("bridge.retrying") : t("bridge.retry")}
          </button>
        )}
      </div>
      {estimate && (
        <div
          className={
            estimateValid ? "bridge-estimate" : "bridge-estimate expired"
          }
        >
          <strong>{t("bridge.estimateTitle")}</strong>
          <ul>
            {estimate.fees.map((fee, index) => (
              <li key={`${fee.type}-${index}`}>
                {t("bridge.fee", {
                  type: fee.type,
                  amount: fee.amount ?? "—",
                  token: fee.token,
                })}
              </li>
            ))}
            {estimate.gasFees.map((fee, index) => (
              <li key={`${fee.name}-${index}`}>
                {t("bridge.gasFee", {
                  name: fee.name,
                  amount: fee.amount ?? "—",
                  token: fee.token,
                })}
              </li>
            ))}
          </ul>
          <small>
            {t("bridge.receivedEstimate", { amount: estimate.receivedAmount })}
          </small>
        </div>
      )}
      {progress.length > 0 && (
        <ol
          className="bridge-progress"
          aria-label={t("bridge.progressAria")}
          aria-live="polite"
        >
          {progress.map((item, index) => (
            <li key={`${item}-${index}`}>{progressLabel(item)}</li>
          ))}
        </ol>
      )}
      {status && (
        <p className="feature-status" role="status" aria-live="polite">
          {status}
        </p>
      )}
      <small>{t("bridge.noAutoSwitch")}</small>
    </section>
  );
}
