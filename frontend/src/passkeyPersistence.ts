import { getAddress, isAddress, type Address, type Hex } from "viem";

export type PasskeyCredentialMetadata = Readonly<{
  id: string;
  publicKey: Hex;
  rpId?: string;
}>;

export type SavedPasskeyWallet = Readonly<{
  address: Address;
  credential: PasskeyCredentialMetadata;
}>;

const PASSKEY_WALLET_METADATA_KEY = "arc-tip-jar-passkey-wallet-v1";

export function clearSavedPasskeyWallet(): void {
  try {
    window.localStorage.removeItem(PASSKEY_WALLET_METADATA_KEY);
  } catch {
    // Storage may be unavailable in hardened browsing modes.
  }
}

export function readSavedPasskeyWallet(): SavedPasskeyWallet | null {
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
    const address = typeof value.address === "string" ? value.address : "";
    const publicKey =
      typeof credential?.publicKey === "string" ? credential.publicKey : "";
    const rpId = credential?.rpId;

    if (
      !isAddress(address) ||
      typeof credential?.id !== "string" ||
      credential.id.length === 0 ||
      !/^0x[0-9a-fA-F]+$/.test(publicKey) ||
      (rpId !== undefined && typeof rpId !== "string")
    ) {
      clearSavedPasskeyWallet();
      return null;
    }

    return {
      address: getAddress(address),
      credential: {
        id: credential.id,
        publicKey: publicKey as Hex,
        ...(rpId ? { rpId } : {}),
      },
    };
  } catch {
    clearSavedPasskeyWallet();
    return null;
  }
}

export function savePasskeyWallet(
  address: Address,
  credential: PasskeyCredentialMetadata,
): boolean {
  const metadata: SavedPasskeyWallet = {
    address: getAddress(address),
    credential,
  };

  try {
    window.localStorage.setItem(
      PASSKEY_WALLET_METADATA_KEY,
      JSON.stringify(metadata),
    );
    return true;
  } catch {
    return false;
  }
}
