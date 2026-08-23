// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectInjectedWallet,
  isIsolatedWalletRequestActive,
  listenForInjectedWallets,
  type InjectedWallet,
} from "./eip6963";

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ethereum");
});

describe("EIP-6963 wallet sessions", () => {
  it("lists the explicitly announced provider without replacing it with fallback", () => {
    vi.useFakeTimers();
    const provider = { request: vi.fn() };
    const snapshots: InjectedWallet[][] = [];
    const stop = listenForInjectedWallets((wallets) => snapshots.push(wallets));

    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: {
            uuid: "rabby-id",
            name: "Rabby",
            icon: "data:image/svg+xml;base64,PHN2Zy8+",
            rdns: "io.rabby",
          },
          provider,
        },
      }),
    );
    vi.advanceTimersByTime(300);

    expect(snapshots.at(-1)?.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "rabby-id", name: "Rabby" },
    ]);
    stop();
  });

  it("marks a recovery/source account request as isolated from Active Wallet events", async () => {
    vi.useFakeTimers();
    let resolveAccounts: ((accounts: string[]) => void) | undefined;
    let markAccountsRequested: (() => void) | undefined;
    const accountsRequested = new Promise<void>((resolve) => {
      markAccountsRequested = resolve;
    });
    const provider = {
      on: vi.fn(),
      removeListener: vi.fn(),
      request: vi.fn(({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          return new Promise<string[]>((resolve) => {
            resolveAccounts = resolve;
            markAccountsRequested?.();
          });
        }
        return Promise.resolve("0x1");
      }),
    } as unknown as InjectedWallet["provider"];
    const wallet: InjectedWallet = {
      id: "metamask-id",
      name: "MetaMask",
      provider,
    };

    const connection = connectInjectedWallet(wallet);
    expect(isIsolatedWalletRequestActive()).toBe(true);
    await accountsRequested;
    resolveAccounts?.(["0x0000000000000000000000000000000000000001"]);
    await expect(connection).resolves.toMatchObject({ chainId: 1 });
    expect(isIsolatedWalletRequestActive()).toBe(true);
    vi.runAllTimers();
    expect(isIsolatedWalletRequestActive()).toBe(false);
  });
});
