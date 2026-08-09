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
  isValidRecoveryMnemonic,
  isCircleConfigured,
  recoverPasskeyWallet,
  recoveryAccountFromMnemonic,
  registerBrowserRecovery,
  verifyRecoveryMapping,
  type PasskeyWalletSession,
  type RecoveryProgressStage,
} from "./circleWallet";
import {
  connectInjectedWallet,
  listenForInjectedWallets,
  switchProviderChain,
  type InjectedWallet,
} from "./eip6963";

export type WalletModalView =
  | "choose"
  | "browser"
  | "passkey"
  | "backup"
  | "recover";

type PublicRecoveryMetadata = {
  method: "browser" | "phrase";
  recoveryAddress: Address;
  walletName?: string;
  walletAddress: Address;
  registrationTransactionHash: Hash;
};

type RecoveryWalletSession = {
  wallet: InjectedWallet;
  address: Address;
  chainId: number;
};

type ModalStage =
  | "choose"
  | "browser"
  | "passkey"
  | "backup"
  | "recover"
  | "recovered";
type WorkingAction =
  | "browser-connect"
  | "recovery-connect"
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
  if (view === "backup") return "backup";
  if (view === "recover") return "recover";
  if (view === "browser") return "browser";
  if (view === "passkey") return "passkey";
  return "choose";
}

function shortAddress(address: Address): string {
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else {
      break;
    }
  }
  return messages;
}

function cleanError(error: unknown): string {
  const messages = errorMessages(error);
  if (messages.length === 0) return "REQUEST_FAILED";
  const normalized = messages.join("\n").toLowerCase();
  if (normalized.includes("user rejected") || normalized.includes("user denied")) {
    return "WALLET_REQUEST_REJECTED";
  }
  if (normalized.includes("155203")) return "SMART_ACCOUNT_NONCE_INVALID";
  if (normalized.includes("155505")) return "SMART_ACCOUNT_INITIALIZING";
  const safeCodes = new Set([
    "CIRCLE_CLIENT_KEY_MISSING",
    "PASSKEY_CREATED_WALLET_INIT_FAILED",
    "USER_OPERATION_REVERTED",
    "RECOVERY_REGISTRATION_FAILED",
    "RECOVERY_REGISTRATION_SPONSORSHIP_FAILED",
    "RECOVERY_REGISTRATION_SUBMISSION_FAILED",
    "RECOVERY_REGISTRATION_RECEIPT_FAILED",
    "RECOVERY_SIGNATURE_FAILED",
    "RECOVERY_SIGNATURE_MISMATCH",
    "RECOVERY_MAPPING_MISMATCH",
    "RECOVERY_MAPPING_NOT_FOUND",
    "RECOVERY_MAPPING_AMBIGUOUS",
    "RECOVERY_SMART_ACCOUNT_MISMATCH",
    "RECOVERY_SMART_ACCOUNT_NOT_DEPLOYED",
    "RECOVERED_WALLET_MISMATCH",
    "RECOVERY_ACCOUNT_MISMATCH",
    "RECOVERY_WALLET_REQUIRED",
    "RECOVERY_PHRASE_INVALID",
    "RECOVERY_MAPPING_LOOKUP_FAILED",
    "RECOVERY_ACCOUNT_BUILD_FAILED",
    "RECOVERY_PASSKEY_CREATE_FAILED",
    "RECOVERY_EXECUTION_FAILED",
    "RECOVERY_RECEIPT_FAILED",
    "RECOVERED_WALLET_OPEN_FAILED",
  ]);
  for (const message of messages) {
    const firstLine = message.split("\n")[0].trim();
    if (safeCodes.has(firstLine)) return firstLine;
  }
  return "SDK_REQUEST_FAILED";
}

