import {
  createPublicClient,
  http,
  type Hex,
} from "viem";
import { arcTestnetConfig } from "../arc";
import {
  discardClaimLinkSecret,
  prepareClaimCapability,
  type ClaimLinkBootstrapResult,
} from "./bootstrap";
import {
  ClaimLinkPaymentStatus,
  isClaimLinkExpired,
  readClaimLinkPayment,
  type ClaimLinkPayment,
} from "./contract";
import { claimLinkId } from "./crypto";

export type ClaimLinkPreflightDependencies = {
  readPayment: (linkId: Hex) => Promise<ClaimLinkPayment>;
};

export type ClaimLinkPaymentValidation =
  | "claimable"
  | "terminal"
  | "invalid";

export function validateClaimLinkPayment(
  result: Extract<ClaimLinkBootstrapResult, { status: "ready" }>,
  payment: ClaimLinkPayment,
): ClaimLinkPaymentValidation {
  if (
    payment.status !== ClaimLinkPaymentStatus.Active ||
    isClaimLinkExpired(payment)
  ) {
    return "terminal";
  }
  try {
    return claimLinkId(payment.sender, payment.claimSigner) === result.linkId
      ? "claimable"
      : "invalid";
  } catch {
    return "invalid";
  }
}

async function readConfiguredPayment(linkId: Hex): Promise<ClaimLinkPayment> {
  const contractAddress = arcTestnetConfig.claimLinkContractAddress;
  if (!contractAddress) throw new Error("CLAIM_LINK_NOT_CONFIGURED");
  const publicClient = createPublicClient({
    chain: arcTestnetConfig.chain,
    transport: http(arcTestnetConfig.browserRpcUrl, { retryCount: 0 }),
  });
  return readClaimLinkPayment({
    publicClient,
    contractAddress,
    linkId,
  });
}

/**
 * Runs after synchronous URL scrubbing and before any React/i18n/UI import.
 * Read failures are retryable and retain the capability; a proven mismatch or
 * terminal payment releases it before optional application modules load.
 */
export async function preflightClaimLink(
  result: ClaimLinkBootstrapResult,
  dependencies?: ClaimLinkPreflightDependencies,
): Promise<ClaimLinkBootstrapResult> {
  if (result.status !== "ready") return result;

  if (
    !dependencies &&
    arcTestnetConfig.claimLinkContractAddress === null
  ) {
    discardClaimLinkSecret();
    return result;
  }

  let payment: ClaimLinkPayment;
  try {
    payment = await (dependencies?.readPayment ?? readConfiguredPayment)(
      result.linkId,
    );
  } catch {
    // The URL is already safe. Keep the in-memory secret so the claim screen
    // can retry the same bounded read without asking the user for another link.
    return result;
  }

  const validation = validateClaimLinkPayment(result, payment);
  if (validation === "terminal") {
    discardClaimLinkSecret();
    return result;
  }
  if (validation === "invalid") {
    discardClaimLinkSecret();
    return { status: "invalid-link" };
  }

  try {
    // This derives the signer from the closure-held key and verifies it against
    // the onchain signer. The returned facade contains no private key and is
    // intentionally not passed into React; the claim screen obtains a fresh
    // facade from the same already-verified module closure.
    await prepareClaimCapability(payment.claimSigner);
    return result;
  } catch {
    discardClaimLinkSecret();
    return { status: "invalid-link" };
  }
}
