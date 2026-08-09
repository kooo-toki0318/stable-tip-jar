export type AppPage = "tip" | "wallet" | "bridge";

export function appPageFromHash(hash: string): AppPage {
  if (hash === "#/wallet") return "wallet";
  if (hash === "#/bridge") return "bridge";
  return "tip";
}
