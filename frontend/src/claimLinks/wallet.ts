import {
  createWalletClient,
  custom,
  getAddress,
  isAddressEqual,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hash,
  type Hex,
} from "viem";
import {
  PasskeyClaimLinkReceiptError,
  type PasskeyWalletSession,
} from "../circleWallet";
import { claimLinkEscrowAbi, type ClaimLinkPublicClient } from "./contract";

export type ClaimLinkWalletKind = "browser" | "passkey";

export type ClaimLinkOperationReceipt = Readonly<{
  transactionHash: Hash;
  userOperationHash?: Hash;
}>;

export type ClaimLinkWalletAdapter = Readonly<{
  kind: ClaimLinkWalletKind;
  address: Address;
  chainId: number;
  sessionKey: string;
  create: (args: {
    contractAddress: Address;
    claimSigner: Address;
    value: bigint;
    message?: string;
  }) => Promise<ClaimLinkOperationReceipt>;
  claim: (args: {
    contractAddress: Address;
    linkId: Hex;
    signature: Hex;
  }) => Promise<ClaimLinkOperationReceipt>;
  refund: (args: {
    contractAddress: Address;
    linkId: Hex;
  }) => Promise<ClaimLinkOperationReceipt>;
}>;

export type ClaimLinkWalletErrorCode =
  | "wallet_context_changed"
  | "wallet_request_rejected"
  | "transaction_failed"
  | "receipt_uncertain";

const WALLET_ERROR_MESSAGES: Record<ClaimLinkWalletErrorCode, string> = {
  wallet_context_changed: "The active wallet context changed.",
  wallet_request_rejected: "The wallet request was rejected.",
  transaction_failed: "The claim link transaction failed.",
  receipt_uncertain: "The claim link transaction receipt is uncertain.",
};

export class ClaimLinkWalletError extends Error {
  readonly code: ClaimLinkWalletErrorCode;
  readonly transactionHash?: Hash;
  readonly userOperationHash?: Hash;

  constructor(
    code: ClaimLinkWalletErrorCode,
    transactionHash?: Hash,
    userOperationHash?: Hash,
  ) {
    super(WALLET_ERROR_MESSAGES[code]);
    this.name = "ClaimLinkWalletError";
    this.code = code;
    this.transactionHash = transactionHash;
    this.userOperationHash = userOperationHash;
  }
}

function requestWasRejected(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Number((error as { code: unknown }).code) === 4001
  );
}

function submissionError(error: unknown): ClaimLinkWalletError {
  if (error instanceof ClaimLinkWalletError) return error;
  if (error instanceof PasskeyClaimLinkReceiptError) {
    return new ClaimLinkWalletError(
      "receipt_uncertain",
      undefined,
      error.userOperationHash,
    );
  }
  return new ClaimLinkWalletError(
    requestWasRejected(error)
      ? "wallet_request_rejected"
      : "transaction_failed",
  );
}

function providerChainId(value: unknown): number {
  const chainId =
    typeof value === "string"
      ? Number.parseInt(value, value.startsWith("0x") ? 16 : 10)
      : Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ClaimLinkWalletError("wallet_context_changed");
  }
  return chainId;
}

async function assertBrowserContext(args: {
  provider: EIP1193Provider;
  address: Address;
  chainId: number;
  isCurrent?: () => boolean;
}): Promise<void> {
  if (args.isCurrent && !args.isCurrent()) {
    throw new ClaimLinkWalletError("wallet_context_changed");
  }
  const [rawAccounts, rawChainId] = await Promise.all([
    args.provider.request({ method: "eth_accounts" }),
    args.provider.request({ method: "eth_chainId" }),
  ]);
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : [];
  const activeAddress = accounts[0];
  if (
    typeof activeAddress !== "string" ||
    !isAddressEqual(getAddress(activeAddress), args.address) ||
    providerChainId(rawChainId) !== args.chainId
  ) {
    throw new ClaimLinkWalletError("wallet_context_changed");
  }
}

async function waitForBrowserReceipt(args: {
  publicClient: ClaimLinkPublicClient;
  hash: Hash;
  isCurrent?: () => boolean;
}): Promise<ClaimLinkOperationReceipt> {
  let receipt: Awaited<
    ReturnType<ClaimLinkPublicClient["waitForTransactionReceipt"]>
  >;
  try {
    receipt = await args.publicClient.waitForTransactionReceipt({
      hash: args.hash,
    });
  } catch {
    throw new ClaimLinkWalletError("receipt_uncertain", args.hash);
  }
  if (receipt.status !== "success") {
    throw new ClaimLinkWalletError("transaction_failed", args.hash);
  }
  if (args.isCurrent && !args.isCurrent()) {
    throw new ClaimLinkWalletError("wallet_context_changed", args.hash);
  }
  return Object.freeze({ transactionHash: args.hash });
}

