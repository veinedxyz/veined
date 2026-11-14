import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1";
await mkdir(`${base}/logs`, { recursive: true });
const pnpm = join(
  dirname(process.execPath),
  "node_modules/corepack/dist/pnpm.js",
);
const commands = [
  ["install", "--frozen-lockfile"],
  ["format:check"],
  ["lint"],
  ["typecheck"],
  ["test"],
  ["test:integration"],
  ["verify:safety"],
  ["build"],
];
const results = [];
for (const args of commands) {
  const at = new Date().toISOString();
  const child = spawn(process.execPath, [pnpm, ...args], { env: process.env });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const log = `${base}/logs/${args[0].replace(":", "-")}.log`;
  await writeFile(log, output);
  results.push({ command: `pnpm ${args.join(" ")}`, at, exitCode: code, log });
  console.log(args[0], code);
  if (code !== 0) break;
}
await writeFile(`${base}/commands.json`, JSON.stringify(results, null, 2));
process.exitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;
