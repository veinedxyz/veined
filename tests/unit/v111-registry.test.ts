// V1.11 chain identity registry + unified asset registry: environment safety, exact identity, levels, ranking,
// impersonation/bidi/oversized metadata, search and the exact-address import preview (fake deps, no network).
import { describe, expect, it } from "vitest";
import {
  crossEnvironment,
  environmentOf,
  monogram,
  shortNameOf,
  type ChainIdentity,
} from "../../src/registry/chain-identity";
import chainFile from "../../src/registry/chain-identities.generated.json";
import clientFile from "../../src/registry/chain-identities.client.json";
import registryFile from "../../src/assets/registry.generated.json";
import pairsFile from "../../src/assets/onebridge-pairs.generated.json";
import {
  assetKey,
  autoSelectable,
  displayText,
  flagImpersonation,
  rankAssets,
  routeEligible,
  sameAsset,
  textRisk,
  type RegistryAsset,
} from "../../src/assets/model";
import {
  knownAsset,
  listAssets,
  marketListing,
  previewImport,
  searchAssets,
  trustWalletFolder,
} from "../../src/assets/registry";
import {
  DEXSCREENER_CHAINS,
  dexEvidence,
  resetDexCacheForTests,
} from "../../src/assets/sources/dexscreener";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validAddress } from "../../src/routing/addresses";

const chains = (chainFile as { chains: ChainIdentity[] }).chains;
const assets = (registryFile as { assets: RegistryAsset[] }).assets;
const USDT_BSC = "0x55d398326f99059ff775485246999027b3197955";
const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("V1.11 chain identity registry", () => {
  it("environment: routing flag decides; names only move away from mainnet; local chains are local; unknown stays unknown", () => {
    expect(
      environmentOf({ id: "1", name: "Ethereum", routingMainnet: true }),
    ).toEqual({
      environment: "mainnet",
      environmentSource: "routing-catalog",
    });
    expect(
      environmentOf({
        id: "11155111",
        name: "Ethereum Sepolia Testnet",
        routingMainnet: false,
      }).environment,
    ).toBe("testnet");
    // a mainnet flag with a testnet-looking name never becomes mainnet
    expect(
      environmentOf({ id: "9", name: "Foo Testnet", routingMainnet: true })
        .environment,
    ).toBe("testnet");
    expect(environmentOf({ id: "31337", name: "Hardhat" }).environment).toBe(
      "local",
    );
    expect(environmentOf({ id: "123", name: "Mystery" })).toEqual({
      environment: "unknown",
      environmentSource: "none",
    });
    expect(environmentOf({ id: "5", name: "Some devnet" }).environment).toBe(
      "devnet",
    );
    expect(
      environmentOf({ id: "77", name: "Chain", tvlPositive: true }).environment,
    ).toBe("mainnet");
    expect(
      environmentOf({
        id: "77",
        name: "Chain",
        tvlPositive: true,
        ethereumListsTestnet: true,
      }).environment,
    ).toBe("testnet");
  });
  it("generated registry: unique ids, no testnet-named mainnet, safe local logos with matching hashes, client map in sync", () => {
    const ids = new Set<string>();
    for (const c of chains) {
      expect(ids.has(c.id), c.id).toBe(false);
      ids.add(c.id);
      if (/test ?net|sepolia|goerli|holesky/i.test(c.name))
        expect(c.environment, c.id).not.toBe("mainnet");
      if (c.logo) {
        expect(c.logo).toMatch(
          /^\/(assets\/chains|networks)\/[A-Za-z0-9_./-]+\.(png|svg|webp)$/,
        );
        expect(existsSync(`public${c.logo}`), c.logo).toBe(true);
        if (c.logoSha256)
          expect(
            createHash("sha256")
              .update(readFileSync(`public${c.logo}`))
              .digest("hex"),
          ).toBe(c.logoSha256);
      } else expect(c.logoSource).toBe("monogram");
    }
    expect(chains.find((c) => c.id === "612055")?.logoSource).toBe("official");
    expect(chains.find((c) => c.id === "56")?.logoSource).toBe("official");
    const client = clientFile as unknown as Record<
      string,
      [string, string, string, string]
    >;
    expect(Object.keys(client).sort()).toEqual([...ids].sort());
    for (const c of chains) expect(client[c.id][0]).toBe(c.environment);
    // no remote URL can reach the browser through the client map
    expect(JSON.stringify(Object.values(client).map((c) => c[1]))).not.toMatch(
      /https?:/,
    );
  });
  it("mainnet ⇄ testnet is a cross-environment route; unknown is never compatible", () => {
    expect(crossEnvironment("mainnet", "mainnet")).toBe(false);
    expect(crossEnvironment("mainnet", "testnet")).toBe(true);
    expect(crossEnvironment("unknown", "unknown")).toBe(true);
    expect(crossEnvironment(undefined, "mainnet")).toBe(true);
  });
  it("display helpers", () => {
    expect(shortNameOf("OP Mainnet")).toBe("OP");
    expect(shortNameOf("BNB Smart Chain")).toBe("BNB");
    // Never cut mid-word.
    expect(shortNameOf("Base Sepolia Testnet")).toBe("Base Sepolia");
    expect(shortNameOf("Supercalifragilisticexpialidocious")).toBe(
      "Supercalifragil…",
    );
    expect(monogram("Arbitrum One")).toBe("AO");
    expect(monogram("")).toBe("?");
  });
});

