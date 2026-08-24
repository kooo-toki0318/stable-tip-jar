import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ClaimLinkBootstrapResult } from "./claimLinks/bootstrap";
import "./i18n";
import App from "./App";
import "./styles.css";
import "./claimLinkPolish.css";

export function renderApp(
  claimLinkBootstrap: ClaimLinkBootstrapResult,
): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App claimLinkBootstrap={claimLinkBootstrap} />
    </StrictMode>,
  );
}
