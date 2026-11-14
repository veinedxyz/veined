import { defineConfig } from "@playwright/test";
// G7 pilot harness E2E: every test starts its own fixture-mode harness process (no network) and drives the real
// local page with an injected EIP-6963 mock wallet that records every wallet call.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  // The in-product suites run under product.playwright.config.ts (production runtime + pilot test artifact).
  testIgnore: /product-[a-z-]+\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  retries: 0,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? `${process.cwd()}/test-results/g7-pilot`}/e2e-results.json`,
      },
    ],
  ],
  use: {
    viewport: { width: 1280, height: 1000 },
    trace: "retain-on-failure",
  },
});
