import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "manual.spec.ts",
  outputDir: "../../../evidence/e2e-artifacts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "../../../evidence/e2e-results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3470",
    viewport: { width: 1440, height: 1050 },
    trace: "retain-on-failure",
  },
});
