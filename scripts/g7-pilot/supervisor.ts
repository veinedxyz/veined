// Process supervision for the in-product G7 pilot launcher (local only). It never stops a process it cannot prove
// is this repository's pilot launcher, and it never acts on a process by name:
//   - runtime record  `<state>/g7-pilot-runtime-<port>.json` (exact pid, start time, instance id, per-run control
//                     token for the loopback shutdown endpoint); removed on a clean exit,
//   - identity        GET /g7-pilot/runtime on the exact 127.0.0.1 Host answers who is serving the port,
//   - port conflicts  explained (our running pilot / our unresponsive launcher / another application), never forced,
//   - orphan guard    the launch wrappers (pnpm's shell, pnpm, the terminal shell) are watched; when one of them
//                     disappears the launcher shuts itself down instead of holding the port as an orphan,
//   - memory          RSS sampled every second (current and peak) for the identity endpoint and the evidence.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { HOST } from "./policy";
import { launchAncestors, osSnapshot, type ProcessRow } from "./os-probe";

export const RUNTIME_APP = "otherbridge-g7-product-pilot" as const;
export const RUNTIME_PATH = "/g7-pilot/runtime";
export const SHUTDOWN_PATH = "/g7-pilot/runtime/shutdown";
export const LAUNCHER_SCRIPT = "scripts/g7-product-pilot.ts";

export interface RuntimeRecord {
  schema: "otherbridge.g7.pilot-runtime.v1";
  app: typeof RUNTIME_APP;
  instanceId: string;
  controlToken: string;
  pid: number;
  processStartedAt: string | null;
  port: number;
  origin: string;
  mode: string;
  fixture: string | null;
  sessionId: string;
  evidence: string;
  startedAt: string;
  expiresAt: string;
  runtime: "next-production";
  distDir: string;
  buildId: string;
  watchedAncestors: { pid: number; name: string }[];
}
export interface RuntimeIdentity {
  app: typeof RUNTIME_APP;
  instanceId: string;
  pid: number;
  port: number;
  mode: string;
  fixture: string | null;
  sessionId: string;
  state: string;
  armed: boolean;
  startedAt: string;
  expiresAt: string;
  runtime: "next-production";
  buildId: string;
  uptimeMs: number;
  rssBytes: number;
  peakRssBytes: number;
}

export const runtimeRecordPath = (stateRoot: string, port: number) =>
  join(stateRoot, `g7-pilot-runtime-${port}.json`);
export const newInstanceId = () => `g7r-${randomBytes(8).toString("hex")}`;
export const newControlToken = () => randomBytes(32).toString("base64url");

export function readRuntimeRecord(path: string): RuntimeRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as RuntimeRecord;
    return r?.schema === "otherbridge.g7.pilot-runtime.v1" ? r : null;
  } catch {
    return null;
  }
}
export function writeRuntimeRecord(path: string, record: RuntimeRecord) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  writeSync(fd, JSON.stringify(record, null, 1) + "\n");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}
// Only the instance that wrote the record removes it.
export function removeRuntimeRecord(path: string, instanceId: string) {
  if (readRuntimeRecord(path)?.instanceId === instanceId)
    rmSync(path, { force: true });
}
export function controlTokenMatches(given: string | null, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given, "utf8"),
    b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Is anything accepting connections on 127.0.0.1:<port>? (A hung listener that never answers counts as busy.)
export function portAcceptsConnections(port: number, timeoutMs = 1500) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: HOST, port });
    const end = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs, () => end(true));
    socket.once("connect", () => end(true));
    socket.once("error", () => end(false));
  });
}

