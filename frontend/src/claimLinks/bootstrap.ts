import type { Address, Hex } from "viem";
import { ClaimLinkError } from "./errors";

const CLAIM_ROUTE_PREFIX = "#/claim/v1/";
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type ClaimLinkLocation = Pick<Location, "hash" | "pathname" | "search">;
type ClaimLinkHistory = Pick<History, "state" | "replaceState">;

type SecretRecord = {
  generation: number;
  linkId: Hex;
  privateKey: Hex;
  verifiedClaimSigner?: Address;
};

let generation = 0;
let activeSecret: SecretRecord | undefined;

export type ClaimLinkBootstrapResult =
  | { status: "not-claim-route" }
  | { status: "ready"; linkId: Hex }
  | { status: "missing-secret"; linkId: Hex }
  | { status: "invalid-link" }
  | { status: "unsafe-url" };

export type ClaimAuthorizationRequest = {
  recipient: Address;
  chainId: number;
  verifyingContract: Address;
};

export type ClaimLinkCapability = Readonly<{
  linkId: Hex;
  claimSigner: Address;
  signClaim: (request: ClaimAuthorizationRequest) => Promise<Hex>;
  discard: () => void;
}>;

type ParsedClaimHash =
  | { status: "not-claim-route" }
  | { status: "ready"; linkId: Hex; privateKey: Hex; safeHash: string }
  | { status: "missing-secret"; linkId: Hex }
  | { status: "invalid-link"; safeHash?: string };

function parseClaimHash(hash: string): ParsedClaimHash {
  if (!hash.startsWith(CLAIM_ROUTE_PREFIX)) {
    return { status: "not-claim-route" };
  }

  const queryIndex = hash.indexOf("?");
  const routeHash = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
  const rawLinkId = routeHash.slice(CLAIM_ROUTE_PREFIX.length);
  const validLinkId = BYTES32_PATTERN.test(rawLinkId);
  const safeHash = validLinkId
    ? `${CLAIM_ROUTE_PREFIX}${rawLinkId.toLowerCase()}`
    : "#/claim";

  if (queryIndex === -1) {
    if (!validLinkId) return { status: "invalid-link" };
    return {
      status: "missing-secret",
      linkId: rawLinkId.toLowerCase() as Hex,
    };
  }

  const rawQuery = hash.slice(queryIndex + 1);
  const privateKeyPrefix = "k=";
  if (
    !validLinkId ||
    !rawQuery.startsWith(privateKeyPrefix) ||
    rawQuery.indexOf("&") !== -1
  ) {
    return { status: "invalid-link", safeHash };
  }

  const rawPrivateKey = rawQuery.slice(privateKeyPrefix.length);
  if (!BYTES32_PATTERN.test(rawPrivateKey)) {
    return { status: "invalid-link", safeHash };
  }

  return {
    status: "ready",
    linkId: rawLinkId.toLowerCase() as Hex,
    privateKey: rawPrivateKey.toLowerCase() as Hex,
    safeHash,
  };
}

function discardGeneration(targetGeneration: number): void {
  if (activeSecret?.generation !== targetGeneration) return;
  activeSecret = undefined;
  generation += 1;
}

/**
 * This must run before React, i18n, viem, or any reporting integration starts.
 * Its return value contains only public routing data.
 */
export function bootstrapClaimLink(
  location: ClaimLinkLocation = window.location,
  history: ClaimLinkHistory = window.history,
): ClaimLinkBootstrapResult {
  discardClaimLinkSecret();
  const parsed = parseClaimHash(location.hash);

  if (parsed.status === "not-claim-route") return parsed;
  if (parsed.status === "missing-secret") return parsed;
  if (parsed.status === "invalid-link" && parsed.safeHash === undefined) {
    return parsed;
  }

  if (parsed.status === "ready") {
    generation += 1;
    activeSecret = {
      generation,
      linkId: parsed.linkId,
      privateKey: parsed.privateKey,
    };
  }

  const safeHash = parsed.safeHash;
  try {
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}${safeHash}`,
    );
  } catch {
    discardClaimLinkSecret();
    return { status: "unsafe-url" };
  }

  if (parsed.status === "invalid-link") return { status: "invalid-link" };
  return { status: "ready", linkId: parsed.linkId };
}

export function discardClaimLinkSecret(): void {
  activeSecret = undefined;
  generation += 1;
}

function secretForGeneration(targetGeneration: number): SecretRecord {
  const record = activeSecret;
  if (!record || record.generation !== targetGeneration) {
    throw new ClaimLinkError("inactive_session");
  }
  return record;
}

export async function prepareClaimCapability(
  onchainClaimSigner: Address,
): Promise<ClaimLinkCapability> {
  const initialRecord = activeSecret;
  if (!initialRecord) throw new ClaimLinkError("missing_secret");
  const targetGeneration = initialRecord.generation;

  let crypto: typeof import("./crypto");
  try {
    crypto = await import("./crypto");
  } catch {
    discardGeneration(targetGeneration);
    throw new ClaimLinkError("crypto_unavailable");
  }

  const currentRecord = secretForGeneration(targetGeneration);
  let claimSigner: Address;
  let normalizedOnchainSigner: Address;
  try {
    claimSigner = crypto.claimSignerFromPrivateKey(currentRecord.privateKey);
  } catch {
    discardGeneration(targetGeneration);
    throw new ClaimLinkError("invalid_secret");
  }
  try {
    normalizedOnchainSigner = crypto.normalizeClaimAddress(onchainClaimSigner);
  } catch {
    discardGeneration(targetGeneration);
    throw new ClaimLinkError("invalid_claim_signer");
  }

  if (claimSigner !== normalizedOnchainSigner) {
    discardGeneration(targetGeneration);
    throw new ClaimLinkError("signer_mismatch");
  }
  currentRecord.verifiedClaimSigner = claimSigner;

  const linkId = currentRecord.linkId;
  return Object.freeze({
    linkId,
    claimSigner,
    async signClaim(request: ClaimAuthorizationRequest): Promise<Hex> {
      const signingRecord = secretForGeneration(targetGeneration);
      if (signingRecord.verifiedClaimSigner !== claimSigner) {
        throw new ClaimLinkError("inactive_session");
      }

      let signature: Hex;
      try {
        signature = await crypto.signClaimAuthorization({
          privateKey: signingRecord.privateKey,
          linkId,
          recipient: request.recipient,
          chainId: request.chainId,
          verifyingContract: request.verifyingContract,
        });
      } catch {
        throw new ClaimLinkError("invalid_request");
      }

      secretForGeneration(targetGeneration);
      return signature;
    },
    discard(): void {
      discardGeneration(targetGeneration);
    },
  });
}
