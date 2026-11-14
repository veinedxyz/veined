// In-product pilot suites run the launcher on the Next.js production runtime, which serves the separate
// local-g7-pilot-test artifact (test-only Privy App ID). Build it once if it is missing or stale.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export default function globalSetup() {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "./scripts/ts-hooks.mjs",
      "scripts/g7-pilot-build.ts",
      "--profile",
      "local-g7-pilot-test",
      "--if-stale",
    ],
    { cwd: REPO, stdio: "inherit" },
  );
  if (r.status !== 0)
    throw new Error(`local-g7-pilot-test build failed (${r.status})`);
}
