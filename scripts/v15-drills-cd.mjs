// V1.5 Incident Drills C (bad release/runtime configuration) and D (replace the disposable staging
// database with a restored copy). Staging-only; the previous staging volume is kept, never deleted.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:https";
import assert from "node:assert/strict";
const root = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/drills`;
await mkdir(root, { recursive: true });
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    encoding: opts.binary ? undefined : "utf8",
    timeout: opts.timeout ?? 900000,
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 1 << 28,
  });
  const clean = (s) =>
    String(s ?? "")
      .replace(/postgres(ql)?:\/\/\S+/g, "[database-url]")
      .replace(/ob_(live|test)_[a-z0-9]{12}_[A-Za-z0-9_-]+/g, "[redacted]");
  // `raw` keeps stdout unredacted for in-memory use only (one-time drill keys); never written to disk.
  return {
    code: r.status,
    out: opts.binary
      ? r.stdout
      : opts.raw
        ? String(r.stdout ?? "").trim()
        : clean(r.stdout).trim(),
    err: clean(r.stderr).trim(),
  };
};
const composeArgs = [
  "compose",
  "--env-file",
  ".env.staging.local",
  "-f",
  "infra/staging/compose.yaml",
];
const compose = (args, env = {}, opts = {}) =>
  sh("docker", [...composeArgs, ...args], { ...opts, env });
const lastJson = (s) =>
  JSON.parse(
    String(s)
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .pop(),
  );
const out = { at: new Date().toISOString(), C: {}, D: {} };
// ---------------- Drill C ----------------
const run = (service, env, cmd = []) => {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = compose(
    ["run", "--rm", "--no-deps", "-T", ...envArgs, service, ...cmd],
    {},
    { timeout: 120000 },
  );
  return {
    exit: r.code,
    reason: (r.err + "\n" + r.out)
      .split("\n")
      .filter((l) => /invalid|INVALID|REQUIRED|Error|refus/i.test(l))
      .slice(-2),
  };
};
out.C.dataApiMemoryLimiterInPublicMode = run("data-api", {
  OTHERBRIDGE_RATE_LIMIT_BACKEND: "memory",
});
out.C.dataApiMissingPseudonymKey = run("data-api", {
  OTHERBRIDGE_DATA_PSEUDONYM_KEY: "",
});
out.C.dataApiInvalidDeploymentMarker = run("data-api", {
  OTHERBRIDGE_DEPLOYMENT_ENV: "Production",
});
out.C.dataApiWeakMetricsToken = run("data-api", {
  OTHERBRIDGE_METRICS_TOKEN: "short",
});
out.C.indexerInvalidWitnessPolicy = run("indexer", {}, [
  "node",
  "scripts/data.mjs",
  "indexer:once",
  "--witness",
  "yes",
]);
for (const [k, v] of Object.entries(out.C))
  assert.notEqual(v.exit, 0, `${k} must fail closed`);
// Hostile release environment on the app: gate, fee and mode stay closed; missing durable limiter
// in public mode makes app APIs refuse (503) instead of degrading to process memory.
const hostile = sh("docker", [
  ...composeArgs,
  "run",
  "-d",
  "--no-deps",
  "--name",
  "otherbridge-staging-app-hostile",
  "-e",
  "REAL_EXECUTION=true",
  "-e",
  "REAL_OTHERBRIDGE_FEE=true",
  "-e",
  "OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION=true",
  "-e",
  "OTHERBRIDGE_MODE=local-test",
  "-e",
  "OTHERBRIDGE_FEE_BPS=10",
  "-e",
  "OTHERBRIDGE_RATE_LIMIT_BACKEND=memory",
  "app",
]);
try {
  let bridge = null;
  for (let i = 0; i < 40 && !bridge; i++) {
    const r = sh("docker", [
      "exec",
      "otherbridge-staging-proxy",
      "wget",
      "-qO-",
      "http://otherbridge-staging-app-hostile:3101/api/bridge",
    ]);
    if (r.code === 0) bridge = JSON.parse(r.out);
    else await new Promise((res) => setTimeout(res, 1500));
  }
  const post = sh("docker", [
    "exec",
    "otherbridge-staging-proxy",
    "wget",
    "-S",
    "-qO-",
    "--header",
    "Origin: https://app.otherbridge.localhost:8443",
    "--header",
    "Content-Type: application/json",
    "--header",
    "X-Forwarded-Host: app.otherbridge.localhost:8443",
    "--header",
    "X-Forwarded-Proto: https",
    "--header",
    "X-Forwarded-For: 203.0.113.7",
    "--post-data",
    JSON.stringify({
      identity: { evm: "0x000000000000000000000000000000000000dEaD" },
      consent: true,
    }),
    "http://otherbridge-staging-app-hostile:3101/api/portfolio",
  ]);
  const status = /HTTP\/1\.1 (\d{3})/.exec(post.err)?.[1] ?? null;
  out.C.hostileApp = {
    containerStarted: hostile.code === 0,
    bridge,
    portfolioStatus: status,
    portfolioBody: post.out.slice(0, 200),
  };
  assert.equal(bridge?.submission, false);
  assert.equal(bridge?.mode, "mainnet-readonly");
  assert.equal(status, "503");
} finally {
  sh("docker", ["rm", "-f", "otherbridge-staging-app-hostile"]);
}
// ---------------- Drill D ----------------
const https = (host, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const ca = sh("docker", [
      "exec",
      "otherbridge-staging-proxy",
      "cat",
      "/data/caddy/pki/authorities/local/root.crt",
    ]).out;
    const req = request(
      {
        host: "127.0.0.1",
        port: 8443,
        servername: host,
        ca,
        path,
        headers: { host: `${host}:8443`, ...headers },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: (() => {
              try {
                return JSON.parse(d);
              } catch {
                return null;
              }
            })(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
const dataCli = (args, env = {}, raw = false) =>
  compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "migrate",
      "node",
      "scripts/data.mjs",
      ...args,
    ],
    env,
    { timeout: 300000, raw },
  );
const bkEnv = {
  OTHERBRIDGE_BACKUP_ENV: "staging",
  OTHERBRIDGE_EVIDENCE_ROOT: process.env.OTHERBRIDGE_EVIDENCE_ROOT,
};
// Drill key created before the backup: must still authenticate after the restore.
const client = lastJson(
  dataCli([
    "client:create",
    "--name",
    "V15 drill D",
    "--plan",
    "developer",
    "--scopes",
    "chains:read",
  ]).out,
);
const key = lastJson(
  dataCli(
    [
      "key:create",
      "--client",
      client.clientId,
      "--yes",
      "--stdout-json",
      "--test",
    ],
    {},
    true,
  ).out,
);
// Planned restore: writers stop first so the backup is a quiescent point-in-time copy.
compose(["stop", "indexer", "rpc-health"]);
const before = {
  verify: lastJson(
    compose([
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "indexer",
      "node",
      "scripts/data.mjs",
      "verify-index",
    ]).out,
  ),
  status: lastJson(dataCli(["db:status"]).out),
};
const backup = sh(process.execPath, ["scripts/data.mjs", "backup:create"], {
  env: bkEnv,
});
assert.equal(backup.code, 0, backup.err);
const b = lastJson(backup.out);
const verify = sh(
  process.execPath,
  ["scripts/data.mjs", "backup:verify", "--id", b.id],
  { env: bkEnv },
);
assert.equal(verify.code, 0);
out.D.backup = {
  id: b.id,
  sha256: b.sha256,
  sizeBytes: b.sizeBytes,
  verify: lastJson(verify.out).result,
};
out.D.before = before;
const newVolume = `otherbridge-staging-pgdata-restored-${b.id.slice(-6)}`;
const volEnv = { OTHERBRIDGE_STAGING_PG_VOLUME: newVolume };
const t0 = Date.now();
compose(["stop", "app", "data-api", "indexer", "rpc-health", "ops-exporter"]);
compose(["up", "-d", "--no-deps", "--wait", "postgres"], volEnv);
const mounted = sh("docker", [
  "inspect",
  "otherbridge-staging-postgres",
  "--format",
  "{{range .Mounts}}{{.Name}}{{end}}",
]).out;
assert.equal(
  mounted,
  newVolume,
  "staging postgres is not on the new restore volume",
);
const dump = await readFile(`${b.dir}/${b.file}`);
const restore = sh(
  "docker",
  [
    "exec",
    "-i",
    "otherbridge-staging-postgres",
    "pg_restore",
    "-U",
    "otherbridge_owner",
    "-d",
    "otherbridge_data",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    "--single-transaction",
  ],
  { input: dump },
);
assert.equal(restore.code, 0, restore.err);
const migrateRun = dataCli(["db:migrate"], volEnv);
assert.equal(migrateRun.code, 0, migrateRun.err);
// Restored copy vs the backup manifest, before any service restarts and writes.
const manifest = JSON.parse(await readFile(`${b.dir}/manifest.json`, "utf8"));
const restoredCounts = lastJson(dataCli(["db:status"], volEnv).out).counts;
const countMismatches = Object.entries(restoredCounts).filter(
  ([t, n]) =>
    t in manifest.rowCounts &&
    manifest.rowCounts[t] !== n &&
    t !== "ops_backup_events",
);
const up = compose(["up", "-d", "--wait", "--wait-timeout", "600"], volEnv, {
  timeout: 900000,
});
const restoreMs = Date.now() - t0;
assert.equal(up.code, 0, up.err.slice(-500));
const after = {
  verify: lastJson(
    compose(
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "indexer",
        "node",
        "scripts/data.mjs",
        "verify-index",
      ],
      volEnv,
    ).out,
  ),
  status: lastJson(dataCli(["db:status"], volEnv).out),
};
const health = await https("api.otherbridge.localhost", "/v1/health");
const auth = await https("api.otherbridge.localhost", "/v1/chains?limit=1", {
  authorization: `Bearer ${key.apiKey}`,
});
const page = await https("app.otherbridge.localhost", "/");
// Indexer resumes from the restored checkpoint (live witness-required run).
const resume = lastJson(
  compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "indexer",
      "node",
      "scripts/data.mjs",
      "indexer:once",
      "--chain",
      "57073",
      "--witness",
      "required",
      "--max-windows",
      "5",
    ],
    volEnv,
  ).out,
);
const postBackup = sh(process.execPath, ["scripts/data.mjs", "backup:create"], {
  env: bkEnv,
});
out.D.swap = {
  newVolume,
  previousVolumeKept:
    sh("docker", ["volume", "inspect", "otherbridge-staging-pgdata"]).code ===
    0,
  restoreAndRestartMs: restoreMs,
};
out.D.after = {
  ...after,
  apiHealth: health.json?.data?.status,
  keyCreatedBeforeBackup: auth.status,
  appHome: page.status,
  indexerResume: {
    status: resume.status,
    windows: resume.windows,
    witness: resume.witness?.lastConsensus,
  },
  postRestoreBackup:
    postBackup.code === 0
      ? lastJson(postBackup.out).id
      : postBackup.err.slice(0, 200),
};
const sameCounts = countMismatches.length === 0;
out.D.restoredVsManifest = { mismatches: countMismatches, restoredCounts };
out.D.checks = {
  verifyBefore: before.verify.result,
  verifyAfter: after.verify.result,
  countsPreserved: sameCounts,
  healthOk: health.json?.data?.status === "ok",
  keyWorks: auth.status === 200,
  appOk: page.status === 200,
  resumed: ["CURRENT", "ADVANCED"].includes(resume.status),
};
dataCli(["key:revoke", "--key", key.prefix], volEnv);
out.result = Object.values(out.D.checks).every(
  (v) => v === true || v === "PASS",
)
  ? "PASS"
  : "FAIL";
await writeFile(`${root}/drill-c-d.json`, JSON.stringify(out, null, 2));
console.log(
  JSON.stringify({
    result: out.result,
    C: Object.fromEntries(
      Object.entries(out.C).map(([k, v]) => [k, v.exit ?? v.portfolioStatus]),
    ),
    D: out.D.checks,
    restoreMs,
  }),
);
process.exit(out.result === "PASS" ? 0 : 1);
