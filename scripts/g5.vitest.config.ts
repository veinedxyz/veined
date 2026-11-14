import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/probes/g5-extra.test.ts"],
    testTimeout: 120000,
  },
});
