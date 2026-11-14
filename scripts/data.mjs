// Launches TypeScript data-plane services with Node's type transform and local git-ignored env.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const [entry, ...args] = process.argv.slice(2);
const target =
  entry === "api"
    ? "services/data-api.ts"
    : entry === "ops-exporter"
      ? "services/ops-exporter.ts"
      : entry?.startsWith("backup:")
        ? "services/backup.ts"
        : "services/data.ts";
const child = spawn(
  process.execPath,
  [
    ...(existsSync(".env.data.local") ? ["--env-file=.env.data.local"] : []),
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    "./scripts/ts-hooks.mjs",
    target,
    ...(entry === "api" || entry === "ops-exporter" ? args : [entry, ...args]),
  ],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
// Never leave an orphaned service if this wrapper exits first.
process.on("exit", () => {
  if (child.exitCode === null) child.kill();
});
child.on("exit", (code) => process.exit(code ?? 1));
