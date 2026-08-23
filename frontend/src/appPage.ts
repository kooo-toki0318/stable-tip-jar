export type AppPage = "tip" | "links" | "claim" | "bridge";

export function appPageFromHash(hash: string): AppPage {
  if (hash === "#/links") return "links";
  if (hash === "#/claim" || hash.startsWith("#/claim/v1/")) {
    return "claim";
  }
  if (hash === "#/bridge") return "bridge";
  return "tip";
}
