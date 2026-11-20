import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "visual.spec.ts",
  outputDir: "../../../evidence/visual-artifacts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: `../../../evidence/visual-${process.env.VISUAL_PHASE ?? "after"}.json`,
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:3470",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
});