// Who answers on 127.0.0.1:<port>? Only an Otherbridge pilot launcher returns this identity.
export async function probeIdentity(
  port: number,
  timeoutMs = 2500,
): Promise<RuntimeIdentity | null> {
  try {
    const r = await fetch(`http://${HOST}:${port}${RUNTIME_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!r.ok) return null;
    const body = (await r.json()) as RuntimeIdentity;
    return body?.app === RUNTIME_APP ? body : null;
  } catch {
    return null;
  }
}

export type PortOwnerStatus =
  | "OTHERBRIDGE_PILOT_RUNNING"
  | "OTHERBRIDGE_PILOT_UNRESPONSIVE"
  | "OTHERBRIDGE_PILOT_OTHER_CHECKOUT"
  | "PORT_HELD_BY_OTHER_PROCESS"
  | "PORT_IN_USE_OWNER_UNKNOWN";
export interface PortOwner {
  status: PortOwnerStatus;
  port: number;
  pid: number | null;
  processName: string | null;
  identity: RuntimeIdentity | null;
  record: Omit<RuntimeRecord, "controlToken"> | null;
  message: string;
  probeError: string | null;
}
export const isOurLauncher = (p: ProcessRow | undefined) =>
  !!p?.commandLine &&
  /node/i.test(p.name) &&
  p.commandLine.replaceAll("\\", "/").includes(LAUNCHER_SCRIPT);
export function publicRecord(r: RuntimeRecord | null) {
  if (!r) return null;
  const { controlToken: _secret, ...rest } = r;
  void _secret;
  return rest;
}
export async function explainPortOwner(
  port: number,
  recordPath: string,
): Promise<PortOwner> {
  const record = readRuntimeRecord(recordPath);
  const identity = await probeIdentity(port);
  const os = await osSnapshot(port);
  const pid = os.listeners[0]?.pid ?? identity?.pid ?? null;
  const proc = pid === null ? undefined : os.processes.get(pid);
  const base = {
    port,
    pid,
    processName: proc?.name ?? null,
    identity,
    record: publicRecord(record),
    probeError: os.error,
  };
  const stop =
    "Stop it with `pnpm g7:product-pilot:stop` (it verifies the process before touching it).";
  if (identity && record && identity.instanceId === record.instanceId)
    return {
      ...base,
      status: "OTHERBRIDGE_PILOT_RUNNING",
      message: `An Otherbridge G7 pilot session is already running on 127.0.0.1:${port} (pid ${identity.pid}, session ${identity.sessionId}, mode ${identity.mode}, state ${identity.state}, started ${identity.startedAt}, expires ${identity.expiresAt}). Use that session's window, or ${stop}`,
    };
  if (identity)
    return {
      ...base,
      status: "OTHERBRIDGE_PILOT_OTHER_CHECKOUT",
      message: `Another Otherbridge G7 pilot launcher (pid ${identity.pid}, session ${identity.sessionId}) serves 127.0.0.1:${port}, but this checkout has no runtime record for it. Stop it from the checkout that started it; nothing was touched.`,
    };
  if (pid !== null && (record?.pid === pid || isOurLauncher(proc)))
    return {
      ...base,
      status: "OTHERBRIDGE_PILOT_UNRESPONSIVE",
      message: `An Otherbridge G7 pilot launcher (pid ${pid}) holds 127.0.0.1:${port} but does not answer (hung or shutting down). ${stop}`,
    };
  if (pid !== null)
    return {
      ...base,
      status: "PORT_HELD_BY_OTHER_PROCESS",
      message: `127.0.0.1:${port} is held by another application (pid ${pid}${proc ? `, ${proc.name}` : ""}). It is not an Otherbridge pilot and is never stopped by Otherbridge. Close that application or free the port; the real pilot only runs on the Privy-allowed origin 127.0.0.1:${port}.`,
    };
  return {
    ...base,
    status: "PORT_IN_USE_OWNER_UNKNOWN",
    message: `127.0.0.1:${port} is in use and its owner could not be identified${os.error ? ` (${os.error})` : ""}. Nothing was touched.`,
  };
}

// Orphan guard: the launch wrappers recorded at startup must stay alive.
export async function watchLaunchWrappers(
  onLost: (lost: { pid: number; name: string }) => void,
  intervalMs = 2000,
) {
  const os = await osSnapshot(null);
  const self = os.processes.get(process.pid);
  const ancestors = launchAncestors(os, process.pid).map((p) => ({
    pid: p.pid,
    name: p.name,
  }));
  const initialParent = process.ppid;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as { code?: string }).code === "EPERM";
    }
  };
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const lost =
      ancestors.find((a) => !alive(a.pid)) ??
      // POSIX re-parents an orphan to init/a subreaper: a changed parent pid means the launcher was orphaned.
      (process.platform !== "win32" && process.ppid !== initialParent
        ? { pid: initialParent, name: "parent" }
        : undefined);
    if (lost) {
      fired = true;
      clearInterval(timer);
      onLost(lost);
    }
  }, intervalMs);
  timer.unref();
  return {
    ancestors,
    processStartedAt: self?.createdAt ?? null,
    probeError: os.error,
    stop: () => clearInterval(timer),
  };
}

export function memorySampler(intervalMs = 1000) {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, intervalMs);
  timer.unref();
  return {
    current: () => process.memoryUsage().rss,
    // The OS-level peak (maxRSS, KiB) also covers spikes between samples.
    peak: () =>
      Math.max(
        peak,
        process.memoryUsage().rss,
        process.resourceUsage().maxRSS * 1024,
      ),
    stop: () => clearInterval(timer),
  };
}
