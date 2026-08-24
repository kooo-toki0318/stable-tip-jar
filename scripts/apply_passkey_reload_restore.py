from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


circle_path = Path("frontend/src/circleWallet.ts")
circle = circle_path.read_text()

circle = replace_once(
    circle,
    '''export type PasskeyWalletSession = {
  kind: "passkey";
  address: Address;
  chainId: number;
''',
    '''export type PasskeyCredentialMetadata = Readonly<{
  id: string;
  publicKey: Hex;
  rpId?: string;
}>;

export type PasskeyWalletSession = {
  kind: "passkey";
  address: Address;
  chainId: number;
  credential?: PasskeyCredentialMetadata;
''',
    "circle session metadata type",
)

circle = replace_once(
    circle,
    '''export function passkeyCredentialToOwner(credential: {
  id: string;
  publicKey: Hex;
  rpId?: string;
}): WebAuthnAccount {
''',
    '''export function passkeyCredentialToOwner(
  credential: PasskeyCredentialMetadata,
): WebAuthnAccount {
''',
    "circle credential owner type",
)

circle = replace_once(
    circle,
    '''async function buildPasskeySession(
  runtime: CircleRuntime,
  owner: WebAuthnAccount,
): Promise<PasskeyWalletSession> {
''',
    '''async function buildPasskeySession(
  runtime: CircleRuntime,
  owner: WebAuthnAccount,
  credential?: PasskeyCredentialMetadata,
): Promise<PasskeyWalletSession> {
''',
    "circle build session signature",
)

circle = replace_once(
    circle,
    '''  return {
    kind: "passkey",
    address: getAddress(smartAccount.address),
    chainId: arcTestnet.id,
''',
    '''  return {
    kind: "passkey",
    address: getAddress(smartAccount.address),
    chainId: arcTestnet.id,
    ...(credential ? { credential } : {}),
''',
    "circle session metadata return",
)

circle = replace_once(
    circle,
    '''export async function createPasskeyWallet(
  mode: "register" | "login",
): Promise<PasskeyWalletSession> {
  const runtime = await loadCircleRuntime();
  const credential = await runtime.circle.toWebAuthnCredential({
    transport: runtime.passkeyTransport,
    mode:
      mode === "register"
        ? runtime.circle.WebAuthnMode.Register
        : runtime.circle.WebAuthnMode.Login,
    username:
      mode === "register" ? `arc-tip-jar-${crypto.randomUUID()}` : undefined,
  });
  const owner = passkeyCredentialToOwner(credential);
  try {
    return await buildPasskeySession(runtime, owner);
  } catch (error) {
    if (mode === "register") {
      throw new Error("PASSKEY_CREATED_WALLET_INIT_FAILED", { cause: error });
    }
    throw error;
  }
}
''',
    '''export function normalizePasskeyCredentialMetadata(
  credential: PasskeyCredentialMetadata,
): PasskeyCredentialMetadata {
  return {
    id: credential.id,
    publicKey: credential.publicKey,
    ...(credential.rpId ? { rpId: credential.rpId } : {}),
  };
}

export async function restorePasskeyWallet(
  credential: PasskeyCredentialMetadata,
): Promise<PasskeyWalletSession> {
  const runtime = await loadCircleRuntime();
  const normalizedCredential = normalizePasskeyCredentialMetadata(credential);
  return buildPasskeySession(
    runtime,
    passkeyCredentialToOwner(normalizedCredential),
    normalizedCredential,
  );
}

export async function createPasskeyWallet(
  mode: "register" | "login",
): Promise<PasskeyWalletSession> {
  const runtime = await loadCircleRuntime();
  const credential = await runtime.circle.toWebAuthnCredential({
    transport: runtime.passkeyTransport,
    mode:
      mode === "register"
        ? runtime.circle.WebAuthnMode.Register
        : runtime.circle.WebAuthnMode.Login,
    username:
      mode === "register" ? `arc-tip-jar-${crypto.randomUUID()}` : undefined,
  });
  const credentialMetadata = normalizePasskeyCredentialMetadata(credential);
  const owner = passkeyCredentialToOwner(credentialMetadata);
  try {
    return await buildPasskeySession(runtime, owner, credentialMetadata);
  } catch (error) {
    if (mode === "register") {
      throw new Error("PASSKEY_CREATED_WALLET_INIT_FAILED", { cause: error });
    }
    throw error;
  }
}
''',
    "circle create and restore passkey wallet",
)

