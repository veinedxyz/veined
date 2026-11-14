export const SAMPLE_FRESHNESS_MS: number;
export const SAMPLE_FUTURE_TOLERANCE_MS: number;
export type MemorySample = {
  at: number;
  freeGb: number;
  commitGb: number;
  commitLimitGb: number;
  nodeGb: number;
  browserGb: number;
  processes: number;
};
export type GuardState = {
  startedAt: number;
  startedMono: number;
  newestAt: number | null;
  newestSeenMono: number;
  samples: MemorySample[];
  lastRead: string;
  transport?: "stdout";
  accepted?: number;
  rejected?: number;
  streamClosed?: boolean;
};
export type GuardStop = {
  at: string;
  reason:
    | "MEMORY_SAMPLER_EXITED"
    | "MEMORY_SAMPLE_CLOCK_SKEW"
    | "MEMORY_SAMPLE_STALE"
    | "MEMORY_LIMIT";
  headroomGb: number | null;
  freeGb: number | null;
  guardGb: number;
  ownedGb: number | null;
  ownedLimitGb: number;
  wallAgeMs?: number;
  monoAgeMs?: number;
  read?: string;
};
export function parseSamples(raw: string): MemorySample[];
export function readSamples(
  file: string,
  state: GuardState,
  read?: (file: string, encoding: "utf8") => string,
): MemorySample[];
export function createGuardState(nowMs: number, monoMs: number): GuardState;
export function evaluateMemoryGuard(input: {
  samples: MemorySample[];
  state: GuardState;
  nowMs: number;
  monoMs: number;
  guardGb: number;
  ownedLimitGb: number;
  samplerExited?: boolean;
}): GuardStop | null;
export type SampleStreamState = GuardState;
export function createSampleStream(
  state: SampleStreamState,
  handlers?: {
    onSample?: (sample: MemorySample, line: string) => void;
    onOwned?: (owned: unknown, json: string) => void;
  },
): { push(chunk: string): void; end(): void };
export type EvidenceStats = {
  written: number;
  retries: number;
  errors: string[];
};
export function createEvidenceWriter(
  file: string,
  options?: {
    mode?: "append" | "replace";
    retryMs?: number;
    io?: {
      appendFile: (file: string, data: string) => Promise<void>;
      writeFile: (file: string, data: string) => Promise<void>;
    };
  },
): {
  stats: EvidenceStats;
  write(text: string): void;
  flush(
    timeoutMs?: number,
  ): Promise<EvidenceStats & { complete: boolean; pending: number }>;
};
