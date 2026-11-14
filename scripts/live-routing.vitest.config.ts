import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/probes/live-routing.test.ts"],
    testTimeout: 90000,
  },
});
