import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "recovery.spec.ts",
  outputDir: "../../../evidence/recovery-artifacts",
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 20000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "../../../evidence/recovery-e2e.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3470",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
});
