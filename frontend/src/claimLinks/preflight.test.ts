// @vitest-environment jsdom
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapClaimLink,
  discardClaimLinkSecret,
  prepareClaimCapability,
} from "./bootstrap";
import {
  ClaimLinkPaymentStatus,
  type ClaimLinkPayment,
} from "./contract";
import { claimLinkId } from "./crypto";
import { preflightClaimLink } from "./preflight";

const PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const CLAIM_SIGNER = privateKeyToAccount(PRIVATE_KEY).address;
const SENDER = "0x00000000000000000000000000000000000000b1";
const LINK_ID = claimLinkId(SENDER, CLAIM_SIGNER);

function bootstrap() {
  return bootstrapClaimLink(
    {
      pathname: "/",
      search: "",
      hash: `#/claim/v1/${LINK_ID}?k=${PRIVATE_KEY}`,
    },
    { state: null, replaceState: vi.fn() },
  );
}

function payment(
  overrides: Partial<ClaimLinkPayment> = {},
): ClaimLinkPayment {
  return {
    linkId: LINK_ID,
    sender: SENDER,
    claimSigner: CLAIM_SIGNER,
    amount: 1n,
    expiresAt: 100n,
    status: ClaimLinkPaymentStatus.Active,
    observedBlockNumber: 50n,
    observedBlockTimestamp: 99n,
    ...overrides,
  };
}

afterEach(() => {
  discardClaimLinkSecret();
  vi.restoreAllMocks();
});

describe("pre-React Claim Link preflight", () => {
  it("verifies the derived signer and ignores the browser clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_999_999_999_000);
    const result = bootstrap();
    const readPayment = vi.fn(async () => payment());

    await expect(preflightClaimLink(result, { readPayment })).resolves.toEqual(
      result,
    );
    expect(readPayment).toHaveBeenCalledWith(LINK_ID);
    await expect(prepareClaimCapability(CLAIM_SIGNER)).resolves.toMatchObject({
      linkId: LINK_ID,
      claimSigner: CLAIM_SIGNER,
    });
  });

  it("retries the same preflight after a read failure without losing the secret", async () => {
    const result = bootstrap();
    const readPayment = vi
      .fn<() => Promise<ClaimLinkPayment>>()
      .mockRejectedValueOnce(new Error("temporary RPC failure"))
      .mockResolvedValueOnce(payment());

    await expect(preflightClaimLink(result, { readPayment })).resolves.toEqual(
      result,
    );
    await expect(preflightClaimLink(result, { readPayment })).resolves.toEqual(
      result,
    );
    expect(readPayment).toHaveBeenCalledTimes(2);
    await expect(prepareClaimCapability(CLAIM_SIGNER)).resolves.toMatchObject({
      linkId: LINK_ID,
      claimSigner: CLAIM_SIGNER,
    });
  });

  it("discards the secret when sender/signer derivation cannot match the link id", async () => {
    const result = bootstrap();

    await expect(
      preflightClaimLink(result, {
        readPayment: vi.fn(async () =>
          payment({
            sender: "0x00000000000000000000000000000000000000b2",
          }),
        ),
      }),
    ).resolves.toEqual({ status: "invalid-link" });
    await expect(prepareClaimCapability(CLAIM_SIGNER)).rejects.toMatchObject({
      code: "missing_secret",
    });
  });

  it.each([
    ClaimLinkPaymentStatus.Claimed,
    ClaimLinkPaymentStatus.Refunded,
  ])("discards the secret for terminal status %s", async (status) => {
    const result = bootstrap();

    await expect(
      preflightClaimLink(result, {
        readPayment: vi.fn(async () => payment({ status })),
      }),
    ).resolves.toEqual(result);
    await expect(prepareClaimCapability(CLAIM_SIGNER)).rejects.toMatchObject({
      code: "missing_secret",
    });
  });
  it("discards at the authoritative block timestamp expiry boundary", async () => {
    const result = bootstrap();

    await expect(
      preflightClaimLink(result, {
        readPayment: vi.fn(async () =>
          payment({ observedBlockTimestamp: 100n }),
        ),
      }),
    ).resolves.toEqual(result);
    await expect(prepareClaimCapability(CLAIM_SIGNER)).rejects.toMatchObject({
      code: "missing_secret",
    });
  });
});
