import { defineConfig } from "vitest/config";
// Explicit opt-in, fixed public address, real RPC only. Not part of offline tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/probes/g5-funded-address.test.ts"],
    testTimeout: 180000,
  },
});
