// V1.11 G7 dry acceptance (READ-ONLY): N consecutive FRESH dry-run pilot sessions against mainnet, each driven
// server-side exactly like the owner's page would — fresh session + baseline + initial preflight, then the final
// preflight with the owner confirmations and the authorized wallet identity, then the arm, which dry-run mode
// SUPPRESSES (DRY_RUN_COMPLETE). There is no wallet object, no signer and no browser here: nothing can be signed,
// approved or broadcast, and every RPC request goes through the allowlisted ReadOnlyRpc (src/g7/rpc.ts).
// Usage: pnpm g7:dry-acceptance [--sessions 10] [--family otherbridge-v1-11/<run>/g7-dry]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPilotRuntime } from "./launch";
import { CONFIRMATION_PHRASE, PILOT_SCOPE } from "./policy";
import { G7_READ_METHODS } from "../../src/g7/policy";
import type { PreflightOutcome } from "./preflight";
import { candidateScanArgs } from "../g7-safety-scan";
import { noWriteReasons } from "../../src/g7/write-evidence";
const candidateBaseline = candidateScanArgs(process.argv.slice(2));
const EXPECTED_DIGEST =
  "4eecb9784961717f8464be8f9a650004974e328239f614211ad51bdf65aac869";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sessions = Number(arg("--sessions") ?? 10);
if (!Number.isInteger(sessions) || sessions < 1 || sessions > 50)
  throw new Error("--sessions must be 1..50");
const family = arg("--family") ?? "otherbridge-v1-11/g7-dry";
// Pause between sessions (an owner retries by hand; the public BSC logs source has a usage quota).
const pauseMs = Number(arg("--pause-ms") ?? 45_000);
if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 600_000)
  throw new Error("--pause-ms must be 0..600000");
if (!/^[A-Za-z0-9._/-]{1,160}$/.test(family) || family.includes(".."))
  throw new Error("invalid --family");

const READ_ONLY = new Set<string>(G7_READ_METHODS);
const wallet = {
  account: PILOT_SCOPE.account,
  chainId: PILOT_SCOPE.sourceChainIdHex,
};
const confirmations = { scope: true, trust: true, phrase: CONFIRMATION_PHRASE };
const view = (o: PreflightOutcome | null) =>
  o && {
    id: o.id,
    kind: o.kind,
    status: o.status,
    failingGates: o.gates.filter((g) => g.status !== "PASS").map((g) => g.id),
    applicableGateCount: o.gates.filter((g) => /^[PS]\d+$/.test(g.id)).length,
    gates: o.gates,
    blockedReasons: o.blockedReasons,
    bscPin: o.summary?.bscPin ?? null,
    diagnostics: o.diagnostics
      ? { code: o.diagnostics.code, attempts: o.diagnostics.attempts }
      : null,
    quoteAgeAtDecisionMs: o.review
      ? o.decisionAt - o.review.quote.observedAt
      : null,
    intentDigest: o.review?.intentDigest ?? null,
    durationMs: o.decisionAt - o.startedAt,
  };

