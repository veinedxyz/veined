import { defineConfig } from "vitest/config";
// Explicit opt-in read-only probe, separate from deterministic acceptance tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/probes/live-native.test.ts"],
    testTimeout: 120000,
  },
});
