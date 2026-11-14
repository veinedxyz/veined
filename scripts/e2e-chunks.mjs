// V1.14.1 deterministic chunked E2E harness with coverage proof and memory profile.
//   node scripts/e2e-chunks.mjs plan <out-dir> [chunks]        discover every test, partition spec files, prove the union
//   node scripts/e2e-chunks.mjs run <out-dir> [chunks] [--only=k]  run chunk by chunk (fresh dev server each), sample memory
//   node scripts/e2e-chunks.mjs monolithic <out-dir> [--guard-gb=N] one full run under a host-memory guard (diagnosis only)
// A chunk is a set of whole spec files (Playwright starts its own Next dev server per invocation, so memory is released
// between chunks). The partition is a deterministic greedy balance by test count over the sorted file list. The
// summary proves union = discovered, duplicates = 0, missing = 0 and reports pass / skip / fail / flaky / retries per
// chunk from Playwright's JSON reports. A run stopped by the guard or by the host is never reported as a pass.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  write,
  writeFileSync,
} from "node:fs";
import { join, resolve as absolutePath } from "node:path";
import { createConnection } from "node:net";
import { sourceInventory, checkpoint } from "./v117-source.mjs";
import { parseE2EOrigin } from "../src/server/e2e-origin.mjs";
import { memoryProfiles, waitForHostMemory } from "./lib/test-memory.mjs";
import {
  createEvidenceWriter,
  createGuardState,
  createSampleStream,
  evaluateMemoryGuard,
} from "./lib/memory-guard.mjs";
import { rotateReproductionCache } from "./lib/e2e-cache.mjs";
import {
  registerProcess,
  processIdentity,
  stopExactProcess,
} from "./lib/process-identity.mjs";
const { origin, port } = parseE2EOrigin(process.env.OTHERBRIDGE_E2E_ORIGIN);
function testedSource() {
  return checkpoint(
    Object.fromEntries(
      Object.entries(sourceInventory()).filter(
        ([path]) =>
          !/^(docs\/|audit\/|legal\/|pentest\/)/.test(path) &&
          !path.endsWith(".md"),
      ),
    ),
  );
}
const [mode, outDir, ...rest] = process.argv.slice(2);
if (!mode || !outDir)
  throw Error("USAGE: e2e-chunks.mjs plan|run|monolithic <out-dir> [chunks]");
const chunksArg = Number(rest.find((x) => /^\d+$/.test(x)) ?? 6);
const only = rest.find((x) => x.startsWith("--only="))?.slice(7);
const guardGb = Number(
  rest.find((x) => x.startsWith("--guard-gb="))?.slice(11) ?? 2,
);
// Admission profile: standard unless selected explicitly (owner-authorized LOW_MEMORY_SERIAL validation runs).
// Only the start admission changes; the runtime guard below keeps its limits. E2E accepts exactly these two
// profiles; small/checks/focused stay available to their own runners and are rejected here before any E2E work.
const E2E_MEMORY_PROFILES = Object.freeze(["standard", "LOW_MEMORY_SERIAL"]);
const e2eMemoryProfile =
  process.env.OTHERBRIDGE_E2E_MEMORY_PROFILE ?? "standard";
if (
  !E2E_MEMORY_PROFILES.includes(e2eMemoryProfile) ||
  !Object.hasOwn(memoryProfiles, e2eMemoryProfile)
)
  throw Error("MEMORY_PROFILE_INVALID");
