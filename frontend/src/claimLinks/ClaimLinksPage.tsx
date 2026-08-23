import {
  useCallback,
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
  type Hex,
} from "viem";
import type { ArcNetworkConfig } from "../arc";
import type { PasskeyWalletSession } from "../circleWallet";
import { formatCount, formatEpochSeconds, formatUsdc } from "../formatters";
import {
  discardClaimLinkSecret,
  prepareClaimCapability,
  type ClaimLinkBootstrapResult,
  type ClaimLinkCapability,
} from "./bootstrap";
import {
  ClaimLinkPaymentStatus,
  isClaimLinkExpired,
  isFundedDraftPayment,
  readClaimLinkPayment,
  readSenderClaimLinks,
  type ClaimLinkPayment,
  type ClaimLinkPublicClient,
} from "./contract";
import { createClaimLinkDraft, type ClaimLinkDraft } from "./create";
import { registerClaimLinkNavigationGuard } from "./navigationGuard";
import { validateClaimLinkPayment } from "./preflight";
import { ClaimLinkError } from "./errors";
import {
  ClaimLinkWalletError,
  createBrowserClaimLinkWalletAdapter,
  createPasskeyClaimLinkWalletAdapter,
  type ClaimLinkWalletAdapter,
  type ClaimLinkWalletKind,
} from "./wallet";

const GAS_RESERVE = parseUnits("0.01", 18);
const MAX_SENDER_LINKS = 8;

type StatusMessage = {
  key: string;
  kind: "success" | "error" | "info";
};

type PublicOperationReference = Readonly<{
  transactionHash?: Hash;
  userOperationHash?: Hash;
}>;

type FundedDraft = {
  linkId: Hex;
  claimSigner: Address;
  amount: bigint;
  expiresAt: bigint;
  transactionHash?: Hash;
  userOperationHash?: Hash;
};

export type ClaimLinksPageProps = {
  mode: "manage" | "claim";
  account: Address | null;
  activeWalletKind: ClaimLinkWalletKind;
  passkeySession: PasskeyWalletSession | null;
  browserProvider: EIP1193Provider | null;
  network: ArcNetworkConfig;
  publicClient: ClaimLinkPublicClient;
  claimLinkBootstrap: ClaimLinkBootstrapResult;
  walletBalance: bigint | null;
  isCorrectNetwork: boolean;
  locale: string;
  onConnectWallet: (kind: ClaimLinkWalletKind) => void;
  onSwitchNetwork: () => void | Promise<void>;
  onRefreshBalance: () => void | Promise<void>;
};

