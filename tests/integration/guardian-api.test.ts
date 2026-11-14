// /api/guardian through the real route handler: origin, content-type and rate guards, strict schemas, NEAR transaction /
// message / address reviews, the server-side Agent Gate, NEAR Intents dry quotes (upstream stubbed with a REAL recorded
// signed 1Click quote) and offline signature verification, and the on-chain account check (NEAR RPC stubbed).
// SYNTHETIC_TEST_ONLY apart from the recorded public quote: no request leaves the process; nothing is signed or deposited.
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
import { GET, POST } from "../../src/app/api/guardian/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { resetIntentsCacheForTests } from "../../src/guardian/server/intents";
import {
  COMPROMISED_RUN,
  DEMO_POLICY,
  DEMO_WALLET,
  INSPECT_SCENARIOS,
  RECORDED_QUOTE,
} from "../../src/guardian/scenarios";
import { parseNearTransaction } from "../../src/guardian/near";
import { reviewNear } from "../../src/guardian/verdict";

const ORIGIN = "http://127.0.0.1:3100";
const saved = { ...process.env };
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
const TOKENS = [
  {
    assetId: "nep141:wrap.near",
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 3.72,
    contractAddress: "wrap.near",
  },
  {
    assetId: "nep141:base.omft.near",
    decimals: 18,
    blockchain: "base",
    symbol: "ETH",
    price: 2242.6,
  },
  {
    assetId: "nep141:ton.omft.near",
    decimals: 9,
    blockchain: "ton",
    symbol: "TON",
    price: 3,
  },
];
const signedAt = Date.parse(String(RECORDED_QUOTE.response.timestamp));
let upstream: string[] = [];
let quoteAnswer: unknown = RECORDED_QUOTE.response;
let rpcAnswer: unknown = {
  result: { code_hash: "11111111111111111111111111111111" },
};
beforeEach(() => {
  process.env.OTHERBRIDGE_APP_ORIGINS = ORIGIN;
  delete process.env.VEINED_GUARDIAN_ONCHAIN;
  delete process.env.VEINED_NEAR_AI_API_KEY;
  delete process.env.VEINED_NEAR_AI_MODEL;
  setAppLimiterForTests(new MemoryRateLimiter());
  resetIntentsCacheForTests();
  upstream = [];
  quoteAnswer = RECORDED_QUOTE.response;
  rpcAnswer = { result: { code_hash: "11111111111111111111111111111111" } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      upstream.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "https://1click.chaindefuser.com/v0/tokens")
        return new Response(JSON.stringify(TOKENS));
      if (url === "https://1click.chaindefuser.com/v0/quote") {
        expect(JSON.parse(String(init?.body)).dry).toBe(true);
        return new Response(JSON.stringify(quoteAnswer), { status: 201 });
      }
      if (url === "https://rpc.mainnet.fastnear.com")
        return new Response(JSON.stringify(rpcAnswer));
      throw Error(`unexpected upstream ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setAppLimiterForTests(undefined);
});
afterAll(() => {
  for (const k of Object.keys(process.env))
    if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});
const levelOf = (r: { json: { verdict: { level: string } } }) =>
  r.json.verdict.level;
const codesOf = (r: { json: { verdict: { findings: { code: string }[] } } }) =>
  r.json.verdict.findings.map((f) => f.code);

describe("Guardian API", () => {
  it("GA1 capabilities: closed execution, dry-only signed intents, MPC signers, on-chain mode, server-side policies", async () => {
    const res = await GET();
    expect(await res.json()).toEqual({
      policy: "g1.2026-11.1",
      execution: "CLOSED",
      signer: { mainnet: "v1.signer", testnet: "v1.signer-prod.testnet" },
      intents: {
        origin: "https://1click.chaindefuser.com",
        quotes: "DRY_ONLY",
        signatureKey: "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc",
      },
      onchain: "NEAR_RPC",
      narrator: "TEMPLATES",
      agentPolicies: ["demo-trader"],
    });
  });
  it("GA2 unauthorized access: missing or foreign origin, wrong content type, unknown action and malformed input are refused", async () => {
    expect(
      (
        await call(
          { action: "address", value: "alice.near" },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    const noOrigin = await POST(
      new NextRequest(`${ORIGIN}/api/guardian`, {
        method: "POST",
        headers: { host: "127.0.0.1:3100", "content-type": "application/json" },
        body: JSON.stringify({ action: "address", value: "alice.near" }),
      }),
    );
    expect(noOrigin.status).toBe(403);
    expect(
      (
        await call(
          { action: "address", value: "alice.near" },
          { "content-type": "text/plain" },
        )
      ).status,
    ).toBe(422);
    expect((await call({ action: "sign", tx: {} })).json).toEqual({
      error: "INVALID_REQUEST",
    });
    expect(
      (
        await call({
          action: "near-transaction",
          tx: { receiverId: "alice.near", actions: [{ type: "Nope" }] },
        })
      ).status,
    ).toBe(422);
    expect((await call("{not json")).status).toBe(422);
    expect(
      (await call({ action: "address", value: "x".repeat(40000) })).status,
    ).toBe(422);
    expect(upstream).toEqual([]);
  });
  it("GA3 a full-access-key request is blocked server-side; the API digest equals the local re-computation", async () => {
    const s = INSPECT_SCENARIOS.find((x) => x.id === "full-access-key")!;
    const a = await call({ action: "near-transaction", tx: s.value });
    expect(a.status).toBe(200);
    expect(levelOf(a)).toBe("BLOCK");
    expect(a.json.verdict.findings[0].code).toBe("NEAR_KEY_FULL_ACCESS");
    expect(a.json.verdict.digest).toBe(
      reviewNear(parseNearTransaction(s.value)).digest,
    );
    // No recipient receives value, so no on-chain lookup was needed.
    expect(upstream).toEqual([]);
  });
  it("GA4 on-chain evidence: a missing named recipient blocks, an existing one passes, an unreachable RPC is reported, off means no request", async () => {
    rpcAnswer = { error: { cause: { name: "UNKNOWN_ACCOUNT" } } };
    const missing = await call({
      action: "address",
      value: "  ghost-account-guardian.near ",
    });
    expect(levelOf(missing)).toBe("BLOCK");
    expect(codesOf(missing)).toContain("NEAR_ACCOUNT_MISSING");
    rpcAnswer = { result: { code_hash: "11111111111111111111111111111111" } };
    const present = await call({ action: "address", value: "alice.near" });
    expect(levelOf(present)).toBe("CLEAR");
    expect(codesOf(present)).toContain("NEAR_ACCOUNT_ONCHAIN");
    rpcAnswer = "<html>gateway error</html>";
    const unreachable = await call({ action: "address", value: "alice.near" });
    expect(codesOf(unreachable)).toContain("NEAR_ACCOUNT_UNVERIFIED");
    expect(levelOf(unreachable)).toBe("CAUTION");
    process.env.VEINED_GUARDIAN_ONCHAIN = "off";
    upstream = [];
    await call({ action: "address", value: "alice.near" });
    expect(upstream).toEqual([]);
  });
  it("GA5 Agent Gate: decided server-side from a named owner policy; callers cannot supply or widen a policy", async () => {
    const r = await call({
      action: "agent-run",
      policyId: "demo-trader",
      proposals: COMPROMISED_RUN,
    });
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe("SIMULATION");
    expect(r.json.results.map((x: { decision: string }) => x.decision)).toEqual(
      ["ALLOW", "ALLOW", "BLOCK", "BLOCK", "BLOCK", "ALLOW", "ESCALATE"],
    );
    expect(
      r.json.results.every(
        (x: { executable: boolean }) => x.executable === false,
      ),
    ).toBe(true);
    expect(
      (
        await call({
          action: "agent-run",
          policyId: "nope",
          proposals: COMPROMISED_RUN,
        })
      ).json,
    ).toEqual({
      error: "POLICY_UNKNOWN",
    });
    const widened = {
      ...DEMO_POLICY,
      allowReceivers: ["ref-finance-rewards.near"],
      perActionLimit: "9".repeat(30),
    };
    expect(
      (
        await call({
          action: "agent-run",
          policyId: "demo-trader",
          policy: widened,
          proposals: COMPROMISED_RUN,
        })
      ).status,
    ).toBe(422);
  });
  it("GA6 NEAR Intents dry quote: limited token list, dry request, real signature verified on the raw response, CLEAR when fresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(signedAt + 5_000);
    const tokens = await call({ action: "intents-tokens" });
    expect(
      tokens.json.tokens.map((t: { assetId: string }) => t.assetId),
    ).toEqual(["nep141:wrap.near", "nep141:base.omft.near"]);
    const q = await call({
      action: "intents-quote",
      request: RECORDED_QUOTE.request,
      sender: DEMO_WALLET,
    });
    expect(q.status).toBe(200);
    expect(q.json.verification).toMatchObject({
      signature: "VALID",
      mismatch: [],
    });
    expect(q.json.signed).toEqual(RECORDED_QUOTE.response);
    expect(levelOf(q)).toBe("CLEAR");
    expect(codesOf(q)).toEqual(
      expect.arrayContaining([
        "INTENTS_SIGNATURE_VALID",
        "INTENTS_DRY_QUOTE",
        "ASSET_EVIDENCE",
        "NEAR_ACCOUNT_ONCHAIN",
      ]),
    );
    upstream = [];
    expect(
      (
        await call({
          action: "intents-quote",
          request: { ...RECORDED_QUOTE.request, dry: false },
          sender: DEMO_WALLET,
        })
      ).status,
    ).toBe(422);
    expect(upstream).toEqual([]);
  });
  it("GA7 a tampered upstream answer is caught on arrival; offline verification needs no network and catches every alteration", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(signedAt + 5_000);
    const forged = structuredClone(RECORDED_QUOTE.response) as Record<
      string,
      Record<string, unknown>
    >;
    forged.quote.amountOut = "1" + String(forged.quote.amountOut);
    quoteAnswer = forged;
    const live = await call({
      action: "intents-quote",
      request: RECORDED_QUOTE.request,
      sender: DEMO_WALLET,
    });
    expect(live.json.verification.signature).toBe("INVALID");
    expect(levelOf(live)).toBe("BLOCK");
    process.env.VEINED_GUARDIAN_ONCHAIN = "off";
    upstream = [];
    const genuine = await call({
      action: "intents-verify",
      request: RECORDED_QUOTE.request,
      response: RECORDED_QUOTE.response,
      sender: DEMO_WALLET,
    });
    expect(levelOf(genuine)).toBe("CLEAR");
    const swapped = structuredClone(RECORDED_QUOTE.response) as Record<
      string,
      Record<string, unknown>
    >;
    swapped.quoteRequest.destinationAsset = "nep141:usdt.tether-token.near";
    const asset = await call({
      action: "intents-verify",
      request: RECORDED_QUOTE.request,
      response: swapped,
      sender: DEMO_WALLET,
    });
    expect(levelOf(asset)).toBe("BLOCK");
    expect(asset.json.verification.mismatch).toContain("destinationAsset");
    expect(upstream).toEqual([]);
    vi.setSystemTime(signedAt + 3_600_000);
    const replayed = await call({
      action: "intents-verify",
      request: RECORDED_QUOTE.request,
      response: RECORDED_QUOTE.response,
      sender: DEMO_WALLET,
    });
    expect(levelOf(replayed)).toBe("HOLD");
    expect(codesOf(replayed)).toContain("ROUTE_STALE");
    expect(
      (
        await call({
          action: "intents-verify",
          request: RECORDED_QUOTE.request,
          response: { quote: "x" },
          sender: DEMO_WALLET,
        })
      ).json,
    ).toEqual({
      error: "INTENTS_INVALID",
    });
  });
  it("GA8 concurrent identical requests give identical decisions and digests", async () => {
    const s = INSPECT_SCENARIOS.find((x) => x.id === "lookalike-token")!;
    process.env.VEINED_GUARDIAN_ONCHAIN = "off";
    const all = await Promise.all(
      Array.from({ length: 25 }, () =>
        call({ action: "near-transaction", tx: s.value }),
      ),
    );
    expect(new Set(all.map((r) => r.status))).toEqual(new Set([200]));
    expect(new Set(all.map((r) => r.json.verdict.digest)).size).toBe(1);
    expect(new Set(all.map((r) => r.json.verdict.level))).toEqual(
      new Set(["BLOCK"]),
    );
  });
  it("GA9 rate limits: the shared Guardian allowance and the smaller upstream allowance both answer 429", async () => {
    process.env.VEINED_GUARDIAN_ONCHAIN = "off";
    const statuses: number[] = [];
    for (let i = 0; i < 41; i++)
      statuses.push(
        (await call({ action: "address", value: "alice.near" })).status,
      );
    expect(statuses.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(statuses[40]).toBe(429);
    setAppLimiterForTests(new MemoryRateLimiter());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(signedAt + 5_000);
    const quotes: number[] = [];
    for (let i = 0; i < 11; i++)
      quotes.push(
        (
          await call({
            action: "intents-quote",
            request: RECORDED_QUOTE.request,
            sender: DEMO_WALLET,
          })
        ).status,
      );
    expect(quotes.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(quotes[10]).toBe(429);
  });
});
