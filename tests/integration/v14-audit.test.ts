// Regression tests for confirmed findings of the V1.4 full Opus audit (docs/OPUS_FINAL_AUDIT.md).
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryStore } from "../../src/data/store/memory";
import { DataPlane } from "../../src/data/plane";
import { indexOnce } from "../../src/data/indexer/worker";
import { readTokenBalances } from "../../src/data/balances/evm";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import { SelfHostedPortfolioProvider } from "../../src/data/portfolio/provider";
import { scanPortfolio, identityScope } from "../../src/portfolio/service";
import { mergePortfolio } from "../../src/portfolio/model";
import { createDataApi } from "../../src/data/api/router";
import { generateKey, randomId } from "../../src/data/api/keys";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { recordFailure, freshHealth } from "../../src/data/rpc/health";
import { originPolicy, checkOrigin } from "../../src/server/origin-policy";
import { publicIp } from "../../src/adapters/read-only";
import { boundedBody } from "../../src/server/body";
import { normalizeQuote } from "../../src/routing/normalize";
import { normalizeActive } from "../../src/catalog/model";
import { assetSchema } from "../../src/routing/catalog";
import { assertNonDestructive } from "../../src/data/store/migrate";
import { OtherbridgeDataClient } from "../../packages/data-client/src/index";
import { POST as bridgePost } from "../../src/app/api/bridge/route";
import { fakeNetwork, approved, FakeChain } from "../fixtures/fake-chain";
import {
  fixtureCatalog,
  fixtureInput,
  fixtureQuote,
} from "../fixtures/routing";
import { firstPage, secondPage } from "../fixtures/portfolio-v14";
import type { ChainRecord } from "../../src/data/registry/chains";
const wallet = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const other = "0x2222222222222222222222222222222222222222";
const tokens = Array.from(
  { length: 12 },
  (_, i) => `0x${"a".repeat(36)}${String(i + 1).padStart(4, "0")}`,
);
const record = (
  id: string,
  tier: ChainRecord["configuredTier"] = "ON_DEMAND_FUNGIBLE",
): ChainRecord => ({
  chainId: id,
  canonicalId: `eip155:${id}`,
  eip155: id,
  ecosystem: "EVM",
  name: `Synthetic ${id}`,
  mainnet: true,
  native: { symbol: "SYN", name: "Synthetic", decimals: 18 },
  finality: { kind: "finalized-tag", depth: 20 },
  configuredTier: tier,
  indexStartBlocks: 100,
  tokenEventModel: "erc20-transfer",
  enabled: true,
  tvlUsd: 1,
  routable: true,
  sources: ["tvl-catalog"],
});
async function plane(
  id = "930001",
  setup?: (c: FakeChain) => void,
  maxLogRange = 1000,
) {
  const net = fakeNetwork();
  const chain = new FakeChain(id);
  chain.mine(150, (n) =>
    n % 5n === 0n
      ? [{ token: tokens[0], from: other, to: wallet, value: 1n }]
      : [],
  );
  for (const t of tokens)
    chain.metadata.set(t, {
      symbol: `T${tokens.indexOf(t)}`,
      name: "Token",
      decimals: 18,
    });
  setup?.(chain);
  net.chains.set(id, chain);
  const store = new MemoryStore();
  await store.upsertChains([record(id)]);
  await store.upsertEndpoint(
    approved(id, "a.synthetic.test", { maxLogRange }),
    10,
  );
  await store.upsertEndpoint(
    approved(id, "b.synthetic.test", { maxLogRange }),
    20,
  );
  await store.setMulticall(id, {
    address: MULTICALL3,
    codeHash: null,
    verified: true,
    observedAt: 1,
  });
  const p = new DataPlane(store, net.transport, 0);
  const state = await p.state();
  return {
    net,
    chain,
    store,
    plane: p,
    state,
    pool: p.pool(state, id)!,
    chainRecord: state.chains[0],
  };
}
afterEach(() => vi.unstubAllEnvs());
describe("V14 audit regressions — data plane", () => {
  it("B1: a hostile token that breaks a Multicall batch is isolated by bisection", async () => {
    const env = await plane();
    for (const t of tokens.slice(1))
      env.chain.balances.set(`${t}|${wallet}`, 7n);
    const transport = env.net.transport;
    const bomb = tokens[5];
    const hostile = new DataPlane(
      env.store,
      async (endpoint, body, options) => {
        const call = body as { method?: string; params?: [{ data?: string }] };
        // Any aggregate containing the bomb token fails as a whole (gas cap / oversized return).
        if (
          call.method === "eth_call" &&
          call.params?.[0]?.data?.includes(bomb.slice(2))
        )
          return {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "out of gas" },
          };
        return transport(endpoint, body, options);
      },
      0,
    );
    const state = await hostile.state();
    const { reads, unchecked } = await readTokenBalances(
      hostile.pool(state, "930001")!,
      wallet,
      tokens,
      10n,
      MULTICALL3,
    );
    expect(unchecked).toEqual([]);
    expect(reads.find((r) => r.token === bomb)?.balance).toBeNull();
    expect(reads.filter((r) => r.balance === 7n)).toHaveLength(10);
  });
  it("B2: when every token read fails, the chain reports FAILED tokens, never checked-and-empty", async () => {
    const env = await plane();
    await env.store.upsertTokens(
      tokens.map((t) => ({
        chainId: "930001",
        address: t,
        sources: ["routing-catalog"],
        symbol: "X",
        decimals: 18,
      })),
    );
    const transport = env.net.transport;
    const broken = new DataPlane(
      env.store,
      async (endpoint, body, options) => {
        const call = body as { method?: string };
        if (call.method === "eth_call")
          return {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "execution reverted" },
          };
        return transport(endpoint, body, options);
      },
      0,
    );
    const catalog = fixtureCatalog();
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      new SelfHostedPortfolioProvider(broken, catalog),
    ]);
    expect(result.coverage.find((c) => c.chainId === "930001")).toMatchObject({
      tokens: "FAILED",
      reason: "TOKEN_READ_INCOMPLETE",
    });
  });
  it("B3/B7: a lying finality tag cannot finalize early; errors do not refresh progress time", async () => {
    const env = await plane();
    for (const host of ["a", "b"])
      env.net.behaviors.set(`https://${host}.synthetic.test`, {
        lyingTags: true,
      });
    const r = await indexOnce(
      env.store,
      env.pool,
      env.chainRecord,
      "audit-owner-1",
      { initialRange: 10, confirmations: 3 },
    );
    expect(r.status).toBe("CURRENT");
    const windows = await env.store.listWindows("930001", 100);
    expect(
      windows.filter((w) => w.finalized).every((w) => w.toBlock <= 150n - 20n),
    ).toBe(true);
    expect(windows.some((w) => !w.finalized)).toBe(true);
    const before = (await env.store.getCheckpoint("930001"))!.updatedAt;
    await env.store.setCheckpointError("930001", "RPC_ERROR");
    expect((await env.store.getCheckpoint("930001"))!.updatedAt).toBe(before);
  });
  it("B8: a reorg deeper than the inspected windows halts instead of rewinding unchecked history", async () => {
    // One-block windows (endpoint range 1) so more than 64 unfinalized windows exist.
    const env = await plane("930002", (c) => (c.finalityDepth = 10000n), 1);
    await indexOnce(
      env.store,
      env.pool,
      { ...env.chainRecord, finality: { kind: "depth", depth: 100000 } },
      "audit-owner-2",
      {
        initialRange: 1,
        confirmations: 3,
        maxWindows: 200,
      },
    );
    expect(
      (await env.store.listWindows("930002", 1000)).length,
    ).toBeGreaterThan(65);
    const transfers = (await env.store.verifyIndex("930002")).transfers;
    env.chain.reorg(20n, "deep-fork");
    const r = await indexOnce(
      env.store,
      env.pool,
      { ...env.chainRecord, finality: { kind: "depth", depth: 100000 } },
      "audit-owner-2",
      {
        initialRange: 1,
        confirmations: 3,
      },
    );
    expect(r.status).toBe("ERROR");
    expect(r.error).toMatch(/REWIND_DEPTH_EXCEEDED/);
    expect((await env.store.verifyIndex("930002")).transfers).toBe(transfers);
  });
  it("B5/C1: an unrouted token reusing a routed symbol is suspicious, unverified and spam", async () => {
    const fake = "0x9999999999999999999999999999999999999999";
    const env = await plane("930003", (c) => {
      c.metadata.set(fake, { symbol: "USDC", name: "USD Coin", decimals: 6 });
      c.balances.set(`${fake}|${wallet}`, 5000000n);
    });
    await env.store.upsertTokens([
      {
        chainId: "930003",
        address: tokens[0],
        sources: ["routing-catalog"],
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
      {
        chainId: "930003",
        address: fake,
        sources: ["indexed"],
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        metadataStatus: "OK",
      },
    ]);
    const catalog = fixtureCatalog();
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      new SelfHostedPortfolioProvider(env.plane, catalog),
    ]);
    expect(result.holdings.find((h) => h.address === fake)).toMatchObject({
      suspicious: true,
      spam: true,
      routable: false,
    });
  });
  it("B6: transient DNS failures back off normally; only non-public answers quarantine for 24 h", () => {
    expect(
      recordFailure(freshHealth(), "DNS_FAILED", 0).quarantinedUntil,
    ).toBeNull();
    expect(recordFailure(freshHealth(), "UNSAFE_DNS", 0).quarantinedUntil).toBe(
      24 * 3600000,
    );
  });
  it("C4/B15: merged pages keep the oldest observation time; identity scope is key-order independent", () => {
    const a = firstPage(),
      b = { ...secondPage(), observedAt: a.observedAt + 600000 };
    expect(mergePortfolio(a, b).observedAt).toBe(a.observedAt);
    expect(
      identityScope({
        evm: wallet,
        solana: "So11111111111111111111111111111111111111112",
      }),
    ).toBe(
      identityScope({
        solana: "So11111111111111111111111111111111111111112",
        evm: wallet,
      }),
    );
    expect(() =>
      assertNonDestructive({ name: "x.sql", sql: "DROP/**/TABLE tokens;" }),
    ).toThrow("DESTRUCTIVE_MIGRATION_REJECTED");
  });
});
describe("V14 audit regressions — Data API and SDK", () => {
  async function api(planId = "developer", scopes = ["chains:read"]) {
    const env = await plane();
    const clientId = randomId("cli");
    await env.store.createClient({
      id: clientId,
      displayName: "audit",
      status: "ACTIVE",
      planId,
      scopes,
      createdAt: Date.now(),
    });
    const key = generateKey("test");
    await env.store.createKey({
      id: randomId("key"),
      clientId,
      prefix: key.prefix,
      verifier: key.verifier,
      status: "ACTIVE",
      createdAt: Date.now(),
      revokedAt: null,
      lastUsedAt: null,
    });
    let rpcCalls = 0;
    const transport = env.net.transport;
    const counted = new DataPlane(
      env.store,
      async (e, b, o) => (rpcCalls++, transport(e, b, o)),
      0,
    );
    const handle = createDataApi({
      store: env.store,
      plane: counted,
      limiter: new MemoryRateLimiter(),
      routing: async () => fixtureCatalog(),
    });
    const get = (path: string, auth: string | null = key.plaintext) =>
      handle(
        new Request(`http://127.0.0.1:3200${path}`, {
          headers: auth ? { authorization: `Bearer ${auth}` } : {},
        }),
      );
    return { ...env, get, rpcCalls: () => rpcCalls, handle, key };
  }
  it("B4: out-of-scope and invalid-cost requests consume the per-client minute quota", async () => {
    const { get } = await api("developer", ["chains:read"]);
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++)
      statuses.push(
        (await get(`/v1/address/${wallet}/portfolio?maxChains=x`)).status,
      );
    expect(statuses.slice(0, 30).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });
  it("B4: unauthenticated traffic and health share a bounded anonymous bucket", async () => {
    const { get } = await api();
    let limited = 0;
    for (let i = 0; i < 310; i++)
      if ((await get("/v1/health", null)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    expect((await get("/v1/chains", "garbage")).status).toBe(429);
  });
  it("B10/B11: oversized activity cursors fail as 400; unknown tokens never trigger RPC", async () => {
    const { get, rpcCalls, handle, key } = await api("internal", [
      "activity:read",
      "tokens:read",
    ]);
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, k: ["930001", "99999999999999999999", 0] }),
    ).toString("base64url");
    expect(
      (await get(`/v1/address/${wallet}/activity?cursor=${cursor}`)).status,
    ).toBe(400);
    const before = rpcCalls();
    expect(
      (await get("/v1/930001/token/0x1234567890123456789012345678901234567890"))
        .status,
    ).toBe(404);
    expect(rpcCalls()).toBe(before);
    void handle;
    void key;
  });
  it("B14: the SDK refuses cleartext non-loopback base URLs and follows continuations", async () => {
    const key = generateKey("test").plaintext;
    expect(
      () =>
        new OtherbridgeDataClient({
          baseUrl: "http://api.example.org",
          apiKey: key,
        }),
    ).toThrow("INVALID_BASE_URL");
    expect(
      () =>
        new OtherbridgeDataClient({
          baseUrl: "https://user:pw@api.example.org",
          apiKey: key,
        }),
    ).toThrow("INVALID_BASE_URL");
    const { handle, key: real } = await api("internal", [
      "portfolio:read",
      "chains:read",
    ]);
    const client = new OtherbridgeDataClient({
      baseUrl: "http://127.0.0.1:3200",
      apiKey: real.plaintext,
      fetch: (async (url: string | URL, init?: RequestInit) =>
        handle(new Request(url, init))) as typeof fetch,
    });
    expect((await client.chains()).items[0].chainId).toBe("930001");
    const pages = await client.portfolioAll(wallet, { maxChains: 1 });
    expect(pages.at(-1)?.continuation ?? null).toBeNull();
    await expect(client.chain("999")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});
describe("V14 audit regressions — app boundary", () => {
  it("A-1/A-7: public production requires trusted proxies; forwarded values are read at the trusted hop", () => {
    expect(
      originPolicy({
        NODE_ENV: "production",
        OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
        OTHERBRIDGE_APP_ORIGINS: "https://otherbridge.io",
      }).errors,
    ).toContain("TRUST_PROXY_REQUIRED");
    const p = originPolicy({
      OTHERBRIDGE_APP_ORIGINS: "https://otherbridge.io",
      OTHERBRIDGE_TRUST_PROXY_HOPS: "1",
    });
    const req = (host: string, proto: string) =>
      new Request("http://x/api", {
        headers: {
          origin: "https://otherbridge.io",
          host: "10.0.0.1",
          "x-forwarded-host": host,
          "x-forwarded-proto": proto,
        },
      });
    expect(checkOrigin(req("evil.io, otherbridge.io", "http, https"), p)).toBe(
      "OK",
    );
    expect(checkOrigin(req("otherbridge.io, evil.io", "https, https"), p)).toBe(
      "ORIGIN_REJECTED",
    );
  });
  it("A-10: 6to4 IPv6 can embed private IPv4 and is not a public target", () => {
    expect(publicIp("2002:7f00:1::1")).toBe(false);
    expect(publicIp("2606:4700::1111")).toBe(true);
  });
  it("A-5: a trickled request body is cut off by the overall deadline", async () => {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 60));
        controller.enqueue(new TextEncoder().encode("x"));
        if (++i > 50) controller.close();
      },
    });
    await expect(
      boundedBody(
        new Request("http://x", {
          method: "POST",
          body: stream,
          duplex: "half",
        } as RequestInit),
        16000,
        250,
      ),
    ).rejects.toThrow("REQUEST_TIMEOUT");
  });
  it("A-6: an upstream quote carrying a nonzero integrator share is rejected", () => {
    const catalog = fixtureCatalog(),
      input = fixtureInput(),
      raw = fixtureQuote(input);
    raw.estimate.feeCosts = [
      {
        ...(raw.estimate.feeCosts?.[0] ?? {}),
        name: "Integrator Fee",
        amount: "1",
        token: raw.action.fromToken,
        feeSplit: { integratorFee: "1" },
      } as unknown as NonNullable<typeof raw.estimate.feeCosts>[number],
    ];
    expect(() => normalizeQuote(raw, input, catalog)).toThrow(
      "PLATFORM_FEE_NONZERO",
    );
    (raw.estimate.feeCosts[0] as unknown as { feeSplit: unknown }).feeSplit = {
      integratorFee: "0",
    };
    expect(() => normalizeQuote(raw, input, catalog)).not.toThrow();
  });
  it("A-9/C3: the Networks catalog derives portfolio capability from data-plane tiers", () => {
    const catalog = fixtureCatalog();
    const active = normalizeActive(
      [
        { name: "Arbitrum", chainId: 42161, tvl: 5 },
        { name: "Ethereum", chainId: 1, tvl: 9 },
      ],
      catalog,
      1,
      "t",
      new Map([
        ["42161", "full"],
        ["1", "native-only"],
      ]),
    );
    expect(
      active.chains.find((c) => c.chainId === "42161")?.capability.portfolio,
    ).toBe("full");
    expect(
      active.chains.find((c) => c.chainId === "1")?.capability.portfolio,
    ).toBe("native-only");
  });
  it("C6: upstream token display text loses bidi/zero-width controls", () => {
    const parsed = assetSchema.parse({
      chainId: "1",
      address: "0x1",
      symbol: "US‮DC",
      name: "Tok​en⁦",
      decimals: 6,
    });
    expect(parsed.symbol).toBe("USDC");
    expect(parsed.name).toBe("Token");
  });
  it("A-4: every bridge response is private and never cached", async () => {
    const r = await bridgePost(
      new NextRequest("http://127.0.0.1:3100/api/bridge", {
        method: "POST",
        headers: { origin: "https://attacker.example", host: "127.0.0.1:3100" },
        body: "{}",
      }),
    );
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
});
