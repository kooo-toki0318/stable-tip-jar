// @vitest-environment jsdom
import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createClaimLinkDraft } from "./create";

const SENDER = "0x00000000000000000000000000000000000000b1" as Address;

describe("claim link creation capability", () => {
  it("derives public fields but exposes the complete link only to explicit copy", async () => {
    const clipboard = { writeText: vi.fn(async (_value: string) => undefined) };
    const draft = await createClaimLinkDraft(SENDER);

    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(Object.keys(draft).sort()).toEqual([
      "claimSigner",
      "copyLink",
      "discard",
      "linkId",
      "sender",
    ]);
    expect(JSON.stringify(draft)).not.toContain("?k=");

    const expectedLinkId = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }],
        [draft.sender, draft.claimSigner],
      ),
    );
    expect(draft.linkId).toBe(expectedLinkId);

    await draft.copyLink(
      "https://example.com/app/?tracking=public#/tip",
      clipboard,
    );
    expect(clipboard.writeText).toHaveBeenCalledOnce();

    const copied = clipboard.writeText.mock.calls[0]?.[0];
    const copiedUrl = new URL(copied);
    expect(copiedUrl.search).toBe("");
    expect(copiedUrl.hash).toMatch(
      new RegExp(`^#/claim/v1/${draft.linkId}\\?k=0x[0-9a-f]{64}$`),
    );

    const privateKey = copiedUrl.hash.slice(copiedUrl.hash.indexOf("?k=") + 3) as Hex;
    expect(privateKeyToAccount(privateKey).address).toBe(draft.claimSigner);
  });

  it("drops the draft secret and returns secret-free copy errors", async () => {
    const draft = await createClaimLinkDraft(SENDER);
    let attemptedLink = "";
    const rejectingClipboard = {
      writeText: vi.fn(async (value: string) => {
        attemptedLink = value;
        throw new Error(`clipboard rejected ${value}`);
      }),
    };

    let copyError: unknown;
    try {
      await draft.copyLink("https://example.com/", rejectingClipboard);
    } catch (error) {
      copyError = error;
    }
    const copiedSecret = attemptedLink.slice(attemptedLink.indexOf("?k=") + 3);
    expect(copyError).toMatchObject({ code: "copy_failed" });
    expect(String(copyError)).not.toContain(copiedSecret);
    expect(JSON.stringify(copyError)).not.toContain(copiedSecret);

    draft.discard();
    await expect(
      draft.copyLink("https://example.com/", { writeText: vi.fn() }),
    ).rejects.toMatchObject({ code: "draft_unavailable" });
  });

  it("rejects invalid senders and unsafe base URLs with static errors", async () => {
    await expect(
      createClaimLinkDraft("not-an-address" as Address),
    ).rejects.toMatchObject({ code: "invalid_sender" });

    const draft = await createClaimLinkDraft(SENDER);
    await expect(
      draft.copyLink("javascript:alert(1)", { writeText: vi.fn() }),
    ).rejects.toMatchObject({ code: "invalid_base_url" });
    await expect(
      draft.copyLink("https://user:password@example.com/", {
        writeText: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "invalid_base_url" });
  });
});
