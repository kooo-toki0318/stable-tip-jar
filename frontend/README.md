# Arc Tip Jar frontend

A small React/Vite frontend for the Arc Tip Jar contract.

## Local development

```bash
npm install
npm run dev
```

## Environment variable

The app defaults to the existing Arc Testnet deployment. To override it:

```bash
cp .env.example .env.local
```

```dotenv
VITE_ARC_TIP_JAR_ADDRESS=0xYOUR_CONTRACT_ADDRESS
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

No environment variable is required for the current deployment because the
verified testnet contract address is the default. If you set
`VITE_ARC_TIP_JAR_ADDRESS` in Cloudflare under Settings > Environment
variables, remember that every `VITE_` value is public and bundled into the
site. Never put a private key, seed phrase, API secret, or privileged RPC
credential in a `VITE_` variable.

Cloudflare creates a preview deployment for non-production branches and pull
requests, and automatically deploys `main` after each push. The `public/_headers`
file is copied into the build output and adds browser security headers.
