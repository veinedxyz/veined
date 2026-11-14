import { defineConfig } from "vitest/config";
// Real PostgreSQL integration suite (local isolated Docker stack). Fails closed without a database.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
