import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  defineChain,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
} from "viem";
import {
  PasskeyClaimLinkReceiptError,
  type PasskeyWalletSession,
} from "../circleWallet";
import type { ClaimLinkPublicClient } from "./contract";
import {
  createBrowserClaimLinkWalletAdapter,
  createPasskeyClaimLinkWalletAdapter,
} from "./wallet";

const ADDRESS = "0x00000000000000000000000000000000000000b1" as Address;
const SIGNER = "0x00000000000000000000000000000000000000c1" as Address;
const CONTRACT = "0x00000000000000000000000000000000000000e1" as Address;
const LINK_ID = `0x${"11".repeat(32)}` as Hex;
const SIGNATURE = `0x${"22".repeat(65)}` as Hex;
const TX_HASH = `0x${"33".repeat(32)}` as Hash;
const USER_OP_HASH = `0x${"44".repeat(32)}` as Hash;
const chain = defineChain({
  id: 5_042_002,
  name: "Arc Test",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.invalid"] } },
});

function browserProvider(overrides?: {
  accounts?: Address[];
  chainId?: string;
}) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_accounts") return overrides?.accounts ?? [ADDRESS];
    if (method === "eth_chainId") {
      return overrides?.chainId ?? `0x${chain.id.toString(16)}`;
    }
    if (method === "eth_sendTransaction") return TX_HASH;
    throw new Error("unexpected method");
  });
  return {
    provider: { request } as unknown as EIP1193Provider,
    request,
  };
}

function publicClient(receiptResult: "success" | "reject" = "success") {
  const waitForTransactionReceipt = vi.fn(async () => {
    if (receiptResult === "reject") throw new Error("provider offline");
    return { status: "success", transactionHash: TX_HASH };
  });
  return {
    client: { waitForTransactionReceipt } as unknown as ClaimLinkPublicClient,
    waitForTransactionReceipt,
  };
}

