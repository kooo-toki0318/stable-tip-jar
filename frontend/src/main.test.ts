import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("application bootstrap ordering", () => {
  it("scrubs a Claim Link before loading React, i18n, or the app", () => {
    const mainSource = readFileSync(
      new URL("./main.tsx", import.meta.url),
      "utf8",
    );
    const bootstrapIndex = mainSource.indexOf("bootstrapClaimLink()");
    const unsafeGuardIndex = mainSource.indexOf(
      'claimLinkBootstrap.status === "unsafe-url"',
    );
    const preflightImportIndex = mainSource.indexOf(
      'import("./claimLinks/preflight")',
    );
    const renderImportIndex = mainSource.indexOf('import("./renderApp")');

    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(unsafeGuardIndex).toBeGreaterThan(bootstrapIndex);
    expect(preflightImportIndex).toBeGreaterThan(unsafeGuardIndex);
    expect(renderImportIndex).toBeGreaterThan(preflightImportIndex);
    expect(mainSource).not.toMatch(/from ["']react/);
    expect(mainSource).not.toContain('import "./i18n"');
    expect(mainSource).not.toContain('from "./App"');
  });

  it("keeps all UI imports behind the dynamic render boundary", () => {
    const renderSource = readFileSync(
      new URL("./renderApp.tsx", import.meta.url),
      "utf8",
    );

    expect(renderSource).toContain('from "react"');
    expect(renderSource).toContain('import "./i18n"');
    expect(renderSource).toContain('from "./App"');
  });
});
