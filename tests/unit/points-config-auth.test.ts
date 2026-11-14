import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPointsMigrations } from "../../src/points/migrate";
import {
  configDigest,
  programConfig,
  simulationSeasonStart,
} from "../../src/points/config";
import {
  authenticate,
  parsePrincipals,
  PERMISSIONS,
  permitted,
} from "../../src/points/admin-auth";
import { resolvePolicy } from "../../src/points/policy";
import {
  istanbulWallClock,
  seasonAt,
  seasonWindow,
  WEEK_MS,
} from "../../src/points/season";
import { principal } from "../helpers/points";
// Program configuration freeze, production guards, season boundaries and admin authentication. SYNTHETIC_TEST_ONLY.

const START = "2026-11-08T21:00:00.000Z";
const frozen = () =>
  configDigest({
    schedule: { seasonOneStartsAt: START, activatedAt: START },
    policyVersion: "draft-1",
    policyHash: resolvePolicy("draft-1").hash,
  });

describe("points program configuration", () => {
  it("is closed by default", () => {
    const config = programConfig({ NODE_ENV: "development" });
    expect(config.enabled).toBe(false);
    expect(config.operational).toBe(false);
    expect(config.trustedVerifiers).toEqual([]);
  });

  it("runs only when the owner-frozen hash matches the exact configuration", () => {
    const env = {
      NODE_ENV: "development",
      VEINED_POINTS_ENABLED: "true",
      VEINED_POINTS_SEASON_ONE_STARTS_AT: START,
      VEINED_POINTS_POLICY_VERSION: "draft-1",
    };
    expect(programConfig(env).errors).toContain("CONFIG_NOT_FROZEN");
    const ok = programConfig({
      ...env,
      VEINED_POINTS_FROZEN_CONFIG_SHA256: frozen(),
    });
    expect(ok.operational).toBe(true);
    expect(ok.configHash).toBe(frozen());
    // Any drift (here: a different week boundary) closes the program.
    const drift = programConfig({
      ...env,
      VEINED_POINTS_SEASON_ONE_STARTS_AT: "2026-11-09T21:00:00.000Z",
      VEINED_POINTS_FROZEN_CONFIG_SHA256: frozen(),
    });
    expect(drift.operational).toBe(false);
    expect(drift.errors).toContain("CONFIG_NOT_FROZEN");
  });

  it("production refuses simulation, placeholder policies, memory storage, and trusts no verifier yet", () => {
    const config = programConfig({
      NODE_ENV: "production",
      VEINED_POINTS_ENABLED: "true",
      VEINED_POINTS_SIMULATION: "1",
      VEINED_POINTS_SEASON_ONE_STARTS_AT: START,
      VEINED_POINTS_POLICY_VERSION: "draft-1",
      VEINED_POINTS_FROZEN_CONFIG_SHA256: frozen(),
    });
    expect(config.operational).toBe(false);
    expect(config.simulation).toBe(false);
    expect(config.errors).toEqual(
      expect.arrayContaining([
        "SIMULATION_IN_PRODUCTION",
        "POLICY_NOT_OWNER_APPROVED",
        "DURABLE_STORE_REQUIRED",
      ]),
    );
    expect(config.trustedVerifiers).toEqual([]);
  });

  it("weeks are exact UTC multiples displayed in Europe/Istanbul", () => {
    const schedule = { seasonOneStartsAt: START, activatedAt: START };
    expect(seasonAt(schedule, "2026-11-08T20:59:59.999Z")).toBe(0);
    expect(seasonAt(schedule, START)).toBe(1);
    expect(seasonAt(schedule, new Date(Date.parse(START) + WEEK_MS - 1))).toBe(
      1,
    );
    expect(seasonAt(schedule, new Date(Date.parse(START) + WEEK_MS))).toBe(2);
    expect(seasonWindow(schedule, 2)).toEqual({
      startsAt: "2026-11-15T21:00:00.000Z",
      endsAt: "2026-11-22T21:00:00.000Z",
    });
    expect(istanbulWallClock(START)).toBe("2026-11-09 00:00");
    expect(simulationSeasonStart(new Date("2026-11-07T10:00:00Z"))).toBe(
      "2026-11-01T21:00:00.000Z",
    );
    expect(simulationSeasonStart(new Date("2026-11-08T21:00:00Z"))).toBe(START);
  });
});

