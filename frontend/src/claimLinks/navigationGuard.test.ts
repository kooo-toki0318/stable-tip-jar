import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearClaimLinkNavigationGuardForTests,
  guardClaimLinkHashNavigation,
  registerClaimLinkNavigationGuard,
} from "./navigationGuard";

afterEach(() => {
  clearClaimLinkNavigationGuardForTests();
});

describe("Claim Link navigation guard", () => {
  it.each([
    ["header anchor", "#/tip"],
    ["browser back", "#/bridge"],
  ])("restores the accepted hash when %s navigation is cancelled", (_, nextHash) => {
    const confirmLeave = vi.fn(() => false);
    const restore = vi.fn();
    registerClaimLinkNavigationGuard(confirmLeave);

    expect(
      guardClaimLinkHashNavigation({
        acceptedHash: "#/links",
        nextHash,
        restore,
      }),
    ).toBe(false);
    expect(confirmLeave).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith("#/links");
  });

  it("allows a confirmed hash navigation without rewriting history", () => {
    const restore = vi.fn();
    registerClaimLinkNavigationGuard(() => true);

    expect(
      guardClaimLinkHashNavigation({
        acceptedHash: "#/links",
        nextHash: "#/tip",
        restore,
      }),
    ).toBe(true);
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not prompt for the already accepted hash", () => {
    const confirmLeave = vi.fn(() => false);
    registerClaimLinkNavigationGuard(confirmLeave);

    expect(
      guardClaimLinkHashNavigation({
        acceptedHash: "#/links",
        nextHash: "#/links",
        restore: vi.fn(),
      }),
    ).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled();
  });

  it("removes only the registration owned by its cleanup", () => {
    const firstCleanup = registerClaimLinkNavigationGuard(() => false);
    const secondCleanup = registerClaimLinkNavigationGuard(() => false);
    firstCleanup();

    const restore = vi.fn();
    expect(
      guardClaimLinkHashNavigation({
        acceptedHash: "#/links",
        nextHash: "#/tip",
        restore,
      }),
    ).toBe(false);

    secondCleanup();
    expect(
      guardClaimLinkHashNavigation({
        acceptedHash: "#/links",
        nextHash: "#/tip",
        restore,
      }),
    ).toBe(true);
  });
});
