// G12 H01: F1 (Circle's native USDC on Base, Arbitrum, OP Mainnet and Polygon) through the accepted issuer-review rule,
// and the three kinds of coverage the Portfolio shows. Local data only (registry, generated sources, a SYNTHETIC
// fixture with the shape of the owner's public test-address scan); no network, nothing signed or sent.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import registry from "../../src/assets/registry.generated.json" with { type: "json" };
import issuer from "../../src/assets/sources/evm-issuer-reviewed.generated.json" with { type: "json" };
import solana from "../../src/assets/sources/solana-reviewed.generated.json" with { type: "json" };
import shape from "../fixtures/g12-owner-shape-portfolio.json" with { type: "json" };
import { curatedUniverse } from "../../src/data/portfolio/provider";
import { chatToken } from "../../src/guardian/server/chat-draft";
import { coverageTiers } from "../../src/components/portfolio-tiers";
import type { PortfolioResult } from "../../src/portfolio/model";
import { detectedValue } from "../../src/portfolio/value";
import { coverage } from "../fixtures/portfolio";

// Circle's published native USDC contracts (developers.circle.com/stablecoins/usdc-contract-addresses, 2026-11-11).
const CIRCLE: Record<string, string> = {
  "8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "42161": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "10": "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  "137": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
};
// Bridged variants that stay separate assets (never renamed or merged into USDC).
const BRIDGED: [string, string, string][] = [
  ["8453", "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "USDbC"],
  ["42161", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "USDC.e"],
  ["137", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "USDC.e"],
];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// Individual DeFi checks the owner-shaped scan planned (all of them were checked).
const SHAPE_DEFI = (
  shape.result as unknown as PortfolioResult
).defiCoverage!.reduce((n, c) => n + c.planned, 0);

describe("G12 H01 F1: Circle's native USDC in the reviewed registry", () => {
  it("PF1 one CURATED entry per chain, the exact Circle contract, 6 decimals, market and routing evidence, a sanitized local logo", () => {
    for (const [chainId, address] of Object.entries(CIRCLE)) {
      const rows = registry.assets.filter(
        (a) => a.chainId === chainId && a.symbol === "USDC",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        address,
        native: false,
        decimals: 6,
        level: "CURATED",
        coingeckoId: "usd-coin",
        risk: [],
        routable: true,
      });
      expect(rows[0].sources).toEqual(
        expect.arrayContaining(["trustwallet", "routing", "coingecko"]),
      );
      const file = `public${rows[0].logo!.src}`;
      expect(existsSync(file)).toBe(true);
      expect(sha(readFileSync(file))).toBe(rows[0].logo!.sha256);
    }
  });
  it("PF2 the reviewed source file is the registry's evidence, under the same rule as the accepted Solana entry", () => {
    expect(issuer.issuer).toBe(solana.issuer);
    expect(issuer.assets).toHaveLength(4);
    for (const a of issuer.assets) expect(registry.assets).toContainEqual(a);
    // Order-independent: object keys that look like integers enumerate in ascending numeric order.
    expect(
      issuer.assets.map((a) => `${a.chainId}:${a.address}`).sort(),
    ).toEqual(
      Object.entries(CIRCLE)
        .map(([chainId, address]) => `${chainId}:${address}`)
        .sort(),
    );
  });
  it("PF3 bridged USDC variants remain separate, differently named assets", () => {
    for (const [chainId, address, symbol] of BRIDGED) {
      const row = registry.assets.find(
        (a) => a.chainId === chainId && a.address === address,
      );
      expect(row?.symbol).toBe(symbol);
    }
  });
  it("PF4 the portfolio's curated sweep now reads the native USDC contract on all four networks", () => {
    for (const [chainId, address] of Object.entries(CIRCLE))
      expect(curatedUniverse(chainId).map((a) => a.address)).toContain(address);
  });
  it("PF5 Guardian treats native USDC as reviewed evidence (no longer 'unverified'), by name and by exact contract", () => {
    for (const [chain, chainId] of [
      ["base", "8453"],
      ["arbitrum", "42161"],
      ["optimism", "10"],
      ["polygon", "137"],
    ] as const) {
      for (const token of [
        { symbol: "USDC" },
        { symbol: "USDC", address: CIRCLE[chainId] },
      ]) {
        const r = chatToken({ chain, token }) as {
          token?: { address: string; level: string };
          verdict?: { level: string; findings: { code: string }[] };
        };
        expect(r.token).toMatchObject({
          address: CIRCLE[chainId],
          level: "CURATED",
        });
        expect(r.verdict?.findings.map((f) => f.code)).not.toContain(
          "ASSET_UNVERIFIED",
        );
      }
    }
  });
});

