import { describe, expect, it } from "vitest";
import {
  positionContracts,
  positionFor,
  receiptCoverage,
  defiCoverageSchema,
} from "../../src/portfolio/positions";
import {
  normalizeHoldings,
  mergePortfolio,
  type PortfolioResult,
} from "../../src/portfolio/model";
import { detectedValue } from "../../src/portfolio/value";
import { holding, portfolioFixture } from "../fixtures/portfolio";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
describe("V1122 exact receipt identity and honest coverage", () => {
  it("receipt logos are sanitized local files with exact content hashes", () => {
    const logos = positionContracts.filter((p) => p.logo);
    expect(logos.length).toBe(3);
    for (const p of logos) {
      expect(p.logo).toMatch(
        new RegExp(
          `^/assets/tokens/${p.chainId}/${p.address}-[a-f0-9]{16}\\.png$`,
        ),
      );
      const hash = createHash("sha256")
        .update(readFileSync("public" + p.logo))
        .digest("hex");
      expect(p.logo).toContain(hash.slice(0, 16));
    }
  });
  it("pins unique mainnet contracts across five chains; never matches a symbol", () => {
    expect(positionContracts).toHaveLength(43);
    expect(new Set(positionContracts.map((p) => p.chainId)).size).toBe(5);
    expect(
      new Set(positionContracts.map((p) => `${p.chainId}:${p.address}`)).size,
    ).toBe(43);
    expect(
      positionFor("11155111", positionContracts[0].address),
    ).toBeUndefined();
    expect(positionFor("1", "stETH")).toBeUndefined();
  });
  it("normalizes only exact protocol identity and leaves price-less positions visible", () => {
    const p = positionContracts.find((p) => p.category === "staking")!;
    const [known, fake] = normalizeHoldings([
      holding(p.chainId, "100", null, {
        address: p.address,
        symbol: p.symbol,
        native: false,
      }),
      holding("1", "100", null, {
        address: "0x" + "af".repeat(20),
        symbol: p.symbol,
        native: false,
        position: {
          protocol: p.protocol,
          category: p.category,
          role: p.role,
          source: p.source,
        },
      }),
    ]);
    expect(known.position?.protocol).toBe("Lido");
    expect(known.usd).toBeNull();
    expect(fake.position).toBeUndefined();
  });
  it("does not add debt to known asset value or count the same receipt twice", () => {
    const p = positionContracts.find((p) => p.role === "debt")!;
    const rows = normalizeHoldings([
      holding("1", "100", 10),
      holding(p.chainId, "100", 900, { address: p.address, native: false }),
      holding(p.chainId, "100", 900, { address: p.address, native: false }),
    ]);
    expect(rows).toHaveLength(2);
    expect(detectedValue(rows)).toBe(10);
  });
  it("zero balances are checked but failed and absent reads remain distinguishable", () => {
    const all = positionContracts.filter((p) => p.chainId === "1");
    const rows = receiptCoverage(
      "1",
      all.map((p) => ({ token: p.address, balance: 0n })),
      100,
      "20",
    );
    expect(rows.every((c) => c.state === "CHECKED")).toBe(true);
    expect(
      receiptCoverage("1", [], 100, "20").every(
        (c) => c.state === "NOT_CHECKED",
      ),
    ).toBe(true);
    const failed = receiptCoverage(
      "1",
      all.map((p) => ({ token: p.address, balance: null })),
      100,
      "20",
    );
    expect(failed.every((c) => c.state === "FAILED")).toBe(true);
  });
  it("rejects coverage that says checked without checking every planned contract", () => {
    expect(
      defiCoverageSchema.safeParse({
        chainId: "1",
        protocol: "Lido",
        category: "staking",
        state: "CHECKED",
        checked: 1,
        planned: 2,
        observedAt: 100,
        observedBlock: "20",
      }).success,
    ).toBe(false);
  });
  it("continuations retain answered DeFi coverage and replace rescanned chains", () => {
    const a = portfolioFixture();
    a.defiCoverage = [
      {
        chainId: "1",
        protocol: "Lido",
        category: "staking",
        state: "CHECKED",
        checked: 2,
        planned: 2,
        observedAt: 100,
        observedBlock: "20",
      },
    ];
    const b: PortfolioResult = {
      ...portfolioFixture(),
      coverage: [],
      holdings: [],
      defiCoverage: [
        {
          ...a.defiCoverage[0],
          state: "PENDING" as const,
          checked: 0,
          observedBlock: null,
        },
      ],
    };
    expect(mergePortfolio(a, b).defiCoverage).toEqual(a.defiCoverage);
    b.coverage = a.coverage.filter((c) => c.chainId === "1");
    b.defiCoverage = [{ ...a.defiCoverage[0], observedBlock: "30" }];
    expect(mergePortfolio(a, b).defiCoverage?.[0].observedBlock).toBe("30");
  });
});