describe("V1.11 asset identity and levels", () => {
  it("identity is chain + exact contract (EVM case-insensitive); native is explicit; symbol never identifies", () => {
    expect(assetKey("1", USDC_ETH.toUpperCase().replace("0X", "0x"))).toBe(
      `1:${USDC_ETH}`,
    );
    expect(
      assetKey("1", "0x0000000000000000000000000000000000000000", true),
    ).toBe("1:native");
    expect(
      sameAsset(
        { chainId: "1", address: USDC_ETH },
        { chainId: "56", address: USDC_ETH },
      ),
    ).toBe(false);
    expect(
      sameAsset(
        { chainId: "1", address: USDC_ETH },
        { chainId: "1", address: USDC_ETH.toUpperCase().replace("0X", "0x") },
      ),
    ).toBe(true);
  });
  it("registry: unique exact identities, valid addresses, curated never carries a risk flag, logos are local", () => {
    const keys = new Set<string>();
    for (const a of assets) {
      const k = assetKey(a.chainId, a.address, a.native);
      expect(keys.has(k), k).toBe(false);
      keys.add(k);
      if (!a.native) {
        if (a.chainId === "1151111081099710") {
          expect(validAddress("SVM", a.address), k).toBe(true);
          expect(a.routable, k).toBe(false);
        } else expect(a.address).toMatch(/^0x[0-9a-f]{40}$/);
      }
      if (a.level === "CURATED") expect(a.risk, k).toEqual([]);
      if (a.logo) expect(a.logo.src).toMatch(/^\/(assets|networks)\//);
    }
    // no two curated/canonical tokens share a symbol on one chain (collisions were demoted or excluded)
    const seen = new Map<string, string>();
    for (const a of assets.filter(
      (x) => x.level === "CURATED" || x.level === "CANONICAL",
    )) {
      const k = `${a.chainId}|${a.symbol.toUpperCase()}`;
      expect(seen.has(k), `${k} ${a.address} vs ${seen.get(k)}`).toBe(false);
      seen.set(k, a.address);
    }
  });
  it("text risk flags bidi/invisible, mixed-script homoglyphs, oversized and link-like metadata; display text strips controls", () => {
    expect(textRisk("USD‮C", "x")).toContain("BIDI_OR_INVISIBLE");
    expect(textRisk("UЅDC", "Cyrillic S")).toContain("MIXED_SCRIPT");
    expect(textRisk("A".repeat(40), "x")).toContain("LONG_TEXT");
    expect(textRisk("FREE", "claim at www.evil.xyz")).toContain("URL_IN_TEXT");
    expect(textRisk("USDC", "USD Coin")).toEqual([]);
    expect(displayText("US​DC‮", 32)).toBe("USDC");
    expect(displayText("x".repeat(500), 120)).toHaveLength(120);
  });
  it("same symbol, different contract → impersonation flag; never auto-selectable; route needs route support", () => {
    const base: RegistryAsset = {
      chainId: "1",
      address: USDC_ETH,
      native: false,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      level: "CURATED",
      sources: ["otherbridge-curated"],
      logo: null,
      risk: [],
      routable: true,
    };
    const fake: RegistryAsset = {
      ...base,
      address: "0x" + "9".repeat(40),
      level: "DEX_DISCOVERED",
      sources: ["dexscreener"],
    };
    const otherChain: RegistryAsset = {
      ...base,
      chainId: "56",
      address: "0x" + "8".repeat(40),
      level: "MARKET_LISTED",
    };
    const [, flagged, unflagged] = flagImpersonation([base, fake, otherChain]);
    expect(flagged.risk).toContain("SYMBOL_IMPERSONATION");
    expect(unflagged.risk).toEqual([]); // a different chain is a different identity space
    expect(autoSelectable(base)).toBe(true);
    expect(autoSelectable(flagged)).toBe(false);
    expect(autoSelectable({ ...base, level: "MARKET_LISTED" })).toBe(false);
    expect(
      routeEligible({ ...base, level: "IMPORTED_UNVERIFIED", routable: false }),
    ).toBe(false);
    expect(routeEligible({ ...base, level: "BLOCKED", routable: true })).toBe(
      false,
    );
  });
  it("ranking: wallet-held routable → native canonical → curated → market listed → recent/imported → DEX discovered", () => {
    const mk = (symbol: string, level: RegistryAsset["level"], extra = {}) =>
      ({
        chainId: "1",
        address: "0x" + symbol.charCodeAt(0).toString(16).padStart(40, "0"),
        native: false,
        symbol,
        name: symbol,
        decimals: 18,
        level,
        sources: [],
        logo: null,
        risk: [],
        routable: true,
        ...extra,
      }) as RegistryAsset & { held?: boolean; recent?: boolean };
    const ranked = rankAssets([
      mk("D", "DEX_DISCOVERED"),
      mk("I", "IMPORTED_UNVERIFIED"),
      mk("M", "MARKET_LISTED"),
      mk("C", "CURATED"),
      mk("N", "CANONICAL", { native: true }),
      mk("H", "MARKET_LISTED", { held: true }),
      mk("B", "BLOCKED", { held: true }),
    ]);
    expect(ranked.map((a) => a.symbol)).toEqual([
      "H",
      "N",
      "C",
      "M",
      "I",
      "D",
      "B",
    ]);
  });
});

describe("V1.11 registry service (server)", () => {
  const route = [
    { address: USDC_ETH, decimals: 6, symbol: "USDC", name: "USD Coin" },
    {
      address: "0x" + "1".repeat(40),
      decimals: 18,
      symbol: "USDC",
      name: "Fake USD Coin",
    },
  ];
  it("default list is canonical + curated (+ registry market listed), never the raw route list; route status from the route list", () => {
    const list = listAssets("1", route);
    expect(list.length).toBeGreaterThan(50);
    expect(
      list.every((a) =>
        ["CANONICAL", "CURATED", "MARKET_LISTED"].includes(a.level),
      ),
    ).toBe(true);
    expect(list.some((a) => a.address === "0x" + "1".repeat(40))).toBe(false);
    expect(list.find((a) => a.address === USDC_ETH)?.routeStatus).toBe(
      "ROUTABLE",
    );
    // unknown route list => never shown as routable
    expect(
      listAssets("1", null).find((a) => a.address === USDC_ETH)?.routeStatus,
    ).toBe("UNKNOWN");
  });
  it("symbol search returns curated first and never an unlisted route token; exact address resolves only that identity", () => {
    const r = searchAssets("1", "usdc", route);
    expect(r.results[0].address).toBe(USDC_ETH);
    expect(r.results.some((a) => a.address === "0x" + "1".repeat(40))).toBe(
      false,
    );
    const exact = searchAssets("1", "0x" + "1".repeat(40), route);
    expect(exact).toEqual({ results: [], lookup: true });
    // the same contract on another chain is not the Ethereum token
    expect(knownAsset("56", USDC_ETH)).toBeNull();
    expect(marketListing("1", USDC_ETH)?.id).toBe("usd-coin");
  });
  it("ONEbridge registered pair tokens are canonical; only the G5-verified pair has a verified route", () => {
    const pairs = (
      pairsFile as {
        pairs: {
          g5Verified: boolean;
          status: string;
          remote: { address: string };
        }[];
      }
    ).pairs;
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs.filter((p) => p.g5Verified).map((p) => p.status)).toEqual([
      "VERIFIED_ROUTE",
    ]);
    expect(
      pairs
        .filter((p) => !p.g5Verified)
        .every((p) => p.status === "REGISTERED_NOT_VERIFIED"),
    ).toBe(true);
    expect(knownAsset("56", USDT_BSC)?.level).toBe("CANONICAL");
    expect(trustWalletFolder("56")).toBe("smartchain");
    expect(trustWalletFolder("999999")).toBeNull();
  });
  const deps = (over: Partial<Parameters<typeof previewImport>[3]> = {}) => ({
    code: async () => "0x6080604052",
    metadata: async () => ({ decimals: 18, symbol: "NEW", name: "New Token" }),
    dex: async () => null,
    logo: async () => null,
    twFolder: () => null,
    ...over,
  });
  it("import preview: invalid address / no code / not ERC-20 are not importable", async () => {
    expect((await previewImport("1", "0x123", route, deps())).importable).toBe(
      false,
    );
    const noCode = await previewImport(
      "1",
      "0x" + "2".repeat(40),
      route,
      deps({ code: async () => "0x" }),
    );
    expect(noCode.importable).toBe(false);
    expect(noCode.warnings).toContain("NO_CODE");
    const notErc20 = await previewImport(
      "1",
      "0x" + "2".repeat(40),
      route,
      deps({
        metadata: async () => ({ decimals: null, symbol: "", name: "" }),
      }),
    );
    expect(notErc20.steps.find((s) => s.step === "metadata")?.detail).toBe(
      "NOT_AN_ERC20_TOKEN",
    );
  });
  it("import preview: unknown token defaults to IMPORTED_UNVERIFIED, no route => not routable, no market evidence flagged", async () => {
    const r = await previewImport("1", "0x" + "3".repeat(40), route, deps());
    expect(r.importable).toBe(true);
    expect(r.asset?.level).toBe("IMPORTED_UNVERIFIED");
    expect(r.asset?.routeStatus).toBe("NO_VERIFIED_ROUTE");
    expect(r.asset?.routable).toBe(false);
    expect(r.warnings).toContain("NO_MARKET_EVIDENCE");
    expect(r.steps.map((s) => s.step)).toEqual([
      "address",
      "code",
      "metadata",
      "curated",
      "market",
      "dex",
      "logo",
      "route",
    ]);
  });
  it("import preview: symbol collision with a curated token and hostile metadata are flagged; bidi/homoglyph is BLOCKED", async () => {
    const imp = await previewImport(
      "1",
      "0x" + "1".repeat(40),
      route,
      deps({
        metadata: async () => ({
          decimals: 6,
          symbol: "USDC",
          name: "USD Coin",
        }),
      }),
    );
    expect(imp.warnings).toContain("SYMBOL_IMPERSONATION");
    expect(imp.asset?.level).toBe("IMPORTED_UNVERIFIED");
    expect(imp.asset?.routeStatus).toBe("ROUTABLE"); // route support is about the exact address, never the symbol
    const bidi = await previewImport(
      "1",
      "0x" + "4".repeat(40),
      route,
      deps({
        metadata: async () => ({ decimals: 6, symbol: "USD‮C", name: "x" }),
      }),
    );
    expect(bidi.asset?.level).toBe("BLOCKED");
    expect(bidi.importable).toBe(false);
    const huge = await previewImport(
      "1",
      "0x" + "5".repeat(40),
      route,
      deps({
        metadata: async () => ({
          decimals: 18,
          symbol: "X".repeat(300),
          name: "N".repeat(5000),
        }),
      }),
    );
    expect(huge.asset?.symbol.length).toBeLessThanOrEqual(32);
    expect(huge.asset?.name.length).toBeLessThanOrEqual(120);
    expect(huge.warnings).toContain("LONG_TEXT");
  });
  it("import preview: a curated token keeps its level; decimals mismatch is flagged", async () => {
    const r = await previewImport(
      "1",
      USDC_ETH,
      route,
      deps({
        metadata: async () => ({
          decimals: 18,
          symbol: "USDC",
          name: "USD Coin",
        }),
      }),
    );
    expect(r.asset?.level).toBe("CURATED");
    expect(r.warnings).toContain("METADATA_MISMATCH");
  });
});

