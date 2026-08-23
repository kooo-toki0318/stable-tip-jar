import type { Address, Hex } from "viem";
import { ClaimLinkError } from "./errors";

export type ClaimLinkClipboard = Pick<Clipboard, "writeText">;

export type ClaimLinkDraft = Readonly<{
  sender: Address;
  claimSigner: Address;
  linkId: Hex;
  copyLink: (baseUrl: string, clipboard: ClaimLinkClipboard) => Promise<void>;
  discard: () => void;
}>;

function completeClaimLink(
  baseUrl: string,
  linkId: Hex,
  privateKey: Hex,
): string {
  const url = new URL(baseUrl);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("invalid base URL");
  }
  url.search = "";
  url.hash = `/claim/v1/${linkId}?k=${privateKey}`;
  return url.toString();
}

/**
 * Creates one in-memory draft. The secret and complete URL are intentionally
 * absent from the returned object and are only used by the explicit copyLink
 * action.
 */
export async function createClaimLinkDraft(
  sender: Address,
): Promise<ClaimLinkDraft> {
  let crypto: typeof import("./crypto");
  try {
    crypto = await import("./crypto");
  } catch {
    throw new ClaimLinkError("crypto_unavailable");
  }

  let normalizedSender: Address;
  try {
    normalizedSender = crypto.normalizeClaimAddress(sender);
  } catch {
    throw new ClaimLinkError("invalid_sender");
  }

  let privateKey: Hex | undefined = crypto.generateClaimPrivateKey();
  const claimSigner = crypto.claimSignerFromPrivateKey(privateKey);
  const linkId = crypto.claimLinkId(normalizedSender, claimSigner);

  return Object.freeze({
    sender: normalizedSender,
    claimSigner,
    linkId,
    async copyLink(
      baseUrl: string,
      clipboard: ClaimLinkClipboard,
    ): Promise<void> {
      const activePrivateKey = privateKey;
      if (!activePrivateKey) throw new ClaimLinkError("draft_unavailable");

      let claimLink: string;
      try {
        claimLink = completeClaimLink(baseUrl, linkId, activePrivateKey);
      } catch {
        throw new ClaimLinkError("invalid_base_url");
      }

      try {
        await clipboard.writeText(claimLink);
      } catch {
        throw new ClaimLinkError("copy_failed");
      }
    },
    discard(): void {
      privateKey = undefined;
    },
  });
}
