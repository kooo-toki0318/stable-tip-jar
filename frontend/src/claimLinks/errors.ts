export type ClaimLinkErrorCode =
  | "missing_secret"
  | "invalid_secret"
  | "crypto_unavailable"
  | "invalid_claim_signer"
  | "signer_mismatch"
  | "invalid_request"
  | "signing_failed"
  | "inactive_session"
  | "invalid_sender"
  | "draft_unavailable"
  | "invalid_base_url"
  | "copy_failed";

const ERROR_MESSAGES: Record<ClaimLinkErrorCode, string> = {
  missing_secret: "The claim link secret is unavailable.",
  invalid_secret: "The claim link secret is invalid.",
  crypto_unavailable: "Claim link cryptography is unavailable.",
  invalid_claim_signer: "The payment claim signer is invalid.",
  signer_mismatch: "The claim link does not match this payment.",
  invalid_request: "The claim authorization request is invalid.",
  signing_failed: "The claim authorization could not be signed.",
  inactive_session: "The claim link session is no longer active.",
  invalid_sender: "The claim link sender is invalid.",
  draft_unavailable: "The claim link draft is no longer available.",
  invalid_base_url: "The claim link base URL is invalid.",
  copy_failed: "The claim link could not be copied.",
};

/**
 * A deliberately context-free error. Never add user input, URLs, or a cause to
 * this error: an upstream reporter may serialize it.
 */
export class ClaimLinkError extends Error {
  readonly code: ClaimLinkErrorCode;

  constructor(code: ClaimLinkErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ClaimLinkError";
    this.code = code;
  }
}
