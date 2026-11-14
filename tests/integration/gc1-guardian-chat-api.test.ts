// Guardian chat (gc1) through the real /api/guardian route handler: the "chat-draft" and "chat-token" actions behind
// the app's origin, content-type and rate guards; direct-API bypass attempts (a client-supplied verdict, decision or
// level, unknown actions, an execution request); Guardian's BLOCK for burn and token-contract recipients; zero upstream
// requests for drafts (no RPC, no price, no AI) even with an AI key configured; and the stale-quote check the chat's
// "check again" button uses. SYNTHETIC_TEST_ONLY apart from the recorded public 1Click quote; nothing leaves the process.
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
import { POST } from "../../src/app/api/guardian/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { resetIntentsCacheForTests } from "../../src/guardian/server/intents";
import { RECORDED_QUOTE } from "../../src/guardian/scenarios";
import { GuardianBlocked, gateSwap } from "../../src/guardian/server/swap-gate";
import { swapIntent } from "../fixtures/swap";

const ORIGIN = "http://127.0.0.1:3100";
const saved = { ...process.env };
const BURN = "0x000000000000000000000000000000000000dEaD";
const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const FAKE = "0x1234567890123456789012345678901234567890";
const WALLET = "0x8a1f3c9b2d4e5f60718293a4b5c6d7e8f9a0b1c2";
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}/api/guardian`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3100",
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const call = async (body: unknown, headers?: Record<string, string>) => {
  const res = await POST(request(body, headers));
  return { status: res.status, json: await res.json() };
};
const draft = (over: Record<string, unknown> = {}) => ({
  action: "chat-draft",
  draft: {
    kind: "swap",
    source: "ethereum",
    destination: "ethereum",
    pay: { symbol: "ETH" },
    receive: { symbol: "USDC" },
    amount: "0.1",
    ...over,
  },
});
let upstream: string[] = [];
beforeEach(() => {
  process.env.OTHERBRIDGE_APP_ORIGINS = ORIGIN;
  delete process.env.VEINED_GUARDIAN_ONCHAIN;
  setAppLimiterForTests(new MemoryRateLimiter());
  resetIntentsCacheForTests();
  upstream = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      upstream.push(`${init?.method ?? "GET"} ${url}`);
      throw Error(`unexpected upstream ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAppLimiterForTests(undefined);
});
afterAll(() => {
  for (const k of Object.keys(process.env))
    if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("Guardian chat API", () => {
  it("GC1I-01 a chat draft is resolved to exact contracts and reviewed by Guardian, with zero upstream requests", async () => {
    const r = await call(draft({ sender: WALLET }));
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("DRAFT");
    expect(r.json.draft).toMatchObject({
      kind: "swap",
      executable: false,
      rawAmount: "100000000000000000",
    });
    expect(r.json.draft.receive.address).toBe(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
    expect(r.json.decision).toBe("ALLOW");
    expect(r.json.verdict.policy).toBe("g1.2026-11.1");
    expect(r.json).not.toHaveProperty("narration");
    expect(upstream).toEqual([]);
  });
  it("GC1I-02 direct API bypass attempts: a client verdict, decision or level, unknown actions and execution requests are refused", async () => {
    const base = draft().draft;
    for (const extra of [
      { verdict: { level: "CLEAR", findings: [] } },
      { decision: "ALLOW" },
      { level: "CLEAR" },
      { executable: true },
      { policy: "always-allow" },
    ]) {
      const r = await call({
        action: "chat-draft",
        draft: { ...base, ...extra },
      });
      expect(r.status, JSON.stringify(extra)).toBe(422);
      expect(r.json).toEqual({ error: "INVALID_REQUEST" });
    }
    expect((await call({ ...draft(), decision: "ALLOW" })).status).toBe(422);
    for (const action of [
      "chat-execute",
      "chat-sign",
      "execute",
      "broadcast",
      "approve",
      "chat",
    ])
      expect((await call({ action, draft: base })).json, action).toEqual({
        error: "INVALID_REQUEST",
      });
    expect(
      (await call(draft(), { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await call(draft(), { "content-type": "text/plain" })).status).toBe(
      422,
    );
    expect((await call(draft({ source: "solana" }))).status).toBe(422);
    expect((await call(draft({ amount: "1e18" }))).status).toBe(422);
    expect(upstream).toEqual([]);
  });
  it("GC1I-03 Guardian decides, not the chat: burn, token-contract and look-alike recipients and an impersonating token are blocked", async () => {
    const burn = await call(
      draft({
        kind: "bridge",
        destination: "base",
        pay: { symbol: "ETH" },
        receive: { symbol: "ETH" },
        recipient: BURN,
      }),
    );
    expect(burn.json.decision).toBe("BLOCK");
    expect(burn.json.verdict.findings[0].code).toBe("RECIPIENT_BURN");
    const contract = await call(
      draft({
        kind: "bridge",
        destination: "polygon",
        pay: { symbol: "USDT" },
        receive: { symbol: "USDT" },
        recipient: USDT_ETH,
      }),
    );
    expect(contract.json.verdict.findings[0].code).toBe(
      "RECIPIENT_TOKEN_CONTRACT",
    );
    const twin = `${WALLET.slice(0, 6)}${"7".repeat(32)}${WALLET.slice(-4)}`;
    const poisoned = await call(draft({ sender: WALLET, recipient: twin }));
    expect(poisoned.json.verdict.findings[0].code).toBe("RECIPIENT_POISONED");
    const fake = await call(
      draft({ receive: { symbol: "USDC", address: FAKE } }),
    );
    expect(fake.json.decision).toBe("BLOCK");
    expect(fake.json.verdict.findings[0].code).toBe("ASSET_IMPERSONATION");
    // The same burn recipient opened in Swap meets the existing server-side gate there (403 GUARDIAN_BLOCKED path).
    expect(() => gateSwap(swapIntent({ recipient: BURN }))).toThrow(
      GuardianBlocked,
    );
    expect(upstream).toEqual([]);
  });
  it("GC1I-04 chat-token: registry evidence for one exact token; an unknown contract named like a curated token is blocked", async () => {
    const real = await call({
      action: "chat-token",
      check: { chain: "ethereum", token: { symbol: "USDC" } },
    });
    expect(real.json.verdict.level).toBe("CLEAR");
    expect(real.json.token.level).toBe("CURATED");
    const fake = await call({
      action: "chat-token",
      check: { chain: "ethereum", token: { symbol: "USDC", address: FAKE } },
    });
    expect(fake.json.verdict.level).toBe("BLOCK");
    // G12 H01 (F1): Circle's native USDC on Base is now issuer-reviewed registry evidence.
    const native = await call({
      action: "chat-token",
      check: { chain: "base", token: { symbol: "USDC" } },
    });
    expect(native.json.verdict.level).toBe("CLEAR");
    expect(native.json.token).toMatchObject({
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      level: "CURATED",
    });
    // A name with no verified token on that network: similar names are offered as different assets.
    const unknown = await call({
      action: "chat-token",
      check: { chain: "polygon", token: { symbol: "MATIC" } },
    });
    expect(unknown.json.needs).toMatchObject({
      reason: "UNKNOWN_SYMBOL",
      symbol: "MATIC",
    });
    expect(
      unknown.json.needs.options.map((o: { symbol: string }) => o.symbol),
    ).toContain("WMATIC");
    expect(upstream).toEqual([]);
  });
  it("GC1I-05 zero paid AI: with an AI key configured, chat drafts still make no request and carry no narration", async () => {
    process.env.VEINED_NEAR_AI_API_KEY = "sk-synthetic-test-key-0000000000";
    process.env.VEINED_NEAR_AI_MODEL = "synthetic/model";
    const r = await call(draft());
    expect(r.status).toBe(200);
    expect(r.json).not.toHaveProperty("narration");
    expect(upstream).toEqual([]);
    delete process.env.VEINED_NEAR_AI_API_KEY;
    delete process.env.VEINED_NEAR_AI_MODEL;
  });
  it("GC1I-06 bounded: chat drafts share the Guardian allowance (40 per window) and answer 429 beyond it", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 41; i++) statuses.push((await call(draft())).status);
    expect(statuses.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(statuses[40]).toBe(429);
  });
  it("GC1I-07 stale quote: re-checking a genuine but old signed quote (the chat's 'check again') is HOLD, never CLEAR", async () => {
    const r = await call({
      action: "intents-verify",
      request: RECORDED_QUOTE.request,
      response: RECORDED_QUOTE.response,
      sender: RECORDED_QUOTE.request.refundTo,
    });
    expect(r.json.verification.signature).toBe("VALID");
    expect(r.json.verdict.level).toBe("HOLD");
    expect(
      r.json.verdict.findings.map((f: { code: string }) => f.code),
    ).toContain("ROUTE_STALE");
  });
});
