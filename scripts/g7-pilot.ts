// G7 pilot standalone TECHNICAL page — localhost-only diagnostics. The owner-approved pilot runs inside the normal
// Otherbridge product (`pnpm g7:product-pilot`); this page is no longer a primary or real execution path.
//   pnpm g7:pilot                    DRY RUN: fresh read-only mainnet preflight + the technical page; the final step
//                                    is verified end to end but the wallet request is never released.
//   --port <n>                       default 3197 (always bound to 127.0.0.1)
//   --owner-approved --fixture <scenario> --state-dir <dir>   TESTS ONLY (deterministic data, mock wallet only).
// No key material is requested or read; there is no local signer and no raw-transaction broadcast.
import { relative } from "node:path";
import { REPO, createPilotRuntime, parseLaunchArgs } from "./g7-pilot/launch";
import { startupReport } from "./g7-pilot/report";
import { startPilotServer } from "./g7-pilot/server";

const { mode, fixture, stateDir, port, candidateBaseline } = parseLaunchArgs(
  process.argv.slice(2),
  {
    real: "--owner-approved",
    dryRun: "--dry-run",
    defaultMode: "dry-run",
  },
);
if (mode === "real" && !fixture)
  throw new Error(
    "G7_STANDALONE_REAL_MODE_SUPERSEDED: the owner-approved pilot runs inside the product — use pnpm g7:product-pilot",
  );
const rt = createPilotRuntime({
  mode,
  fixture,
  stateDir,
  evidenceFamily: "otherbridge-g7-pilot",
  candidateBaseline,
});
const srv = await startPilotServer(rt.session, port, rt.journal);
// The bearer token travels only in the URL fragment (never sent to the server, stripped by the page on load).
console.log(`G7PILOT_URL ${srv.origin}/#token=${rt.session.token}`);
console.log(
  `G7PILOT_SESSION ${rt.session.id} mode=${mode}${fixture ? ` fixture=${fixture}` : ""} evidence=${rt.rel}`,
);
const shutdown = async () => {
  rt.session.stop();
  await srv.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await rt.session.start();
const s = rt.session.snapshot();
const report = startupReport(s, {
  mode,
  fixture: fixture ?? null,
  origin: srv.origin,
  evidence: rt.rel,
  lockPath: rt.lockPath
    ? relative(REPO, rt.lockPath).replaceAll("\\", "/")
    : null,
});
rt.record("STARTUP_REPORT", report);
console.log(
  `G7PILOT_${s.state === "READY" ? "READY" : "STOPPED"} ${rt.json(report)}`,
);
