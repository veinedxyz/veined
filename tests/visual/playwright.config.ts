import { defineConfig } from "@playwright/test";
import { parseE2EOrigin } from "../../src/server/e2e-origin.mjs";
// Visual QA capture harness (screenshots only, deterministic doubles; never a wallet, signature or live provider).
// Run with UX_CAPTURE_OUT=<dir> and the points simulation/admin environment of tests/visual/run-capture.mjs.
const { origin } = parseE2EOrigin(process.env.OTHERBRIDGE_E2E_ORIGIN);
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.capture\.ts$/,
  outputDir: `${process.env.UX_CAPTURE_OUT ?? "test-results/visual"}/playwright-artifacts`,
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
    trace: "off",
  },
  webServer: {
    command: "node scripts/dev-test.mjs",
    cwd: "../..",
    url: `${origin}/app`,
    reuseExistingServer: true,
    timeout: 180000,
  },
});
