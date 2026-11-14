import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as publicPost } from "../../src/app/api/points/route";
import { POST as adminPost } from "../../src/app/api/admin/points/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import {
  pointsService,
  resetPointsServiceForTests,
} from "../../src/points/service";
import { fixtureAccount } from "../../src/points/fixtures";
import { configDigest } from "../../src/points/config";
import { resolvePolicy } from "../../src/points/policy";
import { principal } from "../helpers/points";
// Points API through the real route handlers: current-season privacy, published-only leaderboards, admin
// authentication/authorization and the four-eyes settlement flow. Isolated simulation; SYNTHETIC_TEST_ONLY.

const ORIGIN = "http://127.0.0.1:3100";
const DAY = 24 * 3600_000;
const ops = principal("ops-a", ["viewer", "operator"]);
const owner = principal("owner-b", ["viewer", "approver"]);
const viewer = principal("view-c", ["viewer"]);
const saved = { ...process.env };
const ACCOUNTS = [
  "atlas",
  "boreal",
  "cinder",
  "delta",
  "ember",
  "fjord",
  "garnet",
  "harbor",
].map(fixtureAccount);

function env(extra: Record<string, string | undefined>) {
  for (const k of Object.keys(process.env))
    if (k.startsWith("VEINED_")) delete process.env[k];
  Object.assign(process.env, extra);
  resetPointsServiceForTests();
}
const simulation = () =>
  env({
    VEINED_POINTS_SIMULATION: "1",
    VEINED_POINTS_SEASON_ONE_STARTS_AT: new Date(
      Math.floor((Date.now() - 3 * DAY) / 60_000) * 60_000,
    ).toISOString(),
    VEINED_ADMIN_PRINCIPALS: JSON.stringify([
      ops.principal,
      owner.principal,
      viewer.principal,
    ]),
  });
const request = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3100",
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const pub = async (body: unknown, headers?: Record<string, string>) => {
  const res = await publicPost(request("/api/points", body, headers));
  return {
    status: res.status,
    headers: res.headers,
    body: await res.json(),
    text: "",
  };
};
const adm = async (token: string | null, body: unknown) => {
  const res = await adminPost(
    request(
      "/api/admin/points",
      body,
      token ? { authorization: `Bearer ${token}` } : {},
    ),
  );
  return { status: res.status, body: await res.json() };
};
const keysOf = (value: unknown): string[] =>
  value && typeof value === "object"
    ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
        k,
        ...keysOf(v),
      ])
    : [];
const NUMERIC_KEYS =
  /units|weight|rank|amount|total|points|score|share|denominator/i;

beforeEach(() => setAppLimiterForTests(new MemoryRateLimiter()));
afterAll(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith("VEINED_")) delete process.env[k];
  Object.assign(process.env, saved);
  resetPointsServiceForTests();
  setAppLimiterForTests(undefined);
});

describe("points API — current-season privacy", () => {
  it("public responses for the live season contain no points, weights or positions", async () => {
    simulation();
    const dashboard = await adm(ops.token, { action: "dashboard" });
    expect(dashboard.status).toBe(200);
    const provisional = dashboard.body.accounts as {
      account: string;
      totalUnits: string;
      activityWeight: string;
    }[];
    expect(
      provisional.filter((a) => a.totalUnits !== "0").length,
    ).toBeGreaterThan(3);
    const secrets = provisional
      .flatMap((a) => [a.totalUnits, a.activityWeight])
      .filter((v) => v !== "0");
    const bodies: string[] = [];
    for (const account of [undefined, ...ACCOUNTS]) {
      for (const body of [
        { action: "overview", ...(account ? { account } : {}) },
        { action: "tasks", ...(account ? { account } : {}) },
        ...(account ? [{ action: "history", account }] : []),
      ]) {
        const res = await pub(body);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toContain("no-store");
        expect(keysOf(res.body).filter((k) => NUMERIC_KEYS.test(k))).toEqual(
          [],
        );
        bodies.push(JSON.stringify(res.body));
      }
    }
    const all = bodies.join("\n");
    for (const secret of secrets) expect(all).not.toContain(`"${secret}"`);
    for (const secret of secrets) expect(all).not.toContain(`:${secret}`);
    // The live season and any unpublished season answer exactly like a missing season.
    for (const season of [1, 2, 99]) {
      const res = await pub({
        action: "leaderboard",
        season,
        account: ACCOUNTS[0],
      });
      expect([res.status, res.body]).toEqual([
        404,
        { error: "SEASON_NOT_PUBLISHED" },
      ]);
    }
    const overview = await pub({ action: "overview", account: ACCOUNTS[0] });
    expect(overview.body.current).toMatchObject({
      season: 1,
      resultsHidden: true,
    });
    expect(overview.body.account.referral.code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{8}$/,
    );
  });

  it("enforces origin, content type, body size and schema on the public API", async () => {
    simulation();
    const bad = async (
      headers: Record<string, string>,
      body: unknown = { action: "overview" },
    ) => (await publicPost(request("/api/points", body, headers))).status;
    expect(await bad({ origin: "https://evil.example" })).toBe(403);
    expect(await bad({ "content-type": "text/plain" })).toBe(422);
    expect(
      await bad({}, { action: "overview", account: "not-an-address" }),
    ).toBe(422);
    expect(
      await bad({}, { action: "leaderboard", season: 1, extra: true }),
    ).toBe(422);
    expect(
      await bad(
        {},
        JSON.stringify({ action: "overview", pad: "x".repeat(5000) }),
      ),
    ).toBe(413);
    expect(await bad({}, { action: "preview", season: 1 })).toBe(422);
  });

  it("referral codes only for eligible accounts", async () => {
    simulation();
    const ok = await pub({ action: "referral-code", account: ACCOUNTS[1] });
    expect(ok.status).toBe(200);
    expect(ok.body.path).toBe(`/points?ref=${ok.body.code}`);
    expect(
      (await pub({ action: "referral-code", account: ACCOUNTS[1] })).body.code,
    ).toBe(ok.body.code);
    const none = await pub({
      action: "referral-code",
      account: fixtureAccount("nobody"),
    });
    expect([none.status, none.body.error]).toEqual([
      403,
      "REFERRAL_CODE_NOT_ELIGIBLE",
    ]);
  });
});

