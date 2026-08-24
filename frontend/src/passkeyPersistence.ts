import { getAddress, isAddress, type Address, type Hex } from "viem";
import type {
  PasskeyCredentialMetadata,
  PasskeyWalletSession,
} from "./circleWallet";

const PASSKEY_WALLET_METADATA_KEY = "arc-tip-jar-passkey-wallet-v1";

type SavedPasskeyWallet = Readonly<{
  address: Address;
  credential: PasskeyCredentialMetadata;
}>;

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

export function savePasskeyWallet(session: PasskeyWalletSession): boolean {
  if (!session.credential) return false;

  const metadata: SavedPasskeyWallet = {
    address: getAddress(session.address),
    credential: session.credential,
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
