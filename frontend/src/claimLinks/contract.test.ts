import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import {
  ClaimLinkPaymentStatus,
  isClaimLinkExpired,
  isClaimLinkExpiredAt,
  isFundedDraftPayment,
  readClaimLinkPayment,
  readSenderClaimLinks,
  type ClaimLinkPayment,
  type ClaimLinkPublicClient,
} from "./contract";

const CONTRACT = "0x00000000000000000000000000000000000000e1" as Address;
const SENDER = "0x00000000000000000000000000000000000000b1" as Address;
const SIGNER = "0x00000000000000000000000000000000000000c1" as Address;
const ids = [1, 2, 3].map(
  (value) => `0x${value.toString(16).padStart(64, "0")}` as Hex,
);
const BLOCK_NUMBER = 42n;
const BLOCK_TIMESTAMP = 99n;

function decodedPayment(status = ClaimLinkPaymentStatus.Active) {
  return {
    sender: SENDER,
    claimSigner: SIGNER,
    amount: 12n,
    expiresAt: 100n,
    status,
  };
}

function latestBlock() {
  return { number: BLOCK_NUMBER, timestamp: BLOCK_TIMESTAMP };
}

describe("claim link contract reads", () => {
  it("pins one payment read to the authoritative latest block", async () => {
    const getBlock = vi.fn(async () => latestBlock());
    const readContract = vi.fn(async () => decodedPayment());
    const result = await readClaimLinkPayment({
      publicClient: {
        getBlock,
        readContract,
      } as unknown as ClaimLinkPublicClient,
      contractAddress: CONTRACT,
      linkId: ids[0],
    });

    expect(result).toEqual({
      linkId: ids[0],
      ...decodedPayment(),
      sender: getAddress(SENDER),
      claimSigner: getAddress(SIGNER),
      observedBlockNumber: BLOCK_NUMBER,
      observedBlockTimestamp: BLOCK_TIMESTAMP,
    });
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: CONTRACT,
        functionName: "getPayment",
        args: [ids[0]],
        blockNumber: BLOCK_NUMBER,
      }),
    );
  });

  it("pages newest-first at one block so every sender link remains reachable", async () => {
    const getBlock = vi.fn(async () => latestBlock());
    const readContract = vi.fn(
      async (request: {
        functionName: string;
        args: readonly unknown[];
        blockNumber?: bigint;
      }) => {
        if (request.functionName === "senderLinkCount") return 3n;
        if (request.functionName === "senderLinkAt") {
          return ids[Number(request.args[1] as bigint)];
        }
        return decodedPayment();
      },
    );
    const publicClient = {
      getBlock,
      readContract,
    } as unknown as ClaimLinkPublicClient;

    const firstPage = await readSenderClaimLinks({
      publicClient,
      contractAddress: CONTRACT,
      sender: SENDER,
      limit: 2,
    });
    const secondPage = await readSenderClaimLinks({
      publicClient,
      contractAddress: CONTRACT,
      sender: SENDER,
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(firstPage.payments.map(({ linkId }) => linkId)).toEqual([
      ids[2],
      ids[1],
    ]);
    expect(firstPage.nextCursor).toBe(1n);
    expect(secondPage.payments.map(({ linkId }) => linkId)).toEqual([ids[0]]);
    expect(secondPage.nextCursor).toBeNull();
    expect(firstPage.totalCount).toBe(3n);
    expect(secondPage.totalCount).toBe(3n);
    expect(getBlock).toHaveBeenCalledTimes(2);
    expect(getBlock).toHaveBeenNthCalledWith(1, { blockTag: "latest" });
    expect(getBlock).toHaveBeenNthCalledWith(2, { blockTag: "latest" });

    const calls = readContract.mock.calls.map(([request]) => request);
    expect(calls).toHaveLength(8);
    expect(calls.every(({ blockNumber }) => blockNumber === BLOCK_NUMBER)).toBe(
      true,
    );
    expect(calls.some(({ functionName }) => functionName === "eth_getLogs")).toBe(
      false,
    );
  });

  it("uses only observed block time for expiry and verifies all funding fields", () => {
    const active: ClaimLinkPayment = {
      linkId: ids[0],
      ...decodedPayment(),
      observedBlockNumber: BLOCK_NUMBER,
      observedBlockTimestamp: 99n,
    };
    vi.spyOn(Date, "now").mockReturnValue(9_999_999_999_000);

    expect(isClaimLinkExpired(active)).toBe(false);
    expect(
      isClaimLinkExpired({ ...active, observedBlockTimestamp: 100n }),
    ).toBe(true);
    expect(isClaimLinkExpiredAt(active, 100n)).toBe(true);
    expect(
      isFundedDraftPayment({
        payment: active,
        sender: SENDER,
        claimSigner: SIGNER,
        amount: 12n,
      }),
    ).toBe(true);
    expect(
      isFundedDraftPayment({
        payment: active,
        sender: SENDER,
        claimSigner: SIGNER,
        amount: 13n,
      }),
    ).toBe(false);
  });
});