describe("points admin authentication", () => {
  const ops = principal("ops-a", ["viewer", "operator"]);
  const owner = principal("owner-b", ["viewer", "approver"]);
  const config = JSON.stringify([ops.principal, owner.principal]);

  it("has no built-in identities and closes on missing or invalid configuration", () => {
    expect(parsePrincipals(undefined)).toEqual({
      principals: [],
      errors: ["ADMIN_NOT_CONFIGURED"],
    });
    expect(parsePrincipals("not json").errors).toEqual([
      "ADMIN_CONFIG_INVALID",
    ]);
    expect(
      parsePrincipals(JSON.stringify([{ ...ops.principal, roles: ["root"] }]))
        .errors,
    ).toEqual(["ADMIN_CONFIG_INVALID"]);
    expect(
      parsePrincipals(JSON.stringify([ops.principal, ops.principal])).errors,
    ).toEqual(["ADMIN_DUPLICATE_ID"]);
  });

  it("accepts only the exact bearer token of a configured principal", () => {
    const { principals } = parsePrincipals(config);
    expect(authenticate(`Bearer ${ops.token}`, principals)?.id).toBe("ops-a");
    expect(authenticate(`Bearer ${owner.token}`, principals)?.id).toBe(
      "owner-b",
    );
    for (const header of [
      null,
      "",
      ops.token,
      `Basic ${ops.token}`,
      `Bearer ${ops.token}x`,
      `Bearer ${ops.token.slice(0, -1)}${ops.token.endsWith("A") ? "B" : "A"}`,
      `Bearer ${ops.token.replace("ops-a", "owner-b")}`,
      `Bearer vpa.ghost.${"A".repeat(43)}`,
      `Bearer ${ops.principal.tokenSha256}`,
    ])
      expect(authenticate(header, principals)).toBeNull();
  });

  it("the offline generator yields a principal that authenticates only with its own token", () => {
    const run = (id: string, roles: string) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ["scripts/points-admin-token.mjs", id, roles],
          { encoding: "utf8" },
        ),
      ) as {
        token: string;
        principal: { id: string; roles: string[]; tokenSha256: string };
      };
    const a = run("ops-x", "viewer,operator");
    const b = run("owner-y", "approver");
    expect(a.principal).not.toHaveProperty("token");
    const { principals, errors } = parsePrincipals(
      JSON.stringify([a.principal, b.principal]),
    );
    expect(errors).toEqual([]);
    expect(authenticate(`Bearer ${a.token}`, principals)?.roles).toEqual([
      "viewer",
      "operator",
    ]);
    expect(authenticate(`Bearer ${b.token}`, principals)?.id).toBe("owner-y");
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/points-admin-token.mjs", "x", "root"],
        { stdio: "pipe" },
      ),
    ).toThrow();
  });

  it("enforces least privilege per action", () => {
    expect(permitted(ops.principal, "calculate")).toBe(true);
    expect(permitted(ops.principal, "finalize")).toBe(false);
    expect(permitted(ops.principal, "publish")).toBe(false);
    expect(permitted(owner.principal, "finalize")).toBe(true);
    expect(permitted(owner.principal, "sim-clock")).toBe(false);
    expect(permitted({ ...ops.principal, roles: ["viewer"] }, "flag")).toBe(
      false,
    );
    expect(
      Object.values(PERMISSIONS).filter((r) => r === "approver").length,
    ).toBeGreaterThanOrEqual(6);
  });
});

describe("points migration proposal guard", () => {
  it("the shipped proposal is a single additive migration", async () => {
    const files = await loadPointsMigrations();
    expect(files.map((f) => [f.version, f.name])).toEqual([
      [1, "0001_weekly_points.sql"],
    ]);
    expect(files[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });
  it("refuses destructive statements, obfuscated or not, and sequence gaps", async () => {
    for (const sql of [
      "DrOp TaBlE x;",
      "DROP\n/*x*/TABLE y",
      "truncate\ttokens",
      "delete  from chains",
      "ALTER TABLE a\nDROP COLUMN b",
      "alter table a rename to b",
      "REASSIGN OWNED BY a TO b",
      "DROP/**/SCHEMA public",
      "drop trigger t on x",
    ]) {
      const dir = mkdtempSync(join(tmpdir(), "pts-mig-"));
      writeFileSync(join(dir, "0001_bad.sql"), sql);
      await expect(loadPointsMigrations(dir), sql).rejects.toThrow(
        "DESTRUCTIVE_MIGRATION_REJECTED",
      );
    }
    const gap = mkdtempSync(join(tmpdir(), "pts-mig-"));
    writeFileSync(join(gap, "0002_late.sql"), "SELECT 1;");
    await expect(loadPointsMigrations(gap)).rejects.toThrow(
      "MIGRATION_SEQUENCE_GAP",
    );
  });
});