describe("browser claim link wallet adapter", () => {
  it("checks the selected provider context immediately before submission", async () => {
    const selected = browserProvider();
    const rpc = publicClient();
    const adapter = createBrowserClaimLinkWalletAdapter({
      provider: selected.provider,
      address: ADDRESS,
      chain,
      publicClient: rpc.client,
    });

    await expect(
      adapter.create({
        contractAddress: CONTRACT,
        claimSigner: SIGNER,
        value: 123n,
      }),
    ).resolves.toEqual({ transactionHash: TX_HASH });

    const methods = selected.request.mock.calls.map(
      ([request]) => request.method,
    );
    expect(methods.slice(0, 2).sort()).toEqual(["eth_accounts", "eth_chainId"]);
    expect(methods).toContain("eth_sendTransaction");
    expect(rpc.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: TX_HASH,
    });
  });

  it("blocks account or chain drift without submitting", async () => {
    const selected = browserProvider({ accounts: [SIGNER] });
    const adapter = createBrowserClaimLinkWalletAdapter({
      provider: selected.provider,
      address: ADDRESS,
      chain,
      publicClient: publicClient().client,
    });

    await expect(
      adapter.refund({ contractAddress: CONTRACT, linkId: LINK_ID }),
    ).rejects.toMatchObject({ code: "wallet_context_changed" });
    expect(
      selected.request.mock.calls.some(
        ([request]) => request.method === "eth_sendTransaction",
      ),
    ).toBe(false);
  });

  it("returns a public transaction hash when receipt state is uncertain", async () => {
    const selected = browserProvider();
    const adapter = createBrowserClaimLinkWalletAdapter({
      provider: selected.provider,
      address: ADDRESS,
      chain,
      publicClient: publicClient("reject").client,
    });

    await expect(
      adapter.claim({
        contractAddress: CONTRACT,
        linkId: LINK_ID,
        signature: SIGNATURE,
      }),
    ).rejects.toMatchObject({
      code: "receipt_uncertain",
      transactionHash: TX_HASH,
    });
  });

  it("has no global injected-provider fallback", () => {
    const source = readFileSync(
      new URL("./wallet.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("window.ethereum");
    expect(source).not.toContain("globalThis.ethereum");
  });
});

describe("passkey claim link wallet adapter", () => {
  it("uses only the feature-specific sponsored session methods", async () => {
    const createClaimLink = vi.fn(async () => ({
      transactionHash: TX_HASH,
      userOperationHash: USER_OP_HASH,
    }));
    const claimLink = vi.fn(async () => ({
      transactionHash: TX_HASH,
      userOperationHash: USER_OP_HASH,
    }));
    const refundClaimLink = vi.fn(async () => ({
      transactionHash: TX_HASH,
      userOperationHash: USER_OP_HASH,
    }));
    const session = {
      kind: "passkey",
      address: ADDRESS,
      chainId: chain.id,
      createClaimLink,
      claimLink,
      refundClaimLink,
    } as unknown as PasskeyWalletSession;
    const adapter = createPasskeyClaimLinkWalletAdapter({
      session,
      address: ADDRESS,
      chain,
    });

    await adapter.create({
      contractAddress: CONTRACT,
      claimSigner: SIGNER,
      value: 9n,
    });
    await adapter.claim({
      contractAddress: CONTRACT,
      linkId: LINK_ID,
      signature: SIGNATURE,
    });
    await adapter.refund({ contractAddress: CONTRACT, linkId: LINK_ID });

    expect(createClaimLink).toHaveBeenCalledWith({
      contractAddress: CONTRACT,
      claimSigner: SIGNER,
      value: 9n,
    });
    expect(claimLink).toHaveBeenCalledWith({
      contractAddress: CONTRACT,
      linkId: LINK_ID,
      signature: SIGNATURE,
    });
    expect(refundClaimLink).toHaveBeenCalledWith({
      contractAddress: CONTRACT,
      linkId: LINK_ID,
    });
  });
});

describe("passkey Claim Link failure classification", () => {
  type Operation = "create" | "claim" | "refund";

  function rejectingSession(errorFactory: () => Error): PasskeyWalletSession {
    return {
      kind: "passkey",
      address: ADDRESS,
      chainId: chain.id,
      createClaimLink: vi.fn(async () => {
        throw errorFactory();
      }),
      claimLink: vi.fn(async () => {
        throw errorFactory();
      }),
      refundClaimLink: vi.fn(async () => {
        throw errorFactory();
      }),
    } as unknown as PasskeyWalletSession;
  }

  async function execute(
    operation: Operation,
    session: PasskeyWalletSession,
  ): Promise<unknown> {
    const adapter = createPasskeyClaimLinkWalletAdapter({
      session,
      address: ADDRESS,
      chain,
    });
    if (operation === "create") {
      return adapter.create({
        contractAddress: CONTRACT,
        claimSigner: SIGNER,
        value: 9n,
      });
    }
    if (operation === "claim") {
      return adapter.claim({
        contractAddress: CONTRACT,
        linkId: LINK_ID,
        signature: SIGNATURE,
      });
    }
    return adapter.refund({ contractAddress: CONTRACT, linkId: LINK_ID });
  }

  it.each(["create", "claim", "refund"] as const)(
    "maps %s receipt wait failure to receipt_uncertain and keeps its UserOperation hash",
    async (operation) => {
      const session = rejectingSession(
        () => new PasskeyClaimLinkReceiptError(USER_OP_HASH),
      );
      let caught: unknown;

      try {
        await execute(operation, session);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: "receipt_uncertain",
        userOperationHash: USER_OP_HASH,
      });
      expect(
        (caught as { transactionHash?: Hash }).transactionHash,
      ).toBeUndefined();
      expect(String(caught)).not.toContain(SIGNATURE);
      expect((caught as Error).cause).toBeUndefined();
    },
  );

  it.each(["create", "claim", "refund"] as const)(
    "keeps %s send-before-hash failure classified as transaction_failed",
    async (operation) => {
      const session = rejectingSession(
        () => new Error(`submission failed ${SIGNATURE}`),
      );
      let caught: unknown;

      try {
        await execute(operation, session);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "transaction_failed" });
      expect(
        (caught as { userOperationHash?: Hash }).userOperationHash,
      ).toBeUndefined();
      expect(String(caught)).not.toContain(SIGNATURE);
      expect((caught as Error).cause).toBeUndefined();
    },
  );
});
