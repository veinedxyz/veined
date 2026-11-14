// Read-only engineering diagnostics. This runner never arms a pilot session and cannot release a wallet request.
// The accepted protected baseline remains enforced: any P20 failure is reported as release BLOCKED.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { livePreflight, type PreflightOutcome } from "./g7-pilot/preflight";
import type { RpcAuditRecord } from "../src/g7/rpc";
import { PilotSession } from "./g7-pilot/session";
import { liveTracker } from "./g7-pilot/tracker";
import { G7_READ_METHODS } from "../src/g7/policy";
const arg = (key: string, fallback: string) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? fallback : process.argv[i + 1];
};
const runs = Number(arg("--runs", "1"));
const pauseMs = Number(arg("--pause-ms", "45000"));
if (
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 30 ||
  !Number.isInteger(pauseMs) ||
  pauseMs < 0 ||
  pauseMs > 60000
)
  throw new Error("BAD_DIAGNOSTIC_ARGUMENT");
const family = arg("--family", "g7-rpc");
if (!/^(g7-rpc|g7-soak|g7-final)$/.test(family))
  throw new Error("BAD_EVIDENCE_FAMILY");
const base = readFileSync(".otherbridge/v112-evidence-path.txt", "utf8").trim();
const root = join(
  base,
  family,
  `diagnostic-${new Date().toISOString().replace(/[-:.]/g, "")}`,
);
mkdirSync(root, { recursive: true });
const expected =
  "4eecb9784961717f8464be8f9a650004974e328239f614211ad51bdf65aac869";
const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const results: {
  run: number;
  ms: number;
  initial: ReturnType<typeof outcomeView>;
  final: ReturnType<typeof outcomeView>;
  wireRequests: number;
  cooldownHits: number;
  rateLimited: number;
  retries: number;
  sessionId: string;
  sessionState: string;
}[] = [];
const outcomeView = (o: PreflightOutcome) => ({
  status: o.status,
  gates: o.gates,
  diagnostics: o.diagnostics,
  pin: o.summary?.bscPin,
  intentDigest: o.review?.intentDigest,
  financialChecksPass:
    o.gates.length > 1 &&
    o.gates.filter((g) => g.id !== "P20").every((g) => g.status === "PASS"),
  intentUnchanged: o.review?.intentDigest === expected,
  releaseBlocked: o.gates.some((g) => g.id === "P20" && g.status !== "PASS"),
});
const audits: RpcAuditRecord[] = [];
for (let i = 1; i <= runs; i++) {
  if (i > 1) await new Promise((r) => setTimeout(r, pauseMs));
  const dir = join(root, `run-${i}`);
  mkdirSync(dir, { recursive: true });
  const runAudit: RpcAuditRecord[] = [];
  const source = livePreflight({
    audit: (r) => {
      audits.push(r);
      runAudit.push(r);
      appendFileSync(join(dir, "rpc-audit.jsonl"), JSON.stringify(r) + "\n");
    },
    record: (name, v) => {
      const p = join(dir, name + ".json");
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, json(v));
    },
    log: (m) => {
      appendFileSync(join(dir, "log.txt"), m + "\n");
      console.log(`run ${i}/${runs}: ${m}`);
    },
  });
  const started = Date.now();
  const session = new PilotSession({
    mode: "dry-run",
    fixture: false,
    preflight: source,
    tracker: liveTracker((r) => runAudit.push(r)),
    lock: null,
    journal: (event, data) =>
      appendFileSync(
        join(dir, "session-journal.jsonl"),
        json({ event, ...data }) + "\n",
      ),
  });
  await session.start();
  const initial = session.latest!;
  // Even when P20 is release-blocked, a second fresh read can diagnose the final financial invariants.
  // This is source.run only, with no PilotSession.final/arm and no wallet API or capability.
  const final = await source.run("final");
  const result = {
    sessionId: session.id,
    sessionState: session.state,
    run: i,
    ms: Date.now() - started,
    initial: outcomeView(initial),
    final: outcomeView(final),
    wireRequests: runAudit.filter((r) => !r.cacheHit).length,
    cooldownHits: runAudit.filter((r) => r.cacheHit).length,
    rateLimited: runAudit.filter((r) => r.rateLimited && !r.cacheHit).length,
    retries: runAudit.filter((r) => (r.retry ?? 0) > 0).length,
  };
  session.stop();
  results.push(result);
  writeFileSync(join(dir, "result.json"), json(result));
  console.log(
    `DIAGNOSTIC ${i}/${runs}: initial=${initial.status}, final=${final.status}, ${result.wireRequests} requests, ${result.ms}ms`,
  );
}
const counts: Record<
  string,
  {
    provider: string;
    method: string;
    count: number;
    latencyMs: number;
    cacheHit: number;
    cacheMiss: number;
    retry: number;
    rateLimited: number;
  }
> = {};
const quantile = (values: number[], q: number) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? null;
for (const r of audits) {
  const key = `${new URL(r.url).host}:${r.method}`;
  const v = (counts[key] ??= {
    provider: new URL(r.url).host,
    method: r.method,
    count: 0,
    latencyMs: 0,
    cacheHit: 0,
    cacheMiss: 0,
    retry: 0,
    rateLimited: 0,
  });
  v.count += r.cacheHit ? 0 : 1;
  v.latencyMs += r.ms;
  v.cacheHit += r.cacheHit ? 1 : 0;
  v.cacheMiss += r.cacheHit ? 0 : 1;
  v.retry += (r.retry ?? 0) > 0 ? 1 : 0;
  v.rateLimited += r.rateLimited ? 1 : 0;
}
writeFileSync(
  join(root, "SUMMARY.json"),
  json({
    at: new Date().toISOString(),
    runs,
    pauseMs,
    expectedIntentDigest: expected,
    freshDrySessions: results.length,
    dryRunComplete: 0,
    financialPass: results.filter(
      (r) => r.initial.financialChecksPass && r.final.financialChecksPass,
    ).length,
    unchangedIntent: results.filter(
      (r) => r.initial.intentUnchanged && r.final.intentUnchanged,
    ).length,
    releaseBlocked: results.filter(
      (r) => r.initial.releaseBlocked || r.final.releaseBlocked,
    ).length,
    durationMs: {
      p50: quantile(
        results.map((r) => r.ms),
        0.5,
      ),
      p95: quantile(
        results.map((r) => r.ms),
        0.95,
      ),
      p99: quantile(
        results.map((r) => r.ms),
        0.99,
      ),
    },
    requestCounts: {
      p50: quantile(
        results.map((r) => r.wireRequests),
        0.5,
      ),
      p95: quantile(
        results.map((r) => r.wireRequests),
        0.95,
      ),
      p99: quantile(
        results.map((r) => r.wireRequests),
        0.99,
      ),
    },
    rpcWriteMethods: audits.filter(
      (r) => !new Set<string>(G7_READ_METHODS).has(r.method),
    ).length,
    results,
    requests: Object.values(counts),
    walletRequests: 0,
    realSignatures: 0,
    approvals: 0,
    permits: 0,
    broadcasts: 0,
    deploys: 0,
    feeCollection: 0,
    protectedBaselineReplaced: false,
  }),
);
console.log(`SUMMARY ${root}`);
