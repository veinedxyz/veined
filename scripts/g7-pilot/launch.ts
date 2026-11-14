// Shared launcher plumbing for the G7 pilot (standalone technical page and in-product pilot): arguments, a new
// evidence root per run, the session journal, the RPC audit trail and the one-shot session with its lock.
// Logging never crashes the process when its stdout/stderr pipe goes away (EPIPE is swallowed).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_SCENARIOS,
  fixturePreflight,
  fixtureTracker,
  type FixtureScenario,
} from "./fixture";
import { DEFAULT_PORT, type PilotMode } from "./policy";
import { livePreflight } from "./preflight";
import { PilotSession, fileLockStore } from "./session";
import { liveTracker } from "./tracker";
import { ExecutionEvidence } from "../../src/g7/write-evidence";
import type { CandidateBaseline } from "../g7-safety-scan";

export const REPO = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
// Same lock for every launcher: one owner approval can be consumed exactly once, whichever page is used.
export const LOCK_PATH = join(REPO, ".otherbridge", "g7-pilot-lock.json");

export function parseLaunchArgs(
  argv: string[],
  modeFlags: { real: string | null; dryRun: string; defaultMode: PilotMode },
) {
  const VALUE = new Set([
    "--fixture",
    "--state-dir",
    "--port",
    "--ttl-ms",
    "--expiry-grace-ms",
    "--candidate-baseline",
    "--candidate-sha256",
  ]);
  const BOOL = new Set(
    [modeFlags.real, modeFlags.dryRun].filter((x): x is string => !!x),
  );
  for (let i = 0; i < argv.length; i++) {
    if (VALUE.has(argv[i])) i++;
    else if (!BOOL.has(argv[i])) throw new Error(`UNKNOWN_ARGUMENT ${argv[i]}`);
  }
  const opt = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const real = modeFlags.real !== null && argv.includes(modeFlags.real);
  const dry = argv.includes(modeFlags.dryRun);
  if (real && dry)
    throw new Error(`${modeFlags.real} and ${modeFlags.dryRun} are exclusive`);
  const mode: PilotMode = real
    ? "real"
    : dry
      ? "dry-run"
      : modeFlags.defaultMode;
  const fixture = opt("--fixture") as FixtureScenario | undefined;
  if (fixture !== undefined && !FIXTURE_SCENARIOS.includes(fixture))
    throw new Error(`UNKNOWN_FIXTURE ${fixture}`);
  const stateDir = opt("--state-dir");
  if (!!fixture !== !!stateDir)
    throw new Error("--fixture and --state-dir go together (tests only)");
  const candidatePath = opt("--candidate-baseline"),
    candidateSha = opt("--candidate-sha256");
  if (!!candidatePath !== !!candidateSha)
    throw new Error("CANDIDATE_PATH_AND_SHA_REQUIRED");
  if (candidatePath && mode === "real" && !fixture)
    throw new Error("CANDIDATE_BASELINE_CANNOT_AUTHORIZE_REAL_MODE");
  const candidateBaseline: CandidateBaseline | undefined = candidatePath
    ? {
        path: candidatePath,
        sha256: candidateSha!,
        scope: fixture ? "fixture-validation" : "dry-validation",
      }
    : undefined;
  const port = Number(opt("--port") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("BAD_PORT");
  // TESTS ONLY (fixture): a short session lifetime and expiry grace for the session-expiry cleanup regression.
  const ms = (k: string) => {
    const v = opt(k);
    if (v === undefined) return undefined;
    if (!fixture) throw new Error(`${k} is a fixture-only test argument`);
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1000 || n > 24 * 3600_000)
      throw new Error(`BAD ${k}`);
    return n;
  };
  return {
    mode,
    fixture,
    stateDir,
    port,
    ttlMs: ms("--ttl-ms"),
    expiryGraceMs: ms("--expiry-grace-ms"),
    candidateBaseline,
  };
}

export function createPilotRuntime(options: {
  mode: PilotMode;
  fixture: FixtureScenario | undefined;
  stateDir: string | undefined;
  evidenceFamily: string;
  ttlMs?: number;
  candidateBaseline?: CandidateBaseline;
}) {
  if (options.candidateBaseline && options.mode === "real" && !options.fixture)
    throw new Error("CANDIDATE_BASELINE_CANNOT_AUTHORIZE_REAL_MODE");
  const execution = new ExecutionEvidence();
  for (const stream of [process.stdout, process.stderr])
    stream.on("error", () => undefined);
  const { mode, fixture } = options;
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const root = fixture
    ? resolve(options.stateDir!)
    : join(
        REPO,
        "evidence",
        options.evidenceFamily,
        `${mode}-${stamp}-${randomBytes(3).toString("hex")}`,
      );
  mkdirSync(root, { recursive: true });
  const rel = relative(REPO, root).replaceAll("\\", "/");
  const json = (v: unknown, space?: number) =>
    JSON.stringify(
      v,
      (_, x) => (typeof x === "bigint" ? x.toString() : x),
      space,
    );
  const journal = (event: string, data: Record<string, unknown> = {}) =>
    appendFileSync(
      join(root, "session-journal.jsonl"),
      json({ at: new Date().toISOString(), event, ...data }) + "\n",
    );
  const record = (name: string, value: unknown) => {
    const p = join(root, `${name}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, json(value, 1) + "\n");
  };
  const audit = (r: unknown) =>
    appendFileSync(join(root, "rpc-audit.jsonl"), json(r) + "\n");
  const log = (m: string) => {
    const line = `${new Date().toISOString()} ${m}`;
    appendFileSync(join(root, "launcher.log"), line + "\n");
    try {
      console.log(line);
    } catch {
      // the evidence log above is authoritative
    }
  };
  const lockPath =
    mode === "real"
      ? fixture
        ? join(root, "g7-pilot-lock.json")
        : LOCK_PATH
      : null;
  const session = new PilotSession({
    mode,
    fixture: !!fixture,
    preflight: fixture
      ? fixturePreflight(fixture, Date.now, {
          candidateBaseline: options.candidateBaseline,
          execution,
        })
      : livePreflight({
          audit,
          record,
          log,
          candidateBaseline: options.candidateBaseline,
          execution,
        }),
    execution,
    tracker: fixture ? fixtureTracker(fixture) : liveTracker(audit),
    lock: lockPath ? fileLockStore(lockPath) : null,
    journal,
    ...(fixture ? { trackIntervalMs: 400, detectIntervalMs: 400 } : {}),
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
  });
  return { session, root, rel, json, journal, record, log, lockPath };
}
