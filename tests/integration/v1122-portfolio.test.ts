import { describe, it, expect } from "vitest";
import { DataPlane } from "../../src/data/plane";
import { buildRegistry } from "../../src/data/registry/chains";
import { SelfHostedPortfolioProvider } from "../../src/data/portfolio/provider";
import { positionContracts } from "../../src/portfolio/positions";
import { scanPortfolio } from "../../src/portfolio/service";
import { portfolioSchema } from "../../src/portfolio/model";
import { FakeChain, fakeNetwork } from "../fixtures/fake-chain";
import { fixtureCatalog } from "../fixtures/routing";
import type { ApprovedEndpoint } from "../../src/data/rpc/pool";
const wallet = "0x" + "a1".repeat(20);
describe("V1122 receipt/debt scan through the unchanged read-only transport", () => {
  it("discovers staking, lending, borrowing and vault shares without a datastore or verified Multicall", async () => {
    const catalog = fixtureCatalog();
    const chain = catalog.networks.find((n) => n.id === "1")!;
    const net = fakeNetwork(),
      evm = new FakeChain("1", "eth");
    evm.mine(30);
    evm.native.set(wallet, 10n ** 18n);
    net.chains.set("1", evm);
    const receipts = positionContracts.filter((p) => p.chainId === "1");
    for (const p of receipts)
      evm.balances.set(`${p.address}|${wallet}`, 10n ** BigInt(p.decimals));
    const endpoint: ApprovedEndpoint = {
      id: "1:synthetic",
      chainId: "1",
      url: "https://rpc-eth.synthetic.test",
      priority: 1,
      supportsLogs: false,
      maxLogRange: 0,
      supportsBatch: true,
      supportsFinalized: true,
      supportsSafe: false,
      archive: false,
    };
    const calls: { method: string; params: unknown[] }[] = [];
    const transport: typeof net.transport = async (e, body, options) => {
      calls.push(...((Array.isArray(body) ? body : [body]) as typeof calls));
      return net.transport(e, body, options);
    };
    const plane = new DataPlane(null, transport, 0, () => ({
      chains: buildRegistry([chain], []),
      routing: [chain],
      endpoints: [endpoint],
      multicall: {},
    }));
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      new SelfHostedPortfolioProvider(plane, catalog),
    ]);
    portfolioSchema.parse(result);
    const found = result.holdings.filter((h) => h.position);
    expect(found.length).toBe(receipts.length);
    expect(new Set(found.map((h) => h.position?.category))).toEqual(
      new Set(["staking", "lending", "borrowing", "vault"]),
    );
    expect(found.every((h) => h.usd === null && !h.spam)).toBe(true);
    expect(
      result.defiCoverage
        ?.filter((c) => c.chainId === "1")
        .every((c) => c.state === "CHECKED"),
    ).toBe(true);
    expect(
      result.defiCoverage
        ?.filter((c) => c.chainId !== "1")
        .every((c) => c.state === "NOT_CHECKED"),
    ).toBe(true);
    expect(
      calls.every((c) => !/^eth_send|sign|approve|permit/i.test(c.method)),
    ).toBe(true);
    for (const call of calls.filter((c) => c.method === "eth_call"))
      expect(String((call.params[0] as { data: string }).data)).toMatch(
        /^0x(70a08231|313ce567|95d89b41|06fdde03)/,
      );
  });
});
