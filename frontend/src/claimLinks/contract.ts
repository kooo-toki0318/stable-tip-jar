import {
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const claimLinkEscrowAbi = [
  {
    type: "function",
    name: "createClaimLink",
    stateMutability: "payable",
    inputs: [{ name: "claimSigner", type: "address" }],
    outputs: [{ name: "linkId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "linkId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getPayment",
    stateMutability: "view",
    inputs: [{ name: "linkId", type: "bytes32" }],
    outputs: [
      {
        name: "payment",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "claimSigner", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "senderLinkCount",
    stateMutability: "view",
    inputs: [{ name: "sender", type: "address" }],
    outputs: [{ name: "count", type: "uint256" }],
  },
  {
    type: "function",
    name: "senderLinkAt",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "linkId", type: "bytes32" }],
  },
] as const;

export enum ClaimLinkPaymentStatus {
  Unset = 0,
  Active = 1,
  Claimed = 2,
  Refunded = 3,
}

export type ClaimLinkPayment = Readonly<{
  linkId: Hex;
  sender: Address;
  claimSigner: Address;
  amount: bigint;
  expiresAt: bigint;
  status: ClaimLinkPaymentStatus;
  observedBlockNumber: bigint;
  observedBlockTimestamp: bigint;
}>;

export type ClaimLinkPublicClient = Pick<
  PublicClient,
  "getBlock" | "readContract" | "waitForTransactionReceipt"
>;

export type ClaimLinkBlockSnapshot = Readonly<{
  number: bigint;
  timestamp: bigint;
}>;

type DecodedPayment = {
  sender: Address;
  claimSigner: Address;
  amount: bigint;
  expiresAt: bigint;
  status: number;
};

function isPaymentStatus(value: number): value is ClaimLinkPaymentStatus {
  return (
    value === ClaimLinkPaymentStatus.Unset ||
    value === ClaimLinkPaymentStatus.Active ||
    value === ClaimLinkPaymentStatus.Claimed ||
    value === ClaimLinkPaymentStatus.Refunded
  );
}

export async function readLatestClaimLinkBlock(
  publicClient: ClaimLinkPublicClient,
): Promise<ClaimLinkBlockSnapshot> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  if (block.number === null) throw new Error("CLAIM_LINK_BLOCK_UNAVAILABLE");
  return Object.freeze({ number: block.number, timestamp: block.timestamp });
}

export async function readClaimLinkPayment(args: {
  publicClient: ClaimLinkPublicClient;
  contractAddress: Address;
  linkId: Hex;
  blockSnapshot?: ClaimLinkBlockSnapshot;
}): Promise<ClaimLinkPayment> {
  const blockSnapshot =
    args.blockSnapshot ?? (await readLatestClaimLinkBlock(args.publicClient));
  const decoded = (await args.publicClient.readContract({
    address: args.contractAddress,
    abi: claimLinkEscrowAbi,
    functionName: "getPayment",
    args: [args.linkId],
    blockNumber: blockSnapshot.number,
  })) as DecodedPayment;

  const status = Number(decoded.status);
  if (!isPaymentStatus(status)) throw new Error("CLAIM_LINK_INVALID_STATUS");

  return Object.freeze({
    linkId: args.linkId,
    sender: getAddress(decoded.sender),
    claimSigner: getAddress(decoded.claimSigner),
    amount: decoded.amount,
    expiresAt: decoded.expiresAt,
    status,
    observedBlockNumber: blockSnapshot.number,
    observedBlockTimestamp: blockSnapshot.timestamp,
  });
}

export type SenderClaimLinks = Readonly<{
  totalCount: bigint;
  payments: readonly ClaimLinkPayment[];
  nextCursor: bigint | null;
  blockSnapshot: ClaimLinkBlockSnapshot;
}>;

/** Reads one bounded newest-first page; a cursor reaches every older sender entry. */
export async function readSenderClaimLinks(args: {
  publicClient: ClaimLinkPublicClient;
  contractAddress: Address;
  sender: Address;
  limit?: number;
  cursor?: bigint;
}): Promise<SenderClaimLinks> {
  const limit = args.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new RangeError("CLAIM_LINK_INVALID_READ_LIMIT");
  }
  if (args.cursor !== undefined && args.cursor < 0n) {
    throw new RangeError("CLAIM_LINK_INVALID_CURSOR");
  }

  const blockSnapshot = await readLatestClaimLinkBlock(args.publicClient);
  const totalCount = (await args.publicClient.readContract({
    address: args.contractAddress,
    abi: claimLinkEscrowAbi,
    functionName: "senderLinkCount",
    args: [args.sender],
    blockNumber: blockSnapshot.number,
  })) as bigint;
  const pageEnd =
    args.cursor === undefined || args.cursor > totalCount
      ? totalCount
      : args.cursor;
  const visibleCount = Number(
    pageEnd < BigInt(limit) ? pageEnd : BigInt(limit),
  );
  const indexes = Array.from(
    { length: visibleCount },
    (_, offset) => pageEnd - 1n - BigInt(offset),
  );
  const linkIds = await Promise.all(
    indexes.map(
      (index) =>
        args.publicClient.readContract({
          address: args.contractAddress,
          abi: claimLinkEscrowAbi,
          functionName: "senderLinkAt",
          args: [args.sender, index],
          blockNumber: blockSnapshot.number,
        }) as Promise<Hex>,
    ),
  );
  const payments = await Promise.all(
    linkIds.map((linkId) =>
      readClaimLinkPayment({
        publicClient: args.publicClient,
        contractAddress: args.contractAddress,
        linkId,
        blockSnapshot,
      }),
    ),
  );

  const nextCursor = pageEnd - BigInt(visibleCount);
  return Object.freeze({
    totalCount,
    payments: Object.freeze(payments),
    nextCursor: nextCursor > 0n ? nextCursor : null,
    blockSnapshot,
  });
}

export function isClaimLinkExpiredAt(
  payment: ClaimLinkPayment,
  timestamp: bigint,
): boolean {
  return timestamp >= payment.expiresAt;
}

/** Security decisions use only the timestamp of the block that supplied state. */
export function isClaimLinkExpired(payment: ClaimLinkPayment): boolean {
  return isClaimLinkExpiredAt(payment, payment.observedBlockTimestamp);
}

export function isFundedDraftPayment(args: {
  payment: ClaimLinkPayment;
  sender: Address;
  claimSigner: Address;
  amount: bigint;
}): boolean {
  return (
    args.payment.status === ClaimLinkPaymentStatus.Active &&
    args.payment.sender.toLowerCase() === args.sender.toLowerCase() &&
    args.payment.claimSigner.toLowerCase() === args.claimSigner.toLowerCase() &&
    args.payment.amount === args.amount
  );
}
