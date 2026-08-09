export type AppPage = "tip" | "bridge";

export function appPageFromHash(hash: string): AppPage {
  if (hash === "#/bridge") return "bridge";
  return "tip";
}
