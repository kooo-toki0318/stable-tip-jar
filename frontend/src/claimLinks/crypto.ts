import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const CLAIM_TYPES = {
  Claim: [
    { name: "linkId", type: "bytes32" },
    { name: "recipient", type: "address" },
  ],
} as const;

export function generateClaimPrivateKey(): Hex {
  return generatePrivateKey();
}

export function claimSignerFromPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

export function normalizeClaimAddress(address: Address): Address {
  if (!isAddress(address, { strict: true })) {
    throw new Error("invalid address");
  }
  return getAddress(address);
}

export function claimLinkId(sender: Address, claimSigner: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [normalizeClaimAddress(sender), normalizeClaimAddress(claimSigner)],
    ),
  );
}

export async function signClaimAuthorization({
  privateKey,
  linkId,
  recipient,
  chainId,
  verifyingContract,
}: {
  privateKey: Hex;
  linkId: Hex;
  recipient: Address;
  chainId: number;
  verifyingContract: Address;
}): Promise<Hex> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(linkId)) {
    throw new Error("invalid link id");
  }
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("invalid chain id");
  }

  const account = privateKeyToAccount(privateKey);
  return account.signTypedData({
    domain: {
      name: "ClaimLinkEscrow",
      version: "1",
      chainId,
      verifyingContract: normalizeClaimAddress(verifyingContract),
    },
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: {
      linkId,
      recipient: normalizeClaimAddress(recipient),
    },
  });
}
