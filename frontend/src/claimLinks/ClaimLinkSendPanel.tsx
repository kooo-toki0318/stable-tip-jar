import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  getAddress,
  isAddressEqual,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
} from "viem";
import type { ArcNetworkConfig } from "../arc";
import type { PasskeyWalletSession } from "../circleWallet";
import { formatEpochSeconds, formatUsdc } from "../formatters";
import {
  CLAIM_LINK_MAX_MESSAGE_BYTES,
  ClaimLinkPaymentStatus,
  isFundedDraftPayment,
  readClaimLinkMessage,
  readClaimLinkPayment,
  type ClaimLinkPayment,
  type ClaimLinkPublicClient,
} from "./contract";
import { createClaimLinkDraft, type ClaimLinkDraft } from "./create";
import { ClaimLinkError } from "./errors";
import { registerClaimLinkNavigationGuard } from "./navigationGuard";
import {
  ClaimLinkWalletError,
  createBrowserClaimLinkWalletAdapter,
  createPasskeyClaimLinkWalletAdapter,
  type ClaimLinkWalletAdapter,
  type ClaimLinkWalletKind,
} from "./wallet";

const GAS_RESERVE = parseUnits("0.01", 18);

type StatusMessage = {
  key: string;
  kind: "success" | "error" | "info";
};

type PublicOperationReference = Readonly<{
  transactionHash?: Hash;
  userOperationHash?: Hash;
}>;

type PendingDraft = {
  draft: ClaimLinkDraft;
  amount: bigint;
  message: string;
  sender: Address;
  chainId: number;
  contractAddress: Address;
};

type FundedDraft = {
  linkId: `0x${string}`;
  amount: bigint;
  message: string;
  expiresAt: bigint;
  transactionHash?: Hash;
  userOperationHash?: Hash;
};

export type ClaimLinkSendPanelProps = {
  account: Address | null;
  activeWalletKind: ClaimLinkWalletKind;
  passkeySession: PasskeyWalletSession | null;
  browserProvider: EIP1193Provider | null;
  network: ArcNetworkConfig;
  publicClient: ClaimLinkPublicClient;
  walletBalance: bigint | null;
  isCorrectNetwork: boolean;
  locale: string;
  amountInput: string;
  message: string;
  onConnectWallet: (kind: ClaimLinkWalletKind) => void;
  onSwitchNetwork: () => void | Promise<void>;
  onRefreshBalance: () => void | Promise<void>;
  onLockedChange?: (locked: boolean) => void;
};

