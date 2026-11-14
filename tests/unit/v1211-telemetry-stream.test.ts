import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createEvidenceWriter,
  createGuardState,
  createSampleStream,
  evaluateMemoryGuard,
} from "../../scripts/lib/memory-guard.mjs";

// Deterministic clocks: wall clock T0 + offsets, monotonic clock in ms.
const T0 = 1_800_000_000_000;
const line = (at: number, free = 8) => `${at}|${free}|40|67|1|0.5|6\r\n`;
const setup = () => {
  const state = createGuardState(T0, 0);
  const owned: string[] = [];
  const stream = createSampleStream(state, {
    onOwned: (_, json) => owned.push(json),
  });
  return { state, stream, owned };
};
const tick = (
  state: ReturnType<typeof createGuardState>,
  wall: number,
  mono: number,
) =>
  evaluateMemoryGuard({
    samples: state.samples,
    state,
    nowMs: T0 + wall,
    monoMs: mono,
    guardGb: 2,
    ownedLimitGb: 4,
  });
const busy = (code: string) => Object.assign(new Error(code), { code });

describe("V1.21.1 telemetry stream (sampler stdout -> guard memory)", () => {
  it("assembles lines split across chunks and accepts only complete, new samples", () => {
    const { state, stream } = setup();
    const text = line(T0) + line(T0 + 2000);
    stream.push(text.slice(0, 7));
    expect(state.samples).toHaveLength(0);
    stream.push(text.slice(7, 31));
    expect(state.samples.map((s) => s.at)).toEqual([T0]);
    stream.push(text.slice(31));
    expect(state.samples.map((s) => s.at)).toEqual([T0, T0 + 2000]);
    expect(state.accepted).toBe(2);
    expect(tick(state, 2500, 2500)).toBeNull();
  });
  it("rejects malformed, partial, duplicate and older lines; they never refresh the guard", () => {
    const { state, stream } = setup();
    stream.push(line(T0 + 4000));
    stream.push(`${T0 + 5000}|8|40|67|1\r\n`); // too few fields
    stream.push(`${T0 + 5000}|8|NaN|67|1|0.5|6\r\n`); // not a number
    stream.push(line(T0 + 4000)); // duplicate
    stream.push(line(T0 + 2000)); // older
    expect(state.samples.map((s) => s.at)).toEqual([T0 + 4000]);
    expect(state.rejected).toBe(4);
    expect(tick(state, 4500, 4500)).toBeNull();
    // Only the repeated old sample keeps arriving: stale after 15 s although lines keep coming.
    for (let i = 1; i <= 8; i++) stream.push(line(T0 + 4000));
    expect(tick(state, 18900, 18900)).toBeNull();
    expect(tick(state, 19100, 19100)?.reason).toBe("MEMORY_SAMPLE_STALE");
  });
  it("reads ownership snapshots and rejects a broken one", () => {
    const { state, stream, owned } = setup();
    stream.push('#owned [{"pid":1,"created":"x"}]\r\n#owned {broken\r\n');
    expect(owned).toEqual(['[{"pid":1,"created":"x"}]']);
    expect(state.rejected).toBe(1);
    expect(state.samples).toHaveLength(0);
  });
  it("pipe close (sampler exit or crash) stops immediately; a dangling partial line is rejected", () => {
    const { state, stream } = setup();
    stream.push(line(T0) + `${T0 + 2000}|8|4`);
    stream.end();
    expect(state.streamClosed).toBe(true);
    expect(state.rejected).toBe(1);
    expect(tick(state, 500, 500)?.reason).toBe("MEMORY_SAMPLER_EXITED");
  });
  it("clock skew: a future-dated sample fails closed and later real samples cannot clear it", () => {
    const { state, stream } = setup();
    stream.push(line(T0 + 3600_000));
    expect(tick(state, 0, 0)?.reason).toBe("MEMORY_SAMPLE_CLOCK_SKEW");
    stream.push(line(T0 + 1000));
    expect(state.samples.at(-1)?.at).toBe(T0 + 3600_000);
    expect(tick(state, 1500, 1500)?.reason).toBe("MEMORY_SAMPLE_CLOCK_SKEW");
  });
  it("backpressure / no delivery: no new sample for 15 s on the monotonic clock stops the run", () => {
    const { state, stream } = setup();
    stream.push(line(T0));
    expect(tick(state, 100, 100)).toBeNull();
    expect(tick(state, 1500, 15100)).toBeNull();
    expect(tick(state, 1600, 15101)?.reason).toBe("MEMORY_SAMPLE_STALE");
  });
  it("stops on a real memory limit carried by a fresh streamed sample", () => {
    const { state, stream } = setup();
    stream.push(line(T0, 0.99));
    expect(tick(state, 100, 100)?.reason).toBe("MEMORY_LIMIT");
  });
});

