import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("recovery secret handling", () => {
  const source = ["./WalletFeatures.tsx", "./WalletModal.tsx"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");

  it("copies the in-memory mnemonic only from its explicit copy handler", () => {
    expect(source.match(/navigator\.clipboard\.writeText\(mnemonic\)/g)).toHaveLength(1);
    expect(source).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(source).not.toMatch(
      /URLSearchParams[^;]*(?:mnemonic|phrase|credential)/i,
    );
    expect(source).not.toMatch(
      /(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:mnemonic|phrase|credential|privateKey|seed)/i,
    );
  });

  it("persists only the documented public recovery metadata", () => {
    expect(source).toContain(
      "window.localStorage.setItem(RECOVERY_METADATA_KEY, JSON.stringify(next))",
    );
    expect(source).toContain(
      'const RECOVERY_METADATA_KEY = "arc-tip-jar-recovery-metadata"',
    );
  });
});
