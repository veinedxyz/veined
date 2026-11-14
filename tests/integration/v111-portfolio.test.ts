// V1.11 portfolio discovery: curated balance sweep through a code-hash-verified Multicall3 (no datastore / index),
// native-only without verification, bounded imported contracts, connected-chain priority and coverage classes.
// Synthetic chains only (tests/fixtures/fake-chain.ts); the Multicall3 runtime code is the real verified bytecode.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FakeChain, fakeNetwork } from "../fixtures/fake-chain";
import { DataPlane } from "../../src/data/plane";
import { buildRegistry } from "../../src/data/registry/chains";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import {
  SelfHostedPortfolioProvider,
  curatedUniverse,
} from "../../src/data/portfolio/provider";
import { scanPortfolio } from "../../src/portfolio/service";
import { portfolioSchema, type ChainCoverage } from "../../src/portfolio/model";
import { coverageClass } from "../../src/components/portfolio";
import { initialBsc } from "../../src/routing/custom";
import type { Catalog } from "../../src/routing/model";
import type { ApprovedEndpoint } from "../../src/data/rpc/pool";

const wallet = "0x" + "a1".repeat(20);
const USDT_BSC = "0x55d398326f99059ff775485246999027b3197955";
const NOT_CURATED = "0x" + "c3".repeat(20);
const IMPORTED = "0x" + "d4".repeat(20);
const MC3_CODE = readFileSync(
  "tests/fixtures/multicall3-runtime.hex",
  "utf8",
).trim();
class VerifiedMulticallChain extends FakeChain {
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
function setup(verified: boolean) {
  const net = fakeNetwork();
  const chain = verified
    ? new VerifiedMulticallChain("56", "bsc")
    : new FakeChain("56", "bsc");
  chain.mine(30);
  chain.native.set(wallet, 3n * 10n ** 18n);
  for (const [token, symbol, value] of [
    [USDT_BSC, "USDT", 125n * 10n ** 18n],
    [NOT_CURATED, "NOPE", 7n],
    [IMPORTED, "IMP", 9n * 10n ** 18n],
  ] as const) {
    chain.metadata.set(token, { symbol, name: symbol, decimals: 18 });
    chain.balances.set(`${token}|${wallet}`, value);
  }
  net.chains.set("56", chain);
  // No datastore: the committed fallback registry (chain 56 + one synthetic vetted endpoint), no multicall entry.
  const plane = new DataPlane(null, net.transport, 0, () => ({
    chains: buildRegistry([initialBsc], []),
    routing: [initialBsc],
    endpoints: [endpoint],
    multicall: {},
  }));
  const catalog: Catalog = {
    networks: [initialBsc],
    tools: [],
    generation: "t",
    observedAt: Date.now(),
    stale: false,
  };
  return { plane, catalog, net };
}

describe("V1.11 curated balance scan", () => {
  it("the curated registry for BSC holds exact contracts only (no symbol matching)", () => {
    const u = curatedUniverse("56");
    expect(u.length).toBeGreaterThan(10);
    expect(
      u.every((a) => /^0x[0-9a-f]{40}$/.test(a.address) && !a.native),
    ).toBe(true);
    expect(u.some((a) => a.address === USDT_BSC)).toBe(true);
  });
  it("no index, no token universe, verified Multicall3 → CURATED_BALANCE_SCAN with exact balanceOf; uncurated tokens are not swept", async () => {
    const { plane, catalog } = setup(true);
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      new SelfHostedPortfolioProvider(plane, catalog),
    ]);
    portfolioSchema.parse(result);
    const c = result.coverage.find((x) => x.chainId === "56")!;
    expect(c).toMatchObject({
      tier: "CURATED_BALANCE_SCAN",
      tokens: "CURATED",
      native: "CHECKED",
    });
    expect(c.state).not.toBe("COMPLETE"); // a curated sweep is never "complete"
    expect(coverageClass(c)).toBe("CURATED_BALANCE_SCAN");
    const usdt = result.holdings.find((h) => h.address === USDT_BSC);
    expect(usdt).toMatchObject({
      discovery: "curated",
      balance: (125n * 10n ** 18n).toString(),
      routable: true,
    });
    expect(usdt?.logo).toMatch(
      /^\/(networks\/neutral\.svg|assets\/tokens\/56\/0x[0-9a-f]{40}-[0-9a-f]{16}\.png)$/,
    );
    expect(result.holdings.some((h) => h.address === NOT_CURATED)).toBe(false);
    expect(result.holdings.find((h) => h.native)?.balance).toBe(
      (3n * 10n ** 18n).toString(),
    );
  });
  it("without a code-hash-verified Multicall3 the chain stays native only (no arbitrary call target)", async () => {
    const { plane, catalog } = setup(false);
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      new SelfHostedPortfolioProvider(plane, catalog),
    ]);
    const c = result.coverage.find((x) => x.chainId === "56")!;
    expect(c).toMatchObject({ tier: "NATIVE_ONLY", tokens: "NOT_CHECKED" });
    expect(result.holdings.filter((h) => !h.native)).toEqual([]);
  });
  it("imported exact contracts are included (bounded, deduplicated), labelled imported and never routable", async () => {
    const { plane, catalog } = setup(true);
    const extra = new Map([
      [
        "56",
        [
          IMPORTED,
          IMPORTED,
          ...Array.from(
            { length: 60 },
            (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"),
          ),
        ],
      ],
    ]);
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      new SelfHostedPortfolioProvider(plane, catalog, null, undefined, extra),
    ]);
    const imp = result.holdings.filter((h) => h.address === IMPORTED);
    expect(imp).toHaveLength(1);
    expect(imp[0]).toMatchObject({ discovery: "imported", routable: false });
  });
  it("the connected wallet's chain is scanned first", async () => {
    const { plane, catalog } = setup(true);
    let planned: string[] = [];
    await scanPortfolio(
      { evm: wallet },
      catalog,
      undefined,
      [new SelfHostedPortfolioProvider(plane, catalog)],
      {
        priority: ["56"],
        onRun: (r) => (planned = r.planned),
      },
    );
    expect(planned[0]).toBe("56");
  });
  it("coverage classes map every state truthfully (pending/failed/catalog never look checked)", () => {
    const base: ChainCoverage = {
      chainId: "1",
      state: "PARTIAL",
      tier: "ON_DEMAND_FUNGIBLE",
      native: "CHECKED",
      tokens: "KNOWN_TOKENS",
      historicalComplete: false,
      indexedFromBlock: null,
      indexedThroughBlock: null,
      headBlock: null,
      observedBlock: null,
      reason: "NONE",
      observedAt: 1,
    };
    expect(coverageClass(base)).toBe("ON_DEMAND");
    expect(
      coverageClass({ ...base, tier: "FULL_INDEXED", tokens: "INDEXED" }),
    ).toBe("FULL_INDEXED");
    // An index still catching up reads known tokens: never labelled "Full index".
    expect(
      coverageClass({ ...base, tier: "FULL_INDEXED", state: "INDEXING" }),
    ).toBe("ON_DEMAND");
    expect(
      coverageClass({
        ...base,
        tier: "CURATED_BALANCE_SCAN",
        tokens: "CURATED",
      }),
    ).toBe("CURATED_BALANCE_SCAN");
    // Failed or unchecked token reads leave native only.
    expect(coverageClass({ ...base, tokens: "FAILED" })).toBe("NATIVE_ONLY");
    expect(
      coverageClass({
        ...base,
        tier: "NATIVE_ONLY",
        state: "NATIVE_ONLY",
        tokens: "NOT_CHECKED",
      }),
    ).toBe("NATIVE_ONLY");
    expect(coverageClass({ ...base, state: "PENDING" })).toBe("PENDING");
    expect(coverageClass({ ...base, state: "FAILED" })).toBe("FAILED");
    expect(
      coverageClass({ ...base, state: "CATALOG_ONLY", tier: "CATALOG_ONLY" }),
    ).toBe("CATALOG_ONLY");
  });
});