describe("V1.21.1 asynchronous evidence writer", () => {
  it("appends in order and retries sharing violations without losing lines", async () => {
    const written: string[] = [];
    let failures = 2;
    const writer = createEvidenceWriter("memory.psv", {
      retryMs: 1,
      io: {
        appendFile: async (_f, data) => {
          if (failures-- > 0) throw busy(failures % 2 ? "EBUSY" : "EACCES");
          written.push(data);
        },
        writeFile: async () => {},
      },
    });
    writer.write("a\n");
    writer.write("b\n");
    writer.write("c\n");
    const r = await writer.flush(1000);
    expect(r).toMatchObject({
      complete: true,
      pending: 0,
      written: 3,
      retries: 2,
      errors: [],
    });
    expect(written.join("")).toBe("a\nb\nc\n");
  });
  it("replace mode persists only the newest snapshot; other errors are recorded, not retried forever", async () => {
    const files: string[] = [];
    const replace = createEvidenceWriter("owned.json", {
      mode: "replace",
      io: {
        appendFile: async () => {},
        writeFile: async (_f, data) => void files.push(data),
      },
    });
    replace.write("1");
    replace.write("2");
    replace.write("3");
    await replace.flush(1000);
    expect(files.at(-1)).toBe("3");
    expect(files.length).toBeLessThanOrEqual(2);
    const broken = createEvidenceWriter("x", {
      io: {
        appendFile: async () => {
          throw busy("EIO");
        },
        writeFile: async () => {},
      },
    });
    broken.write("z");
    expect(await broken.flush(1000)).toMatchObject({
      complete: true,
      errors: ["EIO"],
    });
  });
  it("a stalled file operation never blocks the writer's caller, and flush reports it", async () => {
    let release: () => void = () => {};
    const writer = createEvidenceWriter("memory.psv", {
      io: {
        appendFile: () => new Promise<void>((done) => (release = done)),
        writeFile: async () => {},
      },
    });
    const start = performance.now();
    for (let i = 0; i < 100; i++) writer.write(line(T0 + i));
    expect(performance.now() - start).toBeLessThan(50);
    const stalled = await writer.flush(100);
    expect(stalled.complete).toBe(false);
    expect(stalled.pending).toBeGreaterThan(0);
    release();
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await writer.flush(1000)).toMatchObject({
      complete: true,
      pending: 0,
    });
  });
});

describe("V1.21.1 telemetry transport wiring", () => {
  it("both runners take samples from the sampler's stdout and evaluate them in memory", () => {
    for (const file of [
      "scripts/e2e-chunks.mjs",
      "scripts/v1201-owned-run.mjs",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/"-Stream"/);
      expect(source).toMatch(/stdio: \["ignore", "pipe", "pipe"\]/);
      expect(source).toMatch(/samples: telemetry\.samples/);
      expect(source).not.toMatch(/readSamples\(/);
      expect(source).toMatch(
        /createEvidenceWriter\(join\(\w+, "memory\.psv"\)\)/,
      );
    }
    expect(readFileSync("scripts/e2e-chunks.mjs", "utf8")).toMatch(
      /\(log \+= d\), forward\(d\)/,
    );
  });
  it("the stream mode of the sampler writes no file", () => {
    const sampler = readFileSync("scripts/e2e-monitor.ps1", "utf8");
    const stream = sampler.slice(
      sampler.indexOf("if ($Stream) {"),
      sampler.indexOf("} else {"),
    );
    expect(stream).toMatch(/\$stdout\.WriteLine\(\$memory\)/);
    expect(stream).not.toMatch(
      /Add-SharedLine|WriteAllText|Set-Content|Out-File/,
    );
  });
});
