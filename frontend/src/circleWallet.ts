import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  verifyMessage,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
  type LocalAccount,
} from "viem";
import {
  createBundlerClient,
  toWebAuthnAccount,
  type WebAuthnAccount,
} from "viem/account-abstraction";
import { validateMnemonic } from "@scure/bip39";
import { generateMnemonic, mnemonicToAccount } from "viem/accounts";
import { english } from "viem/accounts";
import { arcTipJarAbi } from "./abi";
import { arcTestnet } from "./arc";

const DEFAULT_CLIENT_URL = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";
const ARC_TESTNET_CLIENT_PATH = "arcTestnet";

export function getArcModularClientUrl(clientUrl: string): string {
  return clientUrl.replace(/\/+$/, "") + "/" + ARC_TESTNET_CLIENT_PATH;
}

export type CircleReceipt = {
  userOperationHash: Hash;
  transactionHash: Hash;
};

export type PasskeyWalletSession = {
  kind: "passkey";
  address: Address;
  chainId: number;
  sendTip: (args: {
    contractAddress: Address;
    recipient: Address;
    message: string;
    value: bigint;
  }) => Promise<CircleReceipt>;
  claim: (contractAddress: Address) => Promise<CircleReceipt>;
  registerRecovery: (recoveryAddress: Address) => Promise<CircleReceipt>;
};

export type RecoveryRegistration = CircleReceipt & {
  walletAddress: Address;
  recoveryAddress: Address;
};

export type RecoveryResult = CircleReceipt & {
  walletAddress: Address;
  session: PasskeyWalletSession;
};

export function passkeyCredentialToOwner(credential: {
  id: string;
  publicKey: Hex;
  rpId?: string;
}): WebAuthnAccount {
  return toWebAuthnAccount({
    credential,
    rpId: credential.rpId,
  });
}

type CircleRuntime = Awaited<ReturnType<typeof loadCircleRuntime>>;

function getCircleConfig() {
  const clientKey = import.meta.env.VITE_CIRCLE_CLIENT_KEY?.trim();
  const clientUrl =
    import.meta.env.VITE_CIRCLE_CLIENT_URL?.trim() || DEFAULT_CLIENT_URL;
  if (!clientKey) throw new Error("CIRCLE_CLIENT_KEY_MISSING");
  return { clientKey, clientUrl };
}

async function loadCircleRuntime() {
  const circle = await import("@circle-fin/modular-wallets-core");
  const { clientKey, clientUrl } = getCircleConfig();
  const transport = circle.toModularTransport(
    getArcModularClientUrl(clientUrl),
    clientKey,
  );
  const passkeyTransport = circle.toPasskeyTransport(clientUrl, clientKey);
  const modularClient = circle.toCircleModularWalletClient({
    client: createPublicClient({ chain: arcTestnet, transport }),
  });
  return { circle, transport, passkeyTransport, modularClient };
}

function assertSuccessfulReceipt(receipt: {
  success: boolean;
  receipt: { transactionHash: Hash };
}): Hash {
  if (!receipt.success) throw new Error("USER_OPERATION_REVERTED");
  return receipt.receipt.transactionHash;
}

