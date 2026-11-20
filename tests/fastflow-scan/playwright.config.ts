import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 15000 },
  outputDir: "../../../evidence/fastflow-artifacts",
  reporter: [
    ["list"],
    ["json", { outputFile: "../../../evidence/fastflow-e2e.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3470",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
});
