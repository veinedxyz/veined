// Builds the separate LOCAL-ONLY G7 pilot artifact (never the public `.next` product build):
//   pnpm g7:product-pilot:build [--profile local-g7-pilot|local-g7-pilot-test] [--if-stale] [--measure]
// local-g7-pilot       `.next-g7-pilot`, Privy App ID from the git-ignored .env files (the real pilot).
// local-g7-pilot-test  `.next-g7-pilot-test`, the test-only Privy App ID (fixture suites; Privy doubles).
// `next build` runs with OTHERBRIDGE_BUILD_PROFILE set and without the runtime pilot flag; next-env.d.ts and
// tsconfig.json (which `next build` rewrites for a custom distDir) are restored byte-identical afterwards. The
// artifact gets a manifest (profile, BUILD_ID, source digest) that the launcher verifies before serving it.
// --if-stale skips the build when the existing artifact is fresh. --measure samples the build process tree's
// working set (Windows) for the evidence. No wallet, key, signing or network-write surface exists here.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_MANIFEST,
  PILOT_DIST_DIRS,
  PROFILE_MANIFEST_SCHEMA,
  TEST_ONLY_PRIVY_APP_ID,
  scanClientChunks,
  sourceDigest,
  verifyPilotBuild,
  type BuildManifest,
  type PilotBuildProfile,
} from "./g7-pilot/build-profile";
import { REPO } from "./g7-pilot/launch";
import { probeIdentity, readRuntimeRecord } from "./g7-pilot/supervisor";

const APP_ID = /^[a-z0-9]{25}$/;

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const profile = (opt("--profile") ?? "local-g7-pilot") as PilotBuildProfile;
if (!Object.hasOwn(PILOT_DIST_DIRS, profile))
  throw new Error(`UNKNOWN_PROFILE ${profile}`);
const distDir = PILOT_DIST_DIRS[profile];
const say = (tag: string, v: unknown) =>
  console.log(`${tag} ${JSON.stringify(v)}`);

if (argv.includes("--if-stale")) {
  const check = verifyPilotBuild(REPO, profile);
  if (check.ok) {
    say("G7PILOT_BUILD_FRESH", {
      profile,
      distDir,
      buildId: check.manifest.buildId,
      builtAt: check.manifest.builtAt,
    });
    process.exit(0);
  }
  say("G7PILOT_BUILD_NEEDED", { profile, distDir, reason: check.reason });
}

// Never rebuild an artifact that a running launcher is serving (the build would empty its directory).
for (const f of existsSync(join(REPO, ".otherbridge"))
  ? readdirSync(join(REPO, ".otherbridge")).filter((n) =>
      /^g7-pilot-runtime-\d+\.json$/.test(n),
    )
  : []) {
  const record = readRuntimeRecord(join(REPO, ".otherbridge", f));
  if (!record || record.distDir !== distDir) continue;
  const live = await probeIdentity(record.port, 1500);
  if (live?.instanceId === record.instanceId) {
    say("G7PILOT_BUILD_REFUSED", {
      profile,
      distDir,
      reason: "ARTIFACT_IN_USE",
      pid: live.pid,
      sessionId: live.sessionId,
      hint: "stop the running pilot first: pnpm g7:product-pilot:stop",
    });
    process.exit(3);
  }
}

