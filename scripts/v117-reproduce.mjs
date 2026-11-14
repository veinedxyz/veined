import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  createWriteStream,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { sourceInventory, checkpoint, sha256 } from "./v117-source.mjs";
const out = resolve(process.argv[2] ?? "");
if (!process.argv[2] || existsSync(join(out, "reproducibility.json")))
  throw Error("NEW_EVIDENCE_DIRECTORY_REQUIRED");
const directory = resolve(
  ".otherbridge/v117-repro",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
mkdirSync(out, { recursive: true });
mkdirSync(directory, { recursive: true });
const hashes = sourceInventory(),
  sourceCheckpoint = checkpoint(hashes);
for (const path of Object.keys(hashes)) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  copyFileSync(path, join(directory, path));
}
writeFileSync(
  join(out, "source-checkpoint.json"),
  JSON.stringify(
    { at: new Date().toISOString(), checkpoint: sourceCheckpoint, hashes },
    null,
    2,
  ) + "\n",
);
const cli = join(
  dirname(process.execPath),
  "node_modules/corepack/dist/pnpm.js",
);
// Minimal inherited process runtime. Credentials and wallet sessions are never copied into reproduction.
const env = {};
for (const [key, value] of Object.entries(process.env))
  if (
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PNPM_HOME|COREPACK_HOME|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|HOMEDRIVE|HOMEPATH)$/i.test(
      key,
    )
  )
    env[key] = value;
env.NEXT_TELEMETRY_DISABLED = "1";
env.OTHERBRIDGE_EVIDENCE_ROOT = join(out, "checks-evidence");
if (existsSync(".env.data.local")) {
  const values = parseEnv(readFileSync(".env.data.local", "utf8"));
  // Only the established isolated local PostgreSQL test variables, in memory.
  for (const key of [
    "OTHERBRIDGE_DATA_DATABASE_URL",
    "OTHERBRIDGE_DATA_MIGRATOR_URL",
    "OTHERBRIDGE_DATA_INDEXER_URL",
    "OTHERBRIDGE_DATA_BACKUP_URL",
    "OTHERBRIDGE_DATA_MONITOR_URL",
    "OTHERBRIDGE_DATA_PSEUDONYM_KEY",
  ])
    if (values[key]) {
      if (
        key.endsWith("URL") &&
        !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(values[key]).hostname,
        )
      )
        throw Error("LOCAL_TEST_DATABASE_REQUIRED");
      env[key] = values[key];
    }
}
const results = [];
async function run(name, args) {
  const log = join(out, name + ".log"),
    stream = createWriteStream(log, { flags: "wx" }),
    startedAt = new Date().toISOString();
  const exitCode = await new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on("error", () => done(-1));
    child.on("close", (code) =>
      stream.end(`\nexit ${code}\n`, () => done(code)),
    );
  });
  results.push({
    name,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    log,
    sha256: sha256(readFileSync(log)),
  });
  writeFileSync(
    join(out, "progress.json"),
    JSON.stringify({ directory, sourceCheckpoint, results }, null, 2) + "\n",
  );
  console.log(name, exitCode);
  return exitCode;
}
let pass =
  (await run("install-root", [
    cli,
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ])) === 0;
if (pass)
  pass =
    (await run("install-providers", [
      cli,
      "--dir",
      "swap-providers",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ])) === 0;
if (pass) {
  // Mandatory unchanged suites plus build, DB, protected safety and deterministic G7 fixture suites.
  pass =
    (await run("checks", [
      "scripts/v116-checks.mjs",
      join(out, "checks"),
      "format",
      "lint",
      "typegen",
      "typecheck",
      "unit",
      "integration",
      "db",
      "i18n",
      "docs",
      "safety",
      "g7",
      "g7-pilot",
      "build",
      "bundle",
      "smoke",
      "production-i18n",
      "g7-e2e",
      "g7-product-e2e",
      "g7-artifacts",
      "fork",
      "browser-security",
      "e2e",
    ])) === 0;
}
const actual = sourceInventory(directory),
  current = sourceInventory();
const sourceStable =
  checkpoint(actual) === sourceCheckpoint &&
  checkpoint(current) === sourceCheckpoint;
const summary = {
  at: new Date().toISOString(),
  directory,
  checkpoint: sourceCheckpoint,
  sourceStable,
  files: Object.keys(hashes).length,
  results,
  productionCredentialsCopied: 0,
  environmentFilesCopied: 0,
  execution: "CLOSED",
  pass: pass && sourceStable,
};
writeFileSync(
  join(out, "reproducibility.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary));
if (!summary.pass) process.exitCode = 1;
