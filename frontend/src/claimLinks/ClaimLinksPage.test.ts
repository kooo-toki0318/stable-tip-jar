import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Claim Links UI security boundaries", () => {
  const source = readFileSync(
    new URL("./ClaimLinksPage.tsx", import.meta.url),
    "utf8",
  );

  it("keeps wallet-specific execution and secrets outside React state", () => {
    expect(source).not.toContain("window.ethereum");
    expect(source).not.toMatch(/useState[^\n]*(?:privateKey|ClaimLinkDraft|ClaimLinkCapability)/);
    expect(source).toContain("draftRef = useRef");
    expect(source).toContain("claimCapabilityRef = useRef");
  });

  it("does not persist or report a capability", () => {
    expect(source).not.toMatch(/(?:localStorage|sessionStorage|indexedDB)/);
    expect(source).not.toMatch(/console\.(?:log|info|warn|error|debug)/);
  });

  it("warns for an unshared funded link and only copies in an explicit handler", () => {
    expect(source).toContain('addEventListener("beforeunload"');
    expect(source).toContain("const copyFundedLink = async () =>");
    expect(source.match(/navigator\.clipboard/g)).toHaveLength(2);
    expect(source).toContain("claimLinks.manage.leaveWarning");
  });

  it("offers an explicit bounded-read retry without reloading or discarding the capability", () => {
    expect(source).toContain("canRetryClaimRead");
    expect(source).toContain("setClaimReadRetry((value) => value + 1)");
    expect(source).toContain("validateClaimLinkPayment");
    expect(source).not.toContain("window.location.reload");
  });

  it("uses only observed chain time for expiry decisions and labels", () => {
    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("isClaimLinkExpiredAt");
    expect(source).toContain("isClaimLinkExpired(payment)");
    expect(source).toContain("observedBlockTimestamp");
  });

  it("keeps sender history bounded while exposing every older page", () => {
    expect(source).toContain("senderNextCursor");
    expect(source).toContain("cursor,");
    expect(source).toContain("claimLinks.manage.showMore");
    expect(source).toContain('aria-controls="claim-link-history-list"');
  });

  it("retains public operation hashes and checks pending funding before retrying create", () => {
    const retryStart = source.indexOf("if (wasRetry)");
    const fundingCheck = source.indexOf(
      "readFundingPayment(pending.draft)",
      retryStart,
    );
    const submission = source.indexOf("walletAdapter.create", retryStart);

    expect(retryStart).toBeGreaterThan(-1);
    expect(fundingCheck).toBeGreaterThan(retryStart);
    expect(submission).toBeGreaterThan(fundingCheck);
    expect(source).toContain("createOperationReference");
    expect(source).toContain("hasUnsafeCreateSecret");
    expect(source).toContain(
      "Boolean(fundedDraft || createOperationReference)",
    );
    expect(source).toContain("registerClaimLinkNavigationGuard");
    expect(source).toContain("userOperationHash");
  });
});
