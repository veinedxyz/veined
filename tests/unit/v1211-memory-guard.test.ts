import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_FRESHNESS_MS,
  SAMPLE_FUTURE_TOLERANCE_MS,
  createGuardState,
  evaluateMemoryGuard,
  parseSamples,
  readSamples,
} from "../../scripts/lib/memory-guard.mjs";

// Deterministic clocks: wall clock T0 + offsets, monotonic clock starting at 0.
const T0 = 1_800_000_000_000;
const line = (
  at: number,
  free = 8,
  commit = 40,
  limit = 67,
  node = 1,
  browser = 0.5,
  n = 6,
) => `${at}|${free}|${commit}|${limit}|${node}|${browser}|${n}\r\n`;
const sample = (
  at: number,
  free = 8,
  commit = 40,
  limit = 67,
  node = 1,
  browser = 0.5,
) => parseSamples(line(at, free, commit, limit, node, browser))[0];
const tick = (
  state: ReturnType<typeof createGuardState>,
  samples: ReturnType<typeof parseSamples>,
  wall: number,
  mono: number,
  samplerExited = false,
) =>
  evaluateMemoryGuard({
    samples,
    state,
    nowMs: T0 + wall,
    monoMs: mono,
    guardGb: 2,
    ownedLimitGb: 4,
    samplerExited,
  });
const busy = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

describe("V1.21.1 E2E memory guard policy stays fixed", () => {
  it("keeps the 15 s freshness, admission and runtime limits", () => {
    expect(SAMPLE_FRESHNESS_MS).toBe(15000);
    expect(SAMPLE_FUTURE_TOLERANCE_MS).toBe(2000);
    expect(readFileSync("scripts/lib/test-memory.mjs", "utf8")).toMatch(
      /standard: \{\s+minimumFreeGb: 5,\s+minimumCommitHeadroomGb: 8,\s+heapMiB: 3072,\s+ownedGiB: 4,/,
    );
    const runner = readFileSync("scripts/e2e-chunks.mjs", "utf8");
    expect(runner).toMatch(/guardGb: guard,\s+ownedLimitGb: 4,/);
    expect(runner).toMatch(/"--guard-gb="\)\)\?\.slice\(11\) \?\? 2/);
    const launcher = readFileSync("scripts/v1201-owned-run.mjs", "utf8");
    expect(launcher).toMatch(
      /guardGb: 2,\s+ownedLimitGb: memoryProfiles\[profile\]\.ownedGiB,/,
    );
  });
  it("the sampler appends with read/write sharing, survives a failed iteration and is not silenced", () => {
    const sampler = readFileSync("scripts/e2e-monitor.ps1", "utf8");
    expect(sampler).not.toMatch(/^\s*Add-Content\s/m);
    expect(sampler).toMatch(/\[IO\.FileShare\]::ReadWrite/);
    expect(sampler).toMatch(/sampler-errors\.log/);
    for (const file of [
      "scripts/e2e-chunks.mjs",
      "scripts/v1201-owned-run.mjs",
    ])
      expect(readFileSync(file, "utf8")).toMatch(/sampler\.stderr\.log/);
  });
});

