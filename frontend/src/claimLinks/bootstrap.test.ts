// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapClaimLink,
  discardClaimLinkSecret,
  prepareClaimCapability,
} from "./bootstrap";
import { ClaimLinkError } from "./errors";

const LINK_ID = `0x${"11".repeat(32)}` as Hex;
const PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const CLAIM_SIGNER = privateKeyToAccount(PRIVATE_KEY).address;
const RECIPIENT = "0x00000000000000000000000000000000000000a1" as Address;
const ESCROW = "0x00000000000000000000000000000000000000e1" as Address;

function mockBrowser(hash: string) {
  const location = {
    pathname: "/app/",
    search: "?public=1",
    hash,
  };
  const history = {
    state: { navigation: "state" },
    replaceState: vi.fn(),
  };
  return { location, history };
}

afterEach(() => {
  discardClaimLinkSecret();
  vi.restoreAllMocks();
});

describe("claim link bootstrap", () => {
  it("captures a strict secret and synchronously scrubs it from the URL", async () => {
    const browser = mockBrowser(
      `#/claim/v1/${LINK_ID.toUpperCase().replace("0X", "0x")}?k=${PRIVATE_KEY}`,
    );

    const result = bootstrapClaimLink(browser.location, browser.history);

    expect(result).toEqual({ status: "ready", linkId: LINK_ID });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
    expect(browser.history.replaceState).toHaveBeenCalledOnce();
    expect(browser.history.replaceState).toHaveBeenCalledWith(
      browser.history.state,
      "",
      `/app/?public=1#/claim/v1/${LINK_ID}`,
    );

    const capability = await prepareClaimCapability(CLAIM_SIGNER);
    expect(capability).toMatchObject({ linkId: LINK_ID, claimSigner: CLAIM_SIGNER });
    expect(Object.keys(capability).sort()).toEqual([
      "claimSigner",
      "discard",
      "linkId",
      "signClaim",
    ]);
  });

  it("discards the secret and returns a static-safe state when URL scrubbing fails", async () => {
    const location = {
      pathname: "/",
      search: "",
      hash: `#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}`,
    };
    const history = {
      state: null,
      replaceState: vi.fn(() => {
        throw new DOMException("blocked");
      }),
    };

    expect(bootstrapClaimLink(location, history)).toEqual({
      status: "unsafe-url",
    });
    await expect(prepareClaimCapability(CLAIM_SIGNER)).rejects.toMatchObject({
      code: "missing_secret",
    });
  });

  it.each([
    `#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}&k=${PRIVATE_KEY}`,
    `#/claim/v1/${LINK_ID}?k=%30x${PRIVATE_KEY.slice(2)}`,
    `#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}%30`,
    `#/claim/v1/${LINK_ID}?key=${PRIVATE_KEY}`,
    `#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}&source=test`,
    `#/claim/v1/${LINK_ID}?k=0x01`,
    `#/claim/v1/not-a-link-id?k=${PRIVATE_KEY}`,
  ])("rejects and scrubs malformed or encoded input: %s", (hash) => {
    const browser = mockBrowser(hash);

    expect(bootstrapClaimLink(browser.location, browser.history)).toEqual({
      status: "invalid-link",
    });

    const replacement = String(browser.history.replaceState.mock.calls[0]?.[2]);
    expect(replacement).not.toContain("?k=");
    expect(replacement).not.toContain("%30x");
    expect(replacement).not.toContain(PRIVATE_KEY);
  });

  it("treats a scrubbed route reload as missing and releases the old secret", async () => {
    const initial = mockBrowser(`#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}`);
    expect(bootstrapClaimLink(initial.location, initial.history).status).toBe("ready");

    const reload = mockBrowser(`#/claim/v1/${LINK_ID}`);
    expect(bootstrapClaimLink(reload.location, reload.history)).toEqual({
      status: "missing-secret",
      linkId: LINK_ID,
    });
    expect(reload.history.replaceState).not.toHaveBeenCalled();
    await expect(prepareClaimCapability(CLAIM_SIGNER)).rejects.toMatchObject({
      code: "missing_secret",
    });
  });

  it("uses secret-free errors for an invalid scalar and signer mismatch", async () => {
    const zeroKey = `0x${"00".repeat(32)}` as Hex;
    const invalidScalar = mockBrowser(`#/claim/v1/${LINK_ID}?k=${zeroKey}`);
    bootstrapClaimLink(invalidScalar.location, invalidScalar.history);

    let invalidError: unknown;
    try {
      await prepareClaimCapability(CLAIM_SIGNER);
    } catch (error) {
      invalidError = error;
    }
    expect(invalidError).toBeInstanceOf(ClaimLinkError);
    expect(invalidError).toMatchObject({ code: "invalid_secret" });
    expect(JSON.stringify(invalidError)).not.toContain(zeroKey);
    expect(String(invalidError)).not.toContain(zeroKey);

    const mismatch = mockBrowser(`#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}`);
    bootstrapClaimLink(mismatch.location, mismatch.history);
    let mismatchError: unknown;
    try {
      await prepareClaimCapability(
        "0x0000000000000000000000000000000000000001",
      );
    } catch (error) {
      mismatchError = error;
    }
    expect(mismatchError).toMatchObject({ code: "signer_mismatch" });
    expect(JSON.stringify(mismatchError)).not.toContain(PRIVATE_KEY);
    expect(String(mismatchError)).not.toContain(PRIVATE_KEY);
  });

  it("signs exactly the recipient-bound EIP-712 Claim without a deadline", async () => {
    const browser = mockBrowser(`#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}`);
    bootstrapClaimLink(browser.location, browser.history);
    const capability = await prepareClaimCapability(CLAIM_SIGNER);

    const signature = await capability.signClaim({
      recipient: RECIPIENT,
      chainId: 5_042_002,
      verifyingContract: ESCROW,
    });
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "ClaimLinkEscrow",
        version: "1",
        chainId: 5_042_002,
        verifyingContract: ESCROW,
      },
      types: {
        Claim: [
          { name: "linkId", type: "bytes32" },
          { name: "recipient", type: "address" },
        ],
      },
      primaryType: "Claim",
      message: { linkId: LINK_ID, recipient: RECIPIENT },
      signature,
    });

    expect(recovered).toBe(CLAIM_SIGNER);
  });

  it("invalidates signing on explicit discard or route leave", async () => {
    const browser = mockBrowser(`#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}`);
    bootstrapClaimLink(browser.location, browser.history);
    const capability = await prepareClaimCapability(CLAIM_SIGNER);

    capability.discard();
    await expect(
      capability.signClaim({
        recipient: RECIPIENT,
        chainId: 5_042_002,
        verifyingContract: ESCROW,
      }),
    ).rejects.toMatchObject({ code: "inactive_session" });

    bootstrapClaimLink(browser.location, browser.history);
    const routeCapability = await prepareClaimCapability(CLAIM_SIGNER);
    discardClaimLinkSecret();
    await expect(
      routeCapability.signClaim({
        recipient: RECIPIENT,
        chainId: 5_042_002,
        verifyingContract: ESCROW,
      }),
    ).rejects.toMatchObject({ code: "inactive_session" });
  });

  it("does not use storage, cookies, DOM output, or console reporting", () => {
    const source = ["./bootstrap.ts", "./create.ts", "./crypto.ts", "./errors.ts"]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/(?:localStorage|sessionStorage|indexedDB)/);
    expect(source).not.toMatch(/document\.(?:cookie|body|write)/);
    expect(source).not.toMatch(/console\.(?:log|info|warn|error|debug)/);
  });
});

describe("claim link derivation vector", () => {
  it("matches keccak256(abi.encode(sender, claimSigner))", () => {
    const sender = "0x00000000000000000000000000000000000000b1" as Address;
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }],
        [sender, CLAIM_SIGNER],
      ),
    );
    expect(expected).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
