import { describe, expect, it } from "vitest";
import {
  createRecoveryMnemonic,
  getArcModularClientUrl,
  isValidRecoveryMnemonic,
  passkeyCredentialToOwner,
  recoveryAccountFromMnemonic,
  recoveryProofMessage,
  selectRecoveryWalletAddress,
} from "./circleWallet";

describe("Circle transport configuration", () => {
  it("converts a Circle credential into a Viem WebAuthn owner", () => {
    const owner = passkeyCredentialToOwner({
      id: "credential-id",
      publicKey: "0x02",
      rpId: "arc-tip-jar.pages.dev",
    });

    expect(owner.type).toBe("webAuthn");
    expect(owner.id).toBe("credential-id");
    expect(owner.publicKey).toBe("0x02");
    expect(owner.sign).toBeTypeOf("function");
  });

  it("appends the required Arc Testnet path only to the modular client URL", () => {
    expect(
      getArcModularClientUrl("https://modular-sdk.circle.com/v1/rpc/w3s/buidl"),
    ).toBe("https://modular-sdk.circle.com/v1/rpc/w3s/buidl/arcTestnet");
    expect(getArcModularClientUrl("https://example.com/base/")).toBe(
      "https://example.com/base/arcTestnet",
    );
  });
});

describe("Circle recovery helpers", () => {
  it("binds the proof to the smart account, recovery EOA, Arc chain, and purpose", () => {
    const message = recoveryProofMessage({
      walletAddress: "0x0000000000000000000000000000000000000001",
      recoveryAddress: "0x0000000000000000000000000000000000000002",
    });

    expect(message).toContain(
      "Smart account: 0x0000000000000000000000000000000000000001",
    );
    expect(message).toContain(
      "Recovery address: 0x0000000000000000000000000000000000000002",
    );
    expect(message).toContain("Chain ID: 5042002");
    expect(message).toContain("Purpose:");
  });

  it("rejects a mapping that does not match the expected MSCA before recovery", () => {
    expect(() =>
      selectRecoveryWalletAddress(
        [{ walletAddress: "0x0000000000000000000000000000000000000003" }],
        "0x0000000000000000000000000000000000000001",
      ),
    ).toThrow("RECOVERY_MAPPING_NOT_FOUND");
  });

  it("creates and validates a twelve-word in-memory recovery phrase", () => {
    const generated = createRecoveryMnemonic();
    expect(generated.mnemonic.split(" ")).toHaveLength(12);
    expect(isValidRecoveryMnemonic(generated.mnemonic)).toBe(true);
    expect(recoveryAccountFromMnemonic(generated.mnemonic).address).toBe(
      generated.account.address,
    );
  });

  it("rejects a twelve-word phrase with an invalid checksum", () => {
    const generated = createRecoveryMnemonic();
    const words = generated.mnemonic.split(" ");
    words[11] = "notaword";
    const invalid = words.join(" ");

    expect(isValidRecoveryMnemonic(invalid)).toBe(false);
    expect(() => recoveryAccountFromMnemonic(invalid)).toThrow(
      "RECOVERY_PHRASE_INVALID",
    );
  });
});