describe("V1.21.1 E2E memory guard (negative cases fail closed)", () => {
  it("accepts reliable new samples (positive)", () => {
    const state = createGuardState(T0, 0);
    const samples: ReturnType<typeof parseSamples> = [];
    for (let s = 0; s <= 60; s++) {
      if (s % 2 === 0) samples.push(sample(T0 + s * 1000));
      expect(
        tick(state, [...samples], s * 1000 + 300, s * 1000 + 300),
      ).toBeNull();
    }
  });
  it("stops on a stale sample (wall age above 15 s), not at exactly 15 s", () => {
    const state = createGuardState(T0, 0);
    expect(tick(state, [sample(T0)], 15000, 0)).toBeNull();
    expect(tick(state, [sample(T0)], 15001, 1)?.reason).toBe(
      "MEMORY_SAMPLE_STALE",
    );
  });
  it("stops when no sample ever arrives within 15 s", () => {
    const state = createGuardState(T0, 0);
    expect(tick(state, [], 15000, 15000)).toBeNull();
    expect(tick(state, [], 15001, 15001)?.reason).toBe("MEMORY_SAMPLE_STALE");
  });
  it("stops immediately when the sampler process exits (crash)", () => {
    const state = createGuardState(T0, 0);
    expect(tick(state, [sample(T0)], 500, 500, true)?.reason).toBe(
      "MEMORY_SAMPLER_EXITED",
    );
  });
  it("detects a sampler that silently stops even if the wall clock lags", () => {
    const state = createGuardState(T0, 0);
    expect(tick(state, [sample(T0)], 100, 100)).toBeNull();
    // The wall clock is slewed back: the old sample still looks recent on it, but no new sample for 15 s (monotonic).
    expect(tick(state, [sample(T0)], 1500, 15100)).toBeNull();
    expect(tick(state, [sample(T0)], 1600, 15101)?.reason).toBe(
      "MEMORY_SAMPLE_STALE",
    );
    // A larger backwards jump makes the sample look future-dated: fail closed as well.
    expect(tick(state, [sample(T0)], -9000, 15000)?.reason).toBe(
      "MEMORY_SAMPLE_CLOCK_SKEW",
    );
  });
  it("rejects future-dated samples (clock drift) and treats a forward jump as stale", () => {
    const state = createGuardState(T0, 0);
    expect(tick(state, [sample(T0 + 1500)], 0, 0)).toBeNull();
    expect(
      tick(createGuardState(T0, 0), [sample(T0 + 3600_000)], 0, 0)?.reason,
    ).toBe("MEMORY_SAMPLE_CLOCK_SKEW");
    const jump = createGuardState(T0, 0);
    expect(tick(jump, [sample(T0)], 500, 500)).toBeNull();
    expect(tick(jump, [sample(T0)], 20_000, 1500)?.reason).toBe(
      "MEMORY_SAMPLE_STALE",
    );
  });
  it("EBUSY / EACCES keep only already accepted samples, which age into a stop", () => {
    for (const code of ["EBUSY", "EACCES"]) {
      const state = createGuardState(T0, 0);
      const ok = readSamples("memory.psv", state, () => line(T0));
      expect(ok).toHaveLength(1);
      expect(tick(state, ok, 1000, 1000)).toBeNull();
      const cached = readSamples("memory.psv", state, busy(code));
      expect(state.lastRead).toBe(code);
      expect(cached).toEqual(ok);
      expect(tick(state, cached, 14000, 14000)).toBeNull();
      expect(
        tick(state, readSamples("memory.psv", state, busy(code)), 15100, 15100)
          ?.reason,
      ).toBe("MEMORY_SAMPLE_STALE");
    }
  });
  it("reports read failures other than a sharing violation to the caller", () => {
    expect(() =>
      readSamples("memory.psv", createGuardState(T0, 0), busy("EIO")),
    ).toThrow("EIO");
    const missing = createGuardState(T0, 0);
    expect(readSamples("memory.psv", missing, busy("ENOENT"))).toEqual([]);
    expect(missing.lastRead).toBe("missing");
  });
  it("ignores a partial write and malformed lines", () => {
    const full = line(T0) + line(T0 + 2000);
    expect(parseSamples(full)).toHaveLength(2);
    // The trailing line is still being written: never used, even if it parses as numbers.
    expect(parseSamples(full + `${T0 + 4000}|8|40|67|1|0.5|6`)).toHaveLength(2);
    expect(parseSamples(full + `${T0 + 4000}|8|4`)).toHaveLength(2);
    expect(parseSamples(`${T0}|8|40|67|1\r\n`)).toEqual([]);
    expect(parseSamples(`${T0}|8|40|67|1|0.5|6|9\r\n`)).toEqual([]);
    expect(parseSamples(`${T0}|8|NaN|67|1|0.5|6\r\n`)).toEqual([]);
    expect(parseSamples(`${T0}|8,5|40|67|1|0,5|6\r\n`)[0]).toMatchObject({
      freeGb: 8.5,
      browserGb: 0.5,
    });
  });
  it("a growing file read concurrently never moves the newest sample backwards", () => {
    let raw = "";
    const state = createGuardState(T0, 0);
    for (let i = 0; i < 20; i++) {
      raw += line(T0 + i * 2000);
      const view = raw + `${T0 + (i + 1) * 2000}|8|4`; // reader lands in the middle of the next append
      const samples = readSamples("memory.psv", state, () => view);
      expect(samples.at(-1)?.at).toBe(T0 + i * 2000);
      expect(tick(state, samples, i * 2000 + 500, i * 2000 + 500)).toBeNull();
    }
  });
  it("stops on a real memory limit violation, not at the exact limits", () => {
    const at = T0;
    expect(
      tick(createGuardState(T0, 0), [sample(at, 1, 65, 67, 3, 1)], 100, 100),
    ).toBeNull();
    expect(
      tick(createGuardState(T0, 0), [sample(at, 0.99)], 100, 100)?.reason,
    ).toBe("MEMORY_LIMIT");
    expect(
      tick(createGuardState(T0, 0), [sample(at, 8, 65.01, 67)], 100, 100)
        ?.reason,
    ).toBe("MEMORY_LIMIT");
    expect(
      tick(createGuardState(T0, 0), [sample(at, 8, 40, 67, 3.01, 1)], 100, 100)
        ?.reason,
    ).toBe("MEMORY_LIMIT");
  });
});