const results: Record<string, unknown>[] = [];
let roots: string[] = [];
for (let i = 1; i <= sessions; i++) {
  if (i > 1 && pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  const rt = createPilotRuntime({
    mode: "dry-run",
    fixture: undefined,
    stateDir: undefined,
    evidenceFamily: family,
    candidateBaseline,
  });
  roots = [...roots, rt.root];
  const started = Date.now();
  let final: Record<string, unknown> | null = null;
  let arm: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    await rt.session.start();
    const initial = rt.session.latest;
    if (rt.session.state === "READY" && initial?.review) {
      const f = await rt.session.final({
        intentDigest: initial.review.intentDigest,
        confirmations,
        wallet,
      });
      final = {
        outcome: f.outcome,
        quoteAgeMs: (f as { quoteAgeMs?: number }).quoteAgeMs ?? null,
        preflight: view(rt.session.latest),
      };
      if (f.outcome === "ARMABLE") {
        const a = rt.session.arm({
          candidateId: (f as { candidateId: string }).candidateId,
          intentDigest: initial.review.intentDigest,
          wallet,
        });
        arm = {
          dryRun: (a as { dryRun?: boolean }).dryRun === true,
          state: a.state,
          quoteAgeMs: (a as { quoteAgeMs?: number }).quoteAgeMs ?? null,
        };
      }
    }
    results.push({
      session: i,
      sessionId: rt.session.id,
      evidence: rt.rel,
      initial: view(initialOf(rt.root)),
      final,
      arm,
      endState: rt.session.state,
      counters: rt.session.snapshot().counters,
      ms: Date.now() - started,
    });
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 300);
    results.push({
      session: i,
      sessionId: rt.session.id,
      evidence: rt.rel,
      error,
      endState: rt.session.state,
      counters: rt.session.snapshot().counters,
      ms: Date.now() - started,
    });
  } finally {
    rt.session.stop();
  }
  const r = results.at(-1)!;
  rt.log(
    `dry acceptance ${i}/${sessions}: ${String(r.endState)} in ${String(r.ms)} ms${error ? ` (${error})` : ""}`,
  );
}

// The initial preflight is the first PREFLIGHT journal entry of the session.
function initialOf(root: string): PreflightOutcome | null {
  const line = readFileSync(join(root, "session-journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; id?: string })
    .find((e) => e.event === "PREFLIGHT");
  if (!line?.id) return null;
  return JSON.parse(
    readFileSync(join(root, "preflight", `${line.id}.json`), "utf8"),
  ).outcome as PreflightOutcome;
}

// Method census over every session's RPC audit trail: read-only allowlist only, no wallet/sign/send method.
const methods: Record<string, number> = {};
for (const root of roots)
  for (const l of readFileSync(join(root, "rpc-audit.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)) {
    const m = (JSON.parse(l) as { method: string }).method;
    methods[m] = (methods[m] ?? 0) + 1;
  }
const complete = results.filter((r) => r.endState === "DRY_RUN_COMPLETE");
const summary = {
  at: new Date().toISOString(),
  sessions,
  consecutive: true,
  pauseMs,
  dryRunComplete: complete.length,
  allComplete: complete.length === sessions,
  pins: results.map(
    (r) =>
      (r.final as { preflight?: { bscPin?: unknown } } | null)?.preflight
        ?.bscPin ?? null,
  ),
  rpcMethods: methods,
  // Anything outside the read-only allowlist (there is none: ReadOnlyRpc refuses it before I/O).
  writeMethodCalls: Object.entries(methods)
    .filter(([m]) => !READ_ONLY.has(m))
    .reduce((s, [, n]) => s + n, 0),
  candidateBaseline: candidateBaseline ?? null,
  counters: Object.fromEntries(
    Object.keys(results[0].counters as Record<string, number>).map((k) => [
      k,
      results.reduce(
        (n, r) => n + (r.counters as Record<string, number>)[k],
        0,
      ),
    ]),
  ),
  results,
};
const out = join(roots[0], "..", "DRY_ACCEPTANCE_SUMMARY.json");
writeFileSync(out, JSON.stringify(summary, null, 1) + "\n");
console.log(
  `G7_DRY_ACCEPTANCE ${summary.dryRunComplete}/${sessions} DRY_RUN_COMPLETE; write methods ${summary.writeMethodCalls}; summary ${out}`,
);
const invalid = results.some((r) => {
  const f = (r.final as { preflight?: ReturnType<typeof view> } | null)
    ?.preflight;
  return (
    !f ||
    f.applicableGateCount !== 28 ||
    f.gates.some((g) => g.status !== "PASS") ||
    f.intentDigest !== EXPECTED_DIGEST ||
    noWriteReasons(r.counters as never).length
  );
});
if (!summary.allComplete || summary.writeMethodCalls || invalid)
  process.exitCode = 1;