export function createBrowserClaimLinkWalletAdapter(args: {
  provider: EIP1193Provider;
  address: Address;
  chain: Chain;
  publicClient: ClaimLinkPublicClient;
  isCurrent?: () => boolean;
}): ClaimLinkWalletAdapter {
  const address = getAddress(args.address);
  const walletClient = createWalletClient({
    account: address,
    chain: args.chain,
    transport: custom(args.provider),
  });
  const context = {
    provider: args.provider,
    address,
    chainId: args.chain.id,
    isCurrent: args.isCurrent,
  };

  async function write(request: {
    contractAddress: Address;
    functionName: "createClaimLink" | "claim" | "refund";
    functionArgs:
      | readonly [Address]
      | readonly [Address, string]
      | readonly [Hex, Hex]
      | readonly [Hex];
    value?: bigint;
  }): Promise<ClaimLinkOperationReceipt> {
    await assertBrowserContext(context);
    let hash: Hash;
    try {
      const baseRequest = {
        address: request.contractAddress,
        abi: claimLinkEscrowAbi,
        account: address,
      } as const;
      if (request.functionName === "createClaimLink") {
        const createArgs = request.functionArgs as
          | readonly [Address]
          | readonly [Address, string];
        if (createArgs.length === 2) {
          hash = await walletClient.writeContract({
            ...baseRequest,
            functionName: "createClaimLink",
            args: [createArgs[0], createArgs[1]],
            value: request.value,
          });
        } else {
          hash = await walletClient.writeContract({
            ...baseRequest,
            functionName: "createClaimLink",
            args: [createArgs[0]],
            value: request.value,
          });
        }
      } else if (request.functionName === "claim") {
        hash = await walletClient.writeContract({
          ...baseRequest,
          functionName: "claim",
          args: request.functionArgs as readonly [Hex, Hex],
        });
      } else {
        hash = await walletClient.writeContract({
          ...baseRequest,
          functionName: "refund",
          args: request.functionArgs as readonly [Hex],
        });
      }
    } catch (error) {
      throw submissionError(error);
    }
    return waitForBrowserReceipt({
      publicClient: args.publicClient,
      hash,
      isCurrent: args.isCurrent,
    });
  }

  return Object.freeze({
    kind: "browser" as const,
    address,
    chainId: args.chain.id,
    sessionKey: `browser:${args.chain.id}:${address}`,
    create: ({ contractAddress, claimSigner, value, message }) =>
      write({
        contractAddress,
        functionName: "createClaimLink",
        functionArgs:
          message === undefined
            ? [claimSigner]
            : [claimSigner, message],
        value,
      }),
    claim: ({ contractAddress, linkId, signature }) =>
      write({
        contractAddress,
        functionName: "claim",
        functionArgs: [linkId, signature],
      }),
    refund: ({ contractAddress, linkId }) =>
      write({
        contractAddress,
        functionName: "refund",
        functionArgs: [linkId],
      }),
  });
}

export function createPasskeyClaimLinkWalletAdapter(args: {
  session: PasskeyWalletSession;
  address: Address;
  chain: Chain;
  isCurrent?: () => boolean;
}): ClaimLinkWalletAdapter {
  const address = getAddress(args.address);
  const assertContext = () => {
    if (
      !isAddressEqual(args.session.address, address) ||
      args.session.chainId !== args.chain.id ||
      (args.isCurrent && !args.isCurrent())
    ) {
      throw new ClaimLinkWalletError("wallet_context_changed");
    }
  };
  const run = async (
    operation: () => Promise<ClaimLinkOperationReceipt>,
  ): Promise<ClaimLinkOperationReceipt> => {
    assertContext();
    let receipt: ClaimLinkOperationReceipt;
    try {
      receipt = await operation();
    } catch (error) {
      throw submissionError(error);
    }
    if (args.isCurrent && !args.isCurrent()) {
      throw new ClaimLinkWalletError(
        "wallet_context_changed",
        receipt.transactionHash,
      );
    }
    return Object.freeze(receipt);
  };

  return Object.freeze({
    kind: "passkey" as const,
    address,
    chainId: args.chain.id,
    sessionKey: `passkey:${args.chain.id}:${address}`,
    create: ({ contractAddress, claimSigner, value, message }) =>
      run(() =>
        args.session.createClaimLink({
          contractAddress,
          claimSigner,
          value,
          ...(message === undefined ? {} : { message }),
        }),
      ),
    claim: ({ contractAddress, linkId, signature }) =>
      run(() => args.session.claimLink({ contractAddress, linkId, signature })),
    refund: ({ contractAddress, linkId }) =>
      run(() => args.session.refundClaimLink({ contractAddress, linkId })),
  });
}
