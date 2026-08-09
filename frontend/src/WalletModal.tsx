import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
  type EIP1193Provider,
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
  type InjectedWallet,
} from "./eip6963";

export type WalletModalView = "choose" | "passkey" | "recover";

type PublicRecoveryMetadata = {
  method: "browser" | "phrase";
  recoveryAddress: Address;
  walletName?: string;
  walletAddress: Address;
  registrationTransactionHash: Hash;
};

type ModalStage =
  | "choose"
  | "passkey"
  | "backup"
  | "recover"
  | "recovered";
type WorkingAction =
  | "browser-connect"
  | "passkey-login"
  | "passkey-create"
  | "browser-backup"
  | "phrase-backup"
  | "browser-recover"
  | "phrase-recover"
  | null;

const RECOVERY_METADATA_KEY = "arc-tip-jar-recovery-metadata";
const CONFIRMATION_INDEXES = [2, 6, 10];

function stageFromView(view: WalletModalView): ModalStage {
  if (view === "recover") return "recover";
  if (view === "passkey") return "passkey";
  return "choose";
}

function shortAddress(address: Address): string {
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return "REQUEST_FAILED";
  const normalized = error.message.toLowerCase();
  if (normalized.includes("user rejected") || normalized.includes("user denied")) {
    return "WALLET_REQUEST_REJECTED";
  }
  const firstLine = error.message.split("\n")[0].trim();
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
  ]);
  return safeCodes.has(firstLine) ? firstLine : "SDK_REQUEST_FAILED";
}

function readRecoveryMetadata(): PublicRecoveryMetadata | null {
  try {
    const raw = window.localStorage.getItem(RECOVERY_METADATA_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PublicRecoveryMetadata;
    if (!isAddress(parsed.recoveryAddress) || !isAddress(parsed.walletAddress)) {
      return null;
    }
    return {
      ...parsed,
      recoveryAddress: getAddress(parsed.recoveryAddress),
      walletAddress: getAddress(parsed.walletAddress),
    };
  } catch {
    return null;
  }
}

function saveRecoveryMetadata(metadata: PublicRecoveryMetadata): void {
  window.localStorage.setItem(RECOVERY_METADATA_KEY, JSON.stringify(metadata));
}

function legacyWalletName(provider: EIP1193Provider): string {
  const flags = provider as EIP1193Provider & {
    isMetaMask?: boolean;
    isRabby?: boolean;
  };
  if (flags.isRabby) return "Rabby";
  if (flags.isMetaMask) return "MetaMask";
  return "Browser Wallet";
}

async function getDefaultInjectedWallet(): Promise<InjectedWallet> {
  if (window.ethereum) {
    return {
      id: "default-injected",
      name: legacyWalletName(window.ethereum),
      provider: window.ethereum,
    };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let listenerReady = false;
    let pendingWallet: InjectedWallet | undefined;
    let timeout = 0;
    let stop = () => {};
    const finish = (wallet?: InjectedWallet) => {
      if (settled) return;
      settled = true;
      stop();
      window.clearTimeout(timeout);
      if (wallet) resolve(wallet);
      else reject(new Error("RECOVERY_WALLET_REQUIRED"));
    };
    stop = listenForInjectedWallets((wallets) => {
      if (!listenerReady) {
        pendingWallet = wallets[0];
        return;
      }
      finish(wallets[0]);
    });
    listenerReady = true;
    if (pendingWallet) finish(pendingWallet);
    else timeout = window.setTimeout(() => finish(), 800);
  });
}

function MethodIcon({ children }: { children: string }) {
  return <span className="wallet-method-icon" aria-hidden="true">{children}</span>;
}

