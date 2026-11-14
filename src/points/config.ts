import { digest } from "./hash";
import { resolvePolicy } from "./policy";
import { DISPLAY_TIME_ZONE, WEEK_MS, type Schedule } from "./season";
import {
  POINT_DECIMALS,
  REFERRAL_COMMISSION_BPS,
  WEEKLY_POOL_UNITS,
} from "./units";
// Program configuration. Everything is explicit and owner-supplied; nothing activates by default:
//   VEINED_POINTS_ENABLED                 "true" to run the program at all (default: closed)
//   VEINED_POINTS_SEASON_ONE_STARTS_AT    ISO UTC instant of the season 1 boundary (week boundaries follow it)
//   VEINED_POINTS_ACTIVATED_AT            ISO UTC instant from which verified activity can count
//   VEINED_POINTS_POLICY_VERSION          registered weight policy version
//   VEINED_POINTS_FROZEN_CONFIG_SHA256    the owner-frozen hash of the above; any drift closes the program
//   VEINED_POINTS_STORE                   "memory" (non-production only) | "postgres"
//   VEINED_POINTS_SIMULATION              "1" = isolated playtest: fixtures, simulated verifier, movable clock.
//                                         Refused in production builds.
export const PROGRAM_ID = "veined-weekly-points";
export const TRUSTED_SIMULATION_VERIFIERS = Object.freeze([
  "simulated-verifier",
  "fixture",
]);
// Production verifiers are registered only when real execution is opened by the owner. Execution is CLOSED.
export const TRUSTED_PRODUCTION_VERIFIERS: readonly string[] = Object.freeze(
  [],
);

export interface ProgramConfig {
  programId: string;
  enabled: boolean;
  operational: boolean;
  errors: string[];
  schedule: Schedule;
  policyVersion: string;
  policyHash: string;
  poolUnits: string;
  configHash: string;
  frozen: boolean;
  simulation: boolean;
  production: boolean;
  store: "memory" | "postgres";
  trustedVerifiers: readonly string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const instant = (raw: string | undefined) =>
  raw && ISO.test(raw) && !Number.isNaN(Date.parse(raw))
    ? new Date(raw).toISOString()
    : null;

/** Most recent Monday 00:00 Europe/Istanbul (UTC+3, no DST since 2016) at or before `now`: simulation only. */
export function simulationSeasonStart(now: Date) {
  const istanbul = new Date(now.getTime() + 3 * 3600_000);
  const day = (istanbul.getUTCDay() + 6) % 7;
  const midnight = Date.UTC(
    istanbul.getUTCFullYear(),
    istanbul.getUTCMonth(),
    istanbul.getUTCDate() - day,
  );
  return new Date(midnight - 3 * 3600_000).toISOString();
}

export function configDigest(input: {
  schedule: Schedule;
  policyVersion: string;
  policyHash: string;
}) {
  return digest({
    programId: PROGRAM_ID,
    seasonOneStartsAt: input.schedule.seasonOneStartsAt,
    activatedAt: input.schedule.activatedAt,
    weekMs: WEEK_MS,
    displayTimeZone: DISPLAY_TIME_ZONE,
    poolUnits: WEEKLY_POOL_UNITS.toString(),
    pointDecimals: POINT_DECIMALS,
    commissionBps: REFERRAL_COMMISSION_BPS.toString(),
    policyVersion: input.policyVersion,
    policyHash: input.policyHash,
  });
}

export function programConfig(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): ProgramConfig {
  const errors: string[] = [];
  const production = env.NODE_ENV === "production";
  const simulation = env.VEINED_POINTS_SIMULATION === "1";
  if (simulation && production) errors.push("SIMULATION_IN_PRODUCTION");
  const enabled =
    env.VEINED_POINTS_ENABLED === "true" || (simulation && !production);
  const defaultStart =
    simulation && !production ? simulationSeasonStart(now) : null;
  const seasonOneStartsAt =
    instant(env.VEINED_POINTS_SEASON_ONE_STARTS_AT) ?? defaultStart;
  const activatedAt =
    instant(env.VEINED_POINTS_ACTIVATED_AT) ?? seasonOneStartsAt;
  if (!seasonOneStartsAt) errors.push("SEASON_START_NOT_CONFIGURED");
  if (!activatedAt) errors.push("ACTIVATION_NOT_CONFIGURED");
  const policyVersion =
    env.VEINED_POINTS_POLICY_VERSION ?? (simulation ? "draft-1" : "");
  let policyHash = "";
  try {
    const { policy, hash } = resolvePolicy(policyVersion);
    policyHash = hash;
    if (production && policy.status !== "OWNER_APPROVED")
      errors.push("POLICY_NOT_OWNER_APPROVED");
  } catch {
    errors.push("POLICY_NOT_CONFIGURED");
  }
  const store = env.VEINED_POINTS_STORE === "postgres" ? "postgres" : "memory";
  if (production && store !== "postgres") errors.push("DURABLE_STORE_REQUIRED");
  const schedule = {
    seasonOneStartsAt: seasonOneStartsAt ?? "1970-01-01T00:00:00.000Z",
    activatedAt: activatedAt ?? "1970-01-01T00:00:00.000Z",
  };
  const configHash = configDigest({ schedule, policyVersion, policyHash });
  // Simulation freezes its own generated configuration; a real program must match the owner-frozen hash exactly.
  const frozen = simulation
    ? !production
    : /^[0-9a-f]{64}$/.test(env.VEINED_POINTS_FROZEN_CONFIG_SHA256 ?? "") &&
      env.VEINED_POINTS_FROZEN_CONFIG_SHA256 === configHash;
  if (enabled && !frozen) errors.push("CONFIG_NOT_FROZEN");
  return {
    programId: PROGRAM_ID,
    enabled,
    operational: enabled && errors.length === 0,
    errors,
    schedule,
    policyVersion,
    policyHash,
    poolUnits: WEEKLY_POOL_UNITS.toString(),
    configHash,
    frozen,
    simulation: simulation && !production,
    production,
    store,
    trustedVerifiers:
      simulation && !production
        ? TRUSTED_SIMULATION_VERIFIERS
        : TRUSTED_PRODUCTION_VERIFIERS,
  };
}