async function buildPasskeySession(
  runtime: CircleRuntime,
  owner: WebAuthnAccount,
): Promise<PasskeyWalletSession> {
  const smartAccount = await runtime.circle.toCircleSmartAccount({
    client: runtime.modularClient,
    owner,
  });
  const bundler = createBundlerClient({
    account: smartAccount,
    chain: arcTestnet,
    transport: runtime.transport,
  });

  const waitForReceipt = async (hash: Hash): Promise<CircleReceipt> => {
    const receipt = await bundler.waitForUserOperationReceipt({ hash });
    return {
      userOperationHash: hash,
      transactionHash: assertSuccessfulReceipt(receipt),
    };
  };

  return {
    kind: "passkey",
    address: getAddress(smartAccount.address),
    chainId: arcTestnet.id,
    async sendTip({ contractAddress, recipient, message, value }) {
      const hash = await bundler.sendUserOperation({
        calls: [
          {
            to: contractAddress,
            value,
            data: encodeFunctionData({
              abi: arcTipJarAbi,
              functionName: "tip",
              args: [recipient, message],
            }),
          },
        ],
        paymaster: true,
      });
      return waitForReceipt(hash);
    },
    async claim(contractAddress) {
      const hash = await bundler.sendUserOperation({
        calls: [
          {
            to: contractAddress,
            data: encodeFunctionData({
              abi: arcTipJarAbi,
              functionName: "claim",
            }),
          },
        ],
        paymaster: true,
      });
      return waitForReceipt(hash);
    },
    async registerRecovery(recoveryAddress) {
      try {
        const recoveryBundler = bundler.extend(runtime.circle.recoveryActions);
        const hash = await recoveryBundler.registerRecoveryAddress({
          account: smartAccount,
          recoveryAddress,
          paymaster: true,
        });
        return await waitForReceipt(hash);
      } catch (error) {
        throw new Error("RECOVERY_REGISTRATION_FAILED", { cause: error });
      }
    },
  };
}

export function isCircleConfigured(): boolean {
  return Boolean(import.meta.env.VITE_CIRCLE_CLIENT_KEY?.trim());
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

export function recoveryProofMessage(args: {
  walletAddress: Address;
  recoveryAddress: Address;
}): string {
  return [
    "Arc Tip Jar recovery signer registration",
    `Smart account: ${getAddress(args.walletAddress)}`,
    `Recovery address: ${getAddress(args.recoveryAddress)}`,
    `Chain ID: ${arcTestnet.id}`,
    "Purpose: prove control of this recovery signer; this is not a transaction.",
  ].join("\n");
}

export async function proveRecoveryAddress(args: {
  provider: EIP1193Provider;
  recoveryAddress: Address;
  walletAddress: Address;
}): Promise<Hex> {
  const walletClient = createWalletClient({
    account: args.recoveryAddress,
    transport: custom(args.provider),
  });
  const message = recoveryProofMessage(args);
  const signature = await walletClient.signMessage({ message });
  const valid = await verifyMessage({
    address: args.recoveryAddress,
    message,
    signature,
  });
  if (!valid) throw new Error("RECOVERY_SIGNATURE_MISMATCH");
  return signature;
}

export async function verifyRecoveryMapping(args: {
  recoveryAddress: Address;
  walletAddress: Address;
}): Promise<boolean> {
  const runtime = await loadCircleRuntime();
  const mappings = await runtime.modularClient.getAddressMapping({
    owner: {
      type: runtime.circle.OwnerIdentifierType.EOA,
      identifier: { address: args.recoveryAddress },
    },
  });
  return mappings.some(
    (mapping) =>
      isAddressEqual(getAddress(mapping.walletAddress), args.walletAddress) &&
      mapping.owner.type === runtime.circle.OwnerIdentifierType.EOA &&
      isAddressEqual(
        getAddress(mapping.owner.identifier.address),
        args.recoveryAddress,
      ),
  );
}

export async function registerBrowserRecovery(args: {
  session: PasskeyWalletSession;
  provider: EIP1193Provider;
  recoveryAddress: Address;
}): Promise<RecoveryRegistration> {
  try {
    await proveRecoveryAddress({
      provider: args.provider,
      recoveryAddress: args.recoveryAddress,
      walletAddress: args.session.address,
    });
  } catch (error) {
    throw new Error("RECOVERY_SIGNATURE_FAILED", { cause: error });
  }
  const receipt = await args.session.registerRecovery(args.recoveryAddress);
  const mappingMatches = await verifyRecoveryMapping({
    recoveryAddress: args.recoveryAddress,
    walletAddress: args.session.address,
  });
  if (!mappingMatches) throw new Error("RECOVERY_MAPPING_MISMATCH");
  return {
    ...receipt,
    walletAddress: args.session.address,
    recoveryAddress: args.recoveryAddress,
  };
}

export function createRecoveryMnemonic(): {
  mnemonic: string;
  account: LocalAccount;
} {
  const mnemonic = generateMnemonic(english, 128);
  return { mnemonic, account: mnemonicToAccount(mnemonic) };
}

export function recoveryAccountFromMnemonic(mnemonic: string): LocalAccount {
  const normalized = normalizeRecoveryMnemonic(mnemonic);
  if (!validateMnemonic(normalized, english)) {
    throw new Error("RECOVERY_PHRASE_INVALID");
  }
  return mnemonicToAccount(normalized);
}

export function normalizeRecoveryMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidRecoveryMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeRecoveryMnemonic(mnemonic), english);
}

