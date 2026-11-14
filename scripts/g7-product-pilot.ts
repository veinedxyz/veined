// G7 controlled pilot INSIDE the normal Otherbridge product — owner-approved, LOCAL ONLY, one shot, HUMAN-SIGNED.
//   pnpm g7:product-pilot            builds the separate local-g7-pilot artifact if it is missing or stale, then
//                                    serves it with the Next.js PRODUCTION runtime (no dev server, no Turbopack, no
//                                    workers, no error overlay) on 127.0.0.1 with the local pilot enabled for exactly
//                                    one 5 ONE ONEchain -> BSC transfer from and to the authorized EOA; the wallet's
//                                    own confirmation is the owner's.
//   --dry-run                        same, but the final step never releases the wallet request
//   --port <n>                       default 3197 (the Privy-allowed origin; never changed automatically)
//   --fixture <scenario> --state-dir <dir> [--ttl-ms <n> --expiry-grace-ms <n>]   TESTS ONLY (deterministic pilot
//                                    data, mock wallet only, local-g7-pilot-test artifact)
//   pnpm g7:product-pilot:stop       stops a running launcher after verifying it is this repository's launcher
// One process: an exact-Host loopback server routes /g7-pilot/api/* to the one-shot pilot session,
// /g7-pilot/runtime to the launcher identity (and the token-protected local shutdown) and everything else to Next.
// Lifecycle: a busy port is explained, never forced; the launch wrappers (pnpm, its shell, the terminal) are
// watched so the launcher never outlives them as an orphan; Ctrl+C / SIGTERM / SIGHUP / Ctrl+Break, the stop
// command and session expiry all shut down gracefully and remove the runtime record. The public product is
// unaffected: GLOBAL_EXECUTION_ENABLED stays false, the public `.next` artifact never contains the pilot module,
// and next.config.ts refuses the pilot profile everywhere except this launcher.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join, relative } from "node:path";
import type createNextApp from "next";
import { verifyPilotBuild } from "./g7-pilot/build-profile";
import { REPO, createPilotRuntime, parseLaunchArgs } from "./g7-pilot/launch";
import { PILOT_SCOPE } from "./g7-pilot/policy";
import { startupReport } from "./g7-pilot/report";
import { listenLoopback, pilotApi, sendJson } from "./g7-pilot/server";
import {
  RUNTIME_APP,
  RUNTIME_PATH,
  SHUTDOWN_PATH,
  controlTokenMatches,
  explainPortOwner,
  memorySampler,
  newControlToken,
  newInstanceId,
  readRuntimeRecord,
  removeRuntimeRecord,
  runtimeRecordPath,
  watchLaunchWrappers,
  writeRuntimeRecord,
  type RuntimeIdentity,
  type RuntimeRecord,
} from "./g7-pilot/supervisor";

if (process.env.NODE_ENV === "production")
  throw new Error("G7_PRODUCT_PILOT_IS_LOCAL_DEVELOPMENT_ONLY");
const launchedAt = Date.now();
const say = (line: string) => {
  try {
    console.log(line);
  } catch {
    // stdout may be gone (wrapper killed); the evidence journal is authoritative
  }
};
function stopEarly(report: Record<string, unknown>, code: number): never {
  say(
    `G7PILOT_NOT_STARTED ${String(report.status)}: ${String(report.message ?? report.reason ?? "")}`,
  );
  say(`G7PILOT_STOPPED ${JSON.stringify(report)}`);
  process.exit(code);
}
const {
  mode,
  fixture,
  stateDir,
  port,
  ttlMs,
  expiryGraceMs,
  candidateBaseline,
} = parseLaunchArgs(process.argv.slice(2), {
  real: null,
  dryRun: "--dry-run",
  defaultMode: "real",
});

