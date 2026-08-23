import {
  bootstrapClaimLink,
  discardClaimLinkSecret,
} from "./claimLinks/bootstrap";

const claimLinkBootstrap = bootstrapClaimLink();

if (claimLinkBootstrap.status === "unsafe-url") {
  document
    .getElementById("root")
    ?.replaceChildren(
      "Claim Link could not be opened safely. Close this tab.",
    );
} else {
  const preflight =
    claimLinkBootstrap.status === "ready"
      ? import("./claimLinks/preflight")
          .then(({ preflightClaimLink }) =>
            preflightClaimLink(claimLinkBootstrap),
          )
          .catch(() => {
            discardClaimLinkSecret();
            return { status: "invalid-link" } as const;
          })
      : Promise.resolve(claimLinkBootstrap);

  void preflight.then(async (verifiedBootstrap) => {
    const { renderApp } = await import("./renderApp");
    renderApp(verifiedBootstrap);
  });
}
