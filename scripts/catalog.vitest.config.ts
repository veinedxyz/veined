import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/probes/catalog-sync.test.ts"], testTimeout: 60000 },
});