// 1. The artifact: the separate local-g7-pilot production build, fresh for the current sources.
const profile = fixture ? "local-g7-pilot-test" : "local-g7-pilot";
const build = verifyPilotBuild(REPO, profile);
if (!build.ok)
  stopEarly(
    {
      status: "BUILD_REQUIRED",
      reason: build.reason,
      profile,
      distDir: build.distDir,
      hint: fixture
        ? "pnpm g7:product-pilot:build --profile local-g7-pilot-test"
        : "pnpm g7:product-pilot (builds a fresh local-g7-pilot artifact first) or pnpm g7:product-pilot:build",
    },
    2,
  );
const artifact = build.manifest;

// 2. The port, before any session or evidence exists: a busy port is explained and never forced.
const API_PREFIX = "/g7-pilot/api/";
let host = "";
let origin = "";
let api: ReturnType<typeof pilotApi> | null = null;
let identity: (() => RuntimeIdentity) | null = null;
let onShutdownRequest:
  ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
type NextApp = ReturnType<typeof createNextApp>;
let handle: ReturnType<NextApp["getRequestHandler"]> | null = null;
const server = createServer((req, res) => {
  // Exact Host for every request (pages, assets, API): DNS-rebinding names pointing at 127.0.0.1 are refused.
  if (req.headers.host !== host) {
    req.resume();
    res.setHeader("connection", "close");
    return sendJson(res, 421, { error: "HOST_NOT_ALLOWED" });
  }
  const path = (req.url ?? "").split("?")[0];
  if (path === RUNTIME_PATH && (req.method === "GET" || req.method === "HEAD"))
    return identity
      ? sendJson(res, 200, identity())
      : sendJson(res, 503, { error: "STARTING" });
  if (path === SHUTDOWN_PATH && onShutdownRequest)
    return onShutdownRequest(req, res);
  if (path === "/g7-pilot/api" || path.startsWith(API_PREFIX))
    return api
      ? void api(req, res, origin)
      : sendJson(res, 503, { error: "STARTING" });
  if (path.startsWith("/g7-pilot")) {
    req.resume();
    return sendJson(res, 404, { error: "NOT_FOUND" });
  }
  if (!handle) return sendJson(res, 503, { error: "STARTING" });
  void handle(req, res);
});
// The production runtime has no HMR or other websocket surface.
server.on("upgrade", (_req, socket) => socket.destroy());
const stateRoot = fixture ? stateDir! : join(REPO, ".otherbridge");
let bound: Awaited<ReturnType<typeof listenLoopback>>;
try {
  bound = await listenLoopback(server, port);
} catch (e) {
  if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
  const owner = await explainPortOwner(
    port,
    runtimeRecordPath(stateRoot, port),
  );
  stopEarly({ ...owner }, 3);
}
host = bound!.host;
origin = bound!.origin;
const recordPath = runtimeRecordPath(stateRoot, bound!.port);

// 3. The one-shot session (evidence, journal, lock) and the process supervision.
const rt = createPilotRuntime({
  mode,
  fixture,
  stateDir,
  evidenceFamily: "otherbridge-g7-product-pilot",
  ttlMs,
  candidateBaseline,
});
const memory = memorySampler();
const instanceId = newInstanceId();
const controlToken = newControlToken();
let app: NextApp | null = null;
let watchdog: Awaited<ReturnType<typeof watchLaunchWrappers>> | null = null;
let stopping = false;
const shutdown = async (reason: string, code = 0) => {
  if (stopping) return;
  stopping = true;
  const hardStop = setTimeout(() => process.exit(code), 8000);
  hardStop.unref();
  rt.journal("SHUTDOWN", {
    reason,
    state: rt.session.snapshot().state,
    rssBytes: memory.current(),
    peakRssBytes: memory.peak(),
  });
  rt.log(`shutting down (${reason})`);
  rt.session.stop();
  watchdog?.stop();
  memory.stop();
  removeRuntimeRecord(recordPath, instanceId);
  server.close();
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 1500).unref();
  await app?.close().catch(() => undefined);
  say(`G7PILOT_SHUTDOWN ${JSON.stringify({ reason, session: rt.session.id })}`);
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const)
  process.on(signal, () => void shutdown(signal));
