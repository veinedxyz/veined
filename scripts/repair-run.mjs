import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
const [name, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name ?? "") || !args.length)
  throw Error("Use a unique evidence name and pnpm arguments");
const base =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1/repair-r1";
await mkdir(`${base}/logs`, { recursive: true });
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const tracked = git(
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
  "src",
  "public",
  "tests",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "next.config.ts",
  "playwright.config.ts",
  "vitest.config.ts",
  "eslint.config.mjs",
).split("\n");
const snapshot = {};
for (const path of tracked.filter(Boolean))
  snapshot[path] = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const record = {
  at: new Date().toISOString(),
  head: git("rev-parse", "HEAD"),
  status: git("status", "--short"),
  diff: git("diff", "--stat"),
  command: `pnpm ${args.join(" ")}`,
  sourceSha256: snapshot,
};
const pnpm = join(
  dirname(process.execPath),
  "node_modules/corepack/dist/pnpm.js",
);
const child = spawn(process.execPath, [pnpm, ...args], {
  env: { ...process.env, OTHERBRIDGE_EVIDENCE_ROOT: base },
});
let output = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
record.exitCode = await new Promise((resolve) => child.on("exit", resolve));
record.finishedAt = new Date().toISOString();
record.log = `${base}/logs/${name}.log`;
await writeFile(record.log, output, { flag: "wx" });
await writeFile(`${base}/${name}.json`, JSON.stringify(record, null, 2), {
  flag: "wx",
});
process.exitCode = record.exitCode ?? 1;