export async function browserWalletToRecoveryAccount(args: {
  provider: EIP1193Provider;
  address: Address;
}): Promise<LocalAccount> {
  const walletClient = createWalletClient({
    account: args.address,
    chain: arcTestnet,
    transport: custom(args.provider),
  });
  const circle = await import("@circle-fin/modular-wallets-core");
  return circle.walletClientToLocalAccount(walletClient);
}

export function selectRecoveryWalletAddress(
  mappings: Array<{ walletAddress: Hex }>,
  expectedWalletAddress?: Address,
): Address {
  const matchingMappings = expectedWalletAddress
    ? mappings.filter((candidate) =>
        isAddressEqual(
          getAddress(candidate.walletAddress),
          expectedWalletAddress,
        ),
      )
    : mappings;
  if (matchingMappings.length > 1 && !expectedWalletAddress) {
    throw new Error("RECOVERY_MAPPING_AMBIGUOUS");
  }
  const mapping = matchingMappings[0];
  if (!mapping) throw new Error("RECOVERY_MAPPING_NOT_FOUND");
  return getAddress(mapping.walletAddress);
}

export async function recoverPasskeyWallet(
  recoveryOwner: LocalAccount,
  expectedWalletAddress?: Address,
): Promise<RecoveryResult> {
  const runtime = await loadCircleRuntime();
  const mappings = await runtime.modularClient.getAddressMapping({
    owner: {
      type: runtime.circle.OwnerIdentifierType.EOA,
      identifier: { address: recoveryOwner.address },
    },
  });
  const walletAddress = selectRecoveryWalletAddress(
    mappings,
    expectedWalletAddress,
  );

  const temporarySmartAccount = await runtime.circle.toCircleSmartAccount({
    client: runtime.modularClient,
    owner: recoveryOwner,
  });
  if (!isAddressEqual(temporarySmartAccount.address, walletAddress)) {
    throw new Error("RECOVERY_SMART_ACCOUNT_MISMATCH");
  }

  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: custom({
      request: ({ method, params }) =>
        fetch("/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
          .then((response) => response.json())
          .then((payload) => {
            if (payload.error) throw new Error(payload.error.message);
            return payload.result;
          }),
    }),
  });
  const code = (await publicClient.request({
    method: "eth_getCode",
    params: [walletAddress, "latest"],
  })) as Hex;
  if (code === "0x") throw new Error("RECOVERY_SMART_ACCOUNT_NOT_DEPLOYED");

  const credential = await runtime.circle.toWebAuthnCredential({
    transport: runtime.passkeyTransport,
    mode: runtime.circle.WebAuthnMode.Register,
    username: `arc-tip-jar-recovery-${crypto.randomUUID()}`,
  });
  const recoveryBundler = createBundlerClient({
    account: temporarySmartAccount,
    chain: arcTestnet,
    transport: runtime.transport,
  }).extend(runtime.circle.recoveryActions);
  const hash = await recoveryBundler.executeRecovery({
    account: temporarySmartAccount,
    credential,
    paymaster: true,
  });
  const receipt = await recoveryBundler.waitForUserOperationReceipt({ hash });
  const transactionHash = assertSuccessfulReceipt(receipt);
  const session = await buildPasskeySession(
    runtime,
    passkeyCredentialToOwner(credential),
  );
  if (!isAddressEqual(session.address, walletAddress)) {
    throw new Error("RECOVERED_WALLET_MISMATCH");
  }
  return {
    userOperationHash: hash,
    transactionHash,
    walletAddress,
    session,
  };
}
