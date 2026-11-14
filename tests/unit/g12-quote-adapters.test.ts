// G12 H03 (review M3): the adapters that read a quote as its source reported it (src/quotes/adapters.ts). Pure; the
// first case uses the numbers of a real read-only quote recorded on 2026-11-11 (evidence h03-live/live-1.json, row 1);
// everything else is SYNTHETIC.
import { describe, expect, it } from "vitest";
import {
  routingEconomics,
  sameReviewedAsset,
  swapEconomics,
  type AssetEvidence,
} from "../../src/quotes/adapters";
import type { RoutingQuote } from "../../src/routing/model";

const D6 = { decimals: 6 };
const D18 = { decimals: 18 };
type Fee = { usd?: string; included: boolean; amount?: string };
const quote = (over: {
  amount?: string;
  expected?: string;
  minimum?: string;
  outputUsd?: string;
  priceImpact?: number | null;
  fees?: Fee[];
}): RoutingQuote =>
  ({
    input: { amount: over.amount ?? "5000000" },
    expected: over.expected ?? "4990000",
    minimum: over.minimum ?? "4965000",
    outputUsd: "outputUsd" in over ? over.outputUsd : "4.99",
    priceImpact: "priceImpact" in over ? over.priceImpact : 0.002,
    fees: (over.fees ?? [{ usd: "0.01", included: true }]).map((f) => ({
      name: "fee",
      amount: f.amount ?? "1",
      usd: f.usd,
      included: f.included,
      kind: "fee",
      asset: {},
    })),
  }) as unknown as RoutingQuote;