process.on("uncaughtException", (e) => {
  rt.journal("UNCAUGHT_EXCEPTION", {
    error: String(e?.stack ?? e).slice(0, 500),
  });
  void shutdown("UNCAUGHT_EXCEPTION", 1);
});
process.on("unhandledRejection", (e) =>
  rt.journal("UNHANDLED_REJECTION", {
    error: String((e as Error)?.stack ?? e).slice(0, 500),
  }),
);
const watched = await watchLaunchWrappers((lost) => {
  rt.journal("LAUNCH_WRAPPER_EXITED", lost);
  void shutdown(`LAUNCH_WRAPPER_EXITED pid ${lost.pid} ${lost.name}`);
});
watchdog = watched;
const previous = readRuntimeRecord(recordPath);
if (previous)
  rt.journal("STALE_RUNTIME_RECORD_REPLACED", {
    pid: previous.pid,
    sessionId: previous.sessionId,
    startedAt: previous.startedAt,
  });
const record: RuntimeRecord = {
  schema: "otherbridge.g7.pilot-runtime.v1",
  app: RUNTIME_APP,
  instanceId,
  controlToken,
  pid: process.pid,
  processStartedAt: watched.processStartedAt,
  port: bound!.port,
  origin,
  mode,
  fixture: fixture ?? null,
  sessionId: rt.session.id,
  evidence: rt.rel,
  startedAt: new Date(launchedAt).toISOString(),
  expiresAt: new Date(rt.session.expiresAt).toISOString(),
  runtime: "next-production",
  distDir: artifact.distDir,
  buildId: artifact.buildId,
  watchedAncestors: watched.ancestors,
};
writeRuntimeRecord(recordPath, record);
identity = () => {
  const s = rt.session.snapshot();
  return {
    app: RUNTIME_APP,
    instanceId,
    pid: process.pid,
    port: bound!.port,
    mode,
    fixture: fixture ?? null,
    sessionId: s.sessionId,
    state: s.state,
    armed: s.armed !== null,
    startedAt: record.startedAt,
    expiresAt: record.expiresAt,
    runtime: "next-production",
    buildId: artifact.buildId,
    uptimeMs: Date.now() - launchedAt,
    rssBytes: memory.current(),
    peakRssBytes: memory.peak(),
  };
};
// Local stop command only: per-run control token from the runtime record, never from a browser (a browser always
// sends Origin on POST and cannot add the Authorization header cross-origin without a CORS preflight, never granted).
onShutdownRequest = (req, res) => {
  req.resume();
  if (req.method !== "POST")
    return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
  if (req.headers.origin !== undefined)
    return sendJson(res, 403, { error: "BROWSER_REQUEST_REFUSED" });
  const auth = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(
    String(req.headers.authorization ?? ""),
  );
  if (!controlTokenMatches(auth ? auth[1] : null, controlToken))
    return sendJson(res, 401, { error: "UNAUTHORIZED" });
  const state = rt.session.snapshot().state;
  const force =
    new URL(req.url ?? "/", origin).searchParams.get("force") === "1";
  if (!force && (state === "FINAL_PREFLIGHT_RUNNING" || state === "ARMED"))
    return sendJson(res, 409, { error: "WALLET_REQUEST_IN_FLIGHT", state });
  sendJson(res, 202, { stopping: true, state });
  setTimeout(
    () => void shutdown(force ? "STOP_COMMAND_FORCED" : "STOP_COMMAND"),
    50,
  );
};

