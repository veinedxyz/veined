import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
import ts from "eslint-config-next/typescript";
export default defineConfig([
  ...next,
  ...ts,
  globalIgnores([
    ".next/**",
    ".otherbridge/**",
    "evidence/**",
    "next-env.d.ts",
    "test-results/**",
    "playwright-report/**",
    "otherbridge-review-r1-evidence/**", // User-supplied independent harness; not application code.
  ]),
]);
