import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Passkey wallet reload persistence", () => {
  const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const walletSource = readFileSync(
    new URL("./circleWallet.ts", import.meta.url),
    "utf8",
  );
  const persistenceSource = readFileSync(
    new URL("./passkeyPersistence.ts", import.meta.url),
    "utf8",
  );

  it("restores a saved passkey before falling back to browser-wallet discovery", () => {
    const passkeyRestore = appSource.indexOf("readSavedPasskeyWallet()");
    const browserRestore = appSource.indexOf("readSavedBrowserWallet()");

    expect(passkeyRestore).toBeGreaterThan(-1);
    expect(browserRestore).toBeGreaterThan(-1);
    expect(passkeyRestore).toBeLessThan(browserRestore);
    expect(appSource).toContain(
      "restorePasskeyWallet(savedPasskey.credential)",
    );
  });

  it("stores only public WebAuthn credential metadata", () => {
    expect(persistenceSource).toContain("id: string");
    expect(persistenceSource).toContain("publicKey: Hex");
    expect(persistenceSource).toContain("rpId?: string");
    expect(persistenceSource).not.toMatch(/privateKey|mnemonic|seed/i);
    expect(walletSource).toContain(
      "savePasskeyWallet(session.address, credentialMetadata)",
    );
  });

  it("clears the saved passkey on explicit disconnect or browser-wallet switch", () => {
    expect(appSource.match(/clearSavedPasskeyWallet\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
