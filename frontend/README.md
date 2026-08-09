# Arc Tip Jar frontend

A small React/Vite frontend for the Arc Tip Jar contract.

## Local development

```bash
npm ci
npm run dev
```

## Environment variable

The app defaults to the existing Arc Testnet deployment. To override it:

```bash
cp .env.example .env.local
```

```dotenv
VITE_ARC_TIP_JAR_ADDRESS=0xYOUR_CONTRACT_ADDRESS
VITE_CIRCLE_CLIENT_KEY=YOUR_PUBLIC_CIRCLE_CLIENT_KEY
VITE_CIRCLE_CLIENT_URL=https://modular-sdk.circle.com/v1/rpc/w3s/buidl
VITE_BRIDGE_ETHEREUM_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
VITE_BRIDGE_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
VITE_BRIDGE_ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
VITE_BRIDGE_ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
```

This value is public and will be included in the browser bundle.

## Cloudflare Pages

Push the `frontend` directory to GitHub. Then open
Cloudflare Dashboard > Workers & Pages > Create > Pages > Connect to Git and
select the repository.

Use the following build settings:

```text
Production branch: main
Root directory: frontend
Build command: npm run build
Build output directory: dist
```

Set the four `VITE_BRIDGE_*_RPC_URL` variables in Cloudflare for Bridge.
All four are required and there is no fallback to App Kit's shared RPCs.
The sample hosts are already included in `public/_headers`; update the CSP
`connect-src` allowlist if you choose different hosts. Every `VITE_` value
is public and bundled into the site. Never put a private key, seed phrase,
API secret, or privileged RPC credential in a `VITE_` variable.

Cloudflare creates a preview deployment for non-production branches and pull
requests, and automatically deploys `main` after each push. The `public/_headers`
file is copied into the build output and adds browser security headers.

## Circle setup

Create a production Modular Wallets Client Key in Circle Console and register the exact production Passkey domain, `arc-tip-jar.pages.dev`. The `VITE_CIRCLE_CLIENT_KEY` is public browser configuration; never use an API secret, entity secret, seed, or private key there.

The app lazy-loads `@circle-fin/modular-wallets-core`, `@circle-fin/app-kit`, and `@circle-fin/adapter-viem-v2`. Viem is pinned to `2.45.3` to match Modular Wallets SDK `1.0.15`. Passkey operations use Gas Station with `paymaster: true` and never fall back to user-paid gas automatically.

### UI routes

The top navigation contains `#/tip` and `#/bridge`. Hash routing keeps direct navigation compatible with Cloudflare Pages without a catch-all rewrite; the removed `#/wallet` route falls back to Tip Jar. Header, Tip, and Bridge connection actions open one shared modal with Browser Wallet connect, Passkey connect, Passkey creation, and recovery. Passkey creation advances directly to backup setup inside the same modal.

### Recovery

Browser Wallet Recovery is the recommended default. It opens the default injected Browser Wallet directly; EIP-6963 discovery is used only as a fallback when no legacy injected provider is exposed. Recovery requests remain isolated and do not change the active Tip Jar identity. Only public registration metadata is stored locally. The signer seed/private key is never requested. The alternative 12-word recovery phrase exists only in memory while displayed or submitted; the app does not write it to Storage, logs, analytics, or URLs. The phrase is copied to the system clipboard only when the user explicitly selects `Copy 12 words`, and the UI warns the user to clear it afterward. Recovery adds a new Passkey and does not revoke an old one.

Browser Wallet Recovery is marked Beta until MetaMask and Rabby complete the production smoke test.

### Bridge

The Bridge panel supports Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia. The connected Browser Wallet EOA is both the source signer and the Arc recipient; cross-wallet bridging is intentionally not exposed. A Passkey Wallet is Arc-only and must be replaced by a Browser Wallet session before bridging. The Bridge gate opens the EIP-6963 Browser Wallet chooser directly. The panel uses CCTP with `useForwarder: true`, automatically estimates after valid input changes, refreshes estimates every 60 seconds, provides an icon-only manual refresh, and preserves resumable `retryBridge()` handling. App Kit analytics and error reporting are disabled.

The selected source chain's USDC balance is shown before estimation. App Kit public clients are constructed from the four explicit public RPC environment variables; a missing variable disables Bridge with a safe error rather than falling back to a built-in/shared RPC. Browser Wallet writes continue through its selected EIP-1193 provider. A Passkey Smart Account can technically be the Forwarding Service `recipientAddress`, but the current Arc-only Passkey session cannot sign as a Sepolia source and this single-wallet UI does not expose a separate destination.

An active Passkey Wallet exposes a wallet-menu Deposit/Withdraw modal. Its Browser Wallet connection is isolated from the active Tip Jar session; deposits are ordinary native Arc USDC transfers with the 0.01 USDC reserve, while withdrawals are sponsored Passkey user operations.

## Checks

```bash
npm run test:functions
npm run test:unit
npm run typecheck
npm run build
```
