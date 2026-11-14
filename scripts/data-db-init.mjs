// Generates the git-ignored local data-plane secrets once. Never prints or commits them.
// V1.5: an existing file is upgraded additively (missing monitor/backup/metrics keys are appended);
// existing values are never rewritten.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const file = ".env.data.local";
const ignored = (() => {
  try {
    execFileSync("git", ["check-ignore", "-q", file]);
    return true;
  } catch {
    return false;
  }
})();
if (!ignored) throw Error("REFUSING: .env.data.local is not git-ignored");
const secret = () => randomBytes(24).toString("base64url");
const host = "127.0.0.1:55471/otherbridge_data";
function v15Lines() {
  const monitor = secret(),
    backup = secret();
  return [
    `OTHERBRIDGE_PG_MONITOR_PASSWORD=${monitor}`,
    `OTHERBRIDGE_PG_BACKUP_PASSWORD=${backup}`,
    `OTHERBRIDGE_DATA_MONITOR_URL=postgres://otherbridge_monitor:${monitor}@${host}`,
    `OTHERBRIDGE_DATA_BACKUP_URL=postgres://otherbridge_backup:${backup}@${host}`,
    `OTHERBRIDGE_METRICS_TOKEN=${randomBytes(32).toString("base64url")}`,
  ];
}
const keysOf = (lines) =>
  lines
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => l.split("=")[0]);
if (existsSync(file)) {
  const text = await readFile(file, "utf8");
  const have = new Set(keysOf(text.split(/\r?\n/)));
  const missing = v15Lines().filter((l) => !have.has(l.split("=")[0]));
  if (missing.length)
    await appendFile(
      file,
      `${text.endsWith("\n") ? "" : "\n"}# V1.5 monitor/backup roles and internal metrics token (generated).\n${missing.join("\n")}\n`,
    );
  console.log(
    JSON.stringify({
      file,
      created: false,
      appended: keysOf(missing),
      keys: [...have, ...keysOf(missing)],
    }),
  );
  process.exit(0);
}
const owner = secret(),
  api = secret(),
  indexer = secret();
const lines = [
  "# Local-only Otherbridge data plane secrets (generated; git-ignored; never commit).",
  `OTHERBRIDGE_PG_OWNER_PASSWORD=${owner}`,
  `OTHERBRIDGE_PG_API_PASSWORD=${api}`,
  `OTHERBRIDGE_PG_INDEXER_PASSWORD=${indexer}`,
  `OTHERBRIDGE_DATA_MIGRATOR_URL=postgres://otherbridge_owner:${owner}@${host}`,
  `OTHERBRIDGE_DATA_INDEXER_URL=postgres://otherbridge_indexer:${indexer}@${host}`,
  `OTHERBRIDGE_DATA_DATABASE_URL=postgres://otherbridge_api:${api}@${host}`,
  `OTHERBRIDGE_DATA_PSEUDONYM_KEY=${randomBytes(36).toString("base64url")}`,
  "OTHERBRIDGE_RATE_LIMIT_BACKEND=postgres",
  ...v15Lines(),
];
await writeFile(file, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ file, created: true, keys: keysOf(lines) }));
