import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  slice,
  toFunctionSelector,
} from "viem";
import { encodeCreateClaimLinkCall } from "../circleWallet";

describe("Claim Link message encoding", () => {
  it("uses the message-aware create overload when a message is supplied", () => {
    const contractAddress =
      "0x0000000000000000000000000000000000000001";
    const claimSigner =
      "0x0000000000000000000000000000000000000002";

    const call = encodeCreateClaimLinkCall({
      contractAddress,
      claimSigner,
      value: 123n,
      message: "hello",
    });

    expect(slice(call.data, 0, 4)).toBe(
      toFunctionSelector("createClaimLink(address,string)"),
    );

    const [decodedSigner, decodedMessage] = decodeAbiParameters(
      [{ type: "address" }, { type: "string" }],
      slice(call.data, 4),
    );
    expect(decodedSigner).toBe(claimSigner);
    expect(decodedMessage).toBe("hello");
  });
});
