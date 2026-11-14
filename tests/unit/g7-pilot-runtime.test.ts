// G7 pilot runtime supervision and build-profile units (no browser, no Next server, no wallet).
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  launchAncestors,
  type OsSnapshot,
  type ProcessRow,
} from "../../scripts/g7-pilot/os-probe";
import {
  RUNTIME_APP,
  controlTokenMatches,
  isOurLauncher,
  newControlToken,
  portAcceptsConnections,
  probeIdentity,
  publicRecord,
  readRuntimeRecord,
  removeRuntimeRecord,
  runtimeRecordPath,
  writeRuntimeRecord,
  type RuntimeRecord,
} from "../../scripts/g7-pilot/supervisor";
import {
  BUILD_MANIFEST,
  PILOT_CLIENT_MARKERS,
  PROFILE_MANIFEST_SCHEMA,
  TEST_ONLY_PRIVY_APP_ID,
  scanClientChunks,
  sourceDigest,
  verifyPilotBuild,
} from "../../scripts/g7-pilot/build-profile";
import { parseLaunchArgs } from "../../scripts/g7-pilot/launch";
import { TEST_PRIVY_APP_ID } from "../e2e/privy-mock";

const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "g7-rt-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const row = (
  pid: number,
  ppid: number,
  name: string,
  commandLine = name,
): ProcessRow => ({ pid, ppid, name, commandLine, createdAt: null });
const snapshot = (rows: ProcessRow[]): OsSnapshot => ({
  platform: "win32",
  listeners: [],
  processes: new Map(rows.map((r) => [r.pid, r])),
  error: null,
});

describe("G7 pilot runtime — orphan guard ancestry", () => {
  it("watches pnpm's shell wrapper, pnpm itself and the terminal shell, and stops at the first non-wrapper", () => {
    const os = snapshot([
      row(1, 0, "claude.exe"),
      row(2, 1, "bash.exe"),
      row(
        3,
        2,
        "sh.exe",
        '"sh.exe" "/c/Program Files/nodejs/pnpm" g7:product-pilot',
      ),
      row(4, 3, "node.exe", 'node "corepack/dist/pnpm.js" g7:product-pilot'),
      row(5, 4, "cmd.exe", "cmd.exe /d /s /c node scripts/g7-product-pilot.ts"),
      row(6, 5, "node.exe", "node scripts/g7-product-pilot.ts"),
    ]);
    expect(launchAncestors(os, 6).map((p) => p.pid)).toEqual([5, 4, 3, 2]);
  });
  it("always watches the direct parent (test harness), but not the test runner above it", () => {
    const os = snapshot([
      row(1, 0, "cmd.exe"),
      row(2, 1, "node.exe", "node playwright/cli.js test"),
      row(3, 2, "node.exe", "node playwright/worker.js"),
      row(4, 3, "node.exe", "node scripts/g7-product-pilot.ts --fixture ready"),
    ]);
    expect(launchAncestors(os, 4).map((p) => p.pid)).toEqual([3]);
  });
  it("recognises only this repository's launcher by its command line", () => {
    expect(
      isOurLauncher(
        row(
          9,
          1,
          "node.exe",
          "node --import ./x.mjs scripts\\g7-product-pilot.ts",
        ),
      ),
    ).toBe(true);
    expect(isOurLauncher(row(9, 1, "node.exe", "node server.mjs"))).toBe(false);
    expect(
      isOurLauncher(
        row(9, 1, "python.exe", "python scripts/g7-product-pilot.ts"),
      ),
    ).toBe(false);
    expect(isOurLauncher(undefined)).toBe(false);
  });
});

describe("G7 pilot runtime — runtime record, identity and control token", () => {
  const record = (instanceId: string): RuntimeRecord => ({
    schema: "otherbridge.g7.pilot-runtime.v1",
    app: RUNTIME_APP,
    instanceId,
    controlToken: newControlToken(),
    pid: process.pid,
    processStartedAt: null,
    port: 3197,
    origin: "http://127.0.0.1:3197",
    mode: "dry-run",
    fixture: null,
    sessionId: "g7p-000000000000",
    evidence: "evidence/x",
    startedAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    runtime: "next-production",
    distDir: ".next-g7-pilot",
    buildId: "b",
    watchedAncestors: [],
  });
  it("only the instance that wrote the record removes it; the public view never carries the control token", () => {
    const dir = temp();
    const p = runtimeRecordPath(dir, 3197);
    const mine = record("g7r-mine");
    writeRuntimeRecord(p, mine);
    expect(readRuntimeRecord(p)?.instanceId).toBe("g7r-mine");
    removeRuntimeRecord(p, "g7r-other");
    expect(readRuntimeRecord(p)).not.toBeNull();
    expect(JSON.stringify(publicRecord(mine))).not.toContain(mine.controlToken);
    removeRuntimeRecord(p, "g7r-mine");
    expect(readRuntimeRecord(p)).toBeNull();
    writeFileSync(p, "{not json");
    expect(readRuntimeRecord(p)).toBeNull();
  });
  it("control token comparison is exact", () => {
    const token = newControlToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(controlTokenMatches(token, token)).toBe(true);
    expect(controlTokenMatches(token.slice(1), token)).toBe(false);
    expect(controlTokenMatches(null, token)).toBe(false);
  });
  it("identity: only an Otherbridge pilot answer counts; a busy port is detected", async () => {
    const serve = (body: unknown) =>
      new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
        const s = createServer((_q, r) => {
          r.setHeader("content-type", "application/json");
          r.end(JSON.stringify(body));
        });
        s.listen(0, "127.0.0.1", () =>
          resolve({
            port: (s.address() as { port: number }).port,
            close: () => new Promise((c) => s.close(() => c())),
          }),
        );
      });
    const ours = await serve({ app: RUNTIME_APP, instanceId: "g7r-x" });
    const other = await serve({ app: "something-else" });
    try {
      expect((await probeIdentity(ours.port))?.instanceId).toBe("g7r-x");
      expect(await probeIdentity(other.port)).toBeNull();
      expect(await portAcceptsConnections(other.port)).toBe(true);
    } finally {
      await ours.close();
      await other.close();
    }
    expect(await portAcceptsConnections(other.port)).toBe(false);
    expect(await probeIdentity(other.port, 500)).toBeNull();
  });
});

