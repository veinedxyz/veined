import { defineConfig } from "@playwright/test";
// In-product G7 pilot E2E: every test starts its own `g7-product-pilot` launcher (normal Otherbridge product on the
// Next.js production runtime serving the local-g7-pilot-test artifact + fixture pilot session, no pilot network
// I/O) and drives the normal Bridge screen with an injected EIP-6963 mock wallet that records every wallet call.
// product-runtime: launcher lifecycle (busy port, repeated start, orphan guard, stop, expiry), every product route
// in pilot mode, restart/stale-session behaviour. product-live-*: opt-in live dry runs (real read-only preflight).
export default defineConfig({
  testDir: ".",
  testMatch: /product-(pilot|runtime|live-dry-run|live-routes)\.spec\.ts/,
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240000,
  retries: 0,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? `${process.cwd()}/test-results/g7-product-pilot`}/e2e-results.json`,
      },
    ],
  ],
  use: {
    viewport: { width: 1440, height: 1100 },
    trace: "retain-on-failure",
  },
});
