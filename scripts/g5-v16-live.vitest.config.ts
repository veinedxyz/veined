import { defineConfig } from "vitest/config";
// V1.6 explicit opt-in live read-only probe of the application path; never part of acceptance runs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/probes/g5-v16-live.test.ts"],
    testTimeout: 180000,
  },
});