mkdirSync(outDir, { recursive: true });
const PW = ["node_modules/@playwright/test/cli.js"];
function discover() {
  const r = spawnSync(
    process.execPath,
    [...PW, "test", "--list", "--reporter=json"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) throw Error("DISCOVERY_FAILED " + r.stderr.slice(0, 500));
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  const tests = [];
  const walk = (suite, file) => {
    for (const s of suite.suites ?? []) walk(s, s.file ?? file);
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? [])
        tests.push({
          id: `${spec.file ?? file}:${spec.line}:${spec.column} › ${spec.title}${t.projectName ? " [" + t.projectName + "]" : ""}`,
          file: spec.file ?? file,
        });
  };
  for (const s of json.suites) walk(s, s.file);
  return tests;
}
function plan(chunks) {
  const tests = discover();
  const byFile = new Map();
  for (const t of tests)
    byFile.set(t.file, [...(byFile.get(t.file) ?? []), t.id]);
  const files = [...byFile.keys()].sort();
  // Deterministic greedy balance: largest file first (ties by name) into the lightest chunk (ties by index).
  const order = [...files].sort(
    (a, b) => byFile.get(b).length - byFile.get(a).length || (a < b ? -1 : 1),
  );
  const parts = Array.from({ length: chunks }, (_, i) => ({
    chunk: i + 1,
    files: [],
    tests: [],
  }));
  for (const f of order) {
    const target = parts.reduce(
      (m, p) => (p.tests.length < m.tests.length ? p : m),
      parts[0],
    );
    target.files.push(f);
    target.tests.push(...byFile.get(f));
  }
  for (const p of parts) p.files.sort();
  const all = parts.flatMap((p) => p.tests);
  const union = new Set(all);
  const discovered = new Set(tests.map((t) => t.id));
  const proof = {
    discovered: tests.length,
    discoveredUnique: discovered.size,
    union: union.size,
    assignments: all.length,
    duplicates: all.length - union.size,
    missing: [...discovered].filter((id) => !union.has(id)),
    extra: [...union].filter((id) => !discovered.has(id)),
  };
  const result = {
    at: new Date().toISOString(),
    sourceCheckpoint: checkpoint(sourceInventory()),
    testedSourceCheckpoint: testedSource(),
    method:
      "whole spec files; greedy balance by test count over the sorted file list; deterministic",
    chunks: parts.map((p) => ({
      chunk: p.chunk,
      files: p.files,
      tests: p.tests.length,
      members: p.tests,
    })),
    proof,
  };
  writeFileSync(
    join(outDir, "chunk-plan.json"),
    JSON.stringify(result, null, 1),
  );
  if (
    proof.duplicates ||
    proof.missing.length ||
    proof.extra.length ||
    proof.union !== proof.discovered
  )
    throw Error("CHUNK_PLAN_INVALID " + JSON.stringify(proof).slice(0, 400));
  return result;
}
// Host memory sampler (Windows): free physical memory, commit charge, and the memory of processes started by this run.
// Telemetry arrives on the sampler's stdout (-Stream); stderr is kept as evidence (sampler.stderr.log).
function sampler(directory, since, owner) {
  return spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "scripts/e2e-monitor.ps1",
      "-OwnerPid",
      String(owner.pid),
      "-OwnerCreated",
      owner.created,
      "-Directory",
      absolutePath(directory),
      "-Since",
      since.toISOString(),
      "-Stream",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
}
// Ordered, non-blocking forwarding to stdout: when stdout is redirected to a file, process.stdout writes are
// synchronous, and a stalled file would freeze the guard's event loop.
let forwarding = Promise.resolve();
function forward(data) {
  forwarding = forwarding.then(
    () => new Promise((done) => write(1, data, () => done())),
  );
}
function profile(list) {
  if (!list.length) return null;
  const max = (k) => Math.max(...list.map((s) => s[k]));
  const min = (k) => Math.min(...list.map((s) => s[k]));
  return {
    samples: list.length,
    minFreeGb: min("freeGb"),
    maxCommitGb: max("commitGb"),
    commitLimitGb: list[0].commitLimitGb,
    minCommitHeadroomGb: Math.min(
      ...list.map((s) => s.commitLimitGb - s.commitGb),
    ),
    peakRunNodeGb: max("nodeGb"),
    peakRunBrowserGb: max("browserGb"),
    peakRunGb: Math.max(...list.map((s) => s.nodeGb + s.browserGb)),
    firstRunGb: list[0].nodeGb + list[0].browserGb,
    lastRunGb: list.at(-1).nodeGb + list.at(-1).browserGb,
  };
}
function stats(report) {
  const out = {
    expected: 0,
    skipped: 0,
    unexpected: 0,
    flaky: 0,
    retries: 0,
    tests: [],
  };
  if (!report) return out;
  out.expected = report.stats?.expected ?? 0;
  out.skipped = report.stats?.skipped ?? 0;
  out.unexpected = report.stats?.unexpected ?? 0;
  out.flaky = report.stats?.flaky ?? 0;
  const walk = (suite, file) => {
    for (const s of suite.suites ?? []) walk(s, s.file ?? file);
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        out.retries += Math.max(0, (t.results?.length ?? 1) - 1);
        out.tests.push({
          id: `${spec.file ?? file}:${spec.line}:${spec.column} › ${spec.title}${t.projectName ? " [" + t.projectName + "]" : ""}`,
          status: t.status,
        });
      }
  };
  for (const s of report.suites ?? []) walk(s, s.file);
  return out;
}
// Cleanup uses the monitor's registered descendants and validates process creation
// time. Other repositories' Next/browser processes are never selected by name.
function stopRunServers(directory) {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "scripts/e2e-cleanup.ps1",
      "-Directory",
      absolutePath(directory),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0)
    return {
      pass: false,
      error: "OWNED_PROCESS_CLEANUP_FAILED",
      remaining: [],
    };
  try {
    const result = JSON.parse(r.stdout);
    return {
      ...result,
      pass: result.registryPresent && result.remaining.length === 0,
    };
  } catch {
    return {
      pass: false,
      error: "OWNERSHIP_REGISTRY_UNAVAILABLE",
      remaining: [],
    };
  }
}
async function portBusy() {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (busy) => {
      socket.destroy();
      done(busy);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (e) => finish(e.code !== "ECONNREFUSED"));
    socket.setTimeout(2000, () => finish(true));
  });
}
async function runPlaywright(dir, files, guard) {
  mkdirSync(dir, { recursive: true });
  if (guard) await waitForHostMemory(dir, e2eMemoryProfile);
  if (await portBusy())
    throw Error(
      `PORT_${port}_BUSY: a server is already listening; refusing to run against it`,
    );
  if (process.env.OTHERBRIDGE_E2E_REPRODUCTION_CACHE_ROOT) {
    const expectedOwner = JSON.parse(
      process.env.OTHERBRIDGE_E2E_REPRODUCTION_OWNER ?? "null",
    );
    const receipt = rotateReproductionCache({
      directory: process.env.OTHERBRIDGE_E2E_REPRODUCTION_CACHE_ROOT,
      cwd: process.cwd(),
      expectedOwner,
      currentOwner: expectedOwner?.pid
        ? processIdentity(expectedOwner.pid)
        : null,
    });
    writeFileSync(
      join(dir, "fresh-dev-cache.json"),
      JSON.stringify(receipt, null, 2),
    );
  }
  const since = new Date();
  const telemetry = createGuardState(since.getTime(), performance.now());
  // Evidence only: written asynchronously, never on the decision path.
  const evidence = {
    samples: createEvidenceWriter(join(dir, "memory.psv")),
    owned: createEvidenceWriter(join(dir, "owned-processes.json"), {
      mode: "replace",
    }),
    stderr: createEvidenceWriter(join(dir, "sampler.stderr.log")),
  };
  let ownedSnapshot = null,
    samplerErrors = 0,
    samplerStderrBytes = 0;
  const stream = createSampleStream(telemetry, {
    onSample: (_, line) => evidence.samples.write(line + "\r\n"),
    onOwned: (_, json) => {
      ownedSnapshot = json;
      evidence.owned.write(json);
    },
  });
  let mem;
  return new Promise((resolve) => {
    // The configured reporters (list + JSON written to $OTHERBRIDGE_EVIDENCE_ROOT/e2e-results.json) are kept.
    const child = spawn(process.execPath, [...PW, "test", ...files], {
      env: {
        ...process.env,
        OTHERBRIDGE_EVIDENCE_ROOT: dir,
        OTHERBRIDGE_E2E_PROCESS_DIRECTORY: absolutePath(dir),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childIdentity = registerProcess(child.pid, absolutePath(dir));
    if (!childIdentity) throw Error("PLAYWRIGHT_IDENTITY_UNAVAILABLE");
    mem = sampler(dir, since, childIdentity);
    mem.stdout.setEncoding("utf8");
    mem.stdout.on("data", (d) => stream.push(d));
    mem.stdout.on("close", () => stream.end());
    mem.stderr.on("data", (d) => {
      samplerStderrBytes += d.length;
      samplerErrors += (String(d).match(/#error /g) ?? []).length;
      evidence.stderr.write(String(d));
    });
    const monitorIdentity = processIdentity(mem.pid);
    let log = "";
    let guarded = null;
    child.stdout.on("data", (d) => ((log += d), forward(d)));
    child.stderr.on("data", (d) => (log += d));
    const timer = guard
      ? setInterval(() => {
          if (guarded) return;
          // Host protection: stop before the commit limit or physical memory is exhausted (the V1.14 run was killed
          // by the host at that point); the stopped run is evidence of the memory profile, never a pass.
          // In-memory samples only: no file I/O on this path.
          const decision = evaluateMemoryGuard({
            samples: telemetry.samples,
            state: telemetry,
            nowMs: Date.now(),
            monoMs: performance.now(),
            guardGb: guard,
            ownedLimitGb: 4,
            samplerExited: mem.exitCode !== null || mem.signalCode !== null,
          });
          if (decision) {
            guarded = decision;
            stopExactProcess(child, childIdentity);
          }
        }, 1000)
      : null;
    child.on("error", (error) => {
      log += "\nSPAWN_ERROR: " + error.message;
    });
    child.on("close", async (code) => {
      if (timer) clearInterval(timer);
      // Ensure a fast run still gets an ownership snapshot, then stop only our sampler.
      if (ownedSnapshot === null) await new Promise((r) => setTimeout(r, 2500));
      if (mem && mem.exitCode === null && mem.signalCode === null)
        await new Promise((done) => {
          mem.once("close", done);
          if (!stopExactProcess(mem, monitorIdentity)) done();
        });
      // The cleanup reads the ownership registry from disk: persist the evidence first.
      const written = {
        samples: await evidence.samples.flush(),
        owned: await evidence.owned.flush(),
        stderr: await evidence.stderr.flush(),
      };
      await forwarding;
      const cleanup = stopRunServers(dir);
      cleanup.portFree = !(await portBusy());
      cleanup.pass = cleanup.pass && cleanup.portFree;
      writeFileSync(
        join(dir, "cleanup.json"),
        JSON.stringify(cleanup, null, 2),
      );
      writeFileSync(join(dir, "playwright.log"), log);
      const reportPath = join(dir, "e2e-results.json");
      const report = existsSync(reportPath)
        ? JSON.parse(readFileSync(reportPath, "utf8"))
        : null;
      resolve({
        code,
        cleanup,
        guarded,
        report,
        memory: profile(telemetry.samples),
        telemetry: {
          transport: telemetry.transport,
          accepted: telemetry.accepted,
          rejected: telemetry.rejected,
          streamClosedBeforeStop: guarded?.reason === "MEMORY_SAMPLER_EXITED",
          samplerErrors,
          samplerStderrBytes,
          evidence: Object.fromEntries(
            Object.entries(written).map(([k, v]) => [
              k,
              {
                complete: v.complete,
                written: v.written,
                retries: v.retries,
                errors: v.errors,
              },
            ]),
          ),
        },
        durationMs: Date.now() - since.getTime(),
      });
    });
  });
}
if (mode === "plan") {
  const p = plan(chunksArg);
  console.log(
    JSON.stringify({
      chunks: p.chunks.map((c) => [c.chunk, c.tests, c.files.length]),
      proof: {
        ...p.proof,
        missing: p.proof.missing.length,
        extra: p.proof.extra.length,
      },
    }),
  );
} else if (mode === "run") {
  if (existsSync(join(outDir, "e2e-summary.json")))
    throw Error("INDEPENDENT_NEW_SEQUENCE_DIRECTORY_REQUIRED");
  const p = plan(chunksArg);
  const results = [];
  for (const c of p.chunks) {
    if (only && String(c.chunk) !== only) continue;
    const r = await runPlaywright(
      join(outDir, "chunk-" + c.chunk),
      c.files,
      guardGb,
    );
    const s = stats(r.report);
    const ran = new Set(s.tests.map((t) => t.id));
    results.push({
      chunk: c.chunk,
      files: c.files,
      planned: c.tests,
      exitCode: r.code,
      durationMs: r.durationMs,
      expected: s.expected,
      skipped: s.skipped,
      unexpected: s.unexpected,
      flaky: s.flaky,
      retries: s.retries,
      notRun: c.members.filter((m) => !ran.has(m)),
      memory: r.memory,
      cleanup: r.cleanup,
      guarded: r.guarded,
      telemetry: r.telemetry,
      actualIds: s.tests.map((t) => t.id),
      actualExtra: s.tests
        .filter((t) => !c.members.includes(t.id))
        .map((t) => t.id),
    });
  }
  const all = results.flatMap((r) => r.notRun);
  const summary = {
    at: new Date().toISOString(),
    testedSourceCheckpoint: p.testedSourceCheckpoint,
    origin,
    testedSourceUnchanged: p.testedSourceCheckpoint === testedSource(),
    method:
      "deterministic chunked harness (scripts/e2e-chunks.mjs); each chunk is a separate Playwright invocation with its own Next dev server",
    discovered: p.proof.discovered,
    union: p.proof.union,
    duplicates: p.proof.duplicates,
    missing: p.proof.missing.length,
    chunks: results,
    total: {
      passed: results.reduce((a, r) => a + r.expected, 0),
      skipped: results.reduce((a, r) => a + r.skipped, 0),
      failed: results.reduce((a, r) => a + r.unexpected, 0),
      flaky: results.reduce((a, r) => a + r.flaky, 0),
      retries: results.reduce((a, r) => a + r.retries, 0),
      notRun: all.length,
    },
    pass:
      !only &&
      p.testedSourceCheckpoint === testedSource() &&
      p.proof.discovered >= 332 &&
      results.length === p.chunks.length &&
      results.every(
        (r) =>
          r.exitCode === 0 &&
          r.cleanup?.pass &&
          !r.guarded &&
          !r.skipped &&
          !r.unexpected &&
          !r.flaky &&
          !r.retries &&
          !r.actualExtra?.length &&
          new Set(r.actualIds).size === r.planned,
      ) &&
      new Set(results.flatMap((r) => r.actualIds ?? [])).size ===
        p.proof.discovered &&
      all.length === 0 &&
      results.reduce((a, r) => a + r.expected, 0) === p.proof.discovered,
  };
  writeFileSync(
    join(outDir, only ? `e2e-summary-chunk-${only}.json` : "e2e-summary.json"),
    JSON.stringify(summary, null, 1),
  );
  console.log(JSON.stringify({ ...summary.total, pass: summary.pass }));
  process.exit(
    summary.pass ||
      (only &&
        results.every(
          (r) =>
            r.exitCode === 0 &&
            r.cleanup?.pass &&
            !r.guarded &&
            !r.unexpected &&
            !r.flaky &&
            !r.retries &&
            !r.skipped,
        ))
      ? 0
      : 1,
  );
} else if (mode === "summarize") {
  // Combines chunks run one by one (`run <dir> <n> --only=k`) into the single summary and coverage proof.
  const p = plan(chunksArg);
  const results = p.chunks.map((c) => {
    const f = join(outDir, `e2e-summary-chunk-${c.chunk}.json`);
    if (!existsSync(f))
      return {
        chunk: c.chunk,
        files: c.files,
        planned: c.tests,
        exitCode: null,
        expected: 0,
        skipped: 0,
        unexpected: 0,
        flaky: 0,
        retries: 0,
        notRun: c.members,
        memory: null,
      };
    return JSON.parse(readFileSync(f, "utf8")).chunks[0];
  });
  const all = results.flatMap((r) => r.notRun);
  const summary = {
    at: new Date().toISOString(),
    method:
      "deterministic chunked harness (scripts/e2e-chunks.mjs); chunks run one by one, each a separate Playwright invocation with its own Next dev server; combined here",
    discovered: p.proof.discovered,
    union: p.proof.union,
    duplicates: p.proof.duplicates,
    missing: p.proof.missing.length,
    chunks: results,
    total: {
      passed: results.reduce((a, r) => a + r.expected, 0),
      skipped: results.reduce((a, r) => a + r.skipped, 0),
      failed: results.reduce((a, r) => a + r.unexpected, 0),
      flaky: results.reduce((a, r) => a + r.flaky, 0),
      retries: results.reduce((a, r) => a + r.retries, 0),
      notRun: all.length,
    },
    pass:
      p.proof.discovered >= 332 &&
      results.length === p.chunks.length &&
      results.every(
        (r) =>
          r.exitCode === 0 &&
          r.cleanup?.pass &&
          !r.guarded &&
          !r.skipped &&
          !r.unexpected &&
          !r.flaky &&
          !r.retries &&
          !r.actualExtra?.length &&
          new Set(r.actualIds).size === r.planned,
      ) &&
      new Set(results.flatMap((r) => r.actualIds ?? [])).size ===
        p.proof.discovered &&
      all.length === 0 &&
      results.reduce((a, r) => a + r.expected, 0) === p.proof.discovered,
  };
  writeFileSync(
    join(outDir, "e2e-summary.json"),
    JSON.stringify(summary, null, 1),
  );
  console.log(JSON.stringify({ ...summary.total, pass: summary.pass }));
  process.exit(summary.pass ? 0 : 1);
} else if (mode === "monolithic") {
  const p = plan(chunksArg);
  const r = await runPlaywright(join(outDir, "monolithic"), [], guardGb);
  const s = stats(r.report);
  const summary = {
    at: new Date().toISOString(),
    mode: "monolithic (diagnosis)",
    guardGb,
    discovered: p.proof.discovered,
    exitCode: r.code,
    guarded: r.guarded,
    durationMs: r.durationMs,
    expected: s.expected,
    skipped: s.skipped,
    unexpected: s.unexpected,
    flaky: s.flaky,
    retries: s.retries,
    memory: r.memory,
    verdict: r.guarded
      ? "ABORTED_BY_HOST_MEMORY_GUARD (not a pass)"
      : r.code === 0 && s.expected === p.proof.discovered
        ? "PASS"
        : "NOT_A_PASS",
  };
  writeFileSync(
    join(outDir, "monolithic-summary.json"),
    JSON.stringify(summary, null, 1),
  );
  console.log(
    JSON.stringify({
      verdict: summary.verdict,
      expected: s.expected,
      unexpected: s.unexpected,
      memory: r.memory,
    }),
  );
} else throw Error("UNKNOWN_MODE");