circle = replace_once(
    circle,
    '''  onProgress?.("reopening");
  const session = await buildPasskeySession(
    runtime,
    passkeyCredentialToOwner(credential),
  ).catch((error) => {
''',
    '''  onProgress?.("reopening");
  const credentialMetadata = normalizePasskeyCredentialMetadata(credential);
  const session = await buildPasskeySession(
    runtime,
    passkeyCredentialToOwner(credentialMetadata),
    credentialMetadata,
  ).catch((error) => {
''',
    "circle recovered passkey metadata",
)

circle_path.write_text(circle)

app_path = Path("frontend/src/App.tsx")
app = app_path.read_text()

app = replace_once(
    app,
    '''import type { PasskeyWalletSession } from "./circleWallet";
''',
    '''import type {
  PasskeyCredentialMetadata,
  PasskeyWalletSession,
} from "./circleWallet";
''',
    "app circle wallet type import",
)

app = replace_once(
    app,
    '''const BROWSER_WALLET_METADATA_KEY = "arc-tip-jar-browser-wallet";
type SavedBrowserWallet = {
  id?: string;
  rdns?: string;
  address: Address;
};

const EXPLICIT_DISCONNECT_KEY = "arc-tip-jar-explicitly-disconnected";
''',
    '''const BROWSER_WALLET_METADATA_KEY = "arc-tip-jar-browser-wallet";
const PASSKEY_WALLET_METADATA_KEY = "arc-tip-jar-passkey-wallet-v1";

type SavedBrowserWallet = {
  id?: string;
  rdns?: string;
  address: Address;
};

type SavedPasskeyWallet = {
  address: Address;
  credential: PasskeyCredentialMetadata;
};

const EXPLICIT_DISCONNECT_KEY = "arc-tip-jar-explicitly-disconnected";
''',
    "app passkey storage types",
)

app = replace_once(
    app,
    '''function saveBrowserWallet(wallet: InjectedWallet, address: Address) {
  const metadata: SavedBrowserWallet = {
    id: wallet.id,
    rdns: wallet.rdns,
    address: getAddress(address),
  };
  window.localStorage.setItem(BROWSER_WALLET_METADATA_KEY, JSON.stringify(metadata));
}

function shortAddress(address: Address): string {
''',
    '''function saveBrowserWallet(wallet: InjectedWallet, address: Address) {
  const metadata: SavedBrowserWallet = {
    id: wallet.id,
    rdns: wallet.rdns,
    address: getAddress(address),
  };
  window.localStorage.setItem(BROWSER_WALLET_METADATA_KEY, JSON.stringify(metadata));
}

function clearSavedPasskeyWallet() {
  try {
    window.localStorage.removeItem(PASSKEY_WALLET_METADATA_KEY);
  } catch {
    // Storage may be unavailable in hardened browsing modes.
  }
}

function readSavedPasskeyWallet(): SavedPasskeyWallet | null {
  try {
    const raw = window.localStorage.getItem(PASSKEY_WALLET_METADATA_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as {
      address?: unknown;
      credential?: {
        id?: unknown;
        publicKey?: unknown;
        rpId?: unknown;
      };
    };
    const credential = value.credential;
    const validPublicKey =
      typeof credential?.publicKey === "string" &&
      /^0x[0-9a-fA-F]+$/.test(credential.publicKey);
    const validRpId =
      credential?.rpId === undefined || typeof credential.rpId === "string";
    if (
      !isAddress(typeof value.address === "string" ? value.address : "") ||
      typeof credential?.id !== "string" ||
      credential.id.length === 0 ||
      !validPublicKey ||
      !validRpId
    ) {
      clearSavedPasskeyWallet();
      return null;
    }
    return {
      address: getAddress(value.address as string),
      credential: {
        id: credential.id,
        publicKey: credential.publicKey as Hex,
        ...(credential.rpId ? { rpId: credential.rpId } : {}),
      },
    };
  } catch {
    clearSavedPasskeyWallet();
    return null;
  }
}

function savePasskeyWallet(session: PasskeyWalletSession) {
  if (!session.credential) return;
  const metadata: SavedPasskeyWallet = {
    address: getAddress(session.address),
    credential: session.credential,
  };
  try {
    window.localStorage.setItem(
      PASSKEY_WALLET_METADATA_KEY,
      JSON.stringify(metadata),
    );
  } catch {
    // The wallet remains usable for this page even if persistence is blocked.
  }
}

function shortAddress(address: Address): string {
''',
    "app passkey storage helpers",
)

