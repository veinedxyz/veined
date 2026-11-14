import { spawn } from "node:child_process";
import {
  createWriteStream,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { registerProcess } from "./lib/process-identity.mjs";
const [outArg, ...wanted] = process.argv.slice(2);
if (!outArg)
  throw Error(
    "USAGE: node scripts/v116-checks.mjs <new-evidence-directory> [gate...]",
  );
const out = resolve(outArg);
if (existsSync(join(out, "checks.json")))
  throw Error("EVIDENCE_ALREADY_EXISTS");
mkdirSync(out, { recursive: true });
const pnpm = join(
  dirname(process.execPath),
  "node_modules/corepack/dist/pnpm.js",
);
const ts = [
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
  "--import",
  "./scripts/ts-hooks.mjs",
];
const p = (...args) => [pnpm, ...args];
const steps = {
  format: p("format:check"),
  lint: p("lint"),
  typegen: ["scripts/next-pinned.mjs", "typegen"],
  typecheck: p("typecheck"),
  unit: p("test"),
  integration: p("test:integration"),
  db: p("test:db"),
  i18n: p("i18n:check"),
  docs: p("docs:check"),
  safety: ["scripts/verify-safety.mjs"],
  g7: [...ts, "scripts/g7-safety-scan.ts", join(out, "g7.json")],
  "g7-pilot": [...ts, "scripts/g7-pilot-safety.ts", join(out, "g7-pilot.json")],
  build: p("build"),
  bundle: ["scripts/measure-bundle.mjs"],
  smoke: ["scripts/production-smoke.mjs"],
  "production-i18n": ["scripts/production-i18n.mjs"],
  "production-v13": ["scripts/production-v13.mjs"],
  "g7-e2e": [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "tests/g7-pilot/playwright.config.ts",
  ],
  "g7-product-e2e": [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "tests/g7-pilot/product.playwright.config.ts",
  ],
  "g7-artifacts": [
    ...ts,
    "scripts/g7-pilot-artifacts.ts",
    join(out, "g7-artifacts.json"),
  ],
  fork: [...ts, "scripts/v116-fork-replay.mjs", join(out, "fork")],
  "browser-security": ["scripts/v116-browser-security.mjs"],
  ui: ["scripts/v116-ui.mjs", join(out, "ui")],
  e2e: ["scripts/e2e-chunks.mjs", "run", join(out, "e2e"), "6"],
};
if (wanted.some((n) => !steps[n])) throw Error("UNKNOWN_GATE");
const result = {
  startedAt: new Date().toISOString(),
  cwd: process.cwd(),
  node: process.version,
  steps: [],
  execution: "CLOSED",
};
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const lockBefore = {
  root: hash("pnpm-lock.yaml"),
  provider: hash("swap-providers/pnpm-lock.yaml"),
};
for (const [name, args] of Object.entries(steps)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const log = join(out, name + ".log"),
    startedAt = new Date().toISOString(),
    stream = createWriteStream(log, { flags: "wx" });
  const environment = {
    ...process.env,
    OTHERBRIDGE_EVIDENCE_ROOT: join(out, name + "-evidence"),
  };
  // Explicit reproduction-only scope: database credentials belong to the DB
  // suite, never to in-memory API fixtures or production browser processes.
  if (
    environment.OTHERBRIDGE_TEST_DATABASE_SCOPE === "db-only" &&
    name !== "db"
  )
    for (const key of [
      "OTHERBRIDGE_DATA_DATABASE_URL",
      "OTHERBRIDGE_DATA_MIGRATOR_URL",
      "OTHERBRIDGE_DATA_INDEXER_URL",
      "OTHERBRIDGE_DATA_BACKUP_URL",
      "OTHERBRIDGE_DATA_MONITOR_URL",
      "OTHERBRIDGE_DATA_PSEUDONYM_KEY",
    ])
      delete environment[key];
  delete environment.OTHERBRIDGE_G7_CANDIDATE_SELECTION;
  stream.write(`node ${args.join(" ")}\nstartedAt ${startedAt}\n`);
  const exitCode = await new Promise((done) => {
    const child = spawn(process.execPath, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    if (process.env.OTHERBRIDGE_PROCESS_REGISTRY) registerProcess(child.pid);
    child.on("error", () => done(-1));
    child.on("close", (code) =>
      stream.end(`\nexit ${code}\n`, () => done(code)),
    );
  });
  result.steps.push({
    name,
    command: ["node", ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    log,
    sha256: hash(log),
  });
  writeFileSync(
    join(out, "checks.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(`${name}: exit ${exitCode}`);
}
result.finishedAt = new Date().toISOString();
result.lockUnchanged =
  lockBefore.root === hash("pnpm-lock.yaml") &&
  lockBefore.provider === hash("swap-providers/pnpm-lock.yaml");
result.pass =
  result.lockUnchanged && result.steps.every((s) => s.exitCode === 0);
writeFileSync(join(out, "checks.json"), JSON.stringify(result, null, 2) + "\n");
if (!result.pass) process.exitCode = 1;
