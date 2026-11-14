import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGuardState,
  evaluateMemoryGuard,
  readSamples,
} from "../../scripts/lib/memory-guard.mjs";

// Real Windows sampler (PowerShell + CIM). The guard policy itself is covered on every platform by the unit tests.
const children: ChildProcess[] = [];
let directory = "";
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null) child.kill();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function startSampler() {
  directory = mkdtempSync(join(tmpdir(), "veined-v1211-sampler-"));
  let stderr = "";
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve("scripts/e2e-monitor.ps1"),
      "-OwnerPid",
      String(process.pid),
      "-Directory",
      directory,
      "-Since",
      new Date().toISOString(),
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr!.on("data", (d) => (stderr += d));
  children.push(child);
  return { child, file: join(directory, "memory.psv"), stderr: () => stderr };
}
const alive = (child: ChildProcess) =>
  child.exitCode === null && child.signalCode === null;
const errorsLogged = () =>
  existsSync(join(directory, "sampler-errors.log"))
    ? readFileSync(join(directory, "sampler-errors.log"), "utf8")
        .split(/\r?\n/)
        .filter(Boolean).length
    : 0;

describe.runIf(process.platform === "win32")(
  "V1.21.1 memory sampler under contention (Windows)",
  () => {
    it("keeps writing while a reader holds the file open continuously; the guard never stops (positive)", async () => {
      const { child, file, stderr } = startSampler();
      const state = createGuardState(Date.now(), performance.now());
      const reads: Record<string, number> = {};
      const end = Date.now() + 9000;
      while (Date.now() < end) {
        for (let i = 0; i < 200; i++) {
          readSamples(file, state);
          reads[state.lastRead] = (reads[state.lastRead] ?? 0) + 1;
        }
        expect(
          evaluateMemoryGuard({
            samples: state.samples,
            state,
            nowMs: Date.now(),
            monoMs: performance.now(),
            guardGb: 0,
            ownedLimitGb: 1e9,
            samplerExited: !alive(child),
          }),
        ).toBeNull();
        await wait(5);
      }
      const ats = state.samples.map((s) => s.at);
      expect(alive(child)).toBe(true);
      expect(stderr()).toBe("");
      expect(errorsLogged()).toBe(0);
      expect(reads.EBUSY ?? 0).toBe(0);
      expect(reads.EACCES ?? 0).toBe(0);
      expect(ats.length).toBeGreaterThanOrEqual(3);
      expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    }, 60000);

    it("survives an exclusive lock (EBUSY on both sides), logs it, writes no sample meanwhile and resumes", async () => {
      const { child, file, stderr } = startSampler();
      const state = createGuardState(Date.now(), performance.now());
      while (!readSamples(file, state).length) await wait(200);
      const locker = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$s=[IO.File]::Open('${file}','Open','ReadWrite','None'); 'locked'; Start-Sleep -Seconds 6; $s.Dispose()`,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      children.push(locker);
      await new Promise<void>((r) => locker.stdout!.once("data", () => r()));
      const before = state.samples.length;
      const lockedReads = new Set<string>();
      for (let i = 0; i < 20; i++) {
        readSamples(file, state);
        lockedReads.add(state.lastRead);
        await wait(200);
      }
      expect(lockedReads).toContain("EBUSY");
      expect(state.samples.length).toBe(before);
      await new Promise((r) => locker.once("close", r));
      const deadline = Date.now() + 12000;
      while (readSamples(file, state).length <= before && Date.now() < deadline)
        await wait(250);
      expect(state.samples.length).toBeGreaterThan(before);
      expect(alive(child)).toBe(true);
      expect(errorsLogged()).toBeGreaterThanOrEqual(1);
      expect(stderr()).toBe("");
    }, 60000);

    it("a sampler that stops is reported to the guard immediately", async () => {
      const { child, file } = startSampler();
      const state = createGuardState(Date.now(), performance.now());
      while (!readSamples(file, state).length) await wait(200);
      child.kill();
      await new Promise((r) => child.once("close", r));
      expect(
        evaluateMemoryGuard({
          samples: readSamples(file, state),
          state,
          nowMs: Date.now(),
          monoMs: performance.now(),
          guardGb: 0,
          ownedLimitGb: 1e9,
          samplerExited: !alive(child),
        })?.reason,
      ).toBe("MEMORY_SAMPLER_EXITED");
    }, 60000);
  },
);
