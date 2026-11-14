import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { MODES, ERRORS } from "../model";
import { metrics } from "../../data/observability/log";
const sampleSchema = z
  .object({
    mode: z.enum(MODES),
    chain: z.enum(["1", "56", "8453", "solana"]),
    phase: z.enum(["quote", "decode", "simulation"]),
    status: z.enum(["OK", ...ERRORS]),
    latencyMs: z.number().finite().min(0).max(120000),
    cooldownUntil: z.number().int().nonnegative().optional(),
  })
  .strict();
export type HealthSample = z.infer<typeof sampleSchema>;
/** Hourly aggregates, 48h retention, at most 9*4*3*49 rows. No wallet, token, amount, URL, error text or request IDs. */
export class DurableSwapHealth {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 100 });
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=64;
      CREATE TABLE IF NOT EXISTS samples(hour INTEGER NOT NULL,mode TEXT NOT NULL,chain TEXT NOT NULL,phase TEXT NOT NULL,total INTEGER NOT NULL,success INTEGER NOT NULL,timeout INTEGER NOT NULL,rate_limit INTEGER NOT NULL,schema_failure INTEGER NOT NULL,firewall_failure INTEGER NOT NULL,simulation_failure INTEGER NOT NULL,b0 INTEGER NOT NULL,b1 INTEGER NOT NULL,b2 INTEGER NOT NULL,b3 INTEGER NOT NULL,b4 INTEGER NOT NULL,b5 INTEGER NOT NULL,cooldown_until INTEGER NOT NULL,PRIMARY KEY(hour,mode,chain,phase));`);
  }
  record(input: HealthSample, now = Date.now()) {
    const s = sampleSchema.parse(input),
      hour = Math.floor(now / 3600000),
      bucket = [100, 500, 1000, 2500, 5000, Infinity].findIndex(
        (b) => s.latencyMs <= b,
      );
    const b = Array.from({ length: 6 }, (_, i) => Number(bucket === i));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM samples WHERE hour < ? OR hour > ?")
        .run(hour - 48, hour);
      this.db
        .prepare(
          `INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(hour,mode,chain,phase) DO UPDATE SET total=total+1,success=success+excluded.success,timeout=timeout+excluded.timeout,rate_limit=rate_limit+excluded.rate_limit,schema_failure=schema_failure+excluded.schema_failure,firewall_failure=firewall_failure+excluded.firewall_failure,simulation_failure=simulation_failure+excluded.simulation_failure,b0=b0+excluded.b0,b1=b1+excluded.b1,b2=b2+excluded.b2,b3=b3+excluded.b3,b4=b4+excluded.b4,b5=b5+excluded.b5,cooldown_until=excluded.cooldown_until`,
        )
        .run(
          hour,
          s.mode,
          s.chain,
          s.phase,
          1,
          Number(s.status === "OK"),
          Number(s.status === "PROVIDER_TIMEOUT"),
          Number(s.status === "RATE_LIMITED"),
          Number(s.status === "INVALID_SCHEMA"),
          Number(
            ["REVIEW_REQUIRED", "BUILD_REVIEW_REQUIRED"].includes(s.status),
          ),
          Number(s.status === "SIMULATION_FAILED"),
          ...b,
          Math.min(now + 30000, s.cooldownUntil ?? 0),
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  snapshot(now = Date.now()) {
    return this.db
      .prepare(
        "SELECT * FROM samples WHERE hour >= ? ORDER BY hour,mode,chain,phase",
      )
      .all(Math.floor(now / 3600000) - 48);
  }
  close() {
    this.db.close();
  }
}
const globalHealth = globalThis as typeof globalThis & {
  __swapHealth?: DurableSwapHealth;
};
export function recordSwapHealth(sample: HealthSample) {
  const s = sampleSchema.parse(sample),
    labels = { mode: s.mode, chain: s.chain, phase: s.phase };
  metrics.inc(
    s.status === "OK" ? "swap_success_total" : "swap_failure_total",
    labels,
  );
  metrics.observe("swap_latency_ms", labels, s.latencyMs);
  metrics.inc("swap_outcome_total", { ...labels, status: s.status });
  metrics.set("swap_cooldown_until_ms", labels, s.cooldownUntil ?? 0);
  if (process.env.VITEST && !process.env.SWAP_HEALTH_PATH) return;
  try {
    globalHealth.__swapHealth ??= new DurableSwapHealth(
      process.env.SWAP_HEALTH_PATH ??
        resolve(".otherbridge/swap-health/health.sqlite"),
    );
    globalHealth.__swapHealth.record(s);
  } catch {
    metrics.inc("swap_health_persistence_failure_total");
  }
}
