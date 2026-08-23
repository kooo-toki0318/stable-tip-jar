import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("embedded Claim Link sender security boundaries", () => {
  const source = readFileSync(
    new URL("./ClaimLinkSendPanel.tsx", import.meta.url),
    "utf8",
  );

  it("keeps the bearer secret out of React state and browser storage", () => {
    expect(source).toContain("draftRef = useRef");
    expect(source).not.toMatch(
      /useState[^\n]*(?:privateKey|ClaimLinkDraft)/,
    );
    expect(source).not.toMatch(
      /(?:localStorage|sessionStorage|indexedDB)/,
    );
  });

  it("warns while an unshared capability could be lost", () => {
    expect(source).toContain('addEventListener("beforeunload"');
    expect(source).toContain("registerClaimLinkNavigationGuard");
    expect(source).toContain("hasUnsafeCreateSecret");
  });

  it("submits and reconciles the exact shared onchain message", () => {
    expect(source).toContain("message: pending.message");
    expect(source).toContain("readClaimLinkMessage");
    expect(source).toContain("storedMessage === pending.message");
  });

  it("only copies the complete bearer link from an explicit handler", () => {
    expect(source).toContain("const copyFundedLink = async () =>");
    expect(source).toContain("navigator.clipboard");
  });
});
