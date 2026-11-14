import { defineConfig } from "@playwright/test";
import { parseE2EOrigin } from "./src/server/e2e-origin.mjs";
const { origin } = parseE2EOrigin(process.env.OTHERBRIDGE_E2E_ORIGIN);
export default defineConfig({
  testDir: "./tests/e2e",
  // Each evidence run owns its browser artifacts; a sibling run cannot delete its traces during startup cleanup.
  outputDir: `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1"}/playwright-artifacts`,
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  retries: 0,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1"}/e2e-results.json`,
      },
    ],
  ],
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/dev-test.mjs",
    // Wait for the application route to compile before timing client navigation.
    // A ready marketing page alone does not establish application readiness.
    url: `${origin}/app`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
