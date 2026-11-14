// Host-memory guard shared by the E2E chunk runner and the owned-run launcher. Fail-closed by construction:
// only a complete, plausible sample that is new to this guard counts as fresh telemetry. Thresholds are policy and
// stay fixed: 15 s freshness, free < guard / 2, commit headroom < guard, owned processes above the owned limit.
import { readFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";

export const SAMPLE_FRESHNESS_MS = 15000;
// Bounded in-memory history (over an hour of samples at the sampler's ~2.5 s cadence).
const KEEP_SAMPLES = 2048;
const SHARING_ERRORS = ["EBUSY", "EACCES", "EPERM"];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
// A sample may not claim to be from the future; a small tolerance absorbs the
// sampler/guard clock read order on the same host, never a real skew.
export const SAMPLE_FUTURE_TOLERANCE_MS = 2000;

const FIELDS = [
  "at",
  "freeGb",
  "commitGb",
  "commitLimitGb",
  "nodeGb",
  "browserGb",
  "processes",
];

/** Complete sample lines only: a trailing line without its newline may be a write in progress. */
export function parseSamples(raw) {
  const lines = raw.split(/\r?\n/);
  if (!/\n$/.test(raw)) lines.pop();
  return lines
    .filter(Boolean)
    .map((line) => {
      // Robust to a locale decimal comma in samples written before the invariant-culture fix.
      const values = line.split("|").map((x) => Number(x.replace(",", ".")));
      if (values.length !== FIELDS.length) return null;
      return Object.fromEntries(FIELDS.map((key, i) => [key, values[i]]));
    })
    .filter((sample) => sample && Object.values(sample).every(Number.isFinite));
}

/**
 * Reads the sampler file. A sharing violation (EBUSY / EACCES) keeps the samples
 * already accepted (they only age), every other error is reported to the caller.
 */
export function readSamples(file, state, read = readFileSync) {
  try {
    state.samples = parseSamples(read(file, "utf8"));
    state.lastRead = "ok";
  } catch (error) {
    if (error.code === "ENOENT") state.lastRead = "missing";
    else if (["EBUSY", "EACCES"].includes(error.code))
      state.lastRead = error.code;
    else throw error;
  }
  return state.samples ?? [];
}

/**
 * Line reader for the sampler's stdout (-Stream). Only a complete sample line that is newer
 * than every accepted sample is kept; partial, malformed, duplicate and older lines are
 * counted and dropped. "#owned <json>" lines carry the ownership registry. The end of the
 * pipe marks the sampler as gone. No file is touched on this path.
 */
export function createSampleStream(state, { onSample, onOwned } = {}) {
  let buffer = "";
  Object.assign(state, {
    transport: "stdout",
    accepted: 0,
    rejected: 0,
    streamClosed: false,
  });
  const line = (text) => {
    if (text.startsWith("#owned ")) {
      try {
        onOwned?.(JSON.parse(text.slice(7)), text.slice(7));
      } catch {
        state.rejected++;
      }
      return;
    }
    const sample = parseSamples(text + "\n")[0];
    if (!sample || sample.at <= (state.samples.at(-1)?.at ?? -Infinity)) {
      state.rejected++;
      return;
    }
    state.samples.push(sample);
    if (state.samples.length > KEEP_SAMPLES)
      state.samples.splice(0, state.samples.length - KEEP_SAMPLES);
    state.accepted++;
    state.lastRead = "stream";
    onSample?.(sample, text);
  };
  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      for (const part of parts) if (part) line(part);
    },
    end() {
      if (buffer) state.rejected++;
      buffer = "";
      state.streamClosed = true;
    },
  };
}

/**
 * Asynchronous evidence writer. Text is queued in memory and written one operation at a time
 * ("append": every line; "replace": only the newest content). A slow or locked file never
 * blocks the caller; sharing violations are retried, other errors are recorded.
 */
export function createEvidenceWriter(
  file,
  { mode = "append", retryMs = 250, io = { appendFile, writeFile } } = {},
) {
  const queue = [];
  let latest = null,
    busy = false;
  const stats = { written: 0, retries: 0, errors: [] };
  const pending = () =>
    mode === "append" ? queue.length : latest === null ? 0 : 1;
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (pending()) {
        const data = mode === "append" ? queue.join("") : latest;
        const count = pending();
        try {
          if (mode === "append") await io.appendFile(file, data);
          else await io.writeFile(file, data);
          if (mode === "append") queue.splice(0, count);
          else if (latest === data) latest = null;
          stats.written += count;
        } catch (error) {
          if (SHARING_ERRORS.includes(error?.code)) {
            stats.retries++;
            await wait(retryMs);
          } else {
            stats.errors.push(String(error?.code ?? error?.message ?? error));
            if (mode === "append") queue.splice(0, count);
            else if (latest === data) latest = null;
          }
        }
      }
    } finally {
      busy = false;
    }
  }
  return {
    stats,
    write(text) {
      if (mode === "append") queue.push(text);
      else latest = text;
      pump();
    },
    /** Waits until everything queued is written, at most `timeoutMs`. */
    async flush(timeoutMs = 120000) {
      const until = Date.now() + timeoutMs;
      while ((busy || pending()) && Date.now() < until) await wait(25);
      return { complete: !busy && !pending(), pending: pending(), ...stats };
    },
  };
}

export function createGuardState(nowMs, monoMs) {
  return {
    startedAt: nowMs,
    startedMono: monoMs,
    newestAt: null,
    newestSeenMono: monoMs,
    samples: [],
    lastRead: "none",
  };
}

/**
 * Pure decision for one guard tick. Returns null while telemetry is fresh and within
 * limits, otherwise the stop record. `monoMs` is a monotonic clock (performance.now()).
 */
export function evaluateMemoryGuard({
  samples,
  state,
  nowMs,
  monoMs,
  guardGb,
  ownedLimitGb,
  samplerExited = false,
}) {
  const last = samples.at(-1) ?? null;
  const base = {
    at: new Date(nowMs).toISOString(),
    headroomGb: last ? +(last.commitLimitGb - last.commitGb).toFixed(2) : null,
    freeGb: last?.freeGb ?? null,
    guardGb,
    ownedGb: last ? last.nodeGb + last.browserGb : null,
    ownedLimitGb,
  };
  if (samplerExited || state.streamClosed)
    return { ...base, reason: "MEMORY_SAMPLER_EXITED" };
  if (last && last.at > nowMs + SAMPLE_FUTURE_TOLERANCE_MS)
    return { ...base, reason: "MEMORY_SAMPLE_CLOCK_SKEW" };
  if (last && (state.newestAt === null || last.at > state.newestAt)) {
    state.newestAt = last.at;
    state.newestSeenMono = monoMs;
  }
  // Fresh only if the newest sample is recent on the wall clock AND this guard has
  // observed a new sample recently on its monotonic clock.
  const wallAge = nowMs - (last?.at ?? state.startedAt);
  const monoAge = monoMs - state.newestSeenMono;
  if (wallAge > SAMPLE_FRESHNESS_MS || monoAge > SAMPLE_FRESHNESS_MS)
    return {
      ...base,
      reason: "MEMORY_SAMPLE_STALE",
      wallAgeMs: wallAge,
      monoAgeMs: Math.round(monoAge),
      read: state.lastRead,
    };
  if (
    last &&
    (last.commitLimitGb - last.commitGb < guardGb ||
      last.freeGb < guardGb / 2 ||
      last.nodeGb + last.browserGb > ownedLimitGb)
  )
    return { ...base, reason: "MEMORY_LIMIT" };
  return null;
}
