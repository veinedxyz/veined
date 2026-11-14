import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error("INVALID_PID");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){ @{pid=$p.ProcessId;parent=$p.ParentProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw Error("PROCESS_IDENTITY_UNAVAILABLE");
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

// Each launcher writes a separate immutable identity record. A numeric PID alone
// is never an authorization to adopt or terminate a process.
export function registerProcess(pid, directory) {
  const row = processIdentity(pid);
  if (!row) return null; // A short command may already have exited.
  for (const target of new Set(
    [directory, process.env.OTHERBRIDGE_PROCESS_REGISTRY].filter(Boolean),
  )) {
    const registrations = join(target, "process-registrations");
    mkdirSync(registrations, { recursive: true });
    writeFileSync(
      join(
        registrations,
        `${row.pid}-${row.created.replace(/[^0-9]/g, "")}.json`,
      ),
      JSON.stringify(row),
    );
  }
  return row;
}

export function stopExactProcess(child, identity) {
  if (identity && processIdentity(identity.pid)?.created === identity.created)
    return child.kill();
  return false;
}
