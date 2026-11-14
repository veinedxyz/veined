import { parsePrincipals, type Principal } from "./admin-auth";
import { programConfig, type ProgramConfig } from "./config";
import { PointsEngine } from "./engine";
import { seedSimulation } from "./fixtures";
import { MemoryPointsStore } from "./memory-store";
import { Settlement } from "./settlement";
import type { PointsStore } from "./store";
import { PointsViews } from "./views";
// Process-wide wiring. Route handlers are compiled into separate bundles, so the singleton lives on globalThis.

export interface PointsService {
  config: ProgramConfig;
  engine: PointsEngine;
  settlement: Settlement;
  views: PointsViews;
  admin: { principals: Principal[]; errors: string[] };
  simulation: { offsetMs: number } | null;
}
const KEY = Symbol.for("veined.points.service");
type Holder = { [KEY]?: { key: string; service: Promise<PointsService> } };

export function buildService(input: {
  config: ProgramConfig;
  store: PointsStore;
  principals?: { principals: Principal[]; errors: string[] };
  clock?: () => Date;
}): PointsService {
  const simulation = input.config.simulation ? { offsetMs: 0 } : null;
  const clock =
    input.clock ??
    (simulation
      ? () => new Date(Date.now() + simulation.offsetMs)
      : () => new Date());
  const engine = new PointsEngine({
    store: input.store,
    config: input.config,
    clock,
  });
  const settlement = new Settlement(engine);
  return {
    config: input.config,
    engine,
    settlement,
    views: new PointsViews(engine, settlement),
    admin: input.principals ?? {
      principals: [],
      errors: ["ADMIN_NOT_CONFIGURED"],
    },
    simulation,
  };
}

async function create(
  env: Record<string, string | undefined>,
): Promise<PointsService> {
  const config = programConfig(env);
  let store: PointsStore;
  if (config.store === "postgres") {
    const url = env.VEINED_POINTS_DATABASE_URL;
    if (!url) {
      config.errors.push("POINTS_DATABASE_NOT_CONFIGURED");
      config.operational = false;
      store = new MemoryPointsStore();
    } else {
      const { PostgresPointsStore } = await import("./postgres-store");
      store = await PostgresPointsStore.connect(url);
    }
  } else store = new MemoryPointsStore();
  const service = buildService({
    config,
    store,
    principals: parsePrincipals(env.VEINED_ADMIN_PRINCIPALS),
  });
  if (config.simulation && config.operational)
    await seedSimulation(service.engine);
  return service;
}

export function pointsService(
  env: Record<string, string | undefined> = process.env,
): Promise<PointsService> {
  const holder = globalThis as Holder;
  const key = [
    "VEINED_POINTS_ENABLED",
    "VEINED_POINTS_SEASON_ONE_STARTS_AT",
    "VEINED_POINTS_ACTIVATED_AT",
    "VEINED_POINTS_POLICY_VERSION",
    "VEINED_POINTS_FROZEN_CONFIG_SHA256",
    "VEINED_POINTS_STORE",
    "VEINED_POINTS_SIMULATION",
    "VEINED_ADMIN_PRINCIPALS",
    "NODE_ENV",
  ]
    .map((k) => env[k] ?? "")
    .join("|");
  if (holder[KEY]?.key !== key) {
    const service = create(env);
    holder[KEY] = { key, service };
    service.catch(() => {
      if (holder[KEY]?.service === service) delete holder[KEY];
    });
  }
  return holder[KEY]!.service;
}
/** Tests only: drop the process singleton. */
export function resetPointsServiceForTests() {
  delete (globalThis as Holder)[KEY];
}