export default function WalletModal({
  open,
  initialView,
  onClose,
  onConnectBrowser,
  onActivatePasskey,
}: {
  open: boolean;
  initialView: WalletModalView;
  onClose: () => void;
  onConnectBrowser: () => Promise<boolean>;
  onActivatePasskey: (session: PasskeyWalletSession) => void;
}) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<ModalStage>(() =>
    stageFromView(initialView),
  );
  const [recoveryReturnStage, setRecoveryReturnStage] = useState<
    "choose" | "passkey"
  >("choose");
  const [working, setWorking] = useState<WorkingAction>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [createdSession, setCreatedSession] = useState<PasskeyWalletSession | null>(null);
  const [metadata, setMetadata] = useState<PublicRecoveryMetadata | null>(() =>
    readRecoveryMetadata(),
  );
  const [browserBackupComplete, setBrowserBackupComplete] = useState(false);
  const [phraseBackupComplete, setPhraseBackupComplete] = useState(false);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [mnemonicAccount, setMnemonicAccount] = useState<LocalAccount | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [recoveryPhraseInput, setRecoveryPhraseInput] = useState("");
  const [pendingRecoveredSession, setPendingRecoveredSession] =
    useState<PasskeyWalletSession | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mnemonicRef = useRef<string | null>(null);
  mnemonicRef.current = mnemonic;

  function clearMnemonic() {
    mnemonicRef.current = null;
    setMnemonic(null);
    setMnemonicAccount(null);
    setConfirmation("");
  }

  function resetAndClose() {
    clearMnemonic();
    setRecoveryPhraseInput("");
    setPendingRecoveredSession(null);
    setWorking(null);
    setStatus(null);
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    setStage(stageFromView(initialView));
    setRecoveryReturnStage(
      initialView === "passkey" ? "passkey" : "choose",
    );
    setStatus(null);
    setWorking(null);
    setCreatedSession(null);
    setBrowserBackupComplete(false);
    setPhraseBackupComplete(false);
    setPendingRecoveredSession(null);
    setRecoveryPhraseInput("");
    clearMnemonic();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open, initialView]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) {
        resetAndClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(
    () => () => {
      mnemonicRef.current = null;
    },
    [],
  );

  if (!open) return null;

  const backupComplete = browserBackupComplete || phraseBackupComplete;
  const phraseWords = mnemonic?.split(" ") ?? [];
  const expectedConfirmation = CONFIRMATION_INDEXES.map(
    (index) => phraseWords[index],
  ).join(" ");

  async function connectBrowser() {
    setWorking("browser-connect");
    setStatus(null);
    try {
      const connected = await onConnectBrowser();
      if (connected) resetAndClose();
    } finally {
      setWorking(null);
    }
  }

  async function openPasskey(mode: "register" | "login") {
    const action = mode === "register" ? "passkey-create" : "passkey-login";
    setWorking(action);
    setStatus(null);
    try {
      const session = await createPasskeyWallet(mode);
      onActivatePasskey(session);
      if (mode === "register") {
        setCreatedSession(session);
        setStage("backup");
        setStatus(t("walletModal.create.created", { address: shortAddress(session.address) }));
      } else {
        resetAndClose();
      }
    } catch (error) {
      const code = cleanError(error);
      setStatus(
        code === "PASSKEY_CREATED_WALLET_INIT_FAILED"
          ? t("passkey.createdButInitFailed")
          : t("walletModal.error", { error: code }),
      );
    } finally {
      setWorking(null);
    }
  }

  async function connectRecoveryWallet(): Promise<{
    wallet: InjectedWallet;
    address: Address;
    chainId: number;
  }> {
    const wallet = await getDefaultInjectedWallet();
    const connected = await connectInjectedWallet(wallet);
    return { wallet, ...connected };
  }

  async function configureBrowserBackup() {
    if (!createdSession) return;
    setWorking("browser-backup");
    setStatus(null);
    try {
      const connected = await connectRecoveryWallet();
      const result = await registerBrowserRecovery({
        session: createdSession,
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
      saveRecoveryMetadata(next);
      setMetadata(next);
      setBrowserBackupComplete(true);
      setStatus(t("walletModal.backup.browserComplete"));
    } catch (error) {
      setStatus(t("walletModal.error", { error: cleanError(error) }));
    } finally {
      setWorking(null);
    }
  }

  function beginPhraseBackup() {
    clearMnemonic();
    const generated = createRecoveryMnemonic();
    setMnemonic(generated.mnemonic);
    setMnemonicAccount(generated.account);
    setStatus(null);
  }

  async function configurePhraseBackup() {
    if (!createdSession || !mnemonicAccount) return;
    if (confirmation.trim().toLowerCase() !== expectedConfirmation) {
      setStatus(t("recovery.phrase.confirmMismatch"));
      return;
    }
    setWorking("phrase-backup");
    setStatus(null);
    try {
      const receipt = await createdSession.registerRecovery(mnemonicAccount.address);
      const mappingMatches = await verifyRecoveryMapping({
        recoveryAddress: mnemonicAccount.address,
        walletAddress: createdSession.address,
      });
      if (!mappingMatches) throw new Error("RECOVERY_MAPPING_MISMATCH");
      const next: PublicRecoveryMetadata = {
        method: "phrase",
        recoveryAddress: mnemonicAccount.address,
        walletAddress: createdSession.address,
        registrationTransactionHash: receipt.transactionHash,
      };
      saveRecoveryMetadata(next);
      setMetadata(next);
      setPhraseBackupComplete(true);
      setStatus(t("walletModal.backup.phraseComplete"));
      clearMnemonic();
    } catch (error) {
      setStatus(t("walletModal.error", { error: cleanError(error) }));
      clearMnemonic();
    } finally {
      setWorking(null);
    }
  }

  async function recoverWithBrowser() {
    setWorking("browser-recover");
    setStatus(null);
    try {
      const connected = await connectRecoveryWallet();
      if (metadata && !isAddressEqual(connected.address, metadata.recoveryAddress)) {
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
      if (metadata && !isAddressEqual(result.walletAddress, metadata.walletAddress)) {
        throw new Error("RECOVERED_WALLET_MISMATCH");
      }
      setPendingRecoveredSession(result.session);
      setRecoveryPhraseInput("");
      setStage("recovered");
      setStatus(null);
    } catch (error) {
      setStatus(t("walletModal.error", { error: cleanError(error) }));
    } finally {
      setWorking(null);
    }
  }

  async function recoverWithPhrase() {
    setWorking("phrase-recover");
    setStatus(null);
    let owner: LocalAccount | null = null;
    try {
      owner = recoveryAccountFromMnemonic(recoveryPhraseInput);
      if (metadata && !isAddressEqual(owner.address, metadata.recoveryAddress)) {
        throw new Error("RECOVERY_ACCOUNT_MISMATCH");
      }
      const result = await recoverPasskeyWallet(owner, metadata?.walletAddress);
      if (metadata && !isAddressEqual(result.walletAddress, metadata.walletAddress)) {
        throw new Error("RECOVERED_WALLET_MISMATCH");
      }
      setPendingRecoveredSession(result.session);
      setRecoveryPhraseInput("");
      setStage("recovered");
      setStatus(null);
    } catch (error) {
      setRecoveryPhraseInput("");
      setStatus(t("walletModal.error", { error: cleanError(error) }));
    } finally {
      owner = null;
      setWorking(null);
    }
  }

  function activateRecovered() {
    if (!pendingRecoveredSession) return;
    onActivatePasskey(pendingRecoveredSession);
    resetAndClose();
  }

  const canDismiss = true;

  return (
    <div
      className="wallet-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && canDismiss && !working) {
          resetAndClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="wallet-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
      >
        <div className="wallet-modal-header">
          <div>
            <span className="section-label">
              {stage === "backup"
                ? t("walletModal.backup.eyebrow")
                : stage === "recover" || stage === "recovered"
                  ? t("walletModal.recover.eyebrow")
                  : stage === "passkey"
                    ? t("walletModal.passkeyEntry.eyebrow")
                    : t("walletModal.choose.eyebrow")}
            </span>
            <h2 id="wallet-modal-title">
              {stage === "backup"
                ? t("walletModal.backup.title")
                : stage === "recover"
                  ? t("walletModal.recover.title")
                  : stage === "recovered"
                    ? t("walletModal.recovered.title")
                    : stage === "passkey"
                      ? t("walletModal.passkeyEntry.title")
                      : t("walletModal.choose.title")}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            className="wallet-modal-close"
            type="button"
            aria-label={t("walletModal.closeAria")}
            onClick={resetAndClose}
            disabled={!canDismiss || working !== null}
          >
            ×
          </button>
        </div>

        {stage === "passkey" && (
          <div className="wallet-modal-body">
            <p className="wallet-modal-lead">
              {t("walletModal.passkeyEntry.description")}
            </p>
            <div className="wallet-method-list">
              <button
                type="button"
                className="wallet-method-card primary-method"
                onClick={() => void openPasskey("register")}
                disabled={!isCircleConfigured() || working !== null}
              >
                <MethodIcon>＋</MethodIcon>
                <span>
                  <strong>
                    {working === "passkey-create"
                      ? t("passkey.working")
                      : t("walletModal.choose.create")}
                  </strong>
                  <small>{t("walletModal.choose.createHint")}</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className="wallet-method-card"
                onClick={() => {
                  setStatus(null);
                  setRecoveryReturnStage("passkey");
                  setStage("recover");
                }}
                disabled={!isCircleConfigured() || working !== null}
              >
                <MethodIcon>↺</MethodIcon>
                <span>
                  <strong>{t("walletModal.choose.recover")}</strong>
                  <small>{t("walletModal.choose.recoverHint")}</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
            </div>
            <button
              className="wallet-modal-text-link"
              type="button"
              onClick={() => {
                setStatus(null);
                setStage("choose");
              }}
              disabled={working !== null}
            >
              {t("walletModal.passkeyEntry.connectLink")}
            </button>
            {!isCircleConfigured() && (
              <p className="feature-warning">{t("passkey.notConfigured")}</p>
            )}
          </div>
        )}

        {stage === "choose" && (
          <div className="wallet-modal-body">
            <p className="wallet-modal-lead">{t("walletModal.choose.description")}</p>
            <div className="wallet-method-list">
              <button
                type="button"
                className="wallet-method-card primary-method"
                onClick={() => void openPasskey("login")}
                disabled={!isCircleConfigured() || working !== null}
              >
                <MethodIcon>⌁</MethodIcon>
                <span>
                  <strong>{working === "passkey-login" ? t("passkey.working") : t("walletModal.choose.passkeyConnect")}</strong>
                  <small>{t("walletModal.choose.passkeyConnectHint")}</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className="wallet-method-card"
                onClick={() => void connectBrowser()}
                disabled={working !== null}
              >
                <MethodIcon>◈</MethodIcon>
                <span>
                  <strong>{working === "browser-connect" ? t("header.connecting") : t("walletModal.choose.browserConnect")}</strong>
                  <small>{t("walletModal.choose.browserConnectHint")}</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
            </div>

            <div className="wallet-modal-divider">
              <span>{t("walletModal.choose.newOrRecover")}</span>
            </div>

            <div className="wallet-method-list compact">
              <button
                type="button"
                className="wallet-method-card"
                onClick={() => void openPasskey("register")}
                disabled={!isCircleConfigured() || working !== null}
              >
                <MethodIcon>＋</MethodIcon>
                <span>
                  <strong>{working === "passkey-create" ? t("passkey.working") : t("walletModal.choose.create")}</strong>
                  <small>{t("walletModal.choose.createHint")}</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className="wallet-method-card"
                onClick={() => {
                  setStatus(null);
                  setRecoveryReturnStage("choose");
                  setStage("recover");
                }}
                disabled={!isCircleConfigured() || working !== null}
              >
                <MethodIcon>↺</MethodIcon>
                <span>
                  <strong>{t("walletModal.choose.recover")}</strong>
                  <small>{t("walletModal.choose.recoverHint")}</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
            </div>
            {!isCircleConfigured() && (
              <p className="feature-warning">{t("passkey.notConfigured")}</p>
            )}
          </div>
        )}

        {stage === "backup" && createdSession && (
          <div className="wallet-modal-body">
            <div className="wallet-created-banner">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>{t("walletModal.backup.walletReady")}</strong>
                <small>{shortAddress(createdSession.address)}</small>
              </div>
            </div>
            <p className="wallet-modal-lead">{t("walletModal.backup.description")}</p>
            <div className="recovery-warning" role="note">
              {t("recovery.oldPasskeyWarning")}
            </div>

            <div className="backup-option-list">
              <article className={browserBackupComplete ? "backup-option complete" : "backup-option recommended"}>
                <div className="backup-option-heading">
                  <MethodIcon>◈</MethodIcon>
                  <span>
                    <strong>{t("walletModal.backup.browserTitle")}</strong>
                    <small>{t("walletModal.backup.browserHint")}</small>
                  </span>
                  {browserBackupComplete ? (
                    <span className="backup-state complete">{t("walletModal.backup.complete")}</span>
                  ) : (
                    <span className="backup-state">{t("walletModal.backup.recommended")}</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void configureBrowserBackup()}
                  disabled={working !== null || browserBackupComplete}
                >
                  {working === "browser-backup"
                    ? t("walletModal.backup.registering")
                    : browserBackupComplete
                      ? t("walletModal.backup.browserComplete")
                      : t("walletModal.backup.browserAction")}
                </button>
              </article>

              <article className={phraseBackupComplete ? "backup-option complete" : "backup-option"}>
                <div className="backup-option-heading">
                  <MethodIcon>12</MethodIcon>
                  <span>
                    <strong>{t("walletModal.backup.phraseTitle")}</strong>
                    <small>{t("walletModal.backup.phraseHint")}</small>
                  </span>
                  {phraseBackupComplete && (
                    <span className="backup-state complete">{t("walletModal.backup.complete")}</span>
                  )}
                </div>
                {!mnemonic ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={beginPhraseBackup}
                    disabled={working !== null || phraseBackupComplete}
                  >
                    {phraseBackupComplete
                      ? t("walletModal.backup.phraseComplete")
                      : t("walletModal.backup.phraseAction")}
                  </button>
                ) : (
                  <div className="phrase-setup modal-phrase-setup">
                    <ol className="mnemonic-words" aria-label={t("recovery.phrase.wordsAria")}>
                      {phraseWords.map((word, index) => (
                        <li key={index + "-" + word}>
                          <span>{index + 1}</span>{word}
                        </li>
                      ))}
                    </ol>
                    <p className="feature-warning">{t("recovery.phrase.storeOffline")}</p>
                    <label>
                      {t("recovery.phrase.confirmLabel", { positions: "3, 7, 11" })}
                      <input
                        value={confirmation}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setConfirmation(event.target.value)}
                      />
                    </label>
                    <div className="feature-actions">
                      <button
                        type="button"
                        onClick={() => void configurePhraseBackup()}
                        disabled={working !== null}
                      >
                        {working === "phrase-backup"
                          ? t("walletModal.backup.registering")
                          : t("recovery.phrase.confirm")}
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={clearMnemonic}
                        disabled={working !== null}
                      >
                        {t("recovery.phrase.cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            </div>
          </div>
        )}

        {stage === "recover" && (
          <div className="wallet-modal-body">
            <button
              className="wallet-modal-back"
              type="button"
              onClick={() => {
                setStatus(null);
                setRecoveryPhraseInput("");
                setStage(recoveryReturnStage);
              }}
              disabled={working !== null}
            >
              ← {t("walletModal.back")}
            </button>
            <p className="wallet-modal-lead">{t("walletModal.recover.description")}</p>
            <div className="recovery-warning" role="note">
              {t("recovery.oldPasskeyWarning")}
            </div>
            {metadata && (
              <div className="registered-recovery">
                <span>{t("walletModal.recover.registered")}</span>
                <strong>{t("recovery.method." + metadata.method)}</strong>
                <small>{shortAddress(metadata.recoveryAddress)}</small>
              </div>
            )}
            <div className="recovery-choice-grid">
              <article className="recovery-choice recommended">
                <div>
                  <MethodIcon>◈</MethodIcon>
                  <span className="beta-pill">Beta</span>
                </div>
                <h3>{t("walletModal.recover.browserTitle")}</h3>
                <p>{t("walletModal.recover.browserHint")}</p>
                <button
                  type="button"
                  onClick={() => void recoverWithBrowser()}
                  disabled={working !== null}
                >
                  {working === "browser-recover"
                    ? t("walletModal.recover.working")
                    : t("walletModal.recover.browserAction")}
                </button>
              </article>
              <article className="recovery-choice">
                <MethodIcon>12</MethodIcon>
                <h3>{t("walletModal.recover.phraseTitle")}</h3>
                <p>{t("walletModal.recover.phraseHint")}</p>
                <label>
                  <span className="sr-only">{t("recovery.phrase.inputLabel")}</span>
                  <textarea
                    value={recoveryPhraseInput}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("walletModal.recover.phrasePlaceholder")}
                    onChange={(event) => setRecoveryPhraseInput(event.target.value)}
                  />
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void recoverWithPhrase()}
                  disabled={working !== null || recoveryPhraseInput.trim().split(/\s+/).length !== 12}
                >
                  {working === "phrase-recover"
                    ? t("walletModal.recover.working")
                    : t("walletModal.recover.phraseAction")}
                </button>
              </article>
            </div>
          </div>
        )}

        {stage === "recovered" && pendingRecoveredSession && (
          <div className="wallet-modal-body recovered-wallet-state">
            <div className="recovered-check" aria-hidden="true">✓</div>
            <h3>{t("walletModal.recovered.heading")}</h3>
            <p>{t("walletModal.recovered.description")}</p>
            <code>{pendingRecoveredSession.address}</code>
            <div className="recovery-warning" role="note">
              {t("recovery.oldPasskeyWarning")}
            </div>
            <button type="button" onClick={activateRecovered}>
              {t("walletModal.recovered.useWallet")}
            </button>
            <button className="secondary-button" type="button" onClick={resetAndClose}>
              {t("walletModal.recovered.closeWithoutSwitch")}
            </button>
          </div>
        )}

        {status && (
          <p className="wallet-modal-status" role="status" aria-live="polite">
            {status}
          </p>
        )}

        {stage === "backup" && (
          <div className="wallet-modal-footer">
            <button
              type="button"
              onClick={resetAndClose}
              disabled={!backupComplete || working !== null}
            >
              {t("walletModal.backup.finish")}
            </button>
            {!backupComplete && <small>{t("walletModal.backup.finishHint")}</small>}
          </div>
        )}
      </section>
    </div>
  );
}
