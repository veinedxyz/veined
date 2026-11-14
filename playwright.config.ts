import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
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
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 1100 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev:test",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
