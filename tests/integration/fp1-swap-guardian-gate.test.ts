// fp1: /api/swap "review" through the real route handler with Guardian's server-side gate. The swap review service
// (build + simulation) is replaced by a recorder so the test proves WHEN the gate refuses: a BLOCK from the bound
// intent never reaches the build, a BLOCK from the reviewed quote never returns a "verified for review" body, and a
// clean review carries the same verdict digest the panel derives. SYNTHETIC_TEST_ONLY; nothing leaves the process.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { wire, type SwapIntent, type SwapQuote } from "../../src/swap/model";
import { review } from "../../src/guardian/verdict";
import { swapGateFacts } from "../../src/guardian/server/swap-gate";
import { swapIntent, swapQuote, usdc } from "../fixtures/swap";

const calls: string[] = [];
let reviewed: (i: SwapIntent) => SwapQuote = (i) => swapQuote(i);
vi.mock("../../src/swap/server/service", () => ({
  swapService: () => ({
    review: async (id: string, i: SwapIntent) => {
      calls.push(id);
      const quote = reviewed(i);
      return {
        state: "EXECUTION_CLOSED",
        verifiedForReview: true,
        quote,
        intent: i,
        expiresAt: quote.expiresAt,
        transactionDigest: "f".repeat(64),
        digest: "e".repeat(64),
      };
    },
    quote: async () => {},
  }),
}));
const { POST } = await import("../../src/app/api/swap/route");

const ORIGIN = "http://127.0.0.1:3100";
const saved = { ...process.env };
const BURN = "0x000000000000000000000000000000000000dEaD";
const call = async (intent: SwapIntent) => {
  const res = await POST(
    new NextRequest(`${ORIGIN}/api/swap`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3100",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: wire({ action: "review", id: "a".repeat(64), intent }),
    }),
  );
  return { status: res.status, json: await res.json() };
};
beforeEach(() => {
  process.env.OTHERBRIDGE_APP_ORIGINS = ORIGIN;
  setAppLimiterForTests(new MemoryRateLimiter());
  calls.length = 0;
  reviewed = (i) => swapQuote(i);
});
afterEach(() => setAppLimiterForTests(undefined));
afterAll(() => {
  for (const k of Object.keys(process.env))
    if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("fp1 /api/swap review: Guardian gate", () => {
  it("FPI-01 a clean review passes and carries Guardian's verdict (same digest as the rules over the same facts)", async () => {
    const intent = swapIntent();
    const r = await call(intent);
    expect(r.status).toBe(200);
    expect(r.json.verifiedForReview).toBe(true);
    expect(r.json.guardian.level).not.toBe("BLOCK");
    expect(calls).toHaveLength(1);
    const quote = reviewed(intent);
    expect(r.json.guardian.policy).toBe("g1.2026-11.1");
    expect(r.json.guardian.level).toBe(
      review(swapGateFacts(intent, quote)).level,
    );
  });
  it("FPI-02 burn or token-contract recipients are refused with 403 GUARDIAN_BLOCKED before any build", async () => {
    for (const recipient of [BURN, usdc]) {
      const r = await call(swapIntent({ recipient }));
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("GUARDIAN_BLOCKED");
      expect(r.json.verdict.level).toBe("BLOCK");
      expect(r.json.verifiedForReview).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });
  it("FPI-03 a reviewed quote that Guardian blocks (non-zero VEINED fee) never comes back verified", async () => {
    reviewed = (i) => {
      const q = swapQuote(i);
      return {
        ...q,
        costs: q.costs.map((c) =>
          c.kind === "PLATFORM" ? { ...c, amount: 1n } : c,
        ),
      };
    };
    const r = await call(swapIntent());
    expect(calls).toHaveLength(1);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("GUARDIAN_BLOCKED");
    expect(
      r.json.verdict.findings.map((f: { code: string }) => f.code),
    ).toContain("FEE_POLICY_VIOLATION");
    expect(r.json.transactionDigest).toBeUndefined();
  });
  it("FPI-04 a same-symbol impersonation on the receive side is refused server-side", async () => {
    const r = await call(
      swapIntent({
        tokenOut: {
          chain: "1",
          address: "0x" + "44".repeat(20),
          native: false,
          decimals: 6,
          symbol: "USDC",
        },
      }),
    );
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("GUARDIAN_BLOCKED");
    expect(calls).toHaveLength(0);
  });
});