describe("G7 pilot runtime — launcher arguments", () => {
  const flags = {
    real: null,
    dryRun: "--dry-run",
    defaultMode: "real" as const,
  };
  it("short session lifetimes are fixture-only test arguments", () => {
    expect(() => parseLaunchArgs(["--ttl-ms", "5000"], flags)).toThrow(
      /fixture-only/,
    );
    expect(() =>
      parseLaunchArgs(["--expiry-grace-ms", "2000", "--dry-run"], flags),
    ).toThrow(/fixture-only/);
    const a = parseLaunchArgs(
      ["--fixture", "ready", "--state-dir", "x", "--ttl-ms", "5000"],
      flags,
    );
    expect(a.ttlMs).toBe(5000);
    expect(a.expiryGraceMs).toBeUndefined();
    expect(() =>
      parseLaunchArgs(
        ["--fixture", "ready", "--state-dir", "x", "--ttl-ms", "10"],
        flags,
      ),
    ).toThrow(/BAD/);
    expect(parseLaunchArgs([], flags).port).toBe(3197);
  });
});

describe("G7 pilot build profile — separate, fresh, pilot-only artifact", () => {
  it("the test profile uses exactly the test-only Privy App ID of the E2E doubles", () => {
    expect(TEST_ONLY_PRIVY_APP_ID).toBe(TEST_PRIVY_APP_ID);
  });
  function fakeRepo() {
    const repo = temp();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "package.json"), "{}\n");
    return repo;
  }
  function fakeBuild(repo: string, overrides: Record<string, unknown> = {}) {
    const dist = join(repo, ".next-g7-pilot");
    mkdirSync(join(dist, "static", "chunks"), { recursive: true });
    writeFileSync(join(dist, "BUILD_ID"), "build-1");
    writeFileSync(
      join(dist, BUILD_MANIFEST),
      JSON.stringify({
        schema: PROFILE_MANIFEST_SCHEMA,
        profile: "local-g7-pilot",
        distDir: ".next-g7-pilot",
        bundleConstant: "1",
        buildId: "build-1",
        sourceDigest: sourceDigest(repo).digest,
        pilotMarkerChunks: 1,
        ...overrides,
      }),
    );
  }
  it("is served only when the manifest matches the profile, BUILD_ID and the current sources", () => {
    const repo = fakeRepo();
    expect(verifyPilotBuild(repo, "local-g7-pilot")).toMatchObject({
      ok: false,
      reason: "BUILD_MISSING",
    });
    fakeBuild(repo);
    expect(verifyPilotBuild(repo, "local-g7-pilot").ok).toBe(true);
    // A source change makes the artifact stale.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    expect(verifyPilotBuild(repo, "local-g7-pilot")).toMatchObject({
      ok: false,
      reason: "BUILD_STALE_SOURCE_CHANGED",
    });
    fakeBuild(repo, { buildId: "other" });
    expect(verifyPilotBuild(repo, "local-g7-pilot")).toMatchObject({
      reason: "BUILD_ID_MISMATCH",
    });
    fakeBuild(repo, { profile: "local-g7-pilot-test" });
    expect(verifyPilotBuild(repo, "local-g7-pilot")).toMatchObject({
      ok: false,
    });
    fakeBuild(repo, { bundleConstant: "0" });
    expect(verifyPilotBuild(repo, "local-g7-pilot")).toMatchObject({
      reason: "BUILD_WITHOUT_PILOT_MODULE",
    });
    // The test profile never accepts the real profile's artifact.
    fakeBuild(repo);
    expect(verifyPilotBuild(repo, "local-g7-pilot-test")).toMatchObject({
      ok: false,
      reason: "BUILD_MISSING",
    });
  });
  it("the source digest covers .env files (NEXT_PUBLIC values) and is order independent", () => {
    const repo = fakeRepo();
    const before = sourceDigest(repo).digest;
    expect(sourceDigest(repo).digest).toBe(before);
    writeFileSync(join(repo, ".env.local"), "NEXT_PUBLIC_PRIVY_APP_ID=x\n");
    expect(sourceDigest(repo).digest).not.toBe(before);
  });
  it("finds the pilot module markers only where they are", () => {
    const repo = temp();
    const chunks = join(repo, "dist", "static", "chunks");
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(chunks, "a.js"), "console.log('public');");
    expect(scanClientChunks(repo, "dist").chunksWithMarkers).toBe(0);
    writeFileSync(
      join(chunks, "b.js"),
      `const k="${PILOT_CLIENT_MARKERS[0]}";`,
    );
    const r = scanClientChunks(repo, "dist");
    expect(r.files).toBe(2);
    expect(r.chunksWithMarkers).toBe(1);
    expect(readFileSync(join(chunks, "b.js"), "utf8")).toContain(
      PILOT_CLIENT_MARKERS[0],
    );
  });
});