describe("V1.11 DEXScreener evidence (exact chain + exact token only)", () => {
  it("pairs on another chain or with another base token are not evidence; listing is never 'verified'", async () => {
    resetDexCacheForTests();
    const a = "0x" + "6".repeat(40);
    const fetcher = (async () => ({
      status: 200,
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify([
          {
            chainId: "bsc",
            baseToken: { address: a, symbol: "X" },
            liquidity: { usd: 9e9 },
          },
          {
            chainId: "ethereum",
            baseToken: { address: "0x" + "7".repeat(40), symbol: "X" },
            liquidity: { usd: 9e9 },
          },
          {
            chainId: "ethereum",
            baseToken: {
              address: a.toUpperCase().replace("0X", "0x"),
              symbol: "X",
              name: "X",
            },
            liquidity: { usd: 1234 },
            priceUsd: "0.5",
            info: { imageUrl: "https://dd.dexscreener.com/x.png" },
          },
        ]),
      ),
      finalUrl: "",
      redirects: [],
      address: "",
    })) as never;
    const e = await dexEvidence("1", a, undefined, fetcher);
    expect(e).toMatchObject({
      pairs: 1,
      liquidityUsd: 1234,
      priceUsd: "0.5",
      source: "dexscreener",
    });
    expect(await dexEvidence("999999", a, undefined, fetcher)).toBeNull(); // no slug => no lookup
    expect(DEXSCREENER_CHAINS["56"]).toBe("bsc");
  });
});
