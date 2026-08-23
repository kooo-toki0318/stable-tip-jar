import { describe, expect, it } from "vitest";
import { decodeAbiParameters, slice, toFunctionSelector } from "viem";
import {
  PasskeyClaimLinkReceiptError,
  buildSponsoredClaimLinkUserOperation,
  createRecoveryMnemonic,
  encodeClaimLinkCall,
  encodeCreateClaimLinkCall,
  encodeRefundClaimLinkCall,
  getArcModularClientUrl,
  isValidRecoveryMnemonic,
  passkeyCredentialToOwner,
  recoveryAccountFromMnemonic,
  recoveryProofMessage,
  selectRecoveryWalletAddress,
  waitForClaimLinkUserOperationReceipt,
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

describe("Claim Link Passkey calls", () => {
  const contractAddress = "0x0000000000000000000000000000000000000001";
  const claimSigner = "0x0000000000000000000000000000000000000002";
  const linkId = `0x${"11".repeat(32)}` as `0x${string}`;
  const signature = `0x${"22".repeat(65)}` as `0x${string}`;

  it("encodes create with the exact contract, signer, and msg.value", () => {
    const call = encodeCreateClaimLinkCall({
      contractAddress,
      claimSigner,
      value: 123n,
    });

    expect(call.to).toBe(contractAddress);
    expect(call.value).toBe(123n);
    expect(slice(call.data, 0, 4)).toBe(
      toFunctionSelector("createClaimLink(address)"),
    );
    const [decodedSigner] = decodeAbiParameters(
      [{ type: "address" }],
      slice(call.data, 4),
    );
    expect(decodedSigner).toBe(claimSigner);
  });

  it("encodes claim with the link id and capability signature", () => {
    const call = encodeClaimLinkCall({
      contractAddress,
      linkId,
      signature,
    });

    expect(call.to).toBe(contractAddress);
    expect(slice(call.data, 0, 4)).toBe(
      toFunctionSelector("claim(bytes32,bytes)"),
    );
    const [decodedLinkId, decodedSignature] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }],
      slice(call.data, 4),
    );
    expect(decodedLinkId).toBe(linkId);
    expect(decodedSignature).toBe(signature);
  });

  it("encodes refund with only the public link id", () => {
    const call = encodeRefundClaimLinkCall({ contractAddress, linkId });

    expect(call.to).toBe(contractAddress);
    expect(slice(call.data, 0, 4)).toBe(toFunctionSelector("refund(bytes32)"));
    const [decodedLinkId] = decodeAbiParameters(
      [{ type: "bytes32" }],
      slice(call.data, 4),
    );
    expect(decodedLinkId).toBe(linkId);
  });

  it("builds one sponsored call with no user-paid fallback branch", () => {
    const call = encodeRefundClaimLinkCall({ contractAddress, linkId });
    const operation = buildSponsoredClaimLinkUserOperation(call);

    expect(operation.paymaster).toBe(true);
    expect(operation.calls).toEqual([call]);
    expect(Object.keys(operation).sort()).toEqual(["calls", "paymaster"]);
  });
});

describe("Claim Link Passkey receipt tracking", () => {
  const userOperationHash = `0x${"33".repeat(32)}` as `0x${string}`;
  const transactionHash = `0x${"44".repeat(32)}` as `0x${string}`;
  const signature = `0x${"55".repeat(65)}`;

  it("preserves the public UserOperation hash on a receipt wait failure", async () => {
    let caught: unknown;
    try {
      await waitForClaimLinkUserOperationReceipt({
        userOperationHash,
        waitForReceipt: async () => {
          throw new Error(`transport failed ${signature}`);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PasskeyClaimLinkReceiptError);
    expect(caught).toMatchObject({
      code: "CLAIM_LINK_USER_OPERATION_RECEIPT_UNCERTAIN",
      userOperationHash,
    });
    expect(String(caught)).not.toContain(signature);
    expect((caught as Error).cause).toBeUndefined();
  });

  it("returns both public hashes after a successful receipt", async () => {
    await expect(
      waitForClaimLinkUserOperationReceipt({
        userOperationHash,
        waitForReceipt: async () => ({
          success: true,
          receipt: { transactionHash },
        }),
      }),
    ).resolves.toEqual({ userOperationHash, transactionHash });
  });

  it("keeps a known reverted receipt distinct from an uncertain receipt", async () => {
    await expect(
      waitForClaimLinkUserOperationReceipt({
        userOperationHash,
        waitForReceipt: async () => ({
          success: false,
          receipt: { transactionHash },
        }),
      }),
    ).rejects.toThrow("USER_OPERATION_REVERTED");
  });
});
