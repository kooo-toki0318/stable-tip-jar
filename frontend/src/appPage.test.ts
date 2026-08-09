import { describe, expect, it } from "vitest";
import { appPageFromHash } from "./appPage";

describe("appPageFromHash", () => {
  it.each([
    ["#/tip", "tip"],
    ["#/bridge", "bridge"],
  ])("maps %s to %s", (hash, expected) => {
    expect(appPageFromHash(hash)).toBe(expected);
  });

  it("falls back to Tip Jar for unknown and empty hashes", () => {
    expect(appPageFromHash("")).toBe("tip");
    expect(appPageFromHash("#/unknown")).toBe("tip");
    expect(appPageFromHash("#/wallet")).toBe("tip");
  });
});
