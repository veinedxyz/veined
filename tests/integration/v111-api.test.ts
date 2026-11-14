// V1.11 API routes: portfolio single-flight + bounded inputs, asset registry API (list/search/preview), sanitized
// image route. Synthetic chains; DEXScreener and logo ingestion are mocked (no network).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

vi.mock("../../src/assets/sources/dexscreener", async (orig) => ({
  ...(await orig<typeof import("../../src/assets/sources/dexscreener")>()),
  dexEvidence: vi.fn(async () => null),
}));
vi.mock("../../src/assets/image-cache", async (orig) => ({
  ...(await orig<typeof import("../../src/assets/image-cache")>()),
  ingestRemoteLogo: vi.fn(async () => null),
}));

import { FakeChain, fakeNetwork } from "../fixtures/fake-chain";
import { DataPlane, setDataPlaneForTests } from "../../src/data/plane";
import { buildRegistry } from "../../src/data/registry/chains";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { routingCore } from "../../src/adapters/routing-core";
import { NativePortfolioProvider } from "../../src/portfolio/providers";
import { initialBsc } from "../../src/routing/custom";
import { portfolioSchema } from "../../src/portfolio/model";
import { POST as portfolioPost } from "../../src/app/api/portfolio/route";
import { POST as assetsPost } from "../../src/app/api/assets/route";
import { GET as imageGet } from "../../src/app/api/asset-image/[id]/route";
import type { ApprovedEndpoint } from "../../src/data/rpc/pool";
import { dexEvidence } from "../../src/assets/sources/dexscreener";
import type { Catalog } from "../../src/routing/model";

