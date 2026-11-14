// G12 H02: the Swap / Bridge "To NEAR" route through the real /api/guardian handler. The 1Click upstream is stubbed
// with a REAL recorded signed dry quote (Base native USDC → wNEAR to veinedxyz.near, G11 read-only proof), so the
// signature check, request echo, source-asset identity, freshness and fail-closed error paths all run for real.
// SYNTHETIC_TEST_ONLY apart from that public quote: no request leaves the process; nothing is signed or deposited.
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
import {
  nearQuoteRequest,
  nearRouteDestinations,
} from "../../src/guardian/near-route";
import { INTENTS_REVIEWED_ORIGINS } from "../../src/guardian/intents";
import recorded from "../fixtures/g12-near-usdc-quote.json" with { type: "json" };

/** A signed 1Click quote as JSON, for deliberate edits in adversarial cases. */
type SignedQuote = {
  quote: Record<string, unknown>;
  quoteRequest: Record<string, unknown>;
} & Record<string, unknown>;

const ORIGIN = "http://127.0.0.1:3100";
const SENDER = recorded.request.refundTo;
const saved = { ...process.env };
const signedAt = Date.parse(recorded.response.timestamp);
const call = async (body: unknown) => {
  const res = await POST(
    new NextRequest(`${ORIGIN}/api/guardian`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3100",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
};
const codes = (r: { json: { verdict: { findings: { code: string }[] } } }) =>
  r.json.verdict.findings.map((f) => f.code);
let upstream: { url: string; body?: Record<string, unknown> }[] = [];
let answer: () => Response = () =>
  new Response(JSON.stringify(recorded.response), { status: 201 });
let tokens: unknown[] = [];
beforeEach(() => {
  process.env.OTHERBRIDGE_APP_ORIGINS = ORIGIN;
  process.env.VEINED_GUARDIAN_ONCHAIN = "off";
  delete process.env.VEINED_NEAR_AI_API_KEY;
  setAppLimiterForTests(new MemoryRateLimiter());
  resetIntentsCacheForTests();
  upstream = [];
  tokens = [];
  answer = () =>
    new Response(JSON.stringify(recorded.response), { status: 201 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(signedAt + 5_000);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      upstream.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "https://1click.chaindefuser.com/v0/tokens")
        return new Response(JSON.stringify(tokens));
      if (url === "https://1click.chaindefuser.com/v0/quote") return answer();
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
const quote = (request: unknown = recorded.request) =>
  call({ action: "intents-quote", request, sender: SENDER });

describe("G12 To NEAR route through /api/guardian", () => {
  it("NRA1 a reviewed source asset is quoted dry and reviewed without the live token list: signature VALID, CLEAR, no deposit", async () => {
    const r = await quote();
    expect(r.status).toBe(200);
    expect(r.json.verification).toMatchObject({
      signature: "VALID",
      mismatch: [],
    });
    expect(r.json.verdict.level).toBe("CLEAR");
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "INTENTS_DRY_QUOTE",
        "INTENTS_SIGNATURE_VALID",
        "ASSET_EVIDENCE",
      ]),
    );
    expect(
      r.json.verdict.findings
        .filter(
          (f: { code: string; params: { role?: string } }) =>
            f.code === "ASSET_EVIDENCE",
        )
        .map((f: { params: { role?: string } }) => f.params.role)
        .sort(),
    ).toEqual(["pay", "receive"]);
    expect(r.json.signed.quote.depositAddress).toBeUndefined();
    // Only the quote reached the upstream (assets come from the reviewed lists), and it was dry.
    expect(upstream.map((u) => u.url)).toEqual([
      "https://1click.chaindefuser.com/v0/quote",
    ]);
    expect(upstream[0].body).toMatchObject({
      dry: true,
      recipient: "veinedxyz.near",
    });
  });
  it("NRA2 the UI's own request builder produces exactly what the API accepts (and sends upstream unchanged)", async () => {
    const origin = INTENTS_REVIEWED_ORIGINS.find(
      (t) => t.blockchain === "arb" && t.symbol === "USDC",
    )!;
    const request = nearQuoteRequest({
      origin,
      destination: nearRouteDestinations()[1],
      amount: 25_000_000n,
      sender: SENDER,
      recipient: "veinedxyz.near",
      now: signedAt,
    });
    const r = await quote(request);
    expect(r.status).toBe(200);
    expect(upstream[0].body).toEqual(request);
    // The stub answers with the recorded quote, which was signed for another request: Guardian refuses it.
    expect(r.json.verdict.level).toBe("BLOCK");
    expect(r.json.verification.mismatch).toEqual(
      expect.arrayContaining(["originAsset", "destinationAsset", "amount"]),
    );
  });
  it("NRA3 expiry fails closed: the same genuine signed quote is HOLD (re-quote) once older than two minutes", async () => {
    vi.setSystemTime(signedAt + 121_000);
    const r = await call({
      action: "intents-verify",
      request: recorded.request,
      response: recorded.response,
      sender: SENDER,
    });
    expect(r.json.verification.signature).toBe("VALID");
    expect(r.json.verdict.level).toBe("HOLD");
    expect(r.json.verdict.steps).toContain("REQUOTE");
    expect(upstream).toEqual([]);
  });
  it("NRA4 adversarial answers: a deposit address, a forged amount or a changed recipient never review as a quote", async () => {
    const withDeposit = structuredClone(recorded.response) as SignedQuote;
    withDeposit.quote.depositAddress =
      "0x000000000000000000000000000000000000dEaD";
    answer = () => new Response(JSON.stringify(withDeposit), { status: 201 });
    const a = await quote();
    expect(a.json.verdict.level).toBe("BLOCK");
    expect(a.json.verification.mismatch).toContain("depositAddress");
    const forged = structuredClone(recorded.response) as SignedQuote;
    forged.quote.amountOut = (
      BigInt(String(forged.quote.amountOut)) * 3n
    ).toString();
    answer = () => new Response(JSON.stringify(forged), { status: 201 });
    const b = await quote();
    expect(b.json.verification.signature).toBe("INVALID");
    expect(b.json.verdict.level).toBe("BLOCK");
    const redirected = structuredClone(recorded.response) as SignedQuote;
    redirected.quoteRequest.recipient = "veinedxyz-rewards.near";
    answer = () => new Response(JSON.stringify(redirected), { status: 201 });
    const c = await quote();
    expect(c.json.verdict.level).toBe("BLOCK");
    expect(c.json.verification.mismatch).toContain("recipient");
  });
  it("NRA5 upstream failures are explicit errors, never a quote: 5xx, 4xx, partner-key, malformed and unreachable", async () => {
    const cases: [() => Response, number, string][] = [
      [() => new Response("busy", { status: 503 }), 502, "INTENTS_UNAVAILABLE"],
      [() => new Response("{}", { status: 400 }), 422, "INTENTS_REJECTED"],
      [() => new Response("{}", { status: 401 }), 424, "INTENTS_AUTH_REQUIRED"],
      [() => new Response("<html>", { status: 200 }), 422, "INTENTS_INVALID"],
      [
        () => new Response(JSON.stringify({ quote: { amountIn: "x" } })),
        422,
        "INTENTS_INVALID",
      ],
      [
        () => {
          throw new TypeError("fetch failed");
        },
        502,
        "INTENTS_UNAVAILABLE",
      ],
    ];
    for (const [make, status, error] of cases) {
      answer = make;
      const r = await quote();
      expect([r.status, r.json]).toEqual([status, { error }]);
      expect(r.json.verdict).toBeUndefined();
    }
  });
  it("NRA6 an unreviewed source asset found only in the live list is quoted but reviewed as a caution (identity by contract)", async () => {
    tokens = [
      {
        assetId:
          "nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near",
        decimals: 18,
        blockchain: "bsc",
        symbol: "USDC",
        contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      },
    ];
    const request = {
      ...recorded.request,
      originAsset:
        "nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near",
    };
    const echo = structuredClone(recorded.response) as SignedQuote;
    echo.quoteRequest.originAsset = request.originAsset;
    answer = () => new Response(JSON.stringify(echo), { status: 201 });
    const r = await quote(request);
    expect(r.status).toBe(200);
    // The edited echo breaks the recorded signature (BLOCK); the identity finding is still reported for the asset.
    expect(codes(r)).toContain("ASSET_UNVERIFIED");
    expect(
      r.json.verdict.findings.find(
        (f: { code: string }) => f.code === "ASSET_UNVERIFIED",
      ).params.role,
    ).toBe("pay");
    // An asset in neither list is refused before any quote.
    upstream = [];
    const unknown = await quote({
      ...recorded.request,
      originAsset: "nep141:base-0xdeadbeef.omft.near",
    });
    expect([unknown.status, unknown.json]).toEqual([
      422,
      { error: "INTENTS_REJECTED" },
    ]);
    expect(upstream.map((u) => u.url)).not.toContain(
      "https://1click.chaindefuser.com/v0/quote",
    );
  });
  it("NRA7 the server never sends a non-dry request, a client fee recipient or an unknown field", async () => {
    for (const bad of [
      { ...recorded.request, dry: false },
      { ...recorded.request, appFees: [{ recipient: "veined.near", fee: 50 }] },
      { ...recorded.request, depositType: "INTENTS" },
      { ...recorded.request, amount: "0" },
      { ...recorded.request, amount: "1.5" },
    ]) {
      const r = await quote(bad);
      expect(r.status).toBe(422);
    }
    expect(upstream).toEqual([]);
  });
});