describe("G12 H01 F1: a bridged contract claimed as USDC", () => {
  it("PF9 'USDC' with a bridged contract pasted is answered with the registry's own name for that contract, never 'USDC'", () => {
    for (const [chain, chainId] of [
      ["base", "8453"],
      ["arbitrum", "42161"],
      ["polygon", "137"],
    ] as const) {
      const [, address, symbol] = BRIDGED.find(([c]) => c === chainId)!;
      const r = chatToken({ chain, token: { symbol: "USDC", address } }) as {
        token?: { address: string; symbol: string };
      };
      expect(r.token).toMatchObject({ address, symbol });
      expect(r.token?.address).not.toBe(CIRCLE[chainId]);
    }
  });
});

describe("G12 H01: the three kinds of coverage", () => {
  it("PF6 the owner-shaped scan: native on 144 of 187 networks, reviewed tokens on 9, no activity index, 12 of 12 DeFi checks", () => {
    const r = shape.result as unknown as PortfolioResult;
    expect(coverageTiers(r)).toEqual({
      native: { read: 144, notRead: 43 },
      reviewed: { read: 9, partial: 0, notRead: 178 },
      discovered: {
        networks: 0,
        defiChecked: SHAPE_DEFI,
        defiPlanned: SHAPE_DEFI,
      },
    });
  });
  it("PF7 a network that was not read is never counted as read, whatever the reason", () => {
    const list = [
      coverage("1", "COMPLETE"),
      coverage("8453", "PARTIAL", { tokens: "CURATED" }),
      coverage("10", "FAILED"),
      coverage("137", "PENDING"),
      coverage("56", "CATALOG_ONLY"),
      coverage("42161", "COMPLETE", {
        tokens: "INDEXED",
        tier: "FULL_INDEXED",
      }),
    ];
    expect(coverageTiers({ coverage: list, defiCoverage: [] })).toEqual({
      native: { read: 3, notRead: 3 },
      // The indexed network is discovery, not the reviewed list: it is counted once.
      reviewed: { read: 2, partial: 0, notRead: 3 },
      discovered: { networks: 1, defiChecked: 0, defiPlanned: 0 },
    });
    // Review H01 M2: a network whose token read was incomplete is "partly read", never "read".
    expect(
      coverageTiers({
        coverage: [
          coverage("1", "COMPLETE"),
          coverage("8453", "PARTIAL", {
            tokens: "CURATED",
            reason: "TOKEN_READ_INCOMPLETE",
          }),
          coverage("10", "PARTIAL", { reason: "INDEX_LAGGING" }),
        ],
        // Review H01 m5: individual DeFi checks, not coverage rows.
        defiCoverage: [
          {
            chainId: "1",
            protocol: "Aave V3",
            category: "lending",
            state: "PARTIAL",
            checked: 3,
            planned: 7,
            observedAt: 1,
            observedBlock: "1",
          },
        ],
      }),
    ).toEqual({
      native: { read: 3, notRead: 0 },
      reviewed: { read: 1, partial: 2, notRead: 0 },
      discovered: { networks: 0, defiChecked: 3, defiPlanned: 7 },
    });
    expect(coverageTiers({ coverage: [] })).toEqual({
      native: { read: 0, notRead: 0 },
      reviewed: { read: 0, partial: 0, notRead: 0 },
      discovered: { networks: 0, defiChecked: 0, defiPlanned: 0 },
    });
  });
  it("PF8 the fixture keeps the owner scan's shape: 15 rows on 12 networks, 6 unpriced rows that never count as $0", () => {
    const h = (shape.result as unknown as PortfolioResult).holdings;
    expect(h).toHaveLength(15);
    expect(new Set(h.map((x) => x.chainId)).size).toBe(12);
    const unpriced = h.filter((x) => x.usd === null);
    expect(unpriced.map((x) => `${x.chainId}:${x.symbol}`).sort()).toEqual(
      [
        "10:ETH",
        "169:MANTA",
        "324:ETH",
        "534352:ETH",
        "59144:ETH",
        "714:?",
      ].sort(),
    );
    // The known value is the sum of priced rows only.
    expect(detectedValue(h)).toBeCloseTo(Number(shape.expect.knownUsd), 5);
  });
});
