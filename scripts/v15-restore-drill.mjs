// V1.5 backup -> isolated restore drill (local). Creates a drill API client with one active and one
// revoked key (plaintext kept in memory only), backs up, verifies, restores into a NEW disposable
// PostgreSQL instance, boots the Data API read-only against it, checks key behaviour, runs
// verify-index, resumes the indexer from the restored checkpoint, reads a fresh balance, runs the
// corruption cases, then removes only the disposable drill instance and revokes the drill key.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!root) throw Error("OTHERBRIDGE_EVIDENCE_ROOT required");
await mkdir(`${root}/backup`, { recursive: true });
const log = [];
const run = (args, env = {}, input) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/data.mjs", ...args], {
      env: { ...process.env, ...env },
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    if (input) child.stdin.end(input);
    child.on("close", (code) => {
      const redact = (s) =>
        s
          .replace(
            /ob_(live|test)_[a-z0-9]{12}_[A-Za-z0-9_-]+/g,
            "ob_$1_[redacted]",
          )
          .replace(/postgres(ql)?:\/\/\S+/g, "[database-url]");
      log.push({
        args: args.join(" "),
        code,
        out: redact(out).slice(-3000),
        err: redact(err).slice(-1500),
      });
      resolve({ code, out, err });
    });
  });
const lastJson = (s) =>
  JSON.parse(
    s
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .pop(),
  );
const result = { startedAt: new Date().toISOString(), steps: {} };
let handoff = null,
  api = null,
  keyA = null;