describe("points API — admin access control", () => {
  it("rejects missing, malformed and wrong credentials without returning data", async () => {
    simulation();
    for (const token of [
      null,
      "",
      "vpa.ops-a.short",
      `${ops.token}x`,
      viewer.token.replace("view-c", "ops-a"),
    ]) {
      const res = await adm(token, { action: "dashboard" });
      expect([res.status, res.body]).toEqual([401, { error: "UNAUTHORIZED" }]);
    }
    const cross = await adminPost(
      request(
        "/api/admin/points",
        { action: "dashboard" },
        {
          authorization: `Bearer ${ops.token}`,
          origin: "https://evil.example",
        },
      ),
    );
    expect(cross.status).toBe(403);
    const { engine } = await pointsService();
    expect(
      (await engine.store.listAudit(500)).filter(
        (a) => a.action === "ADMIN_AUTH_FAILED",
      ).length,
    ).toBe(5);
  });

  it("least privilege and four-eyes: viewer reads, operator calculates, a different approver finalizes", async () => {
    simulation();
    expect(
      (await adm(viewer.token, { action: "calculate", season: 1 })).status,
    ).toBe(403);
    expect(
      (
        await adm(ops.token, {
          action: "sim-clock",
          advanceSeconds: 7 * 86_400,
        })
      ).status,
    ).toBe(200);
    const calc = await adm(ops.token, { action: "calculate", season: 1 });
    expect(calc.status).toBe(200);
    const id = calc.body.calculation.id;
    expect(
      (
        await adm(ops.token, {
          action: "finalize",
          season: 1,
          calculationId: id,
        })
      ).body.error,
    ).toBe("FORBIDDEN");
    expect(
      (await adm(viewer.token, { action: "publish", season: 1 })).body.error,
    ).toBe("FORBIDDEN");
    // Before publication the public leaderboard stays closed even though the calculation exists.
    expect((await pub({ action: "leaderboard", season: 1 })).status).toBe(404);
    const fin = await adm(owner.token, {
      action: "finalize",
      season: 1,
      calculationId: id,
    });
    expect(fin.status).toBe(200);
    expect((await pub({ action: "leaderboard", season: 1 })).status).toBe(404);
    expect(
      (await adm(owner.token, { action: "publish", season: 1 })).status,
    ).toBe(200);
    const board = await pub({
      action: "leaderboard",
      season: 1,
      account: ACCOUNTS[0],
    });
    expect(board.status).toBe(200);
    expect(BigInt(board.body.allocatedUnits) <= 200_000_000_000n).toBe(true);
    expect(board.body.rows[0].rank).toBe(1);
    expect(board.body.rows[0].account).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
    expect(board.body.you.totalUnits).toMatch(/^\d+$/);
    // Week 2 is live: only week 1 is visible.
    expect((await pub({ action: "leaderboard", season: 2 })).status).toBe(404);
    const overview = await pub({ action: "overview" });
    expect([
      overview.body.current.season,
      overview.body.latestPublished,
    ]).toEqual([2, 1]);
    const audit = (
      await adm(viewer.token, { action: "dashboard" })
    ).body.audit.map((a: { action: string }) => a.action);
    expect(audit).toEqual(
      expect.arrayContaining([
        "SETTLEMENT_CALCULATED",
        "SETTLEMENT_FINALIZED",
        "SEASON_PUBLISHED",
        "ADMIN_FORBIDDEN",
      ]),
    );
  });

  it("is closed when no principals are configured, and simulation actions do not exist outside simulation", async () => {
    env({ VEINED_POINTS_SIMULATION: "1" });
    expect((await adm(ops.token, { action: "dashboard" })).body.error).toBe(
      "ADMIN_NOT_CONFIGURED",
    );
    const start = "2026-11-08T21:00:00.000Z";
    env({
      VEINED_POINTS_ENABLED: "true",
      VEINED_POINTS_SEASON_ONE_STARTS_AT: start,
      VEINED_POINTS_POLICY_VERSION: "draft-1",
      VEINED_POINTS_FROZEN_CONFIG_SHA256: configDigest({
        schedule: { seasonOneStartsAt: start, activatedAt: start },
        policyVersion: "draft-1",
        policyHash: resolvePolicy("draft-1").hash,
      }),
      VEINED_ADMIN_PRINCIPALS: JSON.stringify([ops.principal]),
    });
    const sim = await adm(ops.token, {
      action: "sim-ingest",
      account: ACCOUNTS[0],
      category: "SWAP",
      usd: 100,
    });
    expect([sim.status, sim.body.error]).toEqual([404, "NOT_FOUND"]);
    const { config } = await pointsService();
    expect(config.trustedVerifiers).toEqual([]);
  });
});