function shortHex(value: string, start = 8, end = 6): string {
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function paymentStatusKey(payment: ClaimLinkPayment): string {
  if (
    payment.status === ClaimLinkPaymentStatus.Active &&
    isClaimLinkExpired(payment)
  ) {
    return "claimLinks.paymentStatus.expired";
  }
  switch (payment.status) {
    case ClaimLinkPaymentStatus.Active:
      return "claimLinks.paymentStatus.active";
    case ClaimLinkPaymentStatus.Claimed:
      return "claimLinks.paymentStatus.claimed";
    case ClaimLinkPaymentStatus.Refunded:
      return "claimLinks.paymentStatus.refunded";
    default:
      return "claimLinks.paymentStatus.unavailable";
  }
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

function WalletGate({
  account,
  activeWalletKind,
  isCorrectNetwork,
  onConnectWallet,
  onSwitchNetwork,
}: Pick<
  ClaimLinksPageProps,
  | "account"
  | "activeWalletKind"
  | "isCorrectNetwork"
  | "onConnectWallet"
  | "onSwitchNetwork"
>) {
  const { t } = useTranslation();
  if (!account) {
    return (
      <div className="claim-link-wallet-gate">
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
  if (!isCorrectNetwork) {
    return (
      <div className="claim-link-wallet-gate">
        <p>{t("claimLinks.wallet.wrongNetwork")}</p>
        <button type="button" onClick={() => void onSwitchNetwork()}>
          {t("claimLinks.wallet.switchNetwork")}
        </button>
      </div>
    );
  }
  return (
    <p className="claim-link-wallet-summary">
      {t("claimLinks.wallet.connectedAs", {
        wallet: t(`claimLinks.wallet.kind.${activeWalletKind}`),
        address: shortHex(account),
      })}
    </p>
  );
}

export default function ClaimLinksPage(props: ClaimLinksPageProps) {
  const { t } = useTranslation();
  const {
    mode,
    account,
    activeWalletKind,
    passkeySession,
    browserProvider,
    network,
    publicClient,
    claimLinkBootstrap,
    walletBalance,
    isCorrectNetwork,
    locale,
    onRefreshBalance,
  } = props;
  const contractAddress = network.claimLinkContractAddress;
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [amountInput, setAmountInput] = useState("1");
  const [isCreating, setIsCreating] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [fundedDraft, setFundedDraft] = useState<FundedDraft | null>(null);
  const [createOperationReference, setCreateOperationReference] =
    useState<PublicOperationReference | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [senderLinks, setSenderLinks] = useState<readonly ClaimLinkPayment[]>([]);
  const [senderLinkCount, setSenderLinkCount] = useState(0n);
  const [isLoadingSenderLinks, setIsLoadingSenderLinks] = useState(false);
  const [senderNextCursor, setSenderNextCursor] = useState<bigint | null>(null);
  const [isLoadingMoreSenderLinks, setIsLoadingMoreSenderLinks] =
    useState(false);
  const [senderLinksRefresh, setSenderLinksRefresh] = useState(0);
  const [refundingLinkId, setRefundingLinkId] = useState<Hex | null>(null);
  const [refundReceipt, setRefundReceipt] = useState<
    (PublicOperationReference & { linkId: Hex }) | null
  >(null);

  const [claimPayment, setClaimPayment] = useState<ClaimLinkPayment | null>(null);
  const [isLoadingClaim, setIsLoadingClaim] = useState(false);
  const [claimReadRetry, setClaimReadRetry] = useState(0);
  const [canRetryClaimRead, setCanRetryClaimRead] = useState(false);
  const [isClaimCapabilityReady, setIsClaimCapabilityReady] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [claimReceipt, setClaimReceipt] = useState<PublicOperationReference | null>(null);
  const draftRef = useRef<{
    draft: ClaimLinkDraft;
    amount: bigint;
    sender: Address;
    chainId: number;
    contractAddress: Address;
  } | null>(null);
  const claimCapabilityRef = useRef<ClaimLinkCapability | null>(null);
  const contextRef = useRef<{
    key: string;
    browserProvider: EIP1193Provider | null;
    passkeySession: PasskeyWalletSession | null;
  }>({ key: "", browserProvider: null, passkeySession: null });
  const claimLifecycleRef = useRef(0);
  const draftLifecycleRef = useRef(0);
  const senderLoadSequenceRef = useRef(0);
  const claimLoadSequenceRef = useRef(0);

  const contextKey = `${network.key}:${network.chain.id}:${activeWalletKind}:${account ?? "disconnected"}`;
  contextRef.current = { key: contextKey, browserProvider, passkeySession };


  const walletAdapter = useMemo<ClaimLinkWalletAdapter | null>(() => {
    if (!account) return null;
    const expectedContext = contextKey;
    if (activeWalletKind === "passkey") {
      if (!passkeySession) return null;
      const isCurrent = () =>
        contextRef.current.key === expectedContext &&
        contextRef.current.passkeySession === passkeySession;
      return createPasskeyClaimLinkWalletAdapter({
        session: passkeySession,
        address: account,
        chain: network.chain,
        isCurrent,
      });
    }
    if (!browserProvider) return null;
    const isCurrent = () =>
      contextRef.current.key === expectedContext &&
      contextRef.current.browserProvider === browserProvider;
    return createBrowserClaimLinkWalletAdapter({
      provider: browserProvider,
      address: account,
      chain: network.chain,
      publicClient,
      isCurrent,
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
      const amount = parseUnits(amountInput, 18);
      return amount > 0n ? amount : null;
    } catch {
      return null;
    }
  }, [amountInput]);
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

  const refreshSenderLinks = useCallback(() => {
    setSenderLinksRefresh((value) => value + 1);
  }, []);

  useEffect(() => {
    if (mode !== "manage" || !account || !contractAddress) {
      setSenderLinks([]);
      setSenderLinkCount(0n);
      setSenderNextCursor(null);
      setIsLoadingSenderLinks(false);
      setIsLoadingMoreSenderLinks(false);
      return;
    }
    const sequence = ++senderLoadSequenceRef.current;
    setSenderLinks([]);
    setSenderLinkCount(0n);
    setSenderNextCursor(null);
    setIsLoadingSenderLinks(true);
    setIsLoadingMoreSenderLinks(false);
    void readSenderClaimLinks({
      publicClient,
      contractAddress,
      sender: account,
      limit: MAX_SENDER_LINKS,
    })
      .then((result) => {
        if (senderLoadSequenceRef.current !== sequence) return;
        setSenderLinks(result.payments);
        setSenderLinkCount(result.totalCount);
        setSenderNextCursor(result.nextCursor);
      })
      .catch(() => {
        if (senderLoadSequenceRef.current !== sequence) return;
        setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
      })
      .finally(() => {
        if (senderLoadSequenceRef.current === sequence) {
          setIsLoadingSenderLinks(false);
        }
      });
    return () => {
      senderLoadSequenceRef.current += 1;
    };
  }, [account, contractAddress, mode, publicClient, senderLinksRefresh]);

  const loadMoreSenderLinks = async () => {
    if (
      !account ||
      !contractAddress ||
      senderNextCursor === null ||
      isLoadingMoreSenderLinks
    ) {
      return;
    }
    const cursor = senderNextCursor;
    const sequence = senderLoadSequenceRef.current;
    setIsLoadingMoreSenderLinks(true);
    try {
      const result = await readSenderClaimLinks({
        publicClient,
        contractAddress,
        sender: account,
        limit: MAX_SENDER_LINKS,
        cursor,
      });
      if (senderLoadSequenceRef.current !== sequence) return;
      setSenderLinks((current) => {
        const known = new Set(current.map(({ linkId }) => linkId));
        return [
          ...current,
          ...result.payments.filter(({ linkId }) => !known.has(linkId)),
        ];
      });
      setSenderLinkCount(result.totalCount);
      setSenderNextCursor(result.nextCursor);
    } catch {
      if (senderLoadSequenceRef.current !== sequence) return;
      setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
    } finally {
      if (senderLoadSequenceRef.current === sequence) {
        setIsLoadingMoreSenderLinks(false);
      }
    }
  };
  useEffect(() => {
    const lifecycle = ++draftLifecycleRef.current;
    return () => {
      // StrictMode immediately mounts again and advances the lifecycle before
      // this timer runs. A real unmount has no replacement and releases the key.
      window.setTimeout(() => {
        if (draftLifecycleRef.current !== lifecycle) return;
        draftRef.current?.draft.discard();
        draftRef.current = null;
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (mode === "manage") return;
    draftRef.current?.draft.discard();
    draftRef.current = null;
    setFundedDraft(null);
    setCreateOperationReference(null);
    setLinkCopied(false);
  }, [mode]);

  const hasUnsafeCreateSecret =
    !linkCopied && Boolean(fundedDraft || createOperationReference);

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

  const claimLinkId =
    claimLinkBootstrap.status === "ready" ||
    claimLinkBootstrap.status === "missing-secret"
      ? claimLinkBootstrap.linkId
      : null;

  useEffect(() => {
    const lifecycle = ++claimLifecycleRef.current;
    if (mode !== "claim") {
      claimCapabilityRef.current?.discard();
      claimCapabilityRef.current = null;
      discardClaimLinkSecret();
      setIsClaimCapabilityReady(false);
      return;
    }

    const discardOnRouteLeave = () => {
      if (!window.location.hash.startsWith("#/claim/v1/")) {
        claimCapabilityRef.current?.discard();
        claimCapabilityRef.current = null;
        discardClaimLinkSecret();
      }
    };
    window.addEventListener("hashchange", discardOnRouteLeave);
    window.addEventListener("pagehide", discardClaimLinkSecret);
    return () => {
      window.removeEventListener("hashchange", discardOnRouteLeave);
      window.removeEventListener("pagehide", discardClaimLinkSecret);
      window.setTimeout(() => {
        if (claimLifecycleRef.current !== lifecycle) return;
        claimCapabilityRef.current?.discard();
        claimCapabilityRef.current = null;
        discardClaimLinkSecret();
      }, 0);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== "claim") return;
    setClaimPayment(null);
    setIsClaimCapabilityReady(false);
    setCanRetryClaimRead(false);
    setClaimReceipt(null);

    if (
      claimCapabilityRef.current &&
      claimCapabilityRef.current.linkId !== claimLinkId
    ) {
      claimCapabilityRef.current.discard();
      claimCapabilityRef.current = null;
    }

    if (!contractAddress) {
      setStatus({ key: "claimLinks.errors.notDeployed", kind: "error" });
      return;
    }
    if (!claimLinkId) {
      const key =
        claimLinkBootstrap.status === "unsafe-url"
          ? "claimLinks.errors.unsafeUrl"
          : "claimLinks.errors.invalidLink";
      setStatus({ key, kind: "error" });
      discardClaimLinkSecret();
      return;
    }
    if (claimLinkBootstrap.status === "missing-secret") {
      setStatus({ key: "claimLinks.errors.missingSecret", kind: "error" });
    } else {
      setStatus(null);
    }

    const sequence = ++claimLoadSequenceRef.current;
    setIsLoadingClaim(true);
    void readClaimLinkPayment({ publicClient, contractAddress, linkId: claimLinkId })
      .then(async (payment) => {
        if (claimLoadSequenceRef.current !== sequence) return;
        setClaimPayment(payment);
        if (claimLinkBootstrap.status !== "ready") return;

        const validation = validateClaimLinkPayment(claimLinkBootstrap, payment);
        if (validation === "terminal") {
          claimCapabilityRef.current?.discard();
          claimCapabilityRef.current = null;
          discardClaimLinkSecret();
          setStatus({
            key: "claimLinks.errors.noLongerClaimable",
            kind: "error",
          });
          return;
        }
        if (validation === "invalid") {
          claimCapabilityRef.current?.discard();
          claimCapabilityRef.current = null;
          discardClaimLinkSecret();
          setStatus({ key: "claimLinks.errors.invalidLink", kind: "error" });
          return;
        }

        const existingCapability = claimCapabilityRef.current;
        if (
          existingCapability?.linkId === payment.linkId &&
          isAddressEqual(existingCapability.claimSigner, payment.claimSigner)
        ) {
          setIsClaimCapabilityReady(true);
          return;
        }
        const capability = await prepareClaimCapability(payment.claimSigner);
        if (claimLoadSequenceRef.current !== sequence) {
          // StrictMode may have started a replacement load for the same key.
          return;
        }
        if (claimCapabilityRef.current) return;
        claimCapabilityRef.current = capability;
        setIsClaimCapabilityReady(true);
      })
      .catch((error) => {
        if (claimLoadSequenceRef.current !== sequence) return;
        const isCapabilityError = error instanceof ClaimLinkError;
        setCanRetryClaimRead(!isCapabilityError);
        setStatus(
          isCapabilityError
            ? publicErrorMessage(error)
            : { key: "claimLinks.errors.readFailed", kind: "error" },
        );
      })
      .finally(() => {
        if (claimLoadSequenceRef.current === sequence) {
          setIsLoadingClaim(false);
        }
      });
    return () => {
      claimLoadSequenceRef.current += 1;
    };
  }, [
    claimLinkBootstrap,
    claimLinkId,
    claimReadRetry,
    contractAddress,
    mode,
    publicClient,
  ]);

  useEffect(() => {
    if (
      mode !== "claim" ||
      !claimPayment ||
      claimPayment.status !== ClaimLinkPaymentStatus.Active ||
      isClaimLinkExpired(claimPayment)
    ) {
      return;
    }
    const remainingSeconds =
      claimPayment.expiresAt - claimPayment.observedBlockTimestamp;
    const delay = Math.min(
      2_147_000_000,
      Math.max(1_000, Number(remainingSeconds) * 1_000),
    );
    const timer = window.setTimeout(() => {
      // The timer only schedules a refresh; the refreshed block timestamp is
      // authoritative for expiry and capability disposal.
      setClaimReadRetry((value) => value + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [claimPayment, mode]);

  const readFundingPayment = useCallback(
    async (draft: ClaimLinkDraft): Promise<ClaimLinkPayment> => {
      if (!contractAddress) {
        throw new Error("CLAIM_LINK_NOT_CONFIGURED");
      }
      return readClaimLinkPayment({
        publicClient,
        contractAddress,
        linkId: draft.linkId,
      });
    },
    [contractAddress, publicClient],
  );

  const createLink = async () => {
    if (
      !account ||
      !contractAddress ||
      !walletAdapter ||
      !isCorrectNetwork ||
      parsedAmount === null ||
      amountExceedsBalance ||
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
          sender: getAddress(account),
          chainId: network.chain.id,
          contractAddress,
        };
        draftRef.current = pending;
      }

      if (wasRetry) {
        let observedPayment: ClaimLinkPayment;
        try {
          observedPayment = await readFundingPayment(pending.draft);
        } catch {
          setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
          return;
        }
        if (
          isFundedDraftPayment({
            payment: observedPayment,
            sender: pending.sender,
            claimSigner: pending.draft.claimSigner,
            amount: pending.amount,
          })
        ) {
          setFundedDraft({
            linkId: pending.draft.linkId,
            claimSigner: pending.draft.claimSigner,
            amount: pending.amount,
            expiresAt: observedPayment.expiresAt,
            transactionHash: operationReference?.transactionHash,
            userOperationHash: operationReference?.userOperationHash,
          });
          setStatus({ key: "claimLinks.status.created", kind: "success" });
          refreshSenderLinks();
          await onRefreshBalance();
          return;
        }
        if (observedPayment.status !== ClaimLinkPaymentStatus.Unset) {
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
      });
      operationReference = receipt;
      setCreateOperationReference(receipt);

      const payment = await readFundingPayment(pending.draft);
      if (
        !isFundedDraftPayment({
          payment,
          sender: pending.sender,
          claimSigner: pending.draft.claimSigner,
          amount: pending.amount,
        })
      ) {
        throw new Error("CLAIM_LINK_FUNDING_NOT_CONFIRMED");
      }
      setFundedDraft({
        linkId: pending.draft.linkId,
        claimSigner: pending.draft.claimSigner,
        amount: pending.amount,
        expiresAt: payment.expiresAt,
        ...receipt,
      });
      setStatus({ key: "claimLinks.status.created", kind: "success" });
      refreshSenderLinks();
      await onRefreshBalance();
    } catch (error) {
      const errorReference = publicOperationReference(error);
      if (errorReference) {
        operationReference = errorReference;
        setCreateOperationReference(errorReference);
      }

      if (pending) {
        let payment: ClaimLinkPayment;
        try {
          payment = await readFundingPayment(pending.draft);
        } catch {
          setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
          return;
        }
        if (
          isFundedDraftPayment({
            payment,
            sender: pending.sender,
            claimSigner: pending.draft.claimSigner,
            amount: pending.amount,
          })
        ) {
          setFundedDraft({
            linkId: pending.draft.linkId,
            claimSigner: pending.draft.claimSigner,
            amount: pending.amount,
            expiresAt: payment.expiresAt,
            transactionHash: operationReference?.transactionHash,
            userOperationHash: operationReference?.userOperationHash,
          });
          setStatus({ key: "claimLinks.status.created", kind: "success" });
          refreshSenderLinks();
          await onRefreshBalance();
          return;
        }
        if (payment.status !== ClaimLinkPaymentStatus.Unset) {
          setStatus({
            key: "claimLinks.errors.draftUnavailable",
            kind: "error",
          });
          return;
        }
      }
      setStatus(publicErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  };

  const copyFundedLink = async () => {
    const pending = draftRef.current;
    if (!pending || !fundedDraft) return;
    setIsCopying(true);
    try {
      if (!navigator.clipboard) throw new ClaimLinkError("copy_failed");
      await pending.draft.copyLink(
        `${window.location.origin}${window.location.pathname}`,
        navigator.clipboard,
      );
      setLinkCopied(true);
      setStatus({ key: "claimLinks.status.copied", kind: "success" });
    } catch (error) {
      setStatus(publicErrorMessage(error));
    } finally {
      setIsCopying(false);
    }
  };

  const startAnotherLink = () => {
    if (!linkCopied) return;
    draftRef.current?.draft.discard();
    draftRef.current = null;
    setFundedDraft(null);
    setCreateOperationReference(null);
    setLinkCopied(false);
    setStatus(null);
  };

  const reconcilePayment = useCallback(
    async (linkId: Hex): Promise<ClaimLinkPayment | null> => {
      if (!contractAddress) return null;
      try {
        return await readClaimLinkPayment({
          publicClient,
          contractAddress,
          linkId,
        });
      } catch {
        return null;
      }
    },
    [contractAddress, publicClient],
  );

  const refundLink = async (payment: ClaimLinkPayment) => {
    if (
      !contractAddress ||
      !walletAdapter ||
      !account ||
      !isCorrectNetwork ||
      payment.status !== ClaimLinkPaymentStatus.Active ||
      !isClaimLinkExpired(payment) ||
      !isAddressEqual(payment.sender, account)
    ) {
      return;
    }

    setRefundingLinkId(payment.linkId);
    setStatus({ key: "claimLinks.status.refunding", kind: "info" });

    let latestPayment: ClaimLinkPayment;
    try {
      latestPayment = await readClaimLinkPayment({
        publicClient,
        contractAddress,
        linkId: payment.linkId,
      });
    } catch {
      setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
      setRefundingLinkId(null);
      return;
    }

    if (
      latestPayment.status !== ClaimLinkPaymentStatus.Active ||
      !isClaimLinkExpired(latestPayment) ||
      !isAddressEqual(latestPayment.sender, account)
    ) {
      if (claimPayment?.linkId === payment.linkId) {
        setClaimPayment(latestPayment);
      }
      setStatus({
        key: "claimLinks.errors.noLongerClaimable",
        kind: "error",
      });
      setRefundingLinkId(null);
      refreshSenderLinks();
      return;
    }
    if (claimPayment?.linkId === payment.linkId) {
      setClaimPayment(latestPayment);
    }

    try {
      const receipt = await walletAdapter.refund({
        contractAddress,
        linkId: payment.linkId,
      });
      setRefundReceipt({ linkId: payment.linkId, ...receipt });
      const reconciled = await reconcilePayment(payment.linkId);
      if (reconciled?.status !== ClaimLinkPaymentStatus.Refunded) {
        throw new Error("CLAIM_LINK_REFUND_NOT_CONFIRMED");
      }
      if (claimPayment?.linkId === payment.linkId) setClaimPayment(reconciled);
      setStatus({ key: "claimLinks.status.refunded", kind: "success" });
      refreshSenderLinks();
      await onRefreshBalance();
    } catch (error) {
      const reference = publicOperationReference(error);
      if (reference) {
        setRefundReceipt({ linkId: payment.linkId, ...reference });
      }
      const reconciled = await reconcilePayment(payment.linkId);
      if (reconciled?.status === ClaimLinkPaymentStatus.Refunded) {
        if (claimPayment?.linkId === payment.linkId) setClaimPayment(reconciled);
        setStatus({ key: "claimLinks.status.refunded", kind: "success" });
        refreshSenderLinks();
        await onRefreshBalance();
      } else {
        setStatus(publicErrorMessage(error));
      }
    } finally {
      setRefundingLinkId(null);
    }
  };

  const claimLink = async () => {
    const readyBootstrap = claimLinkBootstrap;
    if (
      !account ||
      !contractAddress ||
      !walletAdapter ||
      !claimPayment ||
      !isCorrectNetwork ||
      readyBootstrap.status !== "ready" ||
      claimPayment.status !== ClaimLinkPaymentStatus.Active ||
      isClaimLinkExpired(claimPayment)
    ) {
      return;
    }

    setIsClaiming(true);
    setStatus({ key: "claimLinks.status.claiming", kind: "info" });
    const expectedSession = walletAdapter.sessionKey;
    let paymentForAttempt = claimPayment;
    const discardCapability = () => {
      claimCapabilityRef.current?.discard();
      claimCapabilityRef.current = null;
      discardClaimLinkSecret();
      setIsClaimCapabilityReady(false);
    };

    try {
      let latestPayment: ClaimLinkPayment;
      try {
        latestPayment = await readClaimLinkPayment({
          publicClient,
          contractAddress,
          linkId: claimPayment.linkId,
        });
      } catch {
        setStatus({ key: "claimLinks.errors.readFailed", kind: "error" });
        return;
      }
      paymentForAttempt = latestPayment;
      setClaimPayment(latestPayment);

      const validation = validateClaimLinkPayment(
        readyBootstrap,
        latestPayment,
      );
      if (validation !== "claimable") {
        discardCapability();
        setStatus({
          key:
            validation === "terminal"
              ? "claimLinks.errors.noLongerClaimable"
              : "claimLinks.errors.invalidLink",
          kind: "error",
        });
        return;
      }

      const capability = claimCapabilityRef.current;
      if (!capability) throw new ClaimLinkError("missing_secret");
      const signature = await capability.signClaim({
        recipient: getAddress(account),
        chainId: network.chain.id,
        verifyingContract: contractAddress,
      });
      if (walletAdapter.sessionKey !== expectedSession) {
        throw new ClaimLinkWalletError("wallet_context_changed");
      }
      const receipt = await walletAdapter.claim({
        contractAddress,
        linkId: latestPayment.linkId,
        signature,
      });
      setClaimReceipt(receipt);

      const reconciled = await reconcilePayment(latestPayment.linkId);
      if (reconciled?.status !== ClaimLinkPaymentStatus.Claimed) {
        throw new Error("CLAIM_LINK_CLAIM_NOT_CONFIRMED");
      }
      setClaimPayment(reconciled);
      discardCapability();
      setStatus({ key: "claimLinks.status.claimed", kind: "success" });
      await onRefreshBalance();
    } catch (error) {
      const reference = publicOperationReference(error);
      if (reference) setClaimReceipt(reference);

      const reconciled = await reconcilePayment(paymentForAttempt.linkId);
      if (reconciled?.status === ClaimLinkPaymentStatus.Claimed) {
        setClaimPayment(reconciled);
        discardCapability();
        setStatus({ key: "claimLinks.status.claimed", kind: "success" });
        await onRefreshBalance();
      } else if (
        reconciled &&
        (reconciled.status !== ClaimLinkPaymentStatus.Active ||
          isClaimLinkExpired(reconciled))
      ) {
        setClaimPayment(reconciled);
        discardCapability();
        setStatus({ key: "claimLinks.errors.noLongerClaimable", kind: "error" });
      } else {
        // Active or unreadable state is retryable, so retain the capability.
        setStatus(publicErrorMessage(error));
      }
    } finally {
      setIsClaiming(false);
    }
  };

  if (!contractAddress) {
    return (
      <section className="product-page claim-links-page" aria-labelledby="claim-links-title">
        <div className="product-hero claim-links-hero">
          <div className="product-hero-copy">
            <span className="section-label">{t("claimLinks.common.eyebrow")}</span>
            <h1 id="claim-links-title">
              {t(mode === "claim" ? "claimLinks.claim.title" : "claimLinks.manage.title")}
            </h1>
            <p>{t("claimLinks.errors.notDeployed")}</p>
          </div>
        </div>
      </section>
    );
  }

  if (mode === "claim") {
    const isActive = claimPayment?.status === ClaimLinkPaymentStatus.Active;
    const expired = claimPayment ? isClaimLinkExpired(claimPayment) : false;
    const browserHasGas =
      activeWalletKind === "passkey" ||
      walletBalance === null ||
      walletBalance >= GAS_RESERVE;
    const canClaim = Boolean(
      account &&
        walletAdapter &&
        isCorrectNetwork &&
        claimPayment &&
        isActive &&
        !expired &&
        isClaimCapabilityReady &&
        browserHasGas &&
        !isClaiming,
    );
    const canRefund = Boolean(
      account &&
        claimPayment &&
        isActive &&
        expired &&
        isAddressEqual(claimPayment.sender, account) &&
        walletAdapter &&
        isCorrectNetwork,
    );

    return (
      <section className="product-page claim-links-page" aria-labelledby="claim-link-claim-title">
        <div className="product-hero claim-links-hero">
          <div className="product-hero-copy">
            <span className="section-label">{t("claimLinks.claim.eyebrow")}</span>
            <h1 id="claim-link-claim-title">{t("claimLinks.claim.title")}</h1>
            <p>{t("claimLinks.claim.description")}</p>
          </div>
        </div>

        <div className="claim-link-cash-warning" role="note">
          <strong>{t("claimLinks.common.cashWarningTitle")}</strong>
          <p>{t("claimLinks.common.cashWarning")}</p>
        </div>

        <article className="claim-link-card" aria-busy={isLoadingClaim || isClaiming}>
          {isLoadingClaim ? (
            <p>{t("claimLinks.common.loading")}</p>
          ) : claimPayment && claimPayment.status !== ClaimLinkPaymentStatus.Unset ? (
            <>
              <div className="claim-link-amount-block">
                <span>{t("claimLinks.claim.amountLabel")}</span>
                <strong>{formatUsdc(claimPayment.amount, locale)} USDC</strong>
                <span className={`claim-link-status status-${claimPayment.status}`}>
                  {t(paymentStatusKey(claimPayment))}
                </span>
              </div>
              <dl className="claim-link-details">
                <div>
                  <dt>{t("claimLinks.common.sender")}</dt>
                  <dd title={claimPayment.sender}>{shortHex(claimPayment.sender)}</dd>
                </div>
                <div>
                  <dt>{t("claimLinks.common.expires")}</dt>
                  <dd>{formatEpochSeconds(claimPayment.expiresAt, locale)}</dd>
                </div>
                <div>
                  <dt>{t("claimLinks.common.linkId")}</dt>
                  <dd title={claimPayment.linkId}>{shortHex(claimPayment.linkId)}</dd>
                </div>
              </dl>

              {isActive && !expired && (
                <>
                  <WalletGate {...props} />
                  {activeWalletKind === "browser" && (
                    <p className="claim-link-gas-note">
                      {t("claimLinks.claim.browserGasNotice")}
                    </p>
                  )}
                  <button
                    className="claim-link-primary-action"
                    type="button"
                    disabled={!canClaim}
                    onClick={() => void claimLink()}
                  >
                    {t(isClaiming ? "claimLinks.claim.claiming" : "claimLinks.claim.claimButton")}
                  </button>
                </>
              )}

              {canRefund && (
                <button
                  className="claim-link-primary-action"
                  type="button"
                  disabled={refundingLinkId === claimPayment.linkId}
                  onClick={() => void refundLink(claimPayment)}
                >
                  {t("claimLinks.manage.refundButton")}
                </button>
              )}
              {claimReceipt && (
                <TransactionLinks network={network} receipt={claimReceipt} />
              )}
              {refundReceipt?.linkId === claimPayment.linkId && (
                <TransactionLinks network={network} receipt={refundReceipt} />
              )}
            </>
          ) : canRetryClaimRead ? (
            <div className="claim-link-retry">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setClaimReadRetry((value) => value + 1)}
              >
                {t("common.retry")}
              </button>
            </div>
          ) : (
            <p>{t("claimLinks.errors.invalidPayment")}</p>
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
        </article>
      </section>
    );
  }

  const canCreate = Boolean(
    account &&
      walletAdapter &&
      isCorrectNetwork &&
      parsedAmount !== null &&
      !amountExceedsBalance &&
      !isCreating &&
      !fundedDraft,
  );

  return (
    <section className="product-page claim-links-page" aria-labelledby="claim-links-title">
      <div className="product-hero claim-links-hero">
        <div className="product-hero-copy">
          <span className="section-label">{t("claimLinks.manage.eyebrow")}</span>
          <h1 id="claim-links-title">{t("claimLinks.manage.title")}</h1>
          <p>{t("claimLinks.manage.description")}</p>
        </div>
      </div>

      <div className="claim-link-cash-warning" role="note">
        <strong>{t("claimLinks.common.cashWarningTitle")}</strong>
        <p>{t("claimLinks.common.cashWarning")}</p>
      </div>

      <div className="claim-link-grid">
        <article className="claim-link-card" aria-labelledby="claim-link-create-title">
          <h2 id="claim-link-create-title">{t("claimLinks.manage.createTitle")}</h2>
          <p>{t("claimLinks.manage.fixedExpiry")}</p>
          <WalletGate {...props} />
          <label className="claim-link-amount-field">
            <span>{t("claimLinks.manage.amountLabel")}</span>
            <span className="claim-link-input-wrap">
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amountInput}
                disabled={Boolean(draftRef.current) || isCreating}
                aria-invalid={parsedAmount === null || amountExceedsBalance}
                onChange={(event) => setAmountInput(event.target.value)}
              />
              <span>USDC</span>
            </span>
          </label>
          {account && walletBalance !== null && (
            <p className="claim-link-balance">
              {t("claimLinks.manage.spendableBalance", {
                amount: formatUsdc(spendableBalance, locale),
              })}
            </p>
          )}
          {amountExceedsBalance && (
            <p className="claim-link-field-error" role="alert">
              {t("claimLinks.errors.insufficientBalance")}
            </p>
          )}

          {!fundedDraft ? (
            <button
              className="claim-link-primary-action"
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
          ) : (
            <div className="claim-link-funded-result">
              <strong>{t("claimLinks.manage.readyToCopy")}</strong>
              <p>{t("claimLinks.manage.leaveWarning")}</p>
              <dl className="claim-link-details">
                <div>
                  <dt>{t("claimLinks.common.amount")}</dt>
                  <dd>{formatUsdc(fundedDraft.amount, locale)} USDC</dd>
                </div>
                <div>
                  <dt>{t("claimLinks.common.expires")}</dt>
                  <dd>{formatEpochSeconds(fundedDraft.expiresAt, locale)}</dd>
                </div>
                <div>
                  <dt>{t("claimLinks.common.linkId")}</dt>
                  <dd title={fundedDraft.linkId}>{shortHex(fundedDraft.linkId)}</dd>
                </div>
              </dl>
              <button
                className="claim-link-primary-action"
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
                className="secondary-button"
                type="button"
                disabled={!linkCopied}
                onClick={startAnotherLink}
              >
                {t("claimLinks.manage.createAnother")}
              </button>
              {(fundedDraft.transactionHash || fundedDraft.userOperationHash) && (
                <TransactionLinks
                  network={network}
                  receipt={{
                    transactionHash: fundedDraft.transactionHash,
                    userOperationHash: fundedDraft.userOperationHash,
                  }}
                />
              )}
            </div>
          )}
          {!fundedDraft && createOperationReference && (
            <div className="claim-link-pending-operation" role="note">
              <p>{t("claimLinks.manage.pendingLeaveWarning")}</p>
              <TransactionLinks
                network={network}
                receipt={createOperationReference}
              />
            </div>
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
        </article>

        <article className="claim-link-card" aria-labelledby="claim-link-history-title">
          <div className="claim-link-card-heading">
            <div>
              <h2 id="claim-link-history-title">{t("claimLinks.manage.historyTitle")}</h2>
              <p>
                {t("claimLinks.manage.historyCount", {
                  count: formatCount(senderLinkCount, locale),
                })}
              </p>
            </div>
            <button
              className="claim-link-refresh-button secondary-button"
              type="button"
              disabled={!account || isLoadingSenderLinks}
              onClick={refreshSenderLinks}
              aria-label={t("claimLinks.manage.refreshHistory")}
            >
              {t("claimLinks.manage.refresh")}
            </button>
          </div>
          {!account ? (
            <p>{t("claimLinks.manage.connectForHistory")}</p>
          ) : isLoadingSenderLinks ? (
            <p>{t("claimLinks.common.loading")}</p>
          ) : senderLinks.length === 0 ? (
            <p>{t("claimLinks.manage.emptyHistory")}</p>
          ) : (
            <>
              <ol
                id="claim-link-history-list"
                className="claim-link-history-list"
                aria-busy={isLoadingMoreSenderLinks}
              >
                {senderLinks.map((payment) => {
                  const refundable =
                    payment.status === ClaimLinkPaymentStatus.Active &&
                    isClaimLinkExpired(payment);
                  return (
                    <li key={payment.linkId}>
                      <div className="claim-link-history-main">
                        <strong>{formatUsdc(payment.amount, locale)} USDC</strong>
                        <span>{t(paymentStatusKey(payment))}</span>
                      </div>
                      <div className="claim-link-history-meta">
                        <span title={payment.linkId}>
                          {shortHex(payment.linkId)}
                        </span>
                        <span>
                          {formatEpochSeconds(payment.expiresAt, locale)}
                        </span>
                      </div>
                      {refundable && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={
                            !walletAdapter ||
                            !isCorrectNetwork ||
                            refundingLinkId === payment.linkId
                          }
                          onClick={() => void refundLink(payment)}
                        >
                          {t(
                            refundingLinkId === payment.linkId
                              ? "claimLinks.manage.refundingButton"
                              : "claimLinks.manage.refundButton",
                          )}
                        </button>
                      )}
                      {refundReceipt?.linkId === payment.linkId && (
                        <TransactionLinks
                          network={network}
                          receipt={refundReceipt}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
              {senderNextCursor !== null && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={isLoadingMoreSenderLinks}
                  aria-controls="claim-link-history-list"
                  onClick={() => void loadMoreSenderLinks()}
                >
                  {t("claimLinks.manage.showMore", {
                    count: formatCount(
                      senderNextCursor < BigInt(MAX_SENDER_LINKS)
                        ? senderNextCursor
                        : BigInt(MAX_SENDER_LINKS),
                      locale,
                    ),
                  })}
                </button>
              )}
            </>
          )}
        </article>
      </div>
    </section>
  );
}
