import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hex } from "viem";
import { createDataApi } from "../../src/data/api/router";
import { MemoryStore } from "../../src/data/store/memory";
import { DataPlane } from "../../src/data/plane";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { generateKey } from "../../src/data/api/keys";
import { fixtureCatalog } from "../fixtures/routing";
import type { Scope } from "../../src/data/api/plans";
import {
  normalizeUniverse,
  parseChainlistText,
} from "../../src/defi/universe/normalize";
import { buildIndex, loadCatalog } from "../../src/defi/universe/store";
import { parseUniverse } from "../../src/defi/universe/io";
import { POST as catalogPOST } from "../../src/app/api/defi/catalog/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { scanDefi, clearScanStateForTests } from "../../src/defi/scanner";
import { deployments } from "../../src/defi/registry";
import type { AdapterContext } from "../../src/defi/adapters";
import { usdValue } from "../../src/data/core/price";
import type { PositionAsset, ProtocolDeployment } from "../../src/defi/model";
import { WAD } from "../../src/defi/math";
// V1.14 integration: Data API catalog endpoints, app catalog route, universe sync (fixture mode) and the
// candidate-driven scan receipt. Upstream is never contacted; all values are SYNTHETIC FIXTURES.
const dir = "tests/fixtures/defi-universe/";
const fixtureIndex = () => {
  const r = normalizeUniverse(
    {
      protocols: JSON.parse(readFileSync(dir + "protocols.json", "utf8")),
      chains: JSON.parse(readFileSync(dir + "chains.json", "utf8")),
      config: JSON.parse(readFileSync(dir + "config.json", "utf8")),
    },
    {
      syncId: "fixture-sync-api",
      generatedAt: "2026-10-11T00:00:00.000Z",
      sources: [],
      identities: [
        {
          id: "1",
          chainId: "1",
          caip2: "eip155:1",
          name: "Ethereum",
          ecosystem: "EVM",
        },
      ],
      chainlist: parseChainlistText(readFileSync(dir + "chainIds.js", "utf8")),
    },
  );
  return buildIndex(r.universe, "c".repeat(64));
};
async function api(
  scopes: Scope[] = ["chains:read"],
  catalog: () => Promise<ReturnType<typeof fixtureIndex>> = async () =>
    fixtureIndex(),
) {
  const store = new MemoryStore(),
    key = generateKey("test");
  await store.createClient({
    id: "client-a",
    displayName: "Synthetic API",
    status: "ACTIVE",
    planId: "developer",
    scopes,
    createdAt: Date.now(),
  });
  await store.createKey({
    id: "key-a",
    clientId: "client-a",
    prefix: key.prefix,
    verifier: key.verifier,
    status: "ACTIVE",
    createdAt: Date.now(),
    revokedAt: null,
    lastUsedAt: null,
  });
  const handle = createDataApi({
    store,
    plane: new DataPlane(store),
    limiter: new MemoryRateLimiter(),
    routing: async () => fixtureCatalog(),
    catalog,
  });
  return (path: string, auth = true) =>
    handle(
      new Request("http://127.0.0.1:3200" + path, {
        headers: auth ? { Authorization: "Bearer " + key.plaintext } : {},
      }),
    );
}
describe("V1.14 Data API: global DeFi catalog", () => {
  it("lists every cataloged protocol with paginated, searchable, filterable coverage", async () => {
    const get = await api();
    const r = await get("/v1/defi/catalog/protocols?q=aave&limit=5");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.data.items[0].name).toBe("Aave V3");
    expect(b.data.items[0].coverage.headline).toBe("FULL_POSITION");
    const all = await (
      await get("/v1/defi/catalog/protocols?status=ALL&limit=2")
    ).json();
    expect(all.data.items).toHaveLength(2);
    const next = await (
      await get(
        "/v1/defi/catalog/protocols?status=ALL&limit=2&cursor=" +
          all.data.nextCursor,
      )
    ).json();
    expect(next.data.items[0].id).not.toBe(all.data.items[0].id);
    const lending = await (
      await get(
        "/v1/defi/catalog/protocols?category=lending&status=ALL&limit=50",
      )
    ).json();
    expect(
      lending.data.items.every(
        (p: { productCategory: string }) => p.productCategory === "lending",
      ),
    ).toBe(true);
  });
  it("protocol detail keeps TVL context separate; chains, categories and coverage are their own surfaces", async () => {
    const get = await api();
    const d = await (
      await get(
        "/v1/defi/catalog/protocols/" + encodeURIComponent("llama:1599"),
      )
    ).json();
    expect(d.data.identity.name).toBe("Aave V3");
    expect(d.data.tvlContext).toBeDefined();
    expect(d.data.chains.length).toBeGreaterThan(0);
    expect(
      (
        await get(
          "/v1/defi/catalog/protocols/" +
            encodeURIComponent("llama:does-not-exist"),
        )
      ).status,
    ).toBe(404);
    const chains = await (
      await get("/v1/defi/catalog/chains?q=eth&limit=10")
    ).json();
    expect(
      chains.data.items.some((c: { name: string }) => c.name === "Ethereum"),
    ).toBe(true);
    const cats = await (await get("/v1/defi/catalog/categories")).json();
    expect(cats.data.categories.length).toBeGreaterThan(0);
    const cov = await (await get("/v1/defi/catalog/coverage")).json();
    expect(cov.data.protocolHeadline).toBeDefined();
    expect(cov.data.catalogVersion).toBe("fixture-sync-api");
  });
  it("authentication, scope, invalid input and unavailable catalog fail closed", async () => {
    const get = await api();
    expect((await get("/v1/defi/catalog/protocols", false)).status).toBe(401);
    expect((await get("/v1/defi/catalog/protocols?limit=1000")).status).toBe(
      400,
    );
    expect((await get("/v1/defi/catalog/protocols?cursor=forged")).status).toBe(
      400,
    );
    expect(
      (await get("/v1/defi/catalog/protocols?coverage=EVERYTHING")).status,
    ).toBe(400);
    expect(
      (await get("/v1/defi/catalog/protocols?q=" + "a".repeat(81))).status,
    ).toBe(400);
    const noScope = await api(["portfolio:read"]);
    expect((await noScope("/v1/defi/catalog/protocols")).status).toBe(403);
    const down = await api(["chains:read"], async () => {
      throw Error("CATALOG_UNAVAILABLE");
    });
    expect((await down("/v1/defi/catalog/coverage")).status).toBe(503);
  });
});
describe("V1.14 app catalog route (accepted last-good catalog, no upstream proxy)", () => {
  beforeEach(() => setAppLimiterForTests(new MemoryRateLimiter()));
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    catalogPOST(
      new Request("http://127.0.0.1:3100/api/defi/catalog", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3100",
          Host: "127.0.0.1:3100",
          "Content-Type": "application/json",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  it("searches the generated catalog and returns reviewed coverage for Aave V3", async () => {
    const r = await post({ view: "protocols", q: "aave v3", limit: 5 });
    expect(r.status).toBe(200);
    const b = await r.json();
    const aave = b.items.find((p: { slug: string }) => p.slug === "aave-v3");
    expect(aave.coverage.headline).toBe("FULL_POSITION");
    const summary = await (await post({ view: "summary" })).json();
    expect(summary.stats.protocolsSeen).toBeGreaterThan(1000);
  });
  it("cataloged protocols without an adapter are explicit, never a checked zero", async () => {
    const b = await (
      await post({ view: "protocols", coverage: "CATALOG_ONLY", limit: 5 })
    ).json();
    expect(b.items.length).toBe(5);
    expect(
      b.items.every(
        (p: { coverage: { headline: string } }) =>
          p.coverage.headline === "CATALOG_ONLY",
      ),
    ).toBe(true);
  });
  it("rejects unknown fields, hostile origins, oversized bodies and unknown ids", async () => {
    expect(
      (await post({ view: "protocols", url: "https://evil.test" })).status,
    ).toBe(422);
    expect(
      (await post({ view: "protocols" }, { Origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(
      (await post(JSON.stringify({ view: "protocols", q: "x".repeat(20000) })))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await post({ view: "protocol", id: "llama:999999999" })).status,
    ).toBe(404);
  });
  it("the shipped catalog parses under the strict schema and matches its sync receipt", async () => {
    const text = readFileSync(
      "content/defi-universe/universe.generated.json",
      "utf8",
    );
    const u = parseUniverse(text);
    const receipt = JSON.parse(
      readFileSync("content/defi-universe/sync-receipt.json", "utf8"),
    );
    expect(receipt.accepted).toBe(true);
    expect(receipt.syncId).toBe(u.syncId);
    expect(receipt.parity.pass).toBe(true);
    expect(u.stats.protocolsSeen).toBeLessThanOrEqual(u.protocols.length);
    expect(u.stats.protocolsSeen).toBeGreaterThan(1000);
    const index = await loadCatalog();
    expect(index.universe.syncId).toBe(u.syncId);
  });
});
describe("V1.14 universe sync (fixture mode): last-good fallback and anomaly protection", () => {
  const node = [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    "./scripts/ts-hooks.mjs",
    "scripts/defi-universe-sync.ts",
  ];
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "v114-sync-"));
  });
  const sync = (fixture: string, out: string) => {
    try {
      return {
        code: 0,
        out: execFileSync(
          process.execPath,
          [...node, "--fixture", fixture, "--out", out],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: err.stdout + err.stderr };
    }
  };
  it("accepts a complete feed, then rejects a truncated one and keeps the last-good catalog byte-identical", () => {
    const out = join(work, "data");
    const first = sync(dir, out);
    expect(first.code, first.out).toBe(0);
    const catalog = join(out, "universe.generated.json");
    const before = readFileSync(catalog);
    expect(
      parseUniverse(before.toString("utf8")).protocols.length,
    ).toBeGreaterThan(10);
    const truncated = join(work, "truncated");
    cpSync(dir, truncated, { recursive: true });
    const protocols = JSON.parse(
      readFileSync(join(dir, "protocols.json"), "utf8"),
    );
    writeFileSync(
      join(truncated, "protocols.json"),
      JSON.stringify(protocols.slice(0, 2)),
    );
    const second = sync(truncated, out);
    expect(second.code).toBe(2);
    expect(second.out).toContain("SYNC_REJECTED");
    expect(readFileSync(catalog).equals(before)).toBe(true);
    const corrupt = join(work, "corrupt");
    cpSync(dir, corrupt, { recursive: true });
    writeFileSync(join(corrupt, "protocols.json"), "{not json");
    const third = sync(corrupt, out);
    expect(third.code).not.toBe(0);
    expect(readFileSync(catalog).equals(before)).toBe(true);
    rmSync(work, { recursive: true, force: true });
    expect(existsSync(work)).toBe(false);
  }, 120000);
});
describe("V1.14 candidate-driven scan receipt", () => {
  beforeEach(() => clearScanStateForTests());
  const reth = deployments.find((d) => d.id === "lst-reth-1")!;
  const pin = {
    number: 100n,
    hash: ("0x" + "cd".repeat(32)) as Hex,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    observedAt: Date.now(),
    endpointId: "synthetic",
    endpointGroup: "SYNTHETIC_FIXTURE",
  };
  const factory = (
    d: ProtocolDeployment,
    wallet: string,
    _pin: unknown,
    signal: AbortSignal,
  ): AdapterContext => {
    void _pin;
    const ctx: AdapterContext = {
      deployment: d,
      wallet,
      pin: { ...pin, observedAt: Date.now() },
      signal,
      evidence: [],
      calls: 0,
      errors: 0,
      batches: 0,
      fallbacks: 0,
      async code() {
        return "0x6000";
      },
      async asset(target, raw, role, metadata) {
        const m = metadata ?? { symbol: "TKN", decimals: 18 };
        return {
          assetId: d.chainId + ":" + target,
          chainId: d.chainId,
          contract: target,
          symbol: m.symbol,
          decimals: m.decimals,
          rawAmount: raw.toString(),
          role,
          valueUsd: usdValue(raw, m.decimals, "1"),
        } as PositionAsset;
      },
      async read(_target, name, args = []) {
        ctx.calls++;
        if (name === "balanceOf") return 2n * WAD;
        if (name === "getEthValue") return ((args[0] as bigint) * 11n) / 10n;
        throw Error("UNEXPECTED_READ");
      },
    };
    return ctx;
  };
  it("held receipt tokens admit candidates; receipt families without a candidate are NOT_CHECKED, never zero", async () => {
    const scan = await scanDefi(
      "0x28136a77ec8ba3d918114712a588b4095ba12a6b",
      new DataPlane(null),
      {
        deploymentIds: [
          "lst-reth-1",
          "curve-1",
          "balancer-v2-1",
          "aerodrome-v2-8453",
        ],
        held: ["1:" + reth.contracts.token, "not-an-asset-id"],
        pinFactory: async () => ({ ...pin, observedAt: Date.now() }),
        readerFactory: factory,
        catalog: null,
        store: {
          async refs() {
            return { refs: [], complete: false };
          },
          async record() {},
        },
      },
    );
    const by = new Map(scan.coverage.map((c) => [c.deploymentId, c]));
    expect(by.get("lst-reth-1")).toMatchObject({
      state: "FULL_POSITION",
      result: "NONZERO",
      signal: "RECEIPT_TOKEN",
    });
    for (const id of ["curve-1", "balancer-v2-1", "aerodrome-v2-8453"])
      expect(by.get(id)).toMatchObject({
        state: "NOT_CHECKED",
        reason: "NO_RECEIPT_CANDIDATE",
      });
    expect(scan.positions).toHaveLength(1);
    expect(scan.positions[0].underlying[0].rawAmount).toBe(
      ((2n * WAD * 11n) / 10n).toString(),
    );
    const receipt = scan.receipt!;
    expect(receipt.catalogVersion).toBeNull();
    expect(receipt.funnel).toMatchObject({
      universeRows: null,
      candidateDeployments: 1,
      adaptersRun: 1,
    });
    expect(receipt.signals.RECEIPT_TOKEN).toBe(1);
    expect(receipt.skipped.map((s) => s.reason)).toEqual([
      "NO_RECEIPT_CANDIDATE",
      "NO_RECEIPT_CANDIDATE",
      "NO_RECEIPT_CANDIDATE",
    ]);
    expect(receipt.nonzero).toBe(1);
    expect(receipt.rpcCalls).toBeGreaterThan(0);
  });
});
