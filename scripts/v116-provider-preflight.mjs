import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const child = spawn(
  process.execPath,
  [
    ...(existsSync(".env.local") ? ["--env-file=.env.local"] : []),
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    "./scripts/ts-hooks.mjs",
    "scripts/v116-provider-preflight.ts",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => (process.exitCode = code ?? 1));
