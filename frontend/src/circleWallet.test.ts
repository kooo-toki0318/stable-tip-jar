import { describe, expect, it } from "vitest";
import {
  createRecoveryMnemonic,
  getArcModularClientUrl,
  recoveryProofMessage,
  selectRecoveryWalletAddress,
} from "./circleWallet";

describe("Circle transport configuration", () => {
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

  it("creates a twelve-word in-memory recovery phrase and matching EOA", () => {
    const generated = createRecoveryMnemonic();
    expect(generated.mnemonic.split(" ")).toHaveLength(12);
    expect(generated.account.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});
