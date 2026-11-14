// Bounded lifecycle regression: an unrelated process must survive owned cleanup.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("EVIDENCE_DIRECTORY_REQUIRED");
mkdirSync(out, { recursive: true });
const since = new Date();
const own = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  windowsHide: true,
  stdio: "ignore",
});
const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  windowsHide: true,
  stdio: "ignore",
});
const monitor = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    "scripts/e2e-monitor.ps1",
    "-OwnerPid",
    String(own.pid),
    "-Directory",
    out,
    "-Since",
    since.toISOString(),
  ],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
);
let errors = "";
monitor.stderr.on("data", (d) => (errors += d));
try {
  await new Promise((r) => setTimeout(r, 6500));
  monitor.kill();
  await new Promise((r) => monitor.once("close", r));
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "scripts/e2e-cleanup.ps1",
      "-Directory",
      out,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const cleanup = JSON.parse(result.stdout || "{}");
  const registry = JSON.parse(
    readFileSync(join(out, "owned-processes.json"), "utf8"),
  );
  let unrelatedAlive = true;
  try {
    process.kill(unrelated.pid, 0);
  } catch {
    unrelatedAlive = false;
  }
  let ownerAlive = true;
  try {
    process.kill(own.pid, 0);
  } catch {
    ownerAlive = false;
  }
  const pass =
    result.status === 0 &&
    !errors &&
    !ownerAlive &&
    unrelatedAlive &&
    registry.some((p) => p.pid === own.pid) &&
    !registry.some((p) => p.pid === unrelated.pid) &&
    cleanup.remaining?.length === 0;
  const report = {
    at: new Date().toISOString(),
    pass,
    ownerAlive,
    unrelatedAlive,
    registry,
    cleanup,
    cleanupExit: result.status,
    cleanupError: result.stderr,
    ownerPid: own.pid,
    unrelatedPid: unrelated.pid,
    errors,
  };
  writeFileSync(join(out, "lifecycle.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass, ownerAlive, unrelatedAlive, errors }));
  if (!pass) process.exitCode = 1;
} finally {
  monitor.kill();
  own.kill();
  unrelated.kill();
}
