// Stops a running in-product G7 pilot launcher of THIS repository — and nothing else:
//   pnpm g7:product-pilot:stop [--port <n>] [--force]      (--state-dir <dir>: tests only)
// 1. The launcher answers on its exact 127.0.0.1 Host with the instance id of our runtime record: graceful stop
//    through the token-protected loopback shutdown endpoint (refused while a wallet request is in flight unless
//    --force; the one-shot lock is never touched).
// 2. It does not answer but the recorded pid is alive: stopped only after proving it is our launcher (command line
//    names scripts/g7-product-pilot.ts and its start time equals the recorded one). A reused pid is never touched.
// 3. Otherwise the port owner is explained and left alone. There is no kill-by-name and no kill of other processes.
import { setTimeout as sleep } from "node:timers/promises";
import { join, resolve } from "node:path";
import { REPO } from "./g7-pilot/launch";
import { DEFAULT_PORT, HOST } from "./g7-pilot/policy";
import { osSnapshot } from "./g7-pilot/os-probe";
import {
  SHUTDOWN_PATH,
  explainPortOwner,
  isOurLauncher,
  portAcceptsConnections,
  probeIdentity,
  publicRecord,
  readRuntimeRecord,
  removeRuntimeRecord,
  runtimeRecordPath,
} from "./g7-pilot/supervisor";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(opt("--port") ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("BAD_PORT");
const force = argv.includes("--force");
const stateRoot = opt("--state-dir")
  ? resolve(opt("--state-dir")!)
  : join(REPO, ".otherbridge");
const recordPath = runtimeRecordPath(stateRoot, port);
const done = (status: string, extra: Record<string, unknown>, code = 0) => {
  if (typeof extra.message === "string")
    console.log(`${status}: ${extra.message}`);
  console.log(`G7PILOT_STOP ${JSON.stringify({ status, port, ...extra })}`);
  process.exit(code);
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};
async function waitGone(pid: number, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid) && !(await probeIdentity(port, 800))) return true;
    await sleep(250);
  }
  return false;
}

const record = readRuntimeRecord(recordPath);
const identity = await probeIdentity(port);
if (record && identity && identity.instanceId === record.instanceId) {
  const r = await fetch(
    `http://${HOST}:${port}${SHUTDOWN_PATH}${force ? "?force=1" : ""}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${record.controlToken}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 409)
    done(
      "WALLET_REQUEST_IN_FLIGHT",
      {
        state: body.state,
        message:
          "A wallet request is in flight; the launcher keeps running. Finish or reject it in the wallet, or pass --force (the one-shot lock stays in place).",
      },
      4,
    );
  if (r.status !== 202) done("STOP_REFUSED", { httpStatus: r.status, body }, 5);
  const gone = await waitGone(identity.pid);
  done(
    gone ? "STOPPED_GRACEFULLY" : "STOP_REQUESTED_STILL_RUNNING",
    {
      pid: identity.pid,
      sessionId: identity.sessionId,
      state: body.state,
    },
    gone ? 0 : 6,
  );
}
if (record && !identity) {
  if (!alive(record.pid)) {
    removeRuntimeRecord(recordPath, record.instanceId);
    done("STALE_RECORD_REMOVED", {
      recordedPid: record.pid,
      portOwner: (await portAcceptsConnections(port))
        ? await explainPortOwner(port, recordPath)
        : null,
    });
  }
  const os = await osSnapshot(port);
  const proc = os.processes.get(record.pid);
  const sameStart =
    !record.processStartedAt ||
    !proc?.createdAt ||
    record.processStartedAt === proc.createdAt;
  if (!isOurLauncher(proc) || !sameStart) {
    // The recorded pid now belongs to a different process: forget the record, touch nothing.
    removeRuntimeRecord(recordPath, record.instanceId);
    done(
      "RECORDED_PID_REUSED_NOT_TOUCHED",
      {
        recordedPid: record.pid,
        processName: proc?.name ?? null,
        record: publicRecord(record),
      },
      7,
    );
  }
  process.kill(record.pid);
  const gone = await waitGone(record.pid);
  if (gone) removeRuntimeRecord(recordPath, record.instanceId);
  done(
    gone ? "STOPPED_UNRESPONSIVE_VERIFIED_LAUNCHER" : "STOP_FAILED",
    {
      pid: record.pid,
      sessionId: record.sessionId,
    },
    gone ? 0 : 8,
  );
}
if (!identity && !(await portAcceptsConnections(port)))
  done("NOT_RUNNING", {
    message: `No Otherbridge pilot launcher runs on 127.0.0.1:${port}.`,
  });
done(
  "NOT_OURS_NOT_TOUCHED",
  { ...(await explainPortOwner(port, recordPath)) },
  9,
);
