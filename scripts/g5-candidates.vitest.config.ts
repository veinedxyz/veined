import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/probes/g5-candidates.test.ts"],
    testTimeout: 180000,
  },
});
