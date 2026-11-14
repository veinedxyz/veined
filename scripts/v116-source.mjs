import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const ordered = (map) =>
  Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
export const checkpoint = (map) =>
  sha256(Buffer.from(JSON.stringify(ordered(map))));
export function sourceInventory(root = process.cwd()) {
  const hashes = {},
    skip = new Set([
      "node_modules",
      ".git",
      ".next",
      "test-results",
      "playwright-report",
      "__pycache__",
      "secrets",
    ]);
  function walk(p) {
    const absolute = resolve(root, p);
    if (!existsSync(absolute)) return;
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw Error("SOURCE_SYMLINK:" + p);
    if (info.isDirectory()) {
      for (const item of readdirSync(absolute, { withFileTypes: true })) {
        if (
          skip.has(item.name) ||
          item.name.startsWith(".next") ||
          (p === "tests/g7-pilot" && item.name === "evidence")
        )
          continue;
        walk(p + "/" + item.name);
      }
    } else {
      const leaf = p.split("/").at(-1);
      if (
        (leaf.startsWith(".env") && leaf !== ".env.example") ||
        /\.(zip|pyc|tsbuildinfo|pem|key|dump|sqlite)(-|$)/.test(leaf) ||
        p === "release/FINAL_GATE_STATUS.json" ||
        p === "release/candidate.json"
      )
        return;
      hashes[p] = sha256(readFileSync(absolute));
    }
  }
  for (const p of [
    "src",
    "public",
    "scripts",
    "tests",
    "services",
    "packages",
    "swap-providers",
    "infra",
    "docs",
    "content",
    "release",
    "audit",
    "legal",
  ])
    walk(p);
  for (const item of readdirSync(root, { withFileTypes: true }))
    if (
      item.isFile() &&
      (/\.(md|json|ts|mjs)$/.test(item.name) ||
        [
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          ".env.example",
          ".gitignore",
          ".prettierignore",
          ".dockerignore",
        ].includes(item.name)) &&
      item.name !== "next-env.d.ts"
    )
      walk(item.name);
  for (const p of [
    ".otherbridge/EXECUTION_STATE.md",
    ".otherbridge/g7-protected-baseline.txt",
  ])
    walk(p);
  const pointer = readFileSync(
    resolve(root, ".otherbridge/g7-protected-baseline.txt"),
    "utf8",
  ).trim();
  if (
    !/^evidence\/otherbridge-v1-12-1\/[A-Za-z0-9._-]+\/preflight\/protected-hashes\.json$/.test(
      pointer,
    )
  )
    throw Error("ACTIVE_POINTER_INVALID");
  walk(pointer);
  walk(
    pointer.replace(
      "/preflight/protected-hashes.json",
      "/g7-rebaseline/PROTECTED_REBASELINE_REVIEW.json",
    ),
  );
  walk(
    "evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/reserve/route-snapshot-final.json",
  );
  walk("evidence/otherbridge-v1/repair-r1/live");
  return ordered(hashes);
}
