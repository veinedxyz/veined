// V1.5 Incident Drill A — RPC log-set mismatch, end to end on an EPHEMERAL database:
// synthetic multi-operator RPC (primary omits one Transfer event) -> witness consensus -> no corrupt
// commit / chain paused -> DB-derived metrics (ops exporter, monitor role) -> Prometheus rules ->
// Alertmanager shows the alerts -> operator resume -> recovery. SYNTHETIC_TEST_ONLY chain data; the
// ephemeral database is dropped at the end; no live RPC, wallet or signer is involved.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import postgres from "postgres";
import { connect, PostgresStore } from "../src/data/store/postgres";
import { loadMigrations, migrate } from "../src/data/store/migrate";
import { indexOnce } from "../src/data/indexer/worker";
import {
  CHAIN_ID,
  makeChain,
  witnessHarness,
} from "../tests/fixtures/witness-harness";
process.loadEnvFile(".env.data.local");
const root = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/drills`;
await mkdir(root, { recursive: true });
const urlFor = (base: string, db: string) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};
const db = `otherbridge_drill_${randomBytes(4).toString("hex")}`;
const admin = postgres(
  urlFor(process.env.OTHERBRIDGE_DATA_MIGRATOR_URL!, "postgres"),
  { max: 1, onnotice: () => {} },
);
const token = process.env.OTHERBRIDGE_METRICS_TOKEN!;
const out: Record<string, unknown> = {
  at: new Date().toISOString(),
  database: db,
  chain: CHAIN_ID,
  steps: {},
};
const steps = out.steps as Record<string, unknown>;
const children: ReturnType<typeof spawn>[] = [];
const sh = (cmd: string, args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const c = spawn(cmd, args);
    let o = "";
    c.stdout.on("data", (d) => (o += d));
    c.stderr.on("data", (d) => (o += d));
    c.on("close", (code) => resolve({ code: code ?? 1, out: o }));
  });
const alerts = async () =>
  (
    (await (await fetch("http://127.0.0.1:59193/api/v2/alerts")).json()) as {
      labels: Record<string, string>;
      status: { state: string };
    }[]
  ).map((a) => ({
    name: a.labels.alertname,
    chain: a.labels.chain ?? null,
    severity: a.labels.severity,
    state: a.status.state,
  }));
const waitFor = async <T>(
  fn: () => Promise<T | null>,
  ms: number,
  step = 5000,
) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, step));
  }
};
let owner: PostgresStore | null = null,
  indexer: PostgresStore | null = null;
try {
  await admin.unsafe(`CREATE DATABASE ${db}`);
  for (const role of [
    "otherbridge_api",
    "otherbridge_indexer",
    "otherbridge_monitor",
    "otherbridge_backup",
  ])
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
  owner = new PostgresStore(
    connect(urlFor(process.env.OTHERBRIDGE_DATA_MIGRATOR_URL!, db), { max: 2 }),
  );
  await migrate(owner.sql, await loadMigrations());
  await owner.sql.unsafe(
    "GRANT USAGE ON SCHEMA public TO otherbridge_api, otherbridge_indexer, otherbridge_monitor, otherbridge_backup",
  );
  await owner.sql.unsafe(await readFile("src/data/store/grants.sql", "utf8"));
  indexer = new PostgresStore(
    connect(urlFor(process.env.OTHERBRIDGE_DATA_INDEXER_URL!, db), { max: 4 }),
  );
  // Monitoring path: host ops-exporter (monitor role) -> local Prometheus/Alertmanager containers.
  await mkdir("infra/monitoring/secrets", { recursive: true });
  await writeFile("infra/monitoring/secrets/metrics_token", token, {
    mode: 0o600,
  });
  children.push(
    spawn(process.execPath, ["scripts/data.mjs", "ops-exporter"], {
      env: {
        ...process.env,
        OTHERBRIDGE_OPS_METRICS_PORT: "3293",
        OTHERBRIDGE_METRICS_HOST: "127.0.0.1",
        OTHERBRIDGE_DATA_MONITOR_URL: urlFor(
          process.env.OTHERBRIDGE_DATA_MONITOR_URL!,
          db,
        ),
      },
    }),
  );
  steps.monitoringUp = (
    await sh("docker", [
      "compose",
      "-f",
      "infra/monitoring/compose.yaml",
      "up",
      "-d",
    ])
  ).code;
  const opsUp = await waitFor(async () => {
    const t = (await (
      await fetch("http://127.0.0.1:59190/api/v1/targets")
    ).json()) as {
      data: { activeTargets: { labels: { job: string }; health: string }[] };
    };
    return t.data.activeTargets.find(
      (x) => x.labels.job === "otherbridge-ops" && x.health === "up",
    )
      ? true
      : null;
  }, 120000);
  steps.opsTargetUp = !!opsUp;
  assert.ok(opsUp, "ops exporter target not up in local Prometheus");
  // A1: two independent operators, primary omits one event, no tiebreak -> UNRESOLVED -> paused.
  const chain = makeChain();
  const omit = (logs: Record<string, unknown>[]) =>
    logs.filter(
      (l) =>
        !(
          BigInt(String(l.blockNumber)) === 84n &&
          BigInt(String(l.logIndex)) === 0n
        ),
    );
  const two = await witnessHarness({
    hosts: [
      { host: "rpc-a.synthetic.test", operator: "drill-op-a" },
      { host: "rpc-b.synthetic.test", operator: "drill-op-b" },
    ],
    chain,
    store: indexer,
  });
  two.hooks.set("rpc-a.synthetic.test", { logs: omit });
  const a1 = await indexOnce(indexer, two.pool, two.record, "drill-owner-a1", {
    initialRange: 25,
    confirmations: 3,
    witness: "required",
  });
  const cp1 = await indexer.getCheckpoint(CHAIN_ID);
  steps.A1 = {
    status: a1.status,
    error: a1.error,
    windowsCommitted: a1.windows,
    transfersStored: (await indexer.verifyIndex(CHAIN_ID)).transfers,
    halted: cp1?.haltedReason ?? null,
    dispute: a1.disputes[0]
      ? {
          consensus: a1.disputes[0].consensus,
          failure: a1.disputes[0].failure,
          primaryLogCount: a1.disputes[0].primaryLogCount,
          witnessLogCount: a1.disputes[0].witnessLogCount,
          diff: a1.disputes[0].diff?.totals,
        }
      : null,
  };
  assert.equal(a1.status, "HALTED");
  assert.equal(a1.windows, 0);
  assert.equal((await indexer.verifyIndex(CHAIN_ID)).transfers, 0);
  // Indexing stays paused on the next run even after the fault disappears.
  two.hooks.clear();
  const stillHalted = await indexOnce(
    indexer,
    two.pool,
    two.record,
    "drill-owner-a1",
    { initialRange: 25, confirmations: 3, witness: "required" },
  );
  steps.pausedAfterFaultCleared = stillHalted.status;
  assert.equal(stillHalted.status, "HALTED");
  // Alerts fire through the real monitoring path.
  const fired = await waitFor(async () => {
    const a = await alerts();
    return a.some(
      (x) => x.name === "OtherbridgeLogWitnessMismatch" && x.state === "active",
    ) &&
      a.some((x) => x.name === "OtherbridgeIndexHalted" && x.state === "active")
      ? a
      : null;
  }, 240000);
  steps.alertsFired = fired;
  assert.ok(fired, "alerts did not fire");
  // Operator investigation -> resume; A2: three operators, primary omits again -> 2-of-3 tiebreak
  // commits the complete witnessed set and quarantines the lying primary.
  steps.resume = await indexer.resumeChain(CHAIN_ID);
  const three = await witnessHarness({
    hosts: [
      { host: "rpc-a.synthetic.test", operator: "drill-op-a" },
      { host: "rpc-b.synthetic.test", operator: "drill-op-b" },
      { host: "rpc-c.synthetic.test", operator: "drill-op-c" },
    ],
    chain,
    store: indexer,
  });
  three.hooks.set("rpc-a.synthetic.test", { logs: omit });
  const a2 = await indexOnce(
    indexer,
    three.pool,
    three.record,
    "drill-owner-a2",
    { initialRange: 25, confirmations: 3, witness: "required" },
  );
  const rows84 = await indexer.windowRows(CHAIN_ID, 84n, 84n);
  const v = await indexer.verifyIndex(CHAIN_ID);
  steps.A2 = {
    status: a2.status,
    windows: a2.windows,
    tiebreaks: a2.witness.tiebreaks,
    trusted: a2.witness.trusted,
    omittedEventCommitted: rows84.some((r) => r.logIndex === 0),
    primaryQuarantined: !three.pool
      .ranked()
      .some((e) => e.id === `${CHAIN_ID}:rpc-a.synthetic.test`),
    verify: {
      missingRanges: v.missingRanges.length,
      duplicateLogKeys: v.duplicateLogKeys,
      orphanRecords: v.orphanRecords,
      blockHashInconsistencies: v.blockHashInconsistencies,
      disputedCommittedWindows: v.disputedCommittedWindows,
      witness: v.witness,
    },
  };
  assert.ok(["CURRENT", "ADVANCED"].includes(a2.status));
  assert.equal(
    (steps.A2 as { omittedEventCommitted: boolean }).omittedEventCommitted,
    true,
  );
  const haltCleared = await waitFor(
    async () =>
      !(await alerts()).some(
        (x) => x.name === "OtherbridgeIndexHalted" && x.state === "active",
      )
        ? true
        : null,
    240000,
  );
  steps.haltAlertCleared = !!haltCleared;
  steps.evidence = (await indexer.listWitnessRecords(CHAIN_ID, 50)).map(
    (r) => ({
      mode: r.mode,
      from: r.fromBlock.toString(),
      to: r.toBlock.toString(),
      consensus: r.consensus,
      failure: r.failure,
      committed: r.committed,
      primary: r.primaryEndpointId,
      witness: r.witnessEndpointId,
      tiebreak: r.tiebreakEndpointId,
      primaryDigest: r.primaryDigest,
      witnessDigest: r.witnessDigest,
      tiebreakDigest: r.tiebreakDigest,
    }),
  );
  out.result = "PASS";
} catch (error) {
  out.result = "FAIL";
  out.error = String((error as Error)?.stack ?? error).slice(0, 2000);
} finally {
  out.finalAlerts = await alerts().catch(() => null);
  for (const c of children) c.kill();
  await indexer?.close();
  await owner?.close();
  await sh("docker", [
    "compose",
    "-f",
    "infra/monitoring/compose.yaml",
    "down",
  ]);
  // Ephemeral drill database only; no pre-existing data is touched.
  await admin
    .unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    .catch(() => {});
  await admin.end();
  await writeFile(
    `${root}/drill-a-rpc-log-mismatch.json`,
    JSON.stringify(
      out,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    result: out.result,
    error: (out.error as string | undefined)?.slice(0, 300),
  }),
);
process.exit(out.result === "PASS" ? 0 : 1);