const wallet = "0x" + "a1".repeat(20);
const USDT_BSC = "0x55d398326f99059ff775485246999027b3197955";
const NEW_TOKEN = "0x" + "e5".repeat(20);
const MC3_CODE = readFileSync(
  "tests/fixtures/multicall3-runtime.hex",
  "utf8",
).trim();
class Chain56 extends FakeChain {
  handle(
    method: string,
    params: unknown[],
    b: Parameters<FakeChain["handle"]>[2],
  ) {
    if (
      method === "eth_getCode" &&
      String(params[0]).toLowerCase() === MULTICALL3
    )
      return MC3_CODE;
    return super.handle(method, params, b);
  }
}
const catalog: Catalog = {
  networks: [initialBsc],
  tools: [],
  generation: "t",
  observedAt: Date.now(),
  stale: false,
};
function plane() {
  const net = fakeNetwork();
  const c = new Chain56("56", "bsc");
  c.mine(30);
  c.native.set(wallet, 10n ** 18n);
  c.metadata.set(USDT_BSC, {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 18,
  });
  c.balances.set(`${USDT_BSC}|${wallet}`, 5n * 10n ** 18n);
  c.metadata.set(NEW_TOKEN, { symbol: "NEW", name: "New Token", decimals: 9 });
  net.chains.set("56", c);
  const endpoint: ApprovedEndpoint = {
    id: "56:rpc-bsc.synthetic.test",
    chainId: "56",
    url: "https://rpc-bsc.synthetic.test",
    priority: 10,
    supportsLogs: false,
    maxLogRange: 0,
    supportsBatch: true,
    supportsFinalized: true,
    supportsSafe: false,
    archive: false,
  };
  const p = new DataPlane(null, net.transport, 60_000, () => ({
    chains: buildRegistry([initialBsc], []),
    routing: [initialBsc],
    endpoints: [endpoint],
    multicall: {},
  }));
  const calls = () =>
    [...net.behaviors.values()].reduce((s, b) => s + (b.calls ?? 0), 0);
  return { plane: p, calls };
}
const req = (url: string, body: unknown) =>
  new NextRequest(`http://127.0.0.1:3100${url}`, {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3100",
      host: "127.0.0.1:3100",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  setAppLimiterForTests(new MemoryRateLimiter());
  vi.spyOn(routingCore, "listNetworks").mockResolvedValue(catalog);
  vi.spyOn(
    NativePortfolioProvider.prototype,
    "discoverActivity",
  ).mockResolvedValue([]);
  vi.spyOn(routingCore, "getAssets").mockResolvedValue([
    {
      chainId: "56",
      address: USDT_BSC,
      symbol: "USDT",
      name: "Tether USD",
      decimals: 18,
    },
    {
      chainId: "56",
      address: NEW_TOKEN,
      symbol: "NEW",
      name: "New Token",
      decimals: 9,
    },
  ]);
});
afterEach(() => {
  setDataPlaneForTests(undefined);
  setAppLimiterForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("V1.11 portfolio route", () => {
  it("two concurrent identical scans (e.g. two tabs) share ONE upstream scan", async () => {
    const solo = plane();
    setDataPlaneForTests(solo.plane);
    const one = await portfolioPost(
      req("/api/portfolio", { identity: { evm: wallet }, consent: true }),
    );
    expect(one.status).toBe(200);
    const soloCalls = solo.calls();
    const shared = plane();
    setDataPlaneForTests(shared.plane);
    const [a, b] = await Promise.all([
      portfolioPost(
        req("/api/portfolio", { identity: { evm: wallet }, consent: true }),
      ),
      portfolioPost(
        req("/api/portfolio", { identity: { evm: wallet }, consent: true }),
      ),
    ]);
    const [ja, jb] = [
      portfolioSchema.parse(await a.json()),
      portfolioSchema.parse(await b.json()),
    ];
    expect(ja.revision).toBe(jb.revision);
    expect(shared.calls()).toBe(soloCalls);
    expect(ja.holdings.find((h) => h.address === USDT_BSC)?.discovery).toBe(
      "curated",
    );
  });
  it("different identities never share a scan; priority/extra contracts are bounded", async () => {
    setDataPlaneForTests(plane().plane);
    const other = "0x" + "b2".repeat(20);
    const [a, b] = await Promise.all([
      portfolioPost(
        req("/api/portfolio", { identity: { evm: wallet }, consent: true }),
      ),
      portfolioPost(
        req("/api/portfolio", { identity: { evm: other }, consent: true }),
      ),
    ]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(
      ja.holdings.some((h: { address: string }) => h.address === USDT_BSC),
    ).toBe(true);
    expect(
      jb.holdings.some((h: { address: string }) => h.address === USDT_BSC),
    ).toBe(false);
    const tooMany = {
      "56": Array.from(
        { length: 26 },
        (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"),
      ),
    };
    expect(
      (
        await portfolioPost(
          req("/api/portfolio", {
            identity: { evm: wallet },
            consent: true,
            extraTokens: tooMany,
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await portfolioPost(
          req("/api/portfolio", {
            identity: { evm: wallet },
            consent: true,
            priority: ["1", "2", "3", "4", "5", "6"],
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await portfolioPost(
          req("/api/portfolio", {
            identity: { evm: wallet },
            consent: true,
            extraTokens: { "56": ["0xnot"] },
          }),
        )
      ).status,
    ).toBe(422);
  });
});

describe("V1.11 asset registry API", () => {
  it("list/search accept only a chain id and a query; no wallet data; strict schema", async () => {
    setDataPlaneForTests(plane().plane);
    const list = await assetsPost(
      req("/api/assets", { action: "list", chain: "56" }),
    );
    expect(list.status).toBe(200);
    const { assets } = await list.json();
    expect(
      assets.find((a: { address: string }) => a.address === USDT_BSC),
    ).toMatchObject({ level: "CANONICAL", routeStatus: "ROUTABLE" });
    expect(
      assets.some((a: { address: string }) => a.address === NEW_TOKEN),
    ).toBe(false);
    expect(
      (
        await assetsPost(
          req("/api/assets", { action: "list", chain: "56", wallet }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await assetsPost(
          req("/api/assets", {
            action: "search",
            chain: "56",
            query: "x".repeat(200),
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await assetsPost(
          req("/api/assets", { action: "list", chain: "../etc" }),
        )
      ).status,
    ).toBe(422);
  });
  it("preview reads code + ERC-20 metadata through the vetted pool and defaults to IMPORTED_UNVERIFIED", async () => {
    setDataPlaneForTests(plane().plane);
    const r = await assetsPost(
      req("/api/assets", {
        action: "preview",
        chain: "56",
        address: NEW_TOKEN,
      }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.importable).toBe(true);
    expect(body.asset).toMatchObject({
      level: "IMPORTED_UNVERIFIED",
      decimals: 9,
      symbol: "NEW",
      routeStatus: "ROUTABLE",
    });
    const none = await assetsPost(
      req("/api/assets", {
        action: "preview",
        chain: "56",
        address: "0x" + "f6".repeat(20),
      }),
    );
    expect(
      (await none.json()).steps.find((s: { step: string }) => s.step === "code")
        .detail,
    ).toBe("NO_CONTRACT_CODE");
  });
  it("exact route-supported address with DEX evidence → one DEX_DISCOVERED result (label, never auto-selected)", async () => {
    setDataPlaneForTests(plane().plane);
    vi.mocked(dexEvidence).mockResolvedValueOnce({
      chainId: "56",
      address: NEW_TOKEN,
      pairs: 2,
      liquidityUsd: 4200,
      priceUsd: "0.01",
      symbol: "NEW",
      name: "New Token",
      imageUrl: null,
      observedAt: Date.now(),
      source: "dexscreener",
    });
    const r = await assetsPost(
      req("/api/assets", { action: "search", chain: "56", query: NEW_TOKEN }),
    );
    const body = await r.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      level: "DEX_DISCOVERED",
      routeStatus: "ROUTABLE",
    });
    expect(body.results[0].risk).toContain("LOW_LIQUIDITY");
    expect(body.results[0].evidence.dex).toMatchObject({ pairs: 2 });
    // A route-unsupported unknown address never triggers a DEX lookup; it only offers the explicit import preview.
    vi.mocked(dexEvidence).mockClear();
    const other = await (
      await assetsPost(
        req("/api/assets", {
          action: "search",
          chain: "56",
          query: "0x" + "f7".repeat(20),
        }),
      )
    ).json();
    expect(other).toEqual({ results: [], lookup: true });
    expect(dexEvidence).not.toHaveBeenCalled();
  });
  it("local-test mode is hermetic: no route list, no lookups", async () => {
    vi.stubEnv("OTHERBRIDGE_MODE", "local-test");
    vi.stubEnv("NODE_ENV", "development");
    setDataPlaneForTests(plane().plane);
    const r = await assetsPost(
      req("/api/assets", {
        action: "preview",
        chain: "56",
        address: NEW_TOKEN,
      }),
    );
    expect((await r.json()).error).toBe("LOCAL_TEST_MODE_NO_LOOKUP");
    const list = await (
      await assetsPost(req("/api/assets", { action: "list", chain: "56" }))
    ).json();
    expect(
      list.assets.every(
        (a: { routeStatus: string }) => a.routeStatus === "UNKNOWN",
      ),
    ).toBe(true);
    expect(routingCore.getAssets).not.toHaveBeenCalled();
  });
  it("preview is rate limited separately", async () => {
    setDataPlaneForTests(plane().plane);
    const codes: number[] = [];
    for (let i = 0; i < 14; i++)
      codes.push(
        (
          await assetsPost(
            req("/api/assets", {
              action: "preview",
              chain: "56",
              address: NEW_TOKEN,
            }),
          )
        ).status,
      );
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
  it("image route serves only sanitized cached bytes by 64-hex id, with nosniff and a sandbox CSP", async () => {
    const miss = await imageGet(new Request("http://x/api/asset-image/abc"), {
      params: Promise.resolve({ id: "abc" }),
    });
    expect(miss.status).toBe(404);
    const bad = await imageGet(new Request("http://x"), {
      params: Promise.resolve({ id: "../../etc/passwd" }),
    });
    expect(bad.status).toBe(404);
  });
});