// The App ID the artifact will carry, resolved the way Next resolves NEXT_PUBLIC_* for a production build.
function envFileAppId(): string | null {
  for (const f of [
    ".env.production.local",
    ".env.local",
    ".env.production",
    ".env",
  ]) {
    const p = join(REPO, f);
    if (!existsSync(p)) continue;
    const m = /^NEXT_PUBLIC_PRIVY_APP_ID=(.*)$/m.exec(readFileSync(p, "utf8"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OTHERBRIDGE_BUILD_PROFILE: profile,
  NEXT_TELEMETRY_DISABLED: "1",
};
delete childEnv.OTHERBRIDGE_G7_LOCAL_PILOT;
delete childEnv.OTHERBRIDGE_G7_LOCAL_PILOT_ORIGIN;
let appId: string | null;
if (profile === "local-g7-pilot-test") {
  appId = TEST_ONLY_PRIVY_APP_ID;
  childEnv.NEXT_PUBLIC_PRIVY_APP_ID = appId;
} else {
  // The real pilot artifact takes its App ID only from the git-ignored .env files, never from the shell.
  delete childEnv.NEXT_PUBLIC_PRIVY_APP_ID;
  appId = envFileAppId();
  if (!appId || !APP_ID.test(appId))
    throw new Error(
      "PRIVY_APP_ID_REQUIRED: the real local-g7-pilot artifact needs NEXT_PUBLIC_PRIVY_APP_ID in .env.local (docs/PRIVY_SETUP.md)",
    );
}

// Optional: peak working set of the build process tree (Windows), sampled by one long-lived read-only PowerShell.
function treeSampler(rootPid: number) {
  if (!argv.includes("--measure") || process.platform !== "win32")
    return { stop: () => null as null | Record<string, number> };
  const script = `while($true){$p=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize); $p | ConvertTo-Json -Compress; Start-Sleep -Milliseconds 1500}`;
  const ps: ChildProcess = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  let peak = 0,
    peakProcesses = 0,
    samples = 0,
    buffer = "";
  ps.stdout!.on("data", (c: Buffer) => {
    buffer += c.toString("utf8");
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      try {
        const rows = JSON.parse(line) as {
          ProcessId: number;
          ParentProcessId: number;
          WorkingSetSize: number;
        }[];
        const kids = new Map<number, number[]>();
        for (const r of rows)
          kids.set(r.ParentProcessId, [
            ...(kids.get(r.ParentProcessId) ?? []),
            r.ProcessId,
          ]);
        const ws = new Map(rows.map((r) => [r.ProcessId, r.WorkingSetSize]));
        const tree = new Set<number>();
        const stack = [rootPid];
        while (stack.length) {
          const p = stack.pop()!;
          if (tree.has(p) || !ws.has(p)) continue;
          tree.add(p);
          stack.push(...(kids.get(p) ?? []));
        }
        let sum = 0;
        for (const p of tree) sum += ws.get(p) ?? 0;
        samples++;
        peak = Math.max(peak, sum);
        peakProcesses = Math.max(peakProcesses, tree.size);
      } catch {
        // partial line
      }
    }
  });
  return {
    stop: () => {
      ps.kill();
      return {
        peakTreeWorkingSetBytes: peak,
        peakTreeProcesses: peakProcesses,
        samples,
      };
    },
  };
}

const restore = ["next-env.d.ts", "tsconfig.json"].map((f) => ({
  f,
  p: join(REPO, f),
  body: existsSync(join(REPO, f)) ? readFileSync(join(REPO, f)) : null,
}));
const restoreRewritten = () => {
  for (const { p, body } of restore)
    if (body && (!existsSync(p) || !readFileSync(p).equals(body)))
      writeFileSync(p, body);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const)
  process.on(signal, () => {
    restoreRewritten();
    process.exit(130);
  });
const digestBefore = sourceDigest(REPO);
const startedAt = Date.now();
let exitCode: number | null = null;
let measure: Record<string, number> | null = null;
try {
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "build"],
    { cwd: REPO, env: childEnv, stdio: "inherit", shell: false },
  );
  const sampler = treeSampler(child.pid!);
  exitCode = await new Promise<number | null>((r) => child.on("exit", r));
  measure = sampler.stop();
} finally {
  restoreRewritten();
}
const durationMs = Date.now() - startedAt;
if (exitCode !== 0) {
  say("G7PILOT_BUILD_FAILED", { profile, distDir, exitCode, durationMs });
  process.exit(1);
}
if (sourceDigest(REPO).digest !== digestBefore.digest)
  throw new Error("SOURCES_CHANGED_DURING_BUILD: rebuild");
const buildId = readFileSync(join(REPO, distDir, "BUILD_ID"), "utf8").trim();
const chunks = scanClientChunks(REPO, distDir);
if (chunks.chunksWithMarkers < 1)
  throw new Error("PILOT_MODULE_MISSING_FROM_PILOT_ARTIFACT");
const manifest: BuildManifest = {
  schema: PROFILE_MANIFEST_SCHEMA,
  profile,
  distDir,
  bundleConstant: "1",
  buildId,
  sourceDigest: digestBefore.digest,
  sourceFiles: digestBefore.files,
  privyAppId: profile === "local-g7-pilot-test" ? "test-only" : "env-local",
  privyAppIdSha256: appId
    ? createHash("sha256").update(appId).digest("hex")
    : null,
  nextVersion: JSON.parse(
    readFileSync(join(REPO, "node_modules/next/package.json"), "utf8"),
  ).version,
  builtAt: new Date().toISOString(),
  buildDurationMs: durationMs,
  pilotMarkerChunks: chunks.chunksWithMarkers,
};
writeFileSync(
  join(REPO, distDir, BUILD_MANIFEST),
  JSON.stringify(manifest, null, 1) + "\n",
);
if (measure)
  writeFileSync(
    join(REPO, distDir, "otherbridge-build-metrics.json"),
    JSON.stringify({ durationMs, ...measure }, null, 1) + "\n",
  );
say("G7PILOT_BUILD_OK", { ...manifest, measure });
