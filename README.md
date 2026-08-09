# Arc Tip Jar

Arc Tip Jar is a recipient-based tipping dApp built on Arc Testnet. It lets
anyone send native USDC to a wallet-specific tip jar with a short onchain
message. Each recipient controls their own balance and can claim it directly
from the same wallet address.

## Live app

- App: https://arc-tip-jar.pages.dev/
- Contract: [0x44FD57...4E8668](https://testnet.arcscan.app/address/0x44FD57BaeaAC3D2F0a20a8032840E00bd44E8668)
- Network: Arc Testnet (chain ID `5042002`)

> Arc Tip Jar is an experimental testnet application. Testnet USDC has no
> real-world value.

## What it does

### Send tips to any wallet

Connect an EVM wallet, enter a recipient address, choose an amount, and attach
an optional message. The recipient does not need to be connected when the tip
is sent.

The amount controls include:

- Quick presets for 1, 5, and 10 USDC
- A percentage slider based on the connected wallet's spendable balance
- A small USDC reserve so the sender can still pay Arc gas
- A **Use my address** shortcut for self-testing

### Recipient-specific tip jars

Each wallet address has its own independent onchain jar. The contract tracks:

- Current claimable USDC balance
- Current unclaimed tip count
- Lifetime USDC received
- Lifetime tip count
- Recent tips and their messages
- Claim amount and timestamp history

Selecting a recipient in the app shows only that recipient's totals and
activity.

### Claim without an administrator

There is no shared owner account that distributes funds. A recipient claims
their own jar by connecting the exact wallet address that received the tips.
The contract sends the entire claimable balance to that wallet and records the
claim onchain.

Other wallets cannot claim a recipient's balance.

## How it works

1. A sender calls `tip(recipient, message)` and includes native USDC.
2. The contract credits the recipient's claimable balance and stores the tip.
3. The recipient connects the matching wallet and calls `claim()`.
4. The contract clears that recipient's current balance, transfers the USDC,
   and adds a timestamped claim record.

All balances and histories are isolated by recipient address.

## Contract design

The contract is intentionally small and uses a pull-payment model:

- Recipients withdraw their own funds instead of receiving an automatic push
- Claim state is updated before transferring funds
- Claim execution is protected by a reentrancy guard
- Zero-value tips and zero-address recipients are rejected
- Messages are limited to 280 UTF-8 bytes
- A failed transfer reverts the full claim

The deployed contract is not upgradeable. Future contract changes require a
new deployment and an explicit frontend address update. This keeps the trust
model simple and avoids an administrator-controlled upgrade path.

## Frontend

The frontend is a React, TypeScript, Vite, and viem application deployed on
Cloudflare Pages.

It includes:

- Injected wallet support for wallets such as MetaMask and Rabby
- Arc Testnet network detection and switching
- Recipient address validation
- Wallet-balance-aware amount selection
- Recipient totals, recent tips, and claim history
- A same-origin Cloudflare Pages RPC proxy to avoid browser CORS issues and
  reduce direct RPC request bursts
- Responsive layouts for desktop and mobile

## Arc-native wallet and bridge features

The frontend also supports Circle Modular Wallets on Arc Testnet:

- Browser Wallet and Passkey Smart Account as separate active wallet modes
- Gas Station-sponsored Passkey Tip, Claim, and Recovery user operations
- Native Arc USDC deposit/withdraw between an active Passkey Wallet and a separately connected Browser Wallet
- Browser Wallet Recovery (Beta) or an in-memory 12-word recovery phrase
- CCTP Bridge from Ethereum, Base, and Arbitrum Sepolia to the active Arc address
- Circle Forwarding Service for destination minting without an Arc-side wallet switch

The interface uses two hash-routed surfaces: `#/tip` for Tip/Claim and `#/bridge` for CCTP. Wallet connection, Passkey creation, backup setup, and recovery share one modal opened from either page. The Tip page also explains Passkey benefits when disconnected and promotes Passkey Wallets while a Browser Wallet is active.

Recovery adds a new Passkey owner; it does not remove a lost old Passkey. Recovery provider requests remain isolated from the wallet currently driving the Tip Jar dashboard. Browser Wallet Recovery opens the default injected wallet directly and still requires the documented MetaMask/Rabby production smoke test. The current Bridge flow is intentionally single-wallet: the connected Browser Wallet EOA is both the Sepolia source and the Arc recipient. Passkey Wallet sessions are Arc-only and must switch to a Browser Wallet before bridging.

The Bridge shows the connected EOA's USDC balance on the selected source chain and uses explicit environment-configured RPCs for every source plus Arc; it never falls back to App Kit shared RPCs. A Passkey Smart Account can technically be a Forwarding Service recipient, but the current Arc-only Passkey session cannot sign as a Sepolia source and cross-wallet bridge destinations are not exposed. When a Passkey Wallet is active, its wallet menu provides an isolated Browser Wallet session for native Arc USDC deposits and withdrawals.

## Repository structure

| Path                           | Purpose                                      |
| ------------------------------ | -------------------------------------------- |
| `src/ArcTipJar.sol`            | Recipient-based Tip Jar smart contract       |
| `test/ArcTipJar.t.sol`         | Contract behavior and security tests         |
| `script/DeployArcTipJar.s.sol` | Arc deployment script                        |
| `frontend/`                    | React frontend and Cloudflare Pages Function |

## Test status

The current contract test suite covers recipient isolation, claims, claim
history, self-tips, message limits, invalid recipients, zero-value tips, and
unauthorized claim attempts.

Current status: **12 tests passing**.

## License

The smart contract source is licensed under MIT via its SPDX identifier.
