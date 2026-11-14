import { mkdir, cp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1";
await mkdir(`${base}/logs`, { recursive: true });
const directory = resolve(
  ".otherbridge/repro",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(directory, { recursive: true });
for (const file of [
  "src",
  "tests",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "next.config.ts",
  "next-env.d.ts",
  "eslint.config.mjs",
  "vitest.config.ts",
  "playwright.config.ts",
  ".prettierignore",
  ".gitignore",
])
  await cp(file, join(directory, file), { recursive: true });
const cli = join(
  dirname(process.execPath),
  "node_modules/corepack/dist/pnpm.js",
);
const results = [];
for (const args of [["install", "--frozen-lockfile"], ["build"]]) {
  let output = "";
  const child = spawn(process.execPath, [cli, ...args], { cwd: directory });
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exitCode = await new Promise((r) => child.on("exit", r));
  const log = `${base}/logs/reproduce-${args[0]}.log`;
  await writeFile(log, output);
  results.push({ command: `pnpm ${args.join(" ")}`, exitCode, log });
  console.log("clean", args[0], exitCode);
  if (exitCode !== 0) break;
}
await writeFile(
  `${base}/reproducibility.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      directory,
      results,
      result: results.every((r) => r.exitCode === 0) ? "PASS" : "FAIL",
      note: "Fresh dependency tree in new ignored directory; baseline workspace was not deleted or reset.",
    },
    null,
    2,
  ),
);
process.exitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;
