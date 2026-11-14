import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { scanPortfolio } from "../../src/portfolio/service";
// V1.4: the retired paid adapter survives only as a deprecated test-only compatibility fixture.
import { IndexerPortfolioProvider } from "../fixtures/legacy-indexer-provider";
import type { PortfolioProvider } from "../../src/portfolio/model";
import { fixtureCatalog, sender } from "../fixtures/routing";
import { holding } from "../fixtures/portfolio";
import { POST as portfolioPost } from "../../src/app/api/portfolio/route";
import { POST as catalogPost } from "../../src/app/api/catalog/route";
describe("V13 portfolio integration", () => {
  it("activity discovery, bounded concurrency and 20+ asset networks", async () => {
    const catalog = fixtureCatalog(),
      networks = catalog.networks
        .filter((n) => n.mainnet && n.ecosystem === "EVM")
        .slice(0, 24);
    let concurrent = 0,
      max = 0;
    const provider: PortfolioProvider = {
      capabilities: () => ({
        ecosystems: ["EVM"],
        native: true,
        fungible: true,
        discovery: true,
      }),
      discoverActivity: async () => networks.map((n) => n.id),
      getNativeBalance: async () => [],
      getBalances: async (n) => {
        concurrent++;
        max = Math.max(max, concurrent);
        await new Promise((r) => setTimeout(r, 2));
        concurrent--;
        return [holding(n.id)];
      },
    };
    const result = await scanPortfolio({ evm: sender }, catalog, undefined, [
      provider,
    ]);
    expect(result.state).toBe("COMPLETE");
    expect(result.holdings.length).toBeGreaterThanOrEqual(20);
    expect(max).toBeLessThanOrEqual(3);
    expect(result.coverage.every((c) => c.state === "COMPLETE")).toBe(true);
  });
  it("one timeout retains successful balances, unavailable legacy provider falls back truthfully", async () => {
    const catalog = fixtureCatalog(),
      provider: PortfolioProvider = {
        capabilities: () => ({
          ecosystems: ["EVM"],
          native: true,
          fungible: false,
          discovery: true,
        }),
        discoverActivity: async () => ["1", "8453"],
        getNativeBalance: async () => [],
        getBalances: async (n) => {
          if (n.id === "8453") throw Error("PROVIDER_TIMEOUT");
          return [holding("1")];
        },
      };
    const result = await scanPortfolio({ evm: sender }, catalog, undefined, [
      new IndexerPortfolioProvider(undefined),
      provider,
    ]);
    expect(result.state).toBe("PARTIAL");
    expect(result.holdings[0].chainId).toBe("1");
    expect(result.coverage.find((c) => c.chainId === "8453")?.state).toBe(
      "FAILED",
    );
    // V1.4: no credential-blocked state exists; the native fallback is reported as NATIVE_ONLY.
    expect(result.coverage.find((c) => c.chainId === "1")?.state).toBe(
      "NATIVE_ONLY",
    );
    expect(JSON.stringify(result)).not.toMatch(/CREDENTIAL/);
    expect(
      (
        await scanPortfolio(
          { evm: sender },
          { ...catalog, stale: true },
          undefined,
          [provider],
        )
      ).state,
    ).toBe("STALE");
  });
  it("indexer binding and native/fungible normalization with receipt tokens not decoded", async () => {
    const n = fixtureCatalog().networks.find((n) => n.id === "1")!,
      at = new Date().toISOString();
    const provider = new IndexerPortfolioProvider(
      "SYNTHETIC_TEST_KEY",
      async (url) =>
        url.includes("activity")
          ? {
              error: false,
              data: { address: sender, items: [{ chain_id: 1 }] },
            }
          : {
              error: false,
              data: {
                address: sender,
                chain_id: 1,
                updated_at: at,
                items: [
                  {
                    contract_address: sender,
                    contract_decimals: 18,
                    contract_name: "Receipt token",
                    contract_ticker_symbol: "LP",
                    balance: "999999999999999999999999999",
                    is_native_token: false,
                    is_spam: false,
                    quote: 0,
                    type: "cryptocurrency",
                  },
                ],
              },
            },
    );
    expect(await provider.discoverActivity({ evm: sender })).toEqual(["1"]);
    const rows = await provider.getBalances(n, { evm: sender });
    expect(rows[0].symbol).toBe("LP");
    expect(rows[0].balance).toBe("999999999999999999999999999");
    expect(rows[0].usd).toBe(0);
    expect(rows[0].logo).toBe("/networks/neutral.svg");
    const poisoned = new IndexerPortfolioProvider(
      "SYNTHETIC_TEST_KEY",
      async () => ({
        error: false,
        data: { address: `0x${"4".repeat(40)}`, items: [] },
      }),
    );
    await expect(poisoned.discoverActivity({ evm: sender })).rejects.toThrow(
      "ADDRESS_MISMATCH",
    );
  });
  it.each(["sign", "approve", "permit", "broadcast", "deploy", "execute"])(
    "server rejects %s without live calls",
    async (action) => {
      const req = () =>
        new NextRequest("http://127.0.0.1:3100/api/portfolio", {
          method: "POST",
          headers: {
            host: "127.0.0.1:3100",
            origin: "http://127.0.0.1:3100",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action }),
        });
      expect((await portfolioPost(req())).status).toBe(422);
      expect((await catalogPost(req())).status).toBe(422);
    },
  );
  it("consent absent and prototype pollution payload fail schema", async () => {
    const req = new NextRequest("http://127.0.0.1:3100/api/portfolio", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3100",
        origin: "http://127.0.0.1:3100",
        "content-type": "application/json",
      },
      body:
        '{"identity":{"evm":"' +
        sender +
        '","__proto__":{"isAdmin":true}},"consent":true}',
    });
    const result = await portfolioPost(req);
    expect(result.status).toBe(422);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });
});