// 4. The Otherbridge product: the local-g7-pilot artifact on the Next.js production runtime.
// Server-side gate inputs (read by src/server/g7-local-pilot.ts per request) and the exact product API origin.
Object.assign(process.env, {
  NODE_ENV: "production",
  OTHERBRIDGE_BUILD_PROFILE: profile,
  OTHERBRIDGE_G7_LOCAL_PILOT: "1",
  OTHERBRIDGE_G7_LOCAL_PILOT_ORIGIN: origin,
  OTHERBRIDGE_APP_ORIGINS: origin,
  OTHERBRIDGE_MODE: "mainnet-readonly",
  OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "false",
});
rt.log(
  `starting the Otherbridge product (production runtime, ${artifact.distDir}, build ${artifact.buildId}) on ${origin}`,
);
// Loaded only now, after NODE_ENV=production, so React and Next resolve their production builds.
const { default: nextFactory } = await import("next");
app = nextFactory({
  dev: false,
  dir: REPO,
  hostname: "127.0.0.1",
  port: bound!.port,
  httpServer: server,
});
await app.prepare();
handle = app.getRequestHandler();
api = pilotApi(rt.session, rt.journal, API_PREFIX);
rt.journal("LISTENING", {
  origin,
  apiPrefix: API_PREFIX,
  product: "next-production",
  distDir: artifact.distDir,
  buildId: artifact.buildId,
  sourceDigest: artifact.sourceDigest,
  pid: process.pid,
  watchedAncestors: watched.ancestors,
});
// The bearer token travels only in the URL fragment (never sent to the server, stripped by the page on load).
// V1.11: "/" is the public landing page; the Bridge (with the pilot card) lives at /bridge.
say(`G7PILOT_URL ${origin}/bridge#g7-pilot=${rt.session.token}`);
say(
  `G7PILOT_SESSION ${rt.session.id} mode=${mode}${fixture ? ` fixture=${fixture}` : ""} evidence=${rt.rel}`,
);

// 5. Session lifetime: an idle expired session becomes EXPIRED and the launcher stops after a short grace; an
// armed run keeps observing for its tracking window, then stops.
const EXPIRY_GRACE_MS = expiryGraceMs ?? 60_000;
const OBSERVATION_WINDOW_MS = 3 * 3600_000;
const lifetime = setInterval(
  () => {
    if (stopping) return;
    const now = Date.now();
    if (now < rt.session.expiresAt) return;
    if (rt.session.expireIfDue()) {
      if (now >= rt.session.expiresAt + EXPIRY_GRACE_MS)
        void shutdown("SESSION_EXPIRED");
    } else if (now >= rt.session.expiresAt + OBSERVATION_WINDOW_MS)
      void shutdown("OBSERVATION_WINDOW_ENDED");
  },
  Math.min(5000, Math.max(500, Math.floor(EXPIRY_GRACE_MS / 4))),
);
lifetime.unref();

await rt.session.start();
// Render the Bridge page once so the first owner visit is warm (read-only GET; never touches the pilot API).
const warmAt = Date.now();
await fetch(`${origin}/bridge`)
  .then((r) => r.text())
  .catch((e) => rt.log(`warm-up failed: ${String(e).slice(0, 120)}`));
const s = rt.session.snapshot();
const report = startupReport(s, {
  mode,
  fixture: fixture ?? null,
  productUrl: `${origin}/bridge`,
  authorizedWallet: PILOT_SCOPE.accountDisplay,
  evidence: rt.rel,
  lockPath: rt.lockPath
    ? relative(REPO, rt.lockPath).replaceAll("\\", "/")
    : null,
  runtime: {
    mode: "next-production",
    devServer: false,
    distDir: artifact.distDir,
    buildId: artifact.buildId,
    builtAt: artifact.builtAt,
    sourceDigest: artifact.sourceDigest,
    pid: process.pid,
    port: bound!.port,
    runtimeRecord: relative(REPO, recordPath).replaceAll("\\", "/"),
    watchedAncestors: watched.ancestors,
    startupMs: Date.now() - launchedAt,
    warmRenderMs: Date.now() - warmAt,
    rssBytes: memory.current(),
    peakRssBytes: memory.peak(),
  },
});
rt.record("STARTUP_REPORT", report);
say(`G7PILOT_${s.state === "READY" ? "READY" : "STOPPED"} ${rt.json(report)}`);
