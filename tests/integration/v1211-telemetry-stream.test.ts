import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvidenceWriter,
  createGuardState,
  createSampleStream,
  evaluateMemoryGuard,
} from "../../scripts/lib/memory-guard.mjs";

// Real Windows sampler in -Stream mode feeding the same in-memory guard the runners use.
const children: ChildProcess[] = [];
let directory = "";
afterEach(async () => {
  // Wait for every helper (sampler, lock holder) to exit so its handles are released.
  await Promise.all(
    children.splice(0).map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? null
        : new Promise((done) => {
            child.once("close", done);
            child.kill();
          }),
    ),
  );
  if (directory)
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function startStream(onLine?: (line: string) => void) {
  directory = mkdtempSync(join(tmpdir(), "veined-v1211-stream-"));
  const state = createGuardState(Date.now(), performance.now());
  const stream = createSampleStream(state, { onSample: (_, l) => onLine?.(l) });
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
      "-Stream",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d) => stream.push(d));
  child.stdout!.on("close", () => stream.end());
  child.stderr!.on("data", (d) => (stderr += d));
  children.push(child);
  return { child, state, stderr: () => stderr };
}
const decide = (
  state: ReturnType<typeof createGuardState>,
  child: ChildProcess,
) =>
  evaluateMemoryGuard({
    samples: state.samples,
    state,
    nowMs: Date.now(),
    monoMs: performance.now(),
    guardGb: 0,
    ownedLimitGb: 1e9,
    samplerExited: child.exitCode !== null || child.signalCode !== null,
  });
async function untilSamples(
  state: ReturnType<typeof createGuardState>,
  n: number,
) {
  const deadline = Date.now() + 20000;
  while (state.samples.length < n && Date.now() < deadline) await wait(100);
}
/** Runs the guard once a second for `ms` and measures the event-loop lag of each tick. */
async function guardFor(
  ms: number,
  state: ReturnType<typeof createGuardState>,
  child: ChildProcess,
) {
  const decisions: (string | null)[] = [],
    lags: number[] = [];
  const end = performance.now() + ms;
  let expected = performance.now() + 1000;
  while (performance.now() < end) {
    await wait(Math.max(0, expected - performance.now()));
    lags.push(performance.now() - expected);
    decisions.push(decide(state, child)?.reason ?? null);
    expected += 1000;
  }
  return { decisions, maxLagMs: Math.max(...lags) };
}

describe.runIf(process.platform === "win32")(
  "V1.21.1 telemetry over the sampler's stdout (Windows)",
  () => {
    it("delivers fresh samples through the pipe; the stream mode writes no file", async () => {
      const { child, state, stderr } = startStream();
      await untilSamples(state, 3);
      const { decisions } = await guardFor(6000, state, child);
      expect(decisions.every((d) => d === null)).toBe(true);
      expect(state.samples.length).toBeGreaterThanOrEqual(4);
      expect(state.rejected).toBe(0);
      expect(existsSync(join(directory, "memory.psv"))).toBe(false);
      expect(existsSync(join(directory, "owned-processes.json"))).toBe(false);
      expect(stderr()).toBe("");
    }, 60000);

    it("fault injection: a 20 s stalled evidence file close does not block the telemetry decision path", async () => {
      // Every evidence write completes only 20 s after it is issued (the observed stall pattern, extended).
      let stalled = 0;
      const writer = createEvidenceWriter(
        join(mkdtempSync(join(tmpdir(), "veined-v1211-stall-")), "memory.psv"),
        {
          io: {
            appendFile: async (file, data) => {
              stalled++;
              await wait(20000);
              await appendFile(file, data);
            },
            writeFile,
          },
        },
      );
      const { child, state } = startStream((l) => writer.write(l + "\r\n"));
      await untilSamples(state, 2);
      const during = await guardFor(22000, state, child);
      expect(during.decisions.every((d) => d === null)).toBe(true);
      expect(during.maxLagMs).toBeLessThan(250);
      expect(stalled).toBeGreaterThanOrEqual(1);
      expect(state.samples.length).toBeGreaterThanOrEqual(9);
      child.kill();
      await new Promise((r) => child.once("close", r));
      const flushed = await writer.flush(80000);
      expect(flushed).toMatchObject({ complete: true, pending: 0, errors: [] });
      expect(flushed.written).toBe(state.samples.length);
    }, 150000);

    it("fault injection: an evidence file held exclusively by another process for 20 s neither blocks nor loses telemetry", async () => {
      const file = join(
        mkdtempSync(join(tmpdir(), "veined-v1211-lock-")),
        "memory.psv",
      );
      await writeFile(file, "");
      const writer = createEvidenceWriter(file, { retryMs: 200 });
      const locker = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$s=[IO.File]::Open('${file}','Open','ReadWrite','None'); 'locked'; Start-Sleep -Seconds 20; $s.Dispose()`,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      children.push(locker);
      // Listened for from the start: the holder's 20 s end about when the guard period does, so a listener added after
      // it could miss the event and wait forever.
      const lockerClosed = new Promise((r) => locker.once("close", r));
      await new Promise<void>((r) => locker.stdout!.once("data", () => r()));
      const { child, state } = startStream((l) => writer.write(l + "\r\n"));
      const during = await guardFor(20000, state, child);
      expect(during.decisions.every((d) => d === null)).toBe(true);
      expect(during.maxLagMs).toBeLessThan(250);
      expect(writer.stats.retries).toBeGreaterThan(0);
      await lockerClosed;
      child.kill();
      await new Promise((r) => child.once("close", r));
      const flushed = await writer.flush(30000);
      expect(flushed.complete).toBe(true);
      const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBe(state.samples.length);
    }, 90000);

    it("the sampler is unaffected by locked evidence files in its directory (it writes none)", async () => {
      const { child, state, stderr } = startStream();
      await untilSamples(state, 1);
      const files = ["memory.psv", "owned-processes.json"].map((n) =>
        join(directory, n),
      );
      const locker = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          files
            .map(
              (f, i) =>
                `$s${i}=[IO.File]::Open('${f}','OpenOrCreate','ReadWrite','None');`,
            )
            .join(" ") + " 'locked'; Start-Sleep -Seconds 10",
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      children.push(locker);
      await new Promise<void>((r) => locker.stdout!.once("data", () => r()));
      const before = state.samples.length;
      const { decisions } = await guardFor(8000, state, child);
      expect(decisions.every((d) => d === null)).toBe(true);
      expect(state.samples.length).toBeGreaterThanOrEqual(before + 2);
      expect(stderr()).toBe("");
    }, 60000);

    it("sampler crash closes the pipe and stops the run immediately", async () => {
      const { child, state } = startStream();
      await untilSamples(state, 1);
      child.kill();
      await new Promise((r) => child.once("close", r));
      expect(state.streamClosed).toBe(true);
      expect(decide(state, child)?.reason).toBe("MEMORY_SAMPLER_EXITED");
    }, 60000);

    it("backpressure: samples that are not consumed are not fresh; the guard stops after 15 s", async () => {
      const { child, state } = startStream();
      await untilSamples(state, 1);
      child.stdout!.pause();
      const { decisions } = await guardFor(17000, state, child);
      expect(decisions.slice(0, 13).every((d) => d === null)).toBe(true);
      expect(decisions.at(-1)).toBe("MEMORY_SAMPLE_STALE");
    }, 60000);
  },
);
