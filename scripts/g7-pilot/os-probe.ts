// READ-ONLY operating-system probe for the G7 pilot launcher's process supervision: which process listens on a
// loopback port, and the process table (pid, parent, name, command line, start time). It runs exactly two fixed
// programs without a shell — PowerShell (Get-NetTCPConnection / Get-CimInstance) on Windows, lsof/ps elsewhere —
// with a validated integer port as the only variable input. It never starts, signals or stops any process.
import { execFile } from "node:child_process";

export interface ListenerRow {
  address: string;
  port: number;
  pid: number;
}
export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string | null;
  createdAt: string | null;
}
export interface OsSnapshot {
  platform: NodeJS.Platform;
  listeners: ListenerRow[];
  processes: Map<number, ProcessRow>;
  error: string | null;
}

const run = (file: "powershell.exe" | "lsof" | "ps", args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      file,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) =>
        // lsof exits 1 when nothing listens: an empty answer, not a failure.
        error && !(file === "lsof" && stdout === "")
          ? reject(error)
          : resolve(stdout),
    ),
  );

const list = <T>(v: T | T[] | null | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

export async function osSnapshot(port: number | null): Promise<OsSnapshot> {
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error("BAD_PORT");
  const processes = new Map<number, ProcessRow>();
  const listeners: ListenerRow[] = [];
  try {
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        port === null
          ? "$l=@()"
          : `$l=@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object LocalAddress,LocalPort,OwningProcess)`,
        "$p=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}})",
        "ConvertTo-Json -Compress -Depth 3 @{listeners=$l;processes=$p}",
      ].join(";");
      const out = JSON.parse(
        await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ]),
      ) as {
        listeners: unknown;
        processes: unknown;
      };
      for (const r of list(
        out.listeners as {
          LocalAddress: string;
          LocalPort: number;
          OwningProcess: number;
        }[],
      ))
        listeners.push({
          address: r.LocalAddress,
          port: r.LocalPort,
          pid: r.OwningProcess,
        });
      for (const r of list(
        out.processes as {
          ProcessId: number;
          ParentProcessId: number;
          Name: string;
          CommandLine: string | null;
          Created: string | null;
        }[],
      ))
        processes.set(r.ProcessId, {
          pid: r.ProcessId,
          ppid: r.ParentProcessId,
          name: r.Name,
          commandLine: r.CommandLine ?? null,
          createdAt: r.Created ?? null,
        });
    } else {
      if (port !== null)
        for (const line of (
          await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"])
        ).split("\n"))
          if (/^p\d+$/.test(line))
            listeners.push({
              address: "",
              port,
              pid: Number(line.slice(1)),
            });
      for (const line of (
        await run("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="])
      ).split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        processes.set(Number(m[1]), {
          pid: Number(m[1]),
          ppid: Number(m[2]),
          name: (m[3].split(/\s+/)[0] ?? "").split("/").pop() ?? "",
          commandLine: m[3],
          createdAt: null,
        });
      }
    }
    return { platform: process.platform, listeners, processes, error: null };
  } catch (e) {
    return {
      platform: process.platform,
      listeners,
      processes,
      error: String((e as Error)?.message ?? e).slice(0, 300),
    };
  }
}

// Launch wrappers between a user's command and the launcher (pnpm's shell wrapper, pnpm/corepack itself, the
// terminal shell). When any of them disappears while the launcher still runs, the launcher is an orphan.
const SHELL = /^(cmd|sh|bash|dash|zsh|fish|pwsh|powershell)(\.exe)?$/i;
const PACKAGE_RUNNER = /pnpm|npm-cli|corepack|npx-cli|yarn/i;
export function launchAncestors(snapshot: OsSnapshot, pid: number) {
  const chain: ProcessRow[] = [];
  let current = snapshot.processes.get(pid);
  for (let i = 0; current && i < 8; i++) {
    const parent = snapshot.processes.get(current.ppid);
    if (!parent || parent.pid === current.pid) break;
    const wrapper =
      SHELL.test(parent.name) ||
      (/^node(\.exe)?$/i.test(parent.name) &&
        PACKAGE_RUNNER.test(parent.commandLine ?? ""));
    // The direct parent is always watched (pnpm wrapper, test harness, or whoever started the launcher).
    if (chain.length > 0 && !wrapper) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}
