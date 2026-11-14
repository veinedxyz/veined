import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  createWriteStream,
  copyFileSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sourceInventory, sha256 } from "./v117-source.mjs";
const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("EVIDENCE_DIRECTORY_REQUIRED");
const evidence = readFileSync(
  ".otherbridge/v119-evidence-path.txt",
  "utf8",
).trim();
const baseline = JSON.parse(
  readFileSync(evidence + "/preflight/source-before.json"),
);
const current = sourceInventory();
const financial =
  /^src\/(g5|g7|security|release|routing|swap|defi|portfolio|features|storage|adapters|core|data)\//;
const exceptions = new Set([
  "src/data/api/openapi.ts",
  "src/data/api/docs-page.ts",
]);
const paths = Object.keys(baseline.hashes).filter(
  (p) => financial.test(p) && !exceptions.has(p),
);
const changes = paths.filter((p) => current[p] !== baseline.hashes[p]);
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "financial-source-proof.json"),
  JSON.stringify(
    {
      files: paths.length,
      changes,
      hashes: Object.fromEntries(paths.map((p) => [p, current[p]])),
      pass: !changes.length,
    },
    null,
    2,
  ) + "\n",
);
const before = resolve(evidence + "/preflight/original-source");
// Reconstruct omitted fixture files only after proving equality to the preflight digest.
for (const [path, hash] of Object.entries(baseline.hashes)) {
  if (!path.startsWith("tests/fixtures/") || existsSync(join(before, path)))
    continue;
  if (sha256(readFileSync(path)) !== hash)
    throw Error("BASELINE_FIXTURE_CHANGED:" + path);
  mkdirSync(dirname(join(before, path)), { recursive: true });
  copyFileSync(path, join(before, path));
}
const hooks = pathToFileURL(resolve("scripts/ts-hooks.mjs")).href;
const results = [];
async function run(label, cwd, script, args) {
  const stream = createWriteStream(join(out, label + ".log"), { flags: "wx" });
  const code = await new Promise((done) => {
    const p = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        hooks,
        script,
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, OTHERBRIDGE_DATA_LOG: "off" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    p.stdout.pipe(stream, { end: false });
    p.stderr.pipe(stream, { end: false });
    p.on("error", () => done(1));
    p.on("close", (code) => stream.end(() => done(code)));
  });
  results.push({ label, code });
  console.log(label, code);
  return code;
}
for (const [label, cwd] of [
  ["before", before],
  ["after", process.cwd()],
]) {
  await run("wallet-" + label, cwd, "scripts/wallet-perf.ts", [
    "fixture",
    "multichain",
    join(out, "wallet-" + label + ".json"),
    "2",
    "--defi",
  ]);
  await run("oracle-" + label, cwd, "scripts/wallet-perf.ts", [
    "oracle",
    join(out, "oracle-" + label + ".json"),
  ]);
  await run("defi-" + label, cwd, "scripts/defi-perf.ts", [
    "fixture",
    join(out, "defi-" + label + ".json"),
    "production",
    "2",
  ]);
}
if (results.some((r) => r.code !== 0)) {
  writeFileSync(
    join(out, "regression.json"),
    JSON.stringify(
      { results, pass: false, reason: "HARNESS_FAILURE" },
      null,
      2,
    ) + "\n",
  );
  process.exit(1);
}
const oracle = (label) =>
  JSON.parse(readFileSync(join(out, "oracle-" + label + ".json"))).profiles;
const economicDigests = (profiles) =>
  Object.fromEntries(
    Object.entries(profiles).map(([profile, rows]) => [
      profile,
      rows.map((r) => r.digest),
    ]),
  );
const a = economicDigests(oracle("before")),
  b = economicDigests(oracle("after"));
const pass =
  !changes.length &&
  results.every((r) => r.code === 0) &&
  JSON.stringify(a) === JSON.stringify(b);
writeFileSync(
  join(out, "regression.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      financialSourceIdentical: !changes.length,
      files: paths.length,
      results,
      economicDigestsBefore: a,
      economicDigestsAfter: b,
      oracleEquality: JSON.stringify(a) === JSON.stringify(b),
      oracleSha256: sha256(Buffer.from(JSON.stringify(a))),
      pass,
    },
    null,
    2,
  ) + "\n",
);
if (!pass) process.exitCode = 1;