app = replace_once(
    app,
    '''    const saved = readSavedBrowserWallet();
    const wallets = await discoverInjectedWallets();
''',
    '''    const savedPasskey = readSavedPasskeyWallet();
    if (savedPasskey) {
      setIsConnecting(true);
      try {
        const { restorePasskeyWallet } = await import("./circleWallet");
        const session = await restorePasskeyWallet(savedPasskey.credential);
        if (!isAddressEqual(session.address, savedPasskey.address)) {
          clearSavedPasskeyWallet();
          throw new Error("PASSKEY_RESTORE_ADDRESS_MISMATCH");
        }
        savePasskeyWallet(session);
        setBrowserProvider(null);
        setActiveWalletKind("passkey");
        setPasskeySession(session);
        setAccount(session.address);
        setChainId(session.chainId);
        setSelectedNetworkKey("testnet");
        setRecipientInput(session.address);
        setWalletStatus(null);
        return;
      } catch (error) {
        setBrowserProvider(null);
        setAccount(null);
        setChainId(null);
        setPasskeySession(null);
        setActiveWalletKind("browser");
        setWalletStatus(getErrorUiMessage(error));
        return;
      } finally {
        setIsConnecting(false);
      }
    }

    const saved = readSavedBrowserWallet();
    const wallets = await discoverInjectedWallets();
''',
    "app restore passkey before browser wallet",
)

app = replace_once(
    app,
    '''      window.localStorage.removeItem(EXPLICIT_DISCONNECT_KEY);
      saveBrowserWallet(wallet, nextAccount);
''',
    '''      window.localStorage.removeItem(EXPLICIT_DISCONNECT_KEY);
      clearSavedPasskeyWallet();
      saveBrowserWallet(wallet, nextAccount);
''',
    "app browser becomes active preference",
)

app = replace_once(
    app,
    '''  function activatePasskeyWallet(session: PasskeyWalletSession) {
    window.localStorage.removeItem(EXPLICIT_DISCONNECT_KEY);
    setActiveWalletKind("passkey");
''',
    '''  function activatePasskeyWallet(session: PasskeyWalletSession) {
    window.localStorage.removeItem(EXPLICIT_DISCONNECT_KEY);
    window.localStorage.removeItem(BROWSER_WALLET_METADATA_KEY);
    savePasskeyWallet(session);
    setBrowserProvider(null);
    setActiveWalletKind("passkey");
''',
    "app persist activated passkey wallet",
)

app = replace_once(
    app,
    '''      window.localStorage.setItem(EXPLICIT_DISCONNECT_KEY, "true");
      window.localStorage.removeItem(BROWSER_WALLET_METADATA_KEY);
      setPasskeyFundsOpen(false);
''',
    '''      window.localStorage.setItem(EXPLICIT_DISCONNECT_KEY, "true");
      window.localStorage.removeItem(BROWSER_WALLET_METADATA_KEY);
      clearSavedPasskeyWallet();
      setPasskeyFundsOpen(false);
''',
    "app clear passkey on explicit disconnect",
)

app_path.write_text(app)

test_path = Path("frontend/src/circleWallet.test.ts")
test = test_path.read_text()

test = replace_once(
    test,
    '''  isValidRecoveryMnemonic,
  passkeyCredentialToOwner,
''',
    '''  isValidRecoveryMnemonic,
  normalizePasskeyCredentialMetadata,
  passkeyCredentialToOwner,
''',
    "test import metadata normalizer",
)

test = replace_once(
    test,
    '''  it("appends the required Arc Testnet path only to the modular client URL", () => {
''',
    '''  it("keeps only serializable public passkey metadata for reload restore", () => {
    expect(
      normalizePasskeyCredentialMetadata({
        id: "credential-id",
        publicKey: "0x02",
        rpId: "arc-tip-jar.pages.dev",
      }),
    ).toEqual({
      id: "credential-id",
      publicKey: "0x02",
      rpId: "arc-tip-jar.pages.dev",
    });
  });

  it("appends the required Arc Testnet path only to the modular client URL", () => {
''',
    "test public passkey metadata",
)

test_path.write_text(test)

security_test = Path("frontend/src/passkeyPersistence.test.ts")
security_test.write_text('''import { readFileSync } from "node:fs";\nimport { describe, expect, it } from "vitest";\n\ndescribe("Passkey wallet reload persistence", () => {\n  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");\n\n  it("persists only public WebAuthn metadata and restores it before browser-wallet discovery", () => {\n    expect(source).toContain('PASSKEY_WALLET_METADATA_KEY = "arc-tip-jar-passkey-wallet-v1"');\n    expect(source).toContain('const { restorePasskeyWallet } = await import("./circleWallet")');\n    expect(source).toContain("credential: session.credential");\n    expect(source).toContain("clearSavedPasskeyWallet();");\n    expect(source).not.toMatch(/PASSKEY_WALLET_METADATA_KEY[^\\n]*(?:privateKey|mnemonic|seed|secret)/i);\n  });\n});\n''')
