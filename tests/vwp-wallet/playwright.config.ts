// VWP G09: the "no wallet layer configured" build (no Privy App ID, no RainbowKit flag) gets its own isolated dev
// server, because the wallet layer is a build-time choice. Same harness rules as the main suite: workers 1, retries 0,
// loopback origin only, every third-party request recorded and refused.
import { defineConfig } from "@playwright/test";
import { parseE2EOrigin } from "../../src/server/e2e-origin.mjs";
const { origin } = parseE2EOrigin(process.env.OTHERBRIDGE_E2E_ORIGIN);
const evidence =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1";
export default defineConfig({
  testDir: ".",
  outputDir: `${evidence}/vwp-wallet-artifacts`,
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: `${evidence}/vwp-wallet-results.json` }],
  ],
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/dev-test.mjs",
    cwd: "../..",
    url: `${origin}/app`,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      ...(process.env as Record<string, string>),
      NEXT_PUBLIC_VEINED_WALLET_LAYER: "",
      OTHERBRIDGE_E2E_PRIVY: "off",
    },
  },
});
