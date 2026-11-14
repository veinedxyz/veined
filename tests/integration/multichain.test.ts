import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  RoutingCore,
  upstreamRead,
  type ReadTransport,
} from "../../src/adapters/routing-core";
import { GET, POST } from "../../src/app/api/routing/route";
import {
  fixtureCatalog,
  fixtureInput,
  fixtureQuote,
} from "../fixtures/routing";
import snapshot from "../../src/routing/catalog-snapshot.json" with { type: "json" };
import { RoutingError } from "../../src/routing/model";
const transport =
  (quote: unknown): ReadTransport =>
  async (path) =>
    path === "chains"
      ? snapshot.chains
      : path === "tools"
        ? snapshot.tools
        : path === "quote"
          ? quote
          : path === "tokens"
            ? {
                tokens: {
                  "1": [fixtureQuote().action.fromToken],
                  "8453": [fixtureQuote().action.toToken],
                },
              }
            : { connections: [] };
describe("M3 provider adapter deterministic integration (not live execution)", () => {
  it("dynamic provider display labels are neutral while route keys, fees and read-only gates survive", async () => {
    const input = fixtureInput();
    const raw = fixtureQuote(input);
    const tools = structuredClone(snapshot.tools);
    tools.bridges.find((t) => t.key === raw.tool)!.name = "LI.FI Intents";
    raw.estimate.feeCosts[0].name = "LIFI Fixed Fee";
    const provider = new RoutingCore(async (path, params) =>
      path === "tools" ? tools : transport(raw)(path, params),
    );
    const catalog = await provider.listNetworks();
    input.generation = catalog.generation;
    const [quote] = await provider.getQuotes(input);
    expect(catalog.networks).toHaveLength(77);
    expect(catalog.tools.find((t) => t.id === raw.tool)?.name).toBe(
      "Intent routing",
    );
    expect(quote.steps[0].tool).toBe(raw.tool);
    expect(quote.steps[0].toolName).toBe("Intent routing");
    expect(quote.fees[0]).toMatchObject({
      name: "Route service fee",
      amount: "100",
      usd: "0.05",
      included: true,
      asset: { chainId: "1", address: raw.action.fromToken.address },
    });
    expect(quote.executable).toBe(false);
    expect(quote.requirements.reason).toBe("WRITE_DISABLED");
  });
  it.each([
    ["eth", "bas"],
    ["eth", "sol"],
    ["sol", "eth"],
    ["eth", "btc"],
    ["eth", "sui"],
    ["eth", "trn"],
    ["eth", "xlm"],
  ])(
    "normalizes %s → %s with native addresses and no write payload",
    async (source, destination) => {
      const input = fixtureInput(source, destination),
        provider = new RoutingCore(transport(fixtureQuote(input)));
      const catalog = await provider.listNetworks();
      input.generation = catalog.generation;
      const raw = fixtureQuote(input);
      const p = new RoutingCore(transport(raw));
      const c = await p.listNetworks();
      input.generation = c.generation;
      const quotes = await p.getQuotes(input);
      expect(quotes[0].executable).toBe(false);
      expect(quotes[0].input.destinationAddress).toBe(input.destinationAddress);
      expect(JSON.stringify(quotes)).not.toContain("DEADBEEF");
    },
  );
  it.each(["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT"])(
    "upstream %s falls back to stale display catalog and blocks quotes",
    async (code) => {
      const p = new RoutingCore(async () => {
        throw new RoutingError(code);
      });
      const c = await p.listNetworks();
      expect(c.stale).toBe(true);
      expect(c.networks).toHaveLength(fixtureCatalog().networks.length);
      const i = { ...fixtureInput(), generation: c.generation };
      await expect(p.getQuotes(i)).rejects.toThrow("STALE_CATALOG");
    },
  );
  it("connection exists but quote has no liquidity, without fabricated fallback", async () => {
    const p = new RoutingCore(async (path) =>
      path === "chains"
        ? snapshot.chains
        : path === "tools"
          ? snapshot.tools
          : path === "tokens"
            ? {
                tokens: {
                  "1": [fixtureQuote().action.fromToken],
                  "8453": [fixtureQuote().action.toToken],
                },
              }
            : path === "connections"
              ? {
                  connections: [
                    {
                      fromChainId: "1",
                      toChainId: "8453",
                      fromTokens: [],
                      toTokens: [],
                    },
                  ],
                }
              : (() => {
                  throw new RoutingError("NO_EXECUTABLE_ROUTE");
                })(),
    );
    const c = await p.listNetworks();
    expect(await p.getConnections("1", "8453")).toHaveLength(1);
    await expect(
      p.getQuotes({ ...fixtureInput(), generation: c.generation }),
    ).rejects.toThrow("NO_EXECUTABLE_ROUTE");
  });
  it("malformed live catalog cannot poison fresh cache", async () => {
    const p = new RoutingCore(async () => ({ chains: [{ id: "bogus" }] }));
    expect((await p.listNetworks()).stale).toBe(true);
  });
  it("concurrent catalog reads coalesce and refresh invalidates generation", async () => {
    let calls = 0;
    const p = new RoutingCore(async (path, params) => {
      calls++;
      return transport(null)(path, params);
    });
    const [a, b] = await Promise.all([p.listNetworks(), p.listNetworks()]);
    expect(a).toBe(b);
    expect(calls).toBe(2);
    await new Promise((r) => setTimeout(r, 2));
    const fresh = await p.listNetworks(undefined, true);
    expect(fresh.generation).not.toBe(a.generation);
  });
  it("request binding cannot use EVM address on a non-EVM destination", async () => {
    const p = new RoutingCore(transport(null)),
      c = await p.listNetworks(),
      i = {
        ...fixtureInput("eth", "sol"),
        generation: c.generation,
        destinationAddress: fixtureInput().destinationAddress,
      };
    await expect(p.getQuotes(i)).rejects.toThrow("INVALID_ADDRESS");
  });
  it("ONE custom and reverse are isolated from routing-core", async () => {
    const p = new RoutingCore(transport(null));
    await expect(p.getConnections("612055", "56")).rejects.toThrow(
      "CUSTOM_ROUTE_NOT_EXECUTABLE_G5",
    );
    await expect(p.getConnections("56", "612055")).rejects.toThrow(
      "CUSTOM_ROUTE_NOT_EXECUTABLE_G5",
    );
  });
  it("cannot proxy arbitrary URLs, execution, RPC methods or credentials", async () => {
    await expect(upstreamRead("https://127.0.0.1", {})).rejects.toThrow(
      "READ_PATH_REJECTED",
    );
  });
});
describe("M6 same-origin server boundary and immutable execution gate", () => {
  const request = (body: unknown, origin = "http://127.0.0.1:3100") =>
    new NextRequest("http://127.0.0.1:3100/api/routing", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3100",
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  it("hostile origins are rejected before upstream traffic", async () =>
    expect(
      (await POST(request({ action: "catalog" }, "https://attacker.test")))
        .status,
    ).toBe(403));
  it.each([
    { action: "execute" },
    { action: "approve" },
    { action: "catalog", url: "http://169.254.169.254" },
    { action: "quote", input: { amount: "1", privateKey: "x" } },
  ])("strict API rejects unauthorized action/body %#", async (body) =>
    expect((await POST(request(body))).status).toBe(422),
  );
  it("production configuration cannot expose a signer via environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION", "true");
    const config = await GET().json();
    expect(config.execution.enabled).toBe(false);
    expect(config.execution.sign).toBeNull();
    vi.unstubAllEnvs();
  });
});
