import { readFileSync } from "node:fs";
import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  claimLinkId,
  claimSignerFromPrivateKey,
  signClaimAuthorization,
} from "./crypto";

type ClaimVector = {
  privateKey: Hex;
  sender: Address;
  claimSigner: Address;
  recipient: Address;
  domain: {
    name: "ClaimLinkEscrow";
    version: "1";
    chainId: number;
    verifyingContract: Address;
  };
  message: { linkId: Hex; recipient: Address };
  digest: Hex;
  signature: Hex;
};

const vector = JSON.parse(
  readFileSync(
    new URL("../../../test-vectors/claim-link-eip712-v1.json", import.meta.url),
    "utf8",
  ),
) as ClaimVector;

const claimTypes = {
  Claim: [
    { name: "linkId", type: "bytes32" },
    { name: "recipient", type: "address" },
  ],
} as const;

describe("ClaimLinkEscrow V1 interoperability vector", () => {
  it("matches link derivation, EIP-712 digest, and deterministic signature", async () => {
    expect(claimSignerFromPrivateKey(vector.privateKey)).toBe(
      vector.claimSigner,
    );
    expect(claimLinkId(vector.sender, vector.claimSigner)).toBe(
      vector.message.linkId,
    );

    const typedData = {
      domain: vector.domain,
      types: claimTypes,
      primaryType: "Claim" as const,
      message: vector.message,
    };
    expect(hashTypedData(typedData)).toBe(vector.digest);
    expect(
      await signClaimAuthorization({
        privateKey: vector.privateKey,
        linkId: vector.message.linkId,
        recipient: vector.recipient,
        chainId: vector.domain.chainId,
        verifyingContract: vector.domain.verifyingContract,
      }),
    ).toBe(vector.signature);
    expect(
      await recoverTypedDataAddress({ ...typedData, signature: vector.signature }),
    ).toBe(vector.claimSigner);
  });
});