function normalizeMetadata(
  value: unknown,
): PublicRecoveryMetadata | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<PublicRecoveryMetadata>;
  if (
    (parsed.method !== "browser" && parsed.method !== "phrase") ||
    !parsed.registrationTransactionHash ||
    !isAddress(parsed.recoveryAddress ?? "") ||
    !isAddress(parsed.walletAddress ?? "")
  ) {
    return null;
  }
  return {
    method: parsed.method,
    recoveryAddress: getAddress(parsed.recoveryAddress!),
    walletAddress: getAddress(parsed.walletAddress!),
    registrationTransactionHash: parsed.registrationTransactionHash,
    ...(parsed.walletName ? { walletName: parsed.walletName } : {}),
  };
}

function readRecoveryMetadata(): PublicRecoveryMetadata[] {
  try {
    const raw = window.localStorage.getItem(RECOVERY_METADATA_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map(normalizeMetadata)
      .filter((entry): entry is PublicRecoveryMetadata => entry !== null);
  } catch {
    return [];
  }
}

function saveRecoveryMetadata(
  current: PublicRecoveryMetadata[],
  metadata: PublicRecoveryMetadata,
): PublicRecoveryMetadata[] {
  const next = current.filter(
    (entry) =>
      entry.method !== metadata.method ||
      !isAddressEqual(entry.walletAddress, metadata.walletAddress),
  );
  next.push(metadata);
  window.localStorage.setItem(RECOVERY_METADATA_KEY, JSON.stringify(next));
  return next;
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
  activePasskeySession,
  onClose,
  onConnectBrowser,
  onActivatePasskey,
}: {
  open: boolean;
  initialView: WalletModalView;
  activePasskeySession: PasskeyWalletSession | null;
  onClose: () => void;
  onConnectBrowser: (wallet: InjectedWallet) => Promise<boolean>;
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
  const [metadata, setMetadata] = useState<PublicRecoveryMetadata[]>(() =>
    readRecoveryMetadata(),
  );
  const [injectedWallets, setInjectedWallets] = useState<InjectedWallet[]>([]);
  const [recoveryWallet, setRecoveryWallet] =
    useState<RecoveryWalletSession | null>(null);
  const [browserBackupComplete, setBrowserBackupComplete] = useState(false);
  const [phraseBackupComplete, setPhraseBackupComplete] = useState(false);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [mnemonicAccount, setMnemonicAccount] = useState<LocalAccount | null>(null);
  const [confirmation, setConfirmation] = useState(["", "", ""]);
  const [phraseCopied, setPhraseCopied] = useState(false);
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
    setConfirmation(["", "", ""]);
    setPhraseCopied(false);
  }

  function resetAndClose() {
    clearMnemonic();
    setRecoveryPhraseInput("");
    setPendingRecoveredSession(null);
    setRecoveryWallet(null);
    setWorking(null);
    setStatus(null);
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    const backupSession =
      initialView === "backup" ? activePasskeySession : null;
    const savedMetadata = readRecoveryMetadata();
    const savedForBackup = backupSession
      ? savedMetadata.filter((entry) =>
          isAddressEqual(backupSession.address, entry.walletAddress),
        )
      : [];
    setStage(
      initialView === "backup" && !backupSession
        ? "passkey"
        : stageFromView(initialView),
    );
    setRecoveryReturnStage(
      initialView === "passkey" ? "passkey" : "choose",
    );
    setStatus(null);
    setWorking(null);
    setCreatedSession(backupSession);
    setMetadata(savedMetadata);
    setBrowserBackupComplete(
      savedForBackup.some((entry) => entry.method === "browser"),
    );
    setPhraseBackupComplete(
      savedForBackup.some((entry) => entry.method === "phrase"),
    );
    setRecoveryWallet(null);
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
    setInjectedWallets([]);
    return listenForInjectedWallets((wallets) => {
      setInjectedWallets(wallets);
    });
  }, [open]);

  useEffect(() => {
    if (!open || !recoveryWallet?.wallet.provider.on) return;
    const provider = recoveryWallet.wallet.provider;
    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = (args[0] ?? []) as Address[];
      if (
        !accounts[0] ||
        !isAddressEqual(accounts[0], recoveryWallet.address)
      ) {
        setRecoveryWallet(null);
        setStatus(t("walletModal.recoveryWallet.accountChanged"));
      }
    };
    const handleChainChanged = (...args: unknown[]) => {
      const nextChainId = Number.parseInt(args[0] as string, 16);
      setRecoveryWallet((current) =>
        current ? { ...current, chainId: nextChainId } : current,
      );
    };
    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [open, recoveryWallet?.wallet.provider, recoveryWallet?.address, t]);

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
  const currentBrowserBackup = createdSession
    ? metadata.find(
        (entry) =>
          entry.method === "browser" &&
          isAddressEqual(entry.walletAddress, createdSession.address),
      )
    : undefined;
  const expectedConfirmation = CONFIRMATION_INDEXES.map(
    (index) => phraseWords[index],
  );

  const confirmationComplete = confirmation.every(
    (word) => word.trim().length > 0,
  );
  const recoveryPhraseWordCount = recoveryPhraseInput.trim()
    ? recoveryPhraseInput.trim().split(/\s+/).length
    : 0;
  const recoveryPhraseValid =
    recoveryPhraseWordCount === 12 &&
    isValidRecoveryMnemonic(recoveryPhraseInput);

  function modalError(error: unknown): string {
    const code = cleanError(error);
    return t("walletModal.error", {
      error: t("walletModal.errors." + code, { defaultValue: code }),
    });
  }
  function showRecoveryProgress(progressStage: RecoveryProgressStage) {
    setStatus(t("walletModal.recover.progress." + progressStage));
  }

  async function connectBrowser(wallet: InjectedWallet) {
    setWorking("browser-connect");
    setStatus(null);
    try {
      const connected = await onConnectBrowser(wallet);
      if (connected) resetAndClose();
      else setStatus(t("walletModal.errors.REQUEST_FAILED"));
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
          : modalError(error),
      );
    } finally {
      setWorking(null);
    }
  }

  async function connectRecoveryWallet() {
    setWorking("recovery-connect");
    setStatus(null);
    try {
      const wallet = await getDefaultInjectedWallet();
      const connected = await connectInjectedWallet(wallet);
      const session = { wallet, ...connected };
      setRecoveryWallet(session);
      setStatus(
        t("walletModal.recoveryWallet.connected", {
          wallet: wallet.name,
          address: shortAddress(connected.address),
        }),
      );
    } catch (error) {
      setRecoveryWallet(null);
      setStatus(modalError(error));
    } finally {
      setWorking(null);
    }
  }

  function disconnectRecoveryWallet() {
    setRecoveryWallet(null);
    setStatus(t("walletModal.recoveryWallet.disconnected"));
  }

  function matchingMetadata(method: "browser" | "phrase", address: Address) {
    return metadata.find(
      (entry) =>
        entry.method === method &&
        isAddressEqual(entry.recoveryAddress, address),
    );
  }

  async function configureBrowserBackup() {
    if (!createdSession || !recoveryWallet) return;
    setWorking("browser-backup");
    setStatus(null);
    try {
      const result = await registerBrowserRecovery({
        session: createdSession,
        provider: recoveryWallet.wallet.provider,
        recoveryAddress: recoveryWallet.address,
      });
      const next: PublicRecoveryMetadata = {
        method: "browser",
        recoveryAddress: recoveryWallet.address,
        walletName: recoveryWallet.wallet.name,
        walletAddress: result.walletAddress,
        registrationTransactionHash: result.transactionHash,
      };
      const updated = saveRecoveryMetadata(metadata, next);
      setMetadata(updated);
      setBrowserBackupComplete(true);
      setStatus(t("walletModal.backup.browserComplete"));
    } catch (error) {
      setStatus(modalError(error));
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

  async function copyRecoveryPhrase() {
    if (!mnemonic) return;
    try {
      await navigator.clipboard.writeText(mnemonic);
      setPhraseCopied(true);
      setStatus(t("recovery.phrase.copyWarning"));
    } catch {
      setStatus(t("recovery.phrase.copyFailed"));
    }
  }

  function updateConfirmation(index: number, value: string) {
    const normalized = value.replace(/\s+/g, "").toLowerCase();
    setConfirmation((current) =>
      current.map((word, itemIndex) =>
        itemIndex === index ? normalized : word,
      ),
    );
  }

  function pasteConfirmation(value: string) {
    const words = value.trim().toLowerCase().split(/\s+/).slice(0, 3);
    if (words.length !== 3) return;
    setConfirmation(words);
  }

  async function configurePhraseBackup() {
    if (!createdSession || !mnemonicAccount) return;
    const confirmationMatches = confirmation.every(
      (word, index) =>
        word.trim().toLowerCase() === expectedConfirmation[index],
    );
    if (!confirmationMatches) {
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
      const updated = saveRecoveryMetadata(metadata, next);
      setMetadata(updated);
      setPhraseBackupComplete(true);
      setStatus(t("walletModal.backup.phraseComplete"));
      clearMnemonic();
    } catch (error) {
      setStatus(modalError(error));
      clearMnemonic();
    } finally {
      setWorking(null);
    }
  }

  async function recoverWithBrowser() {
    if (!recoveryWallet) return;
    setWorking("browser-recover");
    setStatus(null);
    try {
      const registered = matchingMetadata("browser", recoveryWallet.address);
      if (recoveryWallet.chainId !== arcTestnet.id) {
        await switchProviderChain(recoveryWallet.wallet.provider, arcTestnet.id, {
          chainName: arcTestnet.name,
          nativeCurrency: arcTestnet.nativeCurrency,
          rpcUrls: [...arcTestnet.rpcUrls.default.http],
          blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
        });
        setRecoveryWallet((current) =>
          current ? { ...current, chainId: arcTestnet.id } : current,
        );
      }
      const owner = await browserWalletToRecoveryAccount({
        provider: recoveryWallet.wallet.provider,
        address: recoveryWallet.address,
      });
      const result = await recoverPasskeyWallet(
        owner,
        registered?.walletAddress,
        showRecoveryProgress,
      );
      if (
        registered &&
        !isAddressEqual(result.walletAddress, registered.walletAddress)
      ) {
        throw new Error("RECOVERED_WALLET_MISMATCH");
      }
      setPendingRecoveredSession(result.session);
      setRecoveryPhraseInput("");
      setStage("recovered");
      setStatus(null);
    } catch (error) {
      setStatus(modalError(error));
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
      const registered = matchingMetadata("phrase", owner.address);
      const result = await recoverPasskeyWallet(
        owner,
        registered?.walletAddress,
        showRecoveryProgress,
      );
      if (
        registered &&
        !isAddressEqual(result.walletAddress, registered.walletAddress)
      ) {
        throw new Error("RECOVERED_WALLET_MISMATCH");
      }
      setPendingRecoveredSession(result.session);
      setRecoveryPhraseInput("");
      setStage("recovered");
      setStatus(null);
    } catch (error) {
      setRecoveryPhraseInput("");
      setStatus(modalError(error));
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
                    : stage === "browser"
                      ? t("walletModal.browser.eyebrow")
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
                      : stage === "browser"
                        ? t("walletModal.browser.title")
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

        {stage === "browser" && (
          <div className="wallet-modal-body">
            {initialView !== "browser" && (
              <button
                className="wallet-modal-back"
                type="button"
                onClick={() => setStage("choose")}
                disabled={working !== null}
              >
                ← {t("walletModal.back")}
              </button>
            )}
            <p className="wallet-modal-lead">
              {t("walletModal.browser.description")}
            </p>
            {injectedWallets.length > 0 ? (
              <div className="wallet-picker">
                {injectedWallets.map((wallet) => (
                  <button
                    key={wallet.id}
                    type="button"
                    className="wallet-choice"
                    onClick={() => void connectBrowser(wallet)}
                    disabled={working !== null}
                  >
                    {wallet.icon ? (
                      <img src={wallet.icon} width="32" height="32" alt="" />
                    ) : (
                      <MethodIcon>◈</MethodIcon>
                    )}
                    <span>
                      <strong>{wallet.name}</strong>
                      <small>{wallet.rdns ?? t("walletModal.browser.injected")}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="feature-warning">
                {t("walletModal.browser.noneFound")}
              </p>
            )}
            {working === "browser-connect" && (
              <p className="wallet-modal-lead" role="status">
                {t("header.connecting")}
              </p>
            )}
          </div>
        )}

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
                onClick={() => {
                  setStatus(null);
                  setStage("browser");
                }}
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
                {browserBackupComplete && currentBrowserBackup ? (
                  <div className="recovery-wallet-connection complete">
                    <div>
                      <span>{t("walletModal.recoveryWallet.registeredSigner")}</span>
                      <strong>{currentBrowserBackup.walletName ?? t("recovery.method.browser")}</strong>
                      <code>{currentBrowserBackup.recoveryAddress}</code>
                    </div>
                    {recoveryWallet && (
                      <button
                        className="recovery-wallet-disconnect"
                        type="button"
                        onClick={disconnectRecoveryWallet}
                        disabled={working !== null}
                      >
                        {t("walletModal.recoveryWallet.disconnect")}
                      </button>
                    )}
                  </div>
                ) : recoveryWallet ? (
                  <>
                    <div className="recovery-wallet-connection">
                      {recoveryWallet.wallet.icon && (
                        <img
                          src={recoveryWallet.wallet.icon}
                          alt=""
                          width="36"
                          height="36"
                        />
                      )}
                      <div>
                        <span>{t("walletModal.recoveryWallet.connectedSigner")}</span>
                        <strong>{recoveryWallet.wallet.name}</strong>
                        <code>{recoveryWallet.address}</code>
                      </div>
                      <button
                        className="recovery-wallet-disconnect"
                        type="button"
                        onClick={disconnectRecoveryWallet}
                        disabled={working !== null}
                      >
                        {t("walletModal.recoveryWallet.disconnect")}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => void configureBrowserBackup()}
                      disabled={working !== null}
                    >
                      {working === "browser-backup"
                        ? t("walletModal.backup.registering")
                        : t("walletModal.backup.browserSignAction")}
                    </button>
                    <small className="recovery-session-note">
                      {t("walletModal.recoveryWallet.isolation")}
                    </small>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connectRecoveryWallet()}
                    disabled={working !== null}
                  >
                    {working === "recovery-connect"
                      ? t("header.connecting")
                      : t("walletModal.backup.browserConnectAction")}
                  </button>
                )}
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
                    <div className="mnemonic-toolbar">
                      <strong>{t("recovery.phrase.generatedTitle")}</strong>
                      <button
                        className="phrase-copy-button secondary-button"
                        type="button"
                        onClick={() => void copyRecoveryPhrase()}
                        disabled={working !== null}
                      >
                        <span aria-hidden="true">{phraseCopied ? "✓" : "⧉"}</span>
                        {phraseCopied
                          ? t("recovery.phrase.copied")
                          : t("recovery.phrase.copy")}
                      </button>
                    </div>
                    <ol className="mnemonic-words" aria-label={t("recovery.phrase.wordsAria")}>
                      {phraseWords.map((word, index) => (
                        <li key={index + "-" + word}>
                          <span>{index + 1}</span>{word}
                        </li>
                      ))}
                    </ol>
                    <p className="feature-warning">{t("recovery.phrase.storeOffline")}</p>
                    <fieldset className="mnemonic-confirmation">
                      <legend>{t("recovery.phrase.confirmTitle")}</legend>
                      <p>{t("recovery.phrase.confirmExample")}</p>
                      <div className="mnemonic-confirmation-fields">
                        {CONFIRMATION_INDEXES.map((wordIndex, inputIndex) => (
                          <label key={wordIndex}>
                            <span>
                              {t("recovery.phrase.confirmWordLabel", {
                                position: wordIndex + 1,
                              })}
                            </span>
                            <input
                              value={confirmation[inputIndex]}
                              autoCapitalize="none"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={t("recovery.phrase.confirmPlaceholder")}
                              aria-label={t("recovery.phrase.confirmWordAria", {
                                position: wordIndex + 1,
                              })}
                              onPaste={(event) => {
                                const pasted = event.clipboardData.getData("text");
                                if (pasted.trim().split(/\s+/).length === 3) {
                                  event.preventDefault();
                                  pasteConfirmation(pasted);
                                }
                              }}
                              onChange={(event) =>
                                updateConfirmation(inputIndex, event.target.value)
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <div className="feature-actions">
                      <button
                        type="button"
                        onClick={() => void configurePhraseBackup()}
                        disabled={working !== null || !confirmationComplete}
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
            {metadata.length > 0 && (
              <div className="registered-recovery-list">
                <span>{t("walletModal.recover.registered")}</span>
                {metadata.map((entry) => (
                  <div
                    className="registered-recovery"
                    key={entry.method + "-" + entry.walletAddress}
                  >
                    <strong>{t("recovery.method." + entry.method)}</strong>
                    <small>{shortAddress(entry.recoveryAddress)}</small>
                  </div>
                ))}
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
                {recoveryWallet ? (
                  <>
                    <div className="recovery-wallet-connection compact">
                      {recoveryWallet.wallet.icon && (
                        <img
                          src={recoveryWallet.wallet.icon}
                          alt=""
                          width="36"
                          height="36"
                        />
                      )}
                      <div>
                        <span>{t("walletModal.recoveryWallet.connectedSigner")}</span>
                        <strong>{recoveryWallet.wallet.name}</strong>
                        <code>{recoveryWallet.address}</code>
                      </div>
                      <button
                        className="recovery-wallet-disconnect"
                        type="button"
                        onClick={disconnectRecoveryWallet}
                        disabled={working !== null}
                      >
                        {t("walletModal.recoveryWallet.disconnect")}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => void recoverWithBrowser()}
                      disabled={working !== null}
                    >
                      {working === "browser-recover"
                        ? t("walletModal.recover.working")
                        : t("walletModal.recover.browserAction")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connectRecoveryWallet()}
                    disabled={working !== null}
                  >
                    {working === "recovery-connect"
                      ? t("header.connecting")
                      : t("walletModal.recover.browserConnectAction")}
                  </button>
                )}
              </article>
              <article className="recovery-choice">
                <MethodIcon>12</MethodIcon>
                <h3>{t("walletModal.recover.phraseTitle")}</h3>
                <p>{t("walletModal.recover.phraseHint")}</p>
                <label>
                  <span className="sr-only">{t("recovery.phrase.inputLabel")}</span>
                  <textarea
                    id="recovery-phrase-input"
                    aria-describedby="recovery-phrase-feedback"
                    value={recoveryPhraseInput}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("walletModal.recover.phrasePlaceholder")}
                    onChange={(event) => setRecoveryPhraseInput(event.target.value)}
                  />
                </label>
                <div
                  id="recovery-phrase-feedback"
                  className={
                    recoveryPhraseWordCount === 12 && !recoveryPhraseValid
                      ? "phrase-input-feedback invalid"
                      : "phrase-input-feedback"
                  }
                  aria-live="polite"
                >
                  <span>
                    {t("recovery.phrase.wordCount", {
                      count: recoveryPhraseWordCount,
                    })}
                  </span>
                  {recoveryPhraseWordCount === 12 && (
                    <span>
                      {t(recoveryPhraseValid ? "recovery.phrase.valid" : "recovery.phrase.invalid")}
                    </span>
                  )}
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void recoverWithPhrase()}
                  disabled={working !== null || !recoveryPhraseValid}
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