function shortHex(value: string, start = 8, end = 6): string {
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function publicErrorMessage(error: unknown): StatusMessage {
  if (error instanceof ClaimLinkWalletError) {
    const keys = {
      wallet_context_changed: "claimLinks.errors.walletContextChanged",
      wallet_request_rejected: "claimLinks.errors.walletRejected",
      transaction_failed: "claimLinks.errors.transactionFailed",
      receipt_uncertain: "claimLinks.errors.receiptUncertain",
    } as const;
    return { key: keys[error.code], kind: "error" };
  }
  if (error instanceof ClaimLinkError) {
    const keys = {
      missing_secret: "claimLinks.errors.missingSecret",
      invalid_secret: "claimLinks.errors.invalidSecret",
      crypto_unavailable: "claimLinks.errors.cryptoUnavailable",
      invalid_claim_signer: "claimLinks.errors.invalidPayment",
      signer_mismatch: "claimLinks.errors.signerMismatch",
      invalid_request: "claimLinks.errors.signingFailed",
      signing_failed: "claimLinks.errors.signingFailed",
      inactive_session: "claimLinks.errors.missingSecret",
      invalid_sender: "claimLinks.errors.walletContextChanged",
      draft_unavailable: "claimLinks.errors.draftUnavailable",
      invalid_base_url: "claimLinks.errors.copyFailed",
      copy_failed: "claimLinks.errors.copyFailed",
    } as const;
    return { key: keys[error.code], kind: "error" };
  }
  return { key: "claimLinks.errors.generic", kind: "error" };
}

function publicOperationReference(
  error: unknown,
): PublicOperationReference | null {
  if (!(error instanceof ClaimLinkWalletError)) return null;
  if (!error.transactionHash && !error.userOperationHash) return null;
  return {
    transactionHash: error.transactionHash,
    userOperationHash: error.userOperationHash,
  };
}

function TransactionLinks({
  network,
  receipt,
}: {
  network: ArcNetworkConfig;
  receipt: PublicOperationReference;
}) {
  const { t } = useTranslation();
  const explorer = network.chain.blockExplorers?.default.url;
  if (!receipt.transactionHash && !receipt.userOperationHash) return null;

  return (
    <span className="claim-link-transaction-links">
      {explorer && receipt.transactionHash && (
        <a
          href={`${explorer}/tx/${receipt.transactionHash}`}
          target="_blank"
          rel="noreferrer"
        >
          {t("claimLinks.common.viewTransaction")} ↗
        </a>
      )}
      {receipt.userOperationHash && (
        <span title={receipt.userOperationHash}>
          {t("claimLinks.common.userOperation", {
            hash: shortHex(receipt.userOperationHash),
          })}
        </span>
      )}
    </span>
  );
}

export default function ClaimLinkSendPanel({
  account,
  activeWalletKind,
  passkeySession,
  browserProvider,
  network,
  publicClient,
  walletBalance,
  isCorrectNetwork,
  locale,
  amountInput,
  message,
  onConnectWallet,
  onSwitchNetwork,
  onRefreshBalance,
  onLockedChange,
}: ClaimLinkSendPanelProps) {
  const { t } = useTranslation();
  const contractAddress = network.claimLinkContractAddress;
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [isCopyingShare, setIsCopyingShare] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [fundedDraft, setFundedDraft] = useState<FundedDraft | null>(null);
  const [createOperationReference, setCreateOperationReference] =
    useState<PublicOperationReference | null>(null);

  const draftRef = useRef<PendingDraft | null>(null);
  const lifecycleRef = useRef(0);
  const contextRef = useRef<{
    key: string;
    browserProvider: EIP1193Provider | null;
    passkeySession: PasskeyWalletSession | null;
  }>({ key: "", browserProvider: null, passkeySession: null });

  const contextKey = `${network.key}:${network.chain.id}:${activeWalletKind}:${account ?? "disconnected"}`;
  contextRef.current = { key: contextKey, browserProvider, passkeySession };

  const walletAdapter = useMemo<ClaimLinkWalletAdapter | null>(() => {
    if (!account) return null;
    const expectedContext = contextKey;

    if (activeWalletKind === "passkey") {
      if (!passkeySession) return null;
      return createPasskeyClaimLinkWalletAdapter({
        session: passkeySession,
        address: account,
        chain: network.chain,
        isCurrent: () =>
          contextRef.current.key === expectedContext &&
          contextRef.current.passkeySession === passkeySession,
      });
    }

    if (!browserProvider) return null;
    return createBrowserClaimLinkWalletAdapter({
      provider: browserProvider,
      address: account,
      chain: network.chain,
      publicClient,
      isCurrent: () =>
        contextRef.current.key === expectedContext &&
        contextRef.current.browserProvider === browserProvider,
    });
  }, [
    account,
    activeWalletKind,
    browserProvider,
    contextKey,
    network.chain,
    passkeySession,
    publicClient,
  ]);

  const parsedAmount = useMemo(() => {
    try {
      const parsed = parseUnits(amountInput, 18);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [amountInput]);

  const messageBytes = useMemo(
    () => new TextEncoder().encode(message).length,
    [message],
  );

  const spendableBalance =
    activeWalletKind === "passkey"
      ? (walletBalance ?? 0n)
      : walletBalance !== null && walletBalance > GAS_RESERVE
        ? walletBalance - GAS_RESERVE
        : 0n;

  const amountExceedsBalance =
    parsedAmount !== null &&
    walletBalance !== null &&
    parsedAmount > spendableBalance;

  const linkSaved = linkCopied || shareCopied;
  const hasUnsafeCreateSecret =
    !linkSaved &&
    Boolean(draftRef.current || fundedDraft || createOperationReference);

  const inputLocked = isCreating || hasUnsafeCreateSecret;

  useEffect(() => {
    onLockedChange?.(inputLocked);
    return () => onLockedChange?.(false);
  }, [inputLocked, onLockedChange]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    return () => {
      window.setTimeout(() => {
        if (lifecycleRef.current !== lifecycle) return;
        draftRef.current?.draft.discard();
        draftRef.current = null;
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (!hasUnsafeCreateSecret) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [hasUnsafeCreateSecret]);

  useEffect(() => {
    if (!hasUnsafeCreateSecret) return;
    return registerClaimLinkNavigationGuard(() =>
      window.confirm(t("claimLinks.manage.leaveConfirm")),
    );
  }, [hasUnsafeCreateSecret, t]);

  const readFundingState = async (pending: PendingDraft) => {
    const payment = await readClaimLinkPayment({
      publicClient,
      contractAddress: pending.contractAddress,
      linkId: pending.draft.linkId,
    });
    const storedMessage = await readClaimLinkMessage({
      publicClient,
      contractAddress: pending.contractAddress,
      linkId: pending.draft.linkId,
      blockNumber: payment.observedBlockNumber,
    });
    return { payment, storedMessage };
  };

  const matchesPending = (
    pending: PendingDraft,
    payment: ClaimLinkPayment,
    storedMessage: string,
  ) =>
    isFundedDraftPayment({
      payment,
      sender: pending.sender,
      claimSigner: pending.draft.claimSigner,
      amount: pending.amount,
    }) && storedMessage === pending.message;

  const markFunded = async (
    pending: PendingDraft,
    payment: ClaimLinkPayment,
    receipt?: PublicOperationReference,
  ) => {
    setFundedDraft({
      linkId: pending.draft.linkId,
      amount: pending.amount,
      message: pending.message,
      expiresAt: payment.expiresAt,
      transactionHash: receipt?.transactionHash,
      userOperationHash: receipt?.userOperationHash,
    });
    setStatus({ key: "claimLinks.status.created", kind: "success" });
    await onRefreshBalance();
  };

  const createLink = async () => {
    if (
      !account ||
      !contractAddress ||
      !walletAdapter ||
      !isCorrectNetwork ||
      parsedAmount === null ||
      amountExceedsBalance ||
      messageBytes > CLAIM_LINK_MAX_MESSAGE_BYTES ||
      fundedDraft
    ) {
      return;
    }

    setIsCreating(true);
    setStatus({ key: "claimLinks.status.creating", kind: "info" });

    let pending = draftRef.current;
    const wasRetry = pending !== null;
    let operationReference = createOperationReference;

    try {
      if (!pending) {
        operationReference = null;
        setCreateOperationReference(null);
        pending = {
          draft: await createClaimLinkDraft(account),
          amount: parsedAmount,
          message,
          sender: getAddress(account),
          chainId: network.chain.id,
          contractAddress,
        };
        draftRef.current = pending;
      }

      if (wasRetry) {
        let observed: Awaited<ReturnType<typeof readFundingState>>;
        try {
          observed = await readFundingState(pending);
        } catch {
          setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
          return;
        }

        if (matchesPending(pending, observed.payment, observed.storedMessage)) {
          await markFunded(
            pending,
            observed.payment,
            operationReference ?? undefined,
          );
          return;
        }

        if (observed.payment.status !== ClaimLinkPaymentStatus.Unset) {
          setStatus({
            key: "claimLinks.errors.draftUnavailable",
            kind: "error",
          });
          return;
        }
      }

      if (
        !isAddressEqual(pending.sender, account) ||
        pending.chainId !== network.chain.id ||
        !isAddressEqual(pending.contractAddress, contractAddress)
      ) {
        throw new ClaimLinkWalletError("wallet_context_changed");
      }

      const receipt = await walletAdapter.create({
        contractAddress,
        claimSigner: pending.draft.claimSigner,
        value: pending.amount,
        message: pending.message,
      });
      operationReference = receipt;
      setCreateOperationReference(receipt);

      const observed = await readFundingState(pending);
      if (!matchesPending(pending, observed.payment, observed.storedMessage)) {
        throw new Error("CLAIM_LINK_FUNDING_NOT_CONFIRMED");
      }

      await markFunded(pending, observed.payment, receipt);
    } catch (error) {
      const errorReference = publicOperationReference(error);
      if (errorReference) {
        operationReference = errorReference;
        setCreateOperationReference(errorReference);
      }

      if (pending) {
        try {
          const observed = await readFundingState(pending);
          if (matchesPending(pending, observed.payment, observed.storedMessage)) {
            await markFunded(
              pending,
              observed.payment,
              operationReference ?? undefined,
            );
            return;
          }
          if (observed.payment.status !== ClaimLinkPaymentStatus.Unset) {
            setStatus({
              key: "claimLinks.errors.draftUnavailable",
              kind: "error",
            });
            return;
          }
        } catch {
          if (operationReference) {
            setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
            return;
          }
        }
      }

      setStatus(publicErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  };

  const resetUnsubmittedDraft = async () => {
    const pending = draftRef.current;
    if (!pending || fundedDraft || createOperationReference || isCreating) {
      return;
    }

    try {
      const observed = await readFundingState(pending);
      if (matchesPending(pending, observed.payment, observed.storedMessage)) {
        await markFunded(pending, observed.payment);
        return;
      }
      if (observed.payment.status !== ClaimLinkPaymentStatus.Unset) {
        setStatus({
          key: "claimLinks.errors.draftUnavailable",
          kind: "error",
        });
        return;
      }
      pending.draft.discard();
      draftRef.current = null;
      setStatus(null);
    } catch {
      setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
    }
  };

  const claimLinkBaseUrl = () =>
    `${window.location.origin}${window.location.pathname}`;

  const copyFundedLink = async () => {
    const pending = draftRef.current;
    if (!pending || !fundedDraft) return;

    setIsCopying(true);
    try {
      if (!navigator.clipboard) throw new ClaimLinkError("copy_failed");
      await navigator.clipboard.writeText(
        pending.draft.getLink(claimLinkBaseUrl()),
      );
      setLinkCopied(true);
      setStatus(null);
    } catch (error) {
      setStatus(publicErrorMessage(error));
    } finally {
      setIsCopying(false);
    }
  };

  const copyShareMessage = async () => {
    const pending = draftRef.current;
    if (!pending || !fundedDraft) return;

    setIsCopyingShare(true);
    try {
      if (!navigator.clipboard) throw new ClaimLinkError("copy_failed");
      const claimLink = pending.draft.getLink(claimLinkBaseUrl());
      const shareMessage = t("claimLinks.send.shareTemplate", {
        amount: formatUsdc(fundedDraft.amount, locale),
        expires: formatEpochSeconds(fundedDraft.expiresAt, locale),
        url: claimLink,
      });
      await navigator.clipboard.writeText(shareMessage);
      setShareCopied(true);
      setStatus(null);
    } catch (error) {
      setStatus(publicErrorMessage(error));
    } finally {
      setIsCopyingShare(false);
    }
  };

  const startAnotherLink = () => {
    if (!linkSaved && !window.confirm(t("claimLinks.manage.leaveConfirm"))) {
      return;
    }

    draftRef.current?.draft.discard();
    draftRef.current = null;
    setFundedDraft(null);
    setCreateOperationReference(null);
    setLinkCopied(false);
    setShareCopied(false);
    setStatus(null);
  };

  if (!account) {
    return (
      <div className="claim-link-inline-panel">
        <p>{t("claimLinks.wallet.connectDescription")}</p>
        <div className="claim-link-action-row">
          <button type="button" onClick={() => onConnectWallet("passkey")}>
            {t("claimLinks.wallet.connectPasskey")}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onConnectWallet("browser")}
          >
            {t("claimLinks.wallet.connectBrowser")}
          </button>
        </div>
      </div>
    );
  }

  if (!contractAddress) {
    return (
      <div className="claim-link-inline-panel">
        <p className="field-error" role="alert">
          {t("claimLinks.errors.notDeployed")}
        </p>
      </div>
    );
  }

  if (!isCorrectNetwork) {
    return (
      <div className="claim-link-inline-panel">
        <p>{t("claimLinks.wallet.wrongNetwork")}</p>
        <button type="button" onClick={() => void onSwitchNetwork()}>
          {t("claimLinks.wallet.switchNetwork")}
        </button>
      </div>
    );
  }

  const canCreate =
    Boolean(walletAdapter) &&
    parsedAmount !== null &&
    !amountExceedsBalance &&
    messageBytes <= CLAIM_LINK_MAX_MESSAGE_BYTES &&
    !isCreating &&
    !fundedDraft;

  let claimLinkUrl = "";
  if (fundedDraft && draftRef.current) {
    try {
      claimLinkUrl = draftRef.current.draft.getLink(claimLinkBaseUrl());
    } catch {
      claimLinkUrl = "";
    }
  }

  return (
    <div className="claim-link-inline-panel">
      <div className="claim-link-inline-intro">
        <strong>{t("send.modeLink")}</strong>
        <span>{t("claimLinks.manage.fixedExpiry")}</span>
      </div>

      <div className="claim-link-cash-warning compact" role="note">
        <strong>{t("claimLinks.common.cashWarningTitle")}</strong>
        <p>{t("claimLinks.common.cashWarning")}</p>
      </div>

      {messageBytes > CLAIM_LINK_MAX_MESSAGE_BYTES && (
        <p className="field-error" role="alert">
          {t("send.cta.shortenMessage")}
        </p>
      )}

      {amountExceedsBalance && (
        <p className="field-error" role="alert">
          {t("claimLinks.errors.insufficientBalance")}
        </p>
      )}

      {!fundedDraft ? (
        <>
          <button
            className="primary-button"
            type="button"
            disabled={!canCreate}
            onClick={() => void createLink()}
          >
            {t(
              isCreating
                ? "claimLinks.manage.creatingButton"
                : draftRef.current
                  ? "claimLinks.manage.retryCreateButton"
                  : "claimLinks.manage.createButton",
            )}
          </button>

          {draftRef.current && !createOperationReference && !isCreating && (
            <button
              className="secondary-button claim-link-reset-draft"
              type="button"
              onClick={() => void resetUnsubmittedDraft()}
            >
              {t("claimLinks.send.resetDraft")}
            </button>
          )}
        </>
      ) : (
        <div className="claim-link-funded-result">
          <strong>{t("claimLinks.manage.readyToCopy")}</strong>
          <p className="claim-link-save-warning">
            {t("claimLinks.send.recoveryWarning")}
          </p>

          {claimLinkUrl && (
            <div className="claim-link-url-block">
              <label htmlFor="claim-link-url">
                {t("claimLinks.send.urlLabel")}
              </label>
              <input
                id="claim-link-url"
                className="claim-link-url-input"
                type="text"
                readOnly
                value={claimLinkUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          )}

          <dl className="claim-link-details">
            <div>
              <dt>{t("claimLinks.common.amount")}</dt>
              <dd>{formatUsdc(fundedDraft.amount, locale)} USDC</dd>
            </div>
            <div>
              <dt>{t("claimLinks.common.expires")}</dt>
              <dd>{formatEpochSeconds(fundedDraft.expiresAt, locale)}</dd>
            </div>
          </dl>

          {fundedDraft.message && (
            <div className="claim-link-public-message">
              <span>{t("send.messageLabel")}</span>
              <p>{fundedDraft.message}</p>
            </div>
          )}

          <div className="claim-link-copy-actions">
            <button
              className="primary-button"
              type="button"
              disabled={isCopying}
              onClick={() => void copyFundedLink()}
            >
              {t(
                isCopying
                  ? "claimLinks.manage.copyingButton"
                  : linkCopied
                    ? "claimLinks.manage.copyAgainButton"
                    : "claimLinks.manage.copyButton",
              )}
            </button>

            <button
              className="primary-button"
              type="button"
              disabled={isCopyingShare}
              onClick={() => void copyShareMessage()}
            >
              {t(
                isCopyingShare
                  ? "claimLinks.send.shareCopyingButton"
                  : shareCopied
                    ? "claimLinks.send.shareCopiedButton"
                    : "claimLinks.send.shareButton",
              )}
            </button>
          </div>

          {linkSaved && (
            <p
              className="claim-link-copy-confirmation"
              role="status"
              aria-live="polite"
            >
              ✓{" "}
              {t(
                linkCopied && shareCopied
                  ? "claimLinks.send.bothCopied"
                  : shareCopied
                    ? "claimLinks.send.shareCopied"
                    : "claimLinks.send.linkCopied",
              )}
            </p>
          )}

          <button
            className="inline-action"
            type="button"
            onClick={startAnotherLink}
          >
            + {t("claimLinks.send.createAnotherCompact")}
          </button>
        </div>
      )}

      {createOperationReference && !fundedDraft && (
        <div className="claim-link-pending-operation" role="note">
          <p>{t("claimLinks.manage.pendingLeaveWarning")}</p>
          <TransactionLinks
            network={network}
            receipt={createOperationReference}
          />
        </div>
      )}

      {fundedDraft &&
        (fundedDraft.transactionHash || fundedDraft.userOperationHash) && (
          <TransactionLinks
            network={network}
            receipt={{
              transactionHash: fundedDraft.transactionHash,
              userOperationHash: fundedDraft.userOperationHash,
            }}
          />
        )}

      {status && (
        <p
          className={`claim-link-message is-${status.kind}`}
          role={status.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {t(status.key)}
        </p>
      )}

      <div className="claim-link-manage-footer">
        <a className="claim-link-manage-link" href="#/links">
          {t("claimLinks.send.manageLinks")} →
        </a>
        <p>{t("claimLinks.send.manageLinksHelp")}</p>
      </div>
    </div>
  );
}