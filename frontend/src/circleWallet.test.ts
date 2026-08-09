import { describe, expect, it } from "vitest";
import {
  createRecoveryMnemonic,
  recoveryProofMessage,
  selectRecoveryWalletAddress,
} from "./circleWallet";

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
