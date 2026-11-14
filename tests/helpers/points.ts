import { createHash, randomBytes } from "node:crypto";
import { programConfig } from "../../src/points/config";
import { fixtureAccount, simulatedEvent } from "../../src/points/fixtures";
import { MemoryPointsStore } from "../../src/points/memory-store";
import { buildService } from "../../src/points/service";
import type { PointsStore } from "../../src/points/store";
import type { Principal, Role } from "../../src/points/admin-auth";
// Points test harness: an isolated simulation-mode program with a controllable clock. SYNTHETIC_TEST_ONLY.

export const SEASON_ONE = "2026-11-08T21:00:00.000Z"; // Monday 2026-11-09 00:00 Europe/Istanbul
export const DAY = 24 * 3600_000;
export const WEEK = 7 * DAY;
export const at = (ms: number) =>
  new Date(Date.parse(SEASON_ONE) + ms).toISOString();

export function harness(
  options: { store?: PointsStore; startOffsetMs?: number } = {},
) {
  let now = Date.parse(SEASON_ONE) + (options.startOffsetMs ?? DAY);
  const config = programConfig({
    NODE_ENV: "test",
    VEINED_POINTS_SIMULATION: "1",
    VEINED_POINTS_SEASON_ONE_STARTS_AT: SEASON_ONE,
    VEINED_POINTS_POLICY_VERSION: "draft-1",
  });
  const service = buildService({
    config,
    store: options.store ?? new MemoryPointsStore(),
    clock: () => new Date(now),
  });
  let n = 0;
  return {
    ...service,
    config,
    setNow: (ms: number) => (now = Date.parse(SEASON_ONE) + ms),
    advance: (ms: number) => (now += ms),
    now: () => now,
    /** Ingest a settled verified event (defaults: SWAP, finalized) at an offset from season 1 start. */
    event: (
      input: Partial<Parameters<typeof simulatedEvent>[0]> & {
        account: string;
        offset: number;
      },
    ) =>
      simulatedEvent({
        id: input.id ?? `t-${++n}`,
        category: input.category ?? "SWAP",
        usd: input.usd ?? 1000,
        ...input,
        occurredAt: input.occurredAt ?? at(input.offset),
      }),
    ingest(e: ReturnType<typeof simulatedEvent>) {
      return service.engine.ingest(e, e.verifier);
    },
  };
}
export const acct = fixtureAccount;

export function principal(
  id: string,
  roles: Role[],
): { principal: Principal; token: string } {
  const token = `vpa.${id}.${randomBytes(32).toString("base64url")}`;
  return {
    token,
    principal: {
      id,
      roles,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    },
  };
}