try {
  // 1. Drill client: one active key, one revoked key.
  const client = lastJson(
    (
      await run([
        "client:create",
        "--name",
        "V15 restore drill",
        "--plan",
        "internal",
        "--scopes",
        "chains:read,balances:read",
      ])
    ).out,
  );
  const a = lastJson(
    (
      await run([
        "key:create",
        "--client",
        client.clientId,
        "--yes",
        "--stdout-json",
        "--test",
      ])
    ).out,
  );
  const b = lastJson(
    (
      await run([
        "key:create",
        "--client",
        client.clientId,
        "--yes",
        "--stdout-json",
        "--test",
      ])
    ).out,
  );
  keyA = a;
  assert.equal((await run(["key:revoke", "--key", b.prefix])).code, 0);
  result.steps.drillClient = {
    clientId: client.clientId,
    activePrefix: a.prefix,
    revokedPrefix: b.prefix,
  };
  // 2-3. Backup and verify.
  const created = await run(["backup:create"]);
  assert.equal(created.code, 0, created.err);
  const backup = lastJson(created.out);
  result.steps.backup = backup;
  const verified = await run(["backup:verify", "--id", backup.id]);
  assert.equal(verified.code, 0);
  result.steps.verify = lastJson(verified.out);
  // The plaintext of the drill keys must not exist anywhere in the backup bytes.
  const dump = await readFile(`${backup.dir}/${backup.file}`);
  result.steps.plaintextKeyInDump =
    dump.includes(Buffer.from(a.apiKey)) ||
    dump.includes(Buffer.from(b.apiKey));
  assert.equal(result.steps.plaintextKeyInDump, false);
  // 4. Restore into a new disposable instance (kept for service checks).
  const t0 = Date.now();
  const restored = await run([
    "backup:restore-test",
    "--id",
    backup.id,
    "--keep",
    "--port",
    "55481",
  ]);
  assert.equal(restored.code, 0, restored.out + restored.err);
  const r = lastJson(restored.out);
  handoff = r.handoff;
  result.steps.restore = {
    target: r.target,
    restoreMs: r.restoreMs,
    totalMs: r.totalMs,
    checks: r.checks,
    wallClockMs: Date.now() - t0,
  };
  const h = JSON.parse(await readFile(handoff, "utf8"));
  const url = (role) =>
    `postgres://${role}:${h.roles[role]}@127.0.0.1:${h.port}/${h.database}`;
  const restoredEnv = {
    OTHERBRIDGE_DATA_DATABASE_URL: url("otherbridge_api"),
    OTHERBRIDGE_DATA_INDEXER_URL: url("otherbridge_indexer"),
    OTHERBRIDGE_DATA_MIGRATOR_URL: url("otherbridge_api"), // never the source owner
    OTHERBRIDGE_DATA_API_PORT: "3201",
  };
  // 5. Data API boots read-only against the restored copy.
  api = spawn(process.execPath, ["scripts/data.mjs", "api"], {
    env: { ...process.env, ...restoredEnv },
  });
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    try {
      ok = (await fetch("http://127.0.0.1:3201/v1/health")).ok;
    } catch {}
    if (!ok) await new Promise((res) => setTimeout(res, 500));
  }
  assert.ok(ok, "restored Data API did not start");
  const get = async (path, key) => {
    const res = await fetch(`http://127.0.0.1:3201${path}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const health = await get("/v1/health");
  const chains = await get("/v1/chains?limit=5", a.apiKey);
  const revoked = await get("/v1/chains?limit=5", b.apiKey);
  const coverage = await get("/v1/chains/57073/coverage", a.apiKey);
  const balance = await get(
    "/v1/57073/address/0x4200000000000000000000000000000000000006/native-balance",
    a.apiKey,
  );
  assert.equal(health.body?.data?.status, "ok");
  assert.equal(chains.status, 200);
  assert.equal(revoked.status, 401);
  assert.equal(coverage.status, 200);
  const cp =
    r.checks &&
    JSON.parse(
      await readFile(`${backup.dir}/manifest.json`, "utf8"),
    ).structure.checkpoints.find((c) => c.chain === "57073");
  result.steps.restoredApi = {
    health: health.body?.data,
    activeKey: chains.status,
    revokedKey: revoked.status,
    coverageIntegrity: coverage.body?.data?.index?.integrity,
    nativeBalanceStatus: balance.status,
    nativeObservedBlock: balance.body?.data?.observedBlock ?? null,
    backupCheckpointThrough: cp?.through ?? null,
  };
  // A restore never turns stale snapshots into current data: balances are fresh chain reads.
  if (balance.status === 200)
    assert.ok(
      BigInt(balance.body.data.observedBlock) > BigInt(cp.through),
      "balance not fresh",
    );
  // 6. verify-index on the restored copy (indexer role).
  const v1 = await run(["verify-index", "--label", "restored"], restoredEnv);
  result.steps.verifyIndexRestored = {
    code: v1.code,
    summary: lastJson(v1.out),
  };
  assert.equal(v1.code, 0);
  // 7. Indexer resumes from the restored checkpoint with required witness; then integrity again.
  const resume = await run(
    [
      "indexer:once",
      "--chain",
      "57073",
      "--witness",
      "required",
      "--max-windows",
      "5",
    ],
    restoredEnv,
  );
  const line = lastJson(resume.out);
  result.steps.resume = {
    code: resume.code,
    status: line.status,
    fromBlock: line.fromBlock,
    throughBlock: line.throughBlock,
    windows: line.windows,
    witness: line.witness,
  };
  assert.equal(resume.code, 0);
  assert.ok(["CURRENT", "ADVANCED"].includes(line.status));
  const v2 = await run(
    ["verify-index", "--label", "restored-after-resume"],
    restoredEnv,
  );
  result.steps.verifyIndexAfterResume = {
    code: v2.code,
    summary: lastJson(v2.out),
  };
  assert.equal(v2.code, 0);
  // 8. Corruption cases (refused before any restore target is created; source unchanged).
  const corrupt = await run(["backup:corruption-test", "--id", backup.id]);
  result.steps.corruption = lastJson(corrupt.out);
  assert.equal(corrupt.code, 0);
  // 9. Retention mechanics: dry run only.
  result.steps.pruneDryRun = lastJson(
    (await run(["backup:prune", "--keep", "3"])).out,
  );
  result.result = "PASS";
} catch (error) {
  result.result = "FAIL";
  result.error = String(error?.stack ?? error)
    .replace(/ob_(live|test)_[a-z0-9]{12}_[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 2000);
} finally {
  api?.kill();
  if (handoff)
    result.steps.cleanup = lastJson(
      (await run(["backup:drill-cleanup", "--handoff", handoff])).out,
    );
  if (keyA)
    result.steps.drillKeyRevoked =
      (await run(["key:revoke", "--key", keyA.prefix])).code === 0;
  result.finishedAt = new Date().toISOString();
  await writeFile(
    `${root}/backup/restore-drill.json`,
    JSON.stringify(result, null, 2),
  );
  await writeFile(
    `${root}/backup/restore-drill-commands.json`,
    JSON.stringify(log, null, 2),
  );
}
console.log(
  JSON.stringify({
    result: result.result,
    error: result.error?.slice(0, 300),
    restore: result.steps.restore,
  }),
);
process.exit(result.result === "PASS" ? 0 : 1);
