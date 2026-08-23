import { describe, expect, it } from "vitest";
import { appPageFromHash } from "./appPage";

describe("appPageFromHash", () => {
  it.each([
    ["#/tip", "tip"],
    ["#/links", "links"],
    [`#/claim/v1/0x${"ab".repeat(32)}`, "claim"],
    ["#/bridge", "bridge"],
  ])("maps %s to %s", (hash, expected) => {
    expect(appPageFromHash(hash)).toBe(expected);
  });

  it("falls back to Tip Jar for unknown and empty hashes", () => {
    expect(appPageFromHash("")).toBe("tip");
    expect(appPageFromHash("#/unknown")).toBe("tip");
    expect(appPageFromHash("#/wallet")).toBe("tip");
    expect(appPageFromHash("#/claim/v2/0x" + "ab".repeat(32))).toBe(
      "tip",
    );
    expect(appPageFromHash("#/claim/v1/not-a-link-id")).toBe("claim");
  });
});