describe("G12 H03 adapters: a cross-chain route", () => {
  it("QA1 the recorded live F2 quote (Base USDC 5 -> Arbitrum USDC 5.007450, minimum equal, $5.0101): 14 bps NOTICE with the minimum also above, costs 30 bps OK", () => {
    const e = routingEconomics(
      quote({
        expected: "5007450",
        minimum: "5007450",
        outputUsd: "5.0101",
        priceImpact: 0,
        fees: [
          { usd: "0.0125", included: true },
          { usd: "0.0027", included: false },
        ],
      }),
      D6,
      D6,
      true,
    )!;
    expect(e.surplus).toEqual({
      basis: "SAME_ASSET",
      bps: 14,
      minimumAbove: true,
      level: "NOTICE",
    });
    expect(e.cost).toMatchObject({
      knownUsdMicros: 15_200n,
      complete: true,
      shareBps: 30,
      level: "OK",
    });
  });
  it("QA2 same asset: the output's unit price values the input exactly, across different decimals", () => {
    // 5 units (6 decimals) -> 4 units (18 decimals) worth $4: the 5 sent are worth $5; $0.60 of costs = 12%.
    const e = routingEconomics(
      quote({
        expected: "4000000000000000000",
        minimum: "3900000000000000000",
        outputUsd: "4",
        priceImpact: null,
        fees: [{ usd: "0.6", included: false }],
      }),
      D6,
      D18,
      true,
    )!;
    expect(e.surplus).toBeNull();
    expect(e.cost).toMatchObject({ shareBps: 1200, level: "UNECONOMIC" });
  });
  it("QA3 different assets with a reported loss: input = output / (1 - impact)", () => {
    const at = (usd: string) =>
      routingEconomics(
        quote({
          outputUsd: "50",
          priceImpact: 0.5,
          fees: [{ usd, included: false }],
        }),
        D6,
        D18,
        false,
      )!.cost;
    expect(at("6")).toMatchObject({ shareBps: 600, level: "OK" });
    expect(at("12")).toMatchObject({ shareBps: 1200, level: "UNECONOMIC" });
  });
  it("QA4 review M2: different assets and NO reported price impact -> the input value is unknown, no cost statement (never the output as a guess)", () => {
    const e = routingEconomics(
      quote({
        outputUsd: "50",
        priceImpact: null,
        fees: [{ usd: "45", included: false }],
      }),
      D6,
      D18,
      false,
    )!;
    expect(e.cost).toMatchObject({ shareBps: null, level: "UNKNOWN" });
    expect(e.surplus).toBeNull();
  });
  it("QA5 no loss reported (impact 0): the output value stands in for the input, a lower bound of the share", () => {
    expect(
      routingEconomics(
        quote({
          outputUsd: "50",
          priceImpact: 0,
          fees: [{ usd: "6", included: false }],
        }),
        D6,
        D18,
        false,
      )!.cost,
    ).toMatchObject({ shareBps: 1200, level: "UNECONOMIC" });
  });
  it("QA6 review M1: a price impact that rounds to 100% (or is not a number) never divides by zero or throws; it is unknown", () => {
    for (const priceImpact of [
      0.9999996,
      0.99999999,
      1,
      1.5,
      -0.2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const e = routingEconomics(
        quote({ outputUsd: "0.0001", priceImpact }),
        D6,
        D18,
        false,
      );
      expect(e).not.toBeNull();
      expect(e!.cost).toMatchObject({ shareBps: null, level: "UNKNOWN" });
    }
    // Just below the bound it is still computed.
    expect(
      routingEconomics(
        quote({ outputUsd: "1", priceImpact: 0.999999 }),
        D6,
        D18,
        false,
      )!.cost.shareBps,
    ).toBe(0);
  });
  it("QA7 unreadable quotes yield null (no notice), never a guess; an unvalued or zero output is unknown", () => {
    for (const bad of [
      { amount: "abc" },
      { expected: "1.5" },
      { minimum: "x" },
      { amount: "0" },
      { amount: "-5" },
    ])
      expect(routingEconomics(quote(bad), D6, D6, true)).toBeNull();
    for (const outputUsd of [undefined, "0", "n/a", "1e3"])
      expect(
        routingEconomics(quote({ outputUsd }), D6, D6, false)!.cost,
      ).toMatchObject({ shareBps: null, level: "UNKNOWN" });
  });
  it("QA8 cost lines: a zero-unit line without a dollar value costs nothing; a non-zero one without a value keeps the total incomplete", () => {
    const cost = (fees: Fee[]) =>
      routingEconomics(quote({ fees }), D6, D6, true)!.cost;
    expect(
      cost([
        { usd: "0.01", included: true },
        { amount: "0", included: false },
      ]),
    ).toMatchObject({ knownUsdMicros: 10_000n, complete: true, level: "OK" });
    expect(
      cost([
        { usd: "0.01", included: true },
        { amount: "7", included: false },
      ]),
    ).toMatchObject({ complete: false, level: "UNKNOWN" });
  });
});

describe("G12 H03 adapters: a same-network swap quote", () => {
  const swap = (over: Partial<Parameters<typeof swapEconomics>[0]> = {}) =>
    swapEconomics(
      {
        amountIn: 5_000_000n,
        amountOut: 2_400_000_000_000_000n,
        minAmountOut: 2_388_000_000_000_000n,
        inputUsdMicros: 5_000_000n,
        outputUsdMicros: 4_980_000n,
        costs: [],
        ...over,
      },
      6,
      18,
    )!;
  const c = (
    usdMicros: bigint | null,
    amount: bigint | null,
    included = false,
  ) =>
    ({
      kind: "NETWORK",
      token: "native",
      evidence: "UNKNOWN",
      usdMicros,
      amount,
      included,
    }) as Parameters<typeof swapEconomics>[0]["costs"][number];
  it("QA9 as the live quotes arrive (no valuation, network cost unknown): UNKNOWN, no statement; never a surplus between different assets", () => {
    const e = swap({
      inputUsdMicros: null,
      outputUsdMicros: null,
      costs: [c(0n, 0n, true), c(null, null)],
    });
    expect(e.cost).toMatchObject({
      shareBps: null,
      complete: false,
      level: "UNKNOWN",
    });
    expect(e.surplus).toBeNull();
    expect(swap({ outputUsdMicros: 900_000_000n }).surplus).toBeNull();
  });
  it("QA10 with valuation: costs are a share of the amount sent; a zero-unit cost is zero even without a value", () => {
    expect(swap({ costs: [c(600_000n, 1n)] }).cost).toMatchObject({
      shareBps: 1200,
      level: "UNECONOMIC",
    });
    expect(swap({ costs: [c(null, 0n), c(10_000n, 5n)] }).cost).toMatchObject({
      knownUsdMicros: 10_000n,
      complete: true,
      level: "OK",
    });
    expect(
      swapEconomics(
        {
          amountIn: 0n,
          amountOut: 1n,
          minAmountOut: 1n,
          inputUsdMicros: null,
          outputUsdMicros: null,
          costs: [],
        },
        6,
        18,
      ),
    ).toBeNull();
  });
});

describe("G12 H03 adapters: 'the same reviewed asset' is identity, never a symbol", () => {
  const usdc = (over: Partial<AssetEvidence> = {}): AssetEvidence => ({
    chainId: "8453",
    symbol: "USDC",
    decimals: 6,
    native: false,
    level: "CURATED",
    risk: [],
    coingeckoId: "usd-coin",
    ...over,
  });
  const eth = (chainId: string, over: Partial<AssetEvidence> = {}) =>
    usdc({
      chainId,
      symbol: "ETH",
      decimals: 18,
      native: true,
      level: "CANONICAL",
      coingeckoId: undefined,
      ...over,
    });
  it("QA11 Circle USDC on two networks is the same asset; native ETH on two networks is the same asset", () => {
    expect(sameReviewedAsset(usdc(), usdc({ chainId: "42161" }))).toBe(true);
    expect(sameReviewedAsset(eth("1"), eth("8453"))).toBe(true);
  });
  it("QA12 not the same: a look-alike with the symbol only, a bridged listing, unknown evidence, a risk flag, other decimals, the same network, wrapped vs native, another native coin", () => {
    const other = { chainId: "42161" };
    for (const b of [
      usdc({ ...other, coingeckoId: undefined }),
      usdc({ ...other, coingeckoId: "bridged-usdc" }),
      usdc({ ...other, level: undefined }),
      usdc({ ...other, level: "MARKET_LISTED" }),
      usdc({ ...other, risk: ["SYMBOL_IMPERSONATION"] }),
      usdc({ ...other, decimals: 18 }),
      usdc({ ...other, symbol: "USDC.e" }),
      usdc(),
    ])
      expect(sameReviewedAsset(usdc(), b)).toBe(false);
    // The pay side without a listing id is not "the same" either.
    expect(
      sameReviewedAsset(usdc({ coingeckoId: undefined }), usdc(other)),
    ).toBe(false);
    // Wrapped ETH (a token) against native ETH, and two different native coins that happen to share a symbol.
    expect(
      sameReviewedAsset(
        eth("1"),
        usdc({
          ...other,
          symbol: "ETH",
          decimals: 18,
          coingeckoId: "weth",
        }),
      ),
    ).toBe(false);
    expect(
      sameReviewedAsset(
        eth("1", { symbol: "XYZ" }),
        eth("56", { symbol: "XYZ" }),
      ),
    ).toBe(false);
  });
});
