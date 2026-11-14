import { spawn, spawnSync } from "node:child_process";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  createWriteStream,
} from "node:fs";
import { resolve, join, sep } from "node:path";
import { waitForHostMemory, memoryProfiles } from "./lib/test-memory.mjs";
import { cleanupReproductionDatabase } from "./lib/v1201-postgres.mjs";
import { registerProcess } from "./lib/process-identity.mjs";
import {
  createEvidenceWriter,
  createGuardState,
  createSampleStream,
  evaluateMemoryGuard,
} from "./lib/memory-guard.mjs";

const ps = (script) =>
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
const identity = (pid) => {
  const result = ps(
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){ @{pid=$p.ProcessId;parent=$p.ParentProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`,
  );
  if (result.status !== 0) throw Error("PROCESS_IDENTITY_UNAVAILABLE");
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};

const [outArg, ...args] = process.argv.slice(2);
if (!outArg || !args.length)
  throw Error("USAGE: owned-run <new-evidence-dir> <node-args...>");
const out = resolve(outArg);
if (existsSync(join(out, "result.json"))) throw Error("NEW_EVIDENCE_REQUIRED");
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "controller.json"),
  JSON.stringify(
    { at: new Date().toISOString(), process: identity(process.pid), args },
    null,
    2,
  ),
);
const profile = process.env.V1201_MEMORY_PROFILE ?? "standard";
if (!Object.hasOwn(memoryProfiles, profile))
  throw Error("MEMORY_PROFILE_INVALID");
try {
  await waitForHostMemory(out, profile);
} catch (error) {
  writeFileSync(
    join(out, "result.json"),
    JSON.stringify(
      {
        pass: false,
        started: false,
        reason: error.message,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  throw error;
}
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, args, {
  cwd: process.env.V1201_CHILD_CWD || process.cwd(),
  env: {
    ...process.env,
    NODE_OPTIONS: `--max-old-space-size=${memoryProfiles[profile].heapMiB}`,
    VITEST_MAX_WORKERS: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    OTHERBRIDGE_PROCESS_REGISTRY: out,
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const log = createWriteStream(join(out, "command.log"), { flags: "wx" });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const closed = new Promise((done) => {
  child.once("error", () => done(-1));
  child.once("close", (code) => done(code));
});
const childIdentity = registerProcess(child.pid, out);
writeFileSync(
  join(out, "server-processes.json"),
  JSON.stringify({ processes: [childIdentity].filter(Boolean), at: startedAt }),
);
// Telemetry arrives on the sampler's stdout (-Stream) and is evaluated in memory; the evidence files
// (memory.psv, owned-processes.json, sampler.stderr.log) are written asynchronously, off the decision path.
const telemetry = createGuardState(Date.now(), performance.now());
const evidence = {
  samples: createEvidenceWriter(join(out, "memory.psv")),
  owned: createEvidenceWriter(join(out, "owned-processes.json"), {
    mode: "replace",
  }),
  stderr: createEvidenceWriter(join(out, "sampler.stderr.log")),
};
let ownedSnapshot = null;
const stream = createSampleStream(telemetry, {
  onSample: (_, line) => evidence.samples.write(line + "\r\n"),
  onOwned: (_, json) => {
    ownedSnapshot = json;
    evidence.owned.write(json);
  },
});
const monitor = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    resolve("scripts/e2e-monitor.ps1"),
    "-OwnerPid",
    String(child.pid),
    "-OwnerCreated",
    childIdentity?.created ?? "",
    "-Directory",
    out,
    "-Since",
    startedAt,
    "-Stream",
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
monitor.stdout.setEncoding("utf8");
monitor.stdout.on("data", (d) => stream.push(d));
monitor.stdout.on("close", () => stream.end());
monitor.stderr.on("data", (d) => evidence.stderr.write(String(d)));
const monitorIdentity = identity(monitor.pid);
const monitorClosed = new Promise((done) => monitor.once("close", done));
writeFileSync(
  join(out, "launch.json"),
  JSON.stringify(
    {
      startedAt,
      cwd: process.env.V1201_CHILD_CWD || process.cwd(),
      args,
      profile,
      child: childIdentity,
      monitor: monitorIdentity,
    },
    null,
    2,
  ),
);
let guard = null;
const timer = setInterval(() => {
  if (guard) return;
  try {
    // Same limits as before: free < 1 GiB, commit headroom < 2 GiB, owned above the profile, 15 s freshness.
    guard = evaluateMemoryGuard({
      samples: telemetry.samples,
      state: telemetry,
      nowMs: Date.now(),
      monoMs: performance.now(),
      guardGb: 2,
      ownedLimitGb: memoryProfiles[profile].ownedGiB,
      samplerExited: monitor.exitCode !== null || monitor.signalCode !== null,
    });
  } catch {
    guard = "MEMORY_READER_FAILED";
  }
  if (guard && childIdentity) {
    const current = identity(childIdentity.pid);
    if (current?.created === childIdentity.created) child.kill();
  }
}, 1000);
const code = await closed;
clearInterval(timer);
await new Promise((done) => log.end(done));
if (
  monitorIdentity &&
  identity(monitorIdentity.pid)?.created === monitorIdentity.created
) {
  monitor.kill();
  await monitorClosed;
}
// Ensure even a very short root process has a registration; only exact identities
// registered by this invocation can reach the existing cleanup implementation.
const evidenceWritten = {
  samples: await evidence.samples.flush(),
  owned: await evidence.owned.flush(),
  stderr: await evidence.stderr.flush(),
};
const registryPath = join(out, "owned-processes.json");
const rows = ownedSnapshot ? [JSON.parse(ownedSnapshot)].flat() : [];
if (
  childIdentity &&
  !rows.some(
    (row) =>
      row.pid === childIdentity.pid && row.created === childIdentity.created,
  )
)
  rows.push(childIdentity);
writeFileSync(registryPath, JSON.stringify(rows));
const cleanupResult = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    resolve("scripts/e2e-cleanup.ps1"),
    "-Directory",
    out,
  ],
  { encoding: "utf8", windowsHide: true },
);
const cleanup =
  cleanupResult.status === 0
    ? JSON.parse(cleanupResult.stdout)
    : { remaining: ["cleanup unavailable"] };
let databaseCleanup;
if (args[0] === "scripts/v1201-reproduce.mjs") {
  const databaseDirectory = resolve(args[1]);
  if (!databaseDirectory.startsWith(out + sep))
    throw Error("OWNED_REPRODUCTION_DIRECTORY_REQUIRED");
  try {
    databaseCleanup = cleanupReproductionDatabase(databaseDirectory, startedAt);
  } catch (error) {
    databaseCleanup = { pass: false, error: error.message };
  }
}
const result = {
  startedAt,
  finishedAt: new Date().toISOString(),
  code,
  guard,
  telemetry: {
    transport: telemetry.transport,
    accepted: telemetry.accepted,
    rejected: telemetry.rejected,
    evidence: evidenceWritten,
  },
  cleanup,
  databaseCleanup,
  pass:
    code === 0 &&
    !guard &&
    cleanup.remaining.length === 0 &&
    databaseCleanup?.pass !== false,
};
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.pass) process.exitCode = 1;
