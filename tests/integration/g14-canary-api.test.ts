// G14 Track A: /api/execution "canary" action through the real route handler (origin, content-type and rate guards).
// The live pin reader is replaced by a fixture (the real one reads Base through the protected Swap transport, at most
// once a minute); no request leaves the process, nothing is signed. SYNTHETIC_TEST_ONLY.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fx from "../fixtures/g14-canary-across.json" with { type: "json" };
import { CANARY_PINS, type PinReads } from "../../src/execution/canary/pins";

const good: PinReads = {
  origin: "https://base-rpc.publicnode.com",
  chainId: "8453",
  block: { number: "56376191", hash: "0x" + "a".repeat(64) },
  selector: CANARY_PINS.selector,
  diamondCodehash: fx.pins.diamondCodehash,
  facetForSelector: fx.pins.facet,
  facetCodehash: fx.pins.facetCodehash,
  facetSpokePool: fx.pins.proxies["8453"].spokePool,
  feeCollectorCodehash: CANARY_PINS.feeCollector.codehash,
  sourceSpokePool: {
    codehash: fx.pins.proxies["8453"].spokePoolProxyCodehash,
    implementation: fx.pins.proxies["8453"].spokePoolImplementation,
    implementationCodehash:
      fx.pins.proxies["8453"].spokePoolImplementationCodehash,
  },
  sourceUsdc: {
    codehash: CANARY_PINS.usdc["8453"].codehash,
    implementation: fx.pins.proxies["8453"].usdcImplementation,
    implementationCodehash: fx.pins.proxies["8453"].usdcImplementationCodehash,
    decimals: 6,
    symbol: "USDC",
  },
};
let reads: PinReads = good;
vi.mock("../../src/execution/server/canary/pin-reads", () => ({
  cachedCanaryPins: vi.fn(async () => reads),
}));
const { POST } = await import("../../src/app/api/execution/route");
const { setAppLimiterForTests } = await import("../../src/server/api-guard");
const { MemoryRateLimiter } = await import("../../src/server/rate-limit");

const ORIGIN = "http://127.0.0.1:3100";
const call = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await POST(
    new NextRequest(`${ORIGIN}/api/execution`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3100",
        origin: ORIGIN,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
};
beforeEach(() => setAppLimiterForTests(new MemoryRateLimiter()));
afterEach(() => {
  setAppLimiterForTests(undefined);
  reads = good;
});

describe("G14-API canary status is read-only; the gate stays CLOSED", () => {
  it("C1 reports the scope, the pin check, the release matrix (library, not wired) and the CLOSED gate", async () => {
    const r = await call({ action: "canary" });
    expect(r.status).toBe(200);
    expect(r.json.scope).toEqual({
      id: "base-arbitrum-usdc-max5",
      source: "8453",
      destination: "42161",
      token: "USDC",
      maxAmount: "5000000",
      tool: "across",
    });
    expect(r.json.pins).toEqual({ problems: [], agreement: "SINGLE_SOURCE" });
    expect(r.json.pinSet).toBe("g14-canary-pins.2026-11-12.2");
    expect(r.json.readiness).toMatchObject({
      total: 19,
      implemented: 18,
      wired: true,
      active: false,
      implementation: "PRESENT",
      activation: "DISABLED",
      ownerRecord: "ABSENT",
    });
    expect(r.json.readiness.liveNeeds).toEqual([
      "OWNER_ACTIVATION_AND_G7_APPLICATION",
      "OWNER_GOAL",
      "OWNER_KEEPS_ANCHOR_HEAD",
      "OWNER_RABBY_ACCEPTANCE",
      "OWNER_RECORD",
      "PIN_AND_OPERATOR_RECONFIRMATION",
    ]);
    expect(r.json.gate).toMatchObject({
      state: "CLOSED",
      open: false,
      platformFeeBps: 0,
    });
    expect(r.json.gate.reasons).toEqual(
      expect.arrayContaining([
        "NO_OWNER_APPROVED_CANARY",
        "FIREWALL_GLOBAL_KILL",
        "NO_ACTIVE_CONTRACT_ENTRY",
      ]),
    );
  });
  it("C2 a re-routed facet, a changed fee collector or unreadable chain data is reported, never hidden", async () => {
    reads = {
      ...good,
      facetForSelector: "0x4444444444444444444444444444444444444444",
    };
    expect((await call({ action: "canary" })).json.pins.problems).toEqual([
      "FACET_REROUTED",
    ]);
    setAppLimiterForTests(new MemoryRateLimiter());
    reads = { ...good, feeCollectorCodehash: "0x" + "1".repeat(64) };
    expect((await call({ action: "canary" })).json.pins.problems).toEqual([
      "FEE_COLLECTOR_CHANGED",
    ]);
    setAppLimiterForTests(new MemoryRateLimiter());
    reads = { ...good, diamondCodehash: null, facetCodehash: null };
    expect((await call({ action: "canary" })).json.pins.problems).toContain(
      "PIN_UNREADABLE",
    );
  });
  it("C3 the canary's wallet steps do not exist on the API: authorize / prepare are WRITE_DISABLED", async () => {
    for (const action of ["authorize", "prepare", "Prepare"]) {
      setAppLimiterForTests(new MemoryRateLimiter());
      const r = await call({
        action,
        record: "canary-0001",
        token: { nonce: "a".repeat(32) },
      });
      expect(r.status, action).toBe(403);
      expect(r.json).toMatchObject({
        error: "WRITE_DISABLED",
        gate: { state: "CLOSED" },
      });
    }
  });
  it("C4 extra fields, a foreign origin and the rate limit are refused", async () => {
    expect((await call({ action: "canary", open: true })).json.error).toBe(
      "INVALID_REQUEST",
    );
    setAppLimiterForTests(new MemoryRateLimiter());
    expect(
      (await call({ action: "canary" }, { origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    setAppLimiterForTests(new MemoryRateLimiter());
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await call({ action: "canary" })).status);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});
