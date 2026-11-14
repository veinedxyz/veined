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
import { sourceInventory, checkpoint, sha256 } from "./v116-source.mjs";
const base = resolve(
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? process.argv[2] ?? "",
);
if (!process.env.OTHERBRIDGE_EVIDENCE_ROOT && !process.argv[2])
  throw Error("NEW_EVIDENCE_DIRECTORY_REQUIRED");
if (existsSync(join(base, "reproducibility.json")))
  throw Error("EXISTING_EVIDENCE_REFUSED");
const directory = resolve(
  ".otherbridge/v116-repro",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
if (!/^D:[\\/]/i.test(directory)) throw Error("FRESH_D_COPY_REQUIRED");
mkdirSync(base, { recursive: true });
mkdirSync(directory, { recursive: true });
const hashes = sourceInventory(),
  sourceCheckpoint = checkpoint(hashes);
for (const file of Object.keys(hashes)) {
  mkdirSync(dirname(join(directory, file)), { recursive: true });
  copyFileSync(file, join(directory, file));
}
// No generated type files are copied. The checks run the installed Next typegen
// command, so this also works from the source-only auditor archive.
writeFileSync(
  join(base, "source-copy-checkpoint.json"),
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
const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
delete environment.OTHERBRIDGE_G7_CANDIDATE_SELECTION;
// Only local isolated test DB variables, injected in memory; no .env is copied or printed.
if (existsSync(".env.data.local")) {
  const { parseEnv } = await import("node:util");
  const values = parseEnv(readFileSync(".env.data.local", "utf8"));
  for (const [k, v] of Object.entries(values))
    if (k.startsWith("OTHERBRIDGE_")) environment[k] = v;
}
const results = [];
async function run(name, args) {
  const log = join(base, name + ".log"),
    stream = createWriteStream(log, { flags: "wx" }),
    startedAt = new Date().toISOString();
  stream.write(`node ${args.join(" ")}\n`);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env: environment,
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
    command: ["node", ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: code,
    log,
    sha256: sha256(readFileSync(log)),
  });
  console.log(name, code);
  return code;
}
let proceed =
  (await run("install-root", [
    cli,
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ])) === 0;
if (proceed)
  proceed =
    (await run("install-providers", [
      cli,
      "--dir",
      "swap-providers",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ])) === 0;
if (proceed)
  await run("checks", ["scripts/v116-checks.mjs", join(base, "checks")]);
const actual = sourceInventory(directory),
  current = sourceInventory();
const drift = Object.keys(hashes).filter((p) => actual[p] !== hashes[p]);
const sourceStable =
  checkpoint(current) === sourceCheckpoint &&
  checkpoint(actual) === sourceCheckpoint;
const summary = existsSync(join(base, "checks/checks.json"))
  ? JSON.parse(readFileSync(join(base, "checks/checks.json")))
  : null;
const result = {
  at: new Date().toISOString(),
  directory,
  checkpoint: sourceCheckpoint,
  sourceManifest: join(base, "source-copy-checkpoint.json"),
  results,
  sourceStable,
  drift,
  rootLock: actual["pnpm-lock.yaml"],
  providerLock: actual["swap-providers/pnpm-lock.yaml"],
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  pass:
    sourceStable &&
    results.length === 3 &&
    results.every((r) => r.exitCode === 0) &&
    summary?.pass === true,
  execution: "CLOSED",
  productionCredentialsCopied: 0,
};
writeFileSync(
  join(base, "reproducibility.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({ pass: result.pass, directory, sourceStable, drift }),
);
if (!result.pass) process.exitCode = 1;
