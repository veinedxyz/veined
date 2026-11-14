// G13 Phase 1: the five audited P1 repairs (VBA-P1-01 … 05). Pure functions; SYNTHETIC_TEST_ONLY fixtures (no real
// wallet, balance, block height or quote of the owner).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ambiguousAmountReadings,
  normalizeAmountInput,
} from "../../src/i18n/amounts";
import { amountInput } from "../../src/quotes/percent";
import { GUARDIAN_POLICY, levelOf } from "../../src/guardian/model";
import type { BridgeFacts } from "../../src/guardian/model";
import {
  bridgeRules,
  portfolioRules,
  routeCostShareBps,
} from "../../src/guardian/rules";
import { review } from "../../src/guardian/verdict";
import { sameCatalogContent } from "../../src/quotes/catalog-content";
import {
  ETH_GAS_TVL_SYMBOL,
  displayNativeSymbol,
} from "../../src/registry/native-gas";
import { translate } from "../../src/i18n/messages";

describe("G13 VBA-P1-01 comma-decimal amounts", () => {
  it.each([
    ["0,002", "tr", 18, "0.002"],
    ["0.002", "tr", 18, "0.002"],
    ["0,005", "de", 18, "0.005"],
    ["0,625", "tr", 18, "0.625"],
    ["0,001", "es", 6, "0.001"],
    ["1234,567", "tr", 18, "1234.567"],
    ["1234.567", "de", 18, "1234.567"],
    ["4,9950", "tr", 6, "4.9950"],
    ["0,0021", "tr", 18, "0.0021"],
  ] as const)(
    "%s (%s) can only be a decimal and parses",
    (raw, locale, d, out) =>
      expect(normalizeAmountInput(raw, locale, d)).toBe(out),
  );
  it.each([
    ["4,995", "tr"],
    ["1,234", "tr"],
    ["2,002", "tr"],
    ["1.234", "de"],
    ["999,999", "it"],
    ["1.234,5", "tr"],
    ["1,234", "en"],
    ["00,002", "tr"],
  ] as const)(
    "%s (%s) is still refused (it can be read two ways or is malformed)",
    (raw, locale) =>
      expect(() => normalizeAmountInput(raw, locale, 18)).toThrow(),
  );
  it("a genuinely ambiguous amount names both unambiguous spellings, in the locale's decimal separator", () => {
    expect(ambiguousAmountReadings("4,995", "tr", 6)).toEqual({
      whole: "4995",
      decimal: "4,9950",
    });
    expect(ambiguousAmountReadings("1.234", "de", 18)).toEqual({
      whole: "1234",
      decimal: "1,2340",
    });
    expect(ambiguousAmountReadings("1,234", "en", 18)).toEqual({
      whole: "1234",
      decimal: "1.2340",
    });
    // Both suggestions parse to exactly what they say.
    expect(normalizeAmountInput("4995", "tr", 6)).toBe("4995");
    expect(normalizeAmountInput("4,9950", "tr", 6)).toBe("4.9950");
  });
  it("no suggestion when the input parses, is refused for another reason, or a fourth digit does not fit", () => {
    expect(ambiguousAmountReadings("0,002", "tr", 18)).toBeNull();
    expect(ambiguousAmountReadings("1.5", "tr", 18)).toBeNull();
    expect(ambiguousAmountReadings("1 234", "fr", 18)).toBeNull();
    expect(ambiguousAmountReadings("1.234,5", "tr", 18)).toBeNull();
    expect(ambiguousAmountReadings("abc", "tr", 18)).toBeNull();
    expect(ambiguousAmountReadings("4,995", "tr", 3)).toBeNull();
    expect(ambiguousAmountReadings("", "tr", 18)).toBeNull();
  });
  it("the message carries the typed text and both readings in every loaded locale", () => {
    for (const lang of ["en", "tr"] as const) {
      const text = translate(lang, "g13.amount.ambiguous", {
        amount: "4,995",
        whole: "4995",
        decimal: "4,9950",
      });
      expect(text).toContain("4,995");
      expect(text).toContain("4995");
      expect(text).toContain("4,9950");
    }
  });
  it("percent buttons still write text every locale accepts (accepted H04 rule unchanged)", () => {
    for (const locale of ["tr", "de", "en", "es"] as const) {
      expect(normalizeAmountInput(amountInput("1.625", 18), locale, 18)).toBe(
        "1.6250",
      );
      expect(normalizeAmountInput(amountInput("0.625", 18), locale, 18)).toBe(
        "0.6250",
      );
    }
  });
});

const usdc = (chainId: string, address: string) => ({
  chainId,
  address,
  symbol: "USDC",
  native: false,
  level: "CANONICAL" as const,
  risk: [],
});
const SELF = "0x1111111111111111111111111111111111111111";
const bridge = (
  route: Partial<NonNullable<BridgeFacts["route"]>>,
): BridgeFacts => ({
  kind: "bridge",
  sourceChain: "8453",
  destinationChain: "42161",
  sender: SELF,
  recipient: SELF,
  pay: usdc("8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  receive: usdc("42161", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
  route: {
    steps: [{ tool: "relay", catalogBound: true, destinationSignature: false }],
    durationSeconds: 2,
    priceImpact: 0.0843,
    warnings: 0,
    valid: true,
    inputUsd: null,
    outputUsd: 0.045785,
    ...route,
  },
  known: [SELF],
});
const codes = (f: BridgeFacts) => bridgeRules(f).findings.map((x) => x.code);

describe("G13 VBA-P1-02 Guardian names route fees instead of advising a smaller amount", () => {
  it("policy version moved with the rule", () =>
    expect(GUARDIAN_POLICY.version).toBe("g1.2026-11.1"));
  it("fees that explain the reported impact: ROUTE_COST_SHARE + LARGER_AMOUNT, never REDUCE_AMOUNT", () => {
    const r = bridgeRules(bridge({ costUsd: 0.007185 }));
    expect(r.findings.map((f) => f.code)).toContain("ROUTE_COST_SHARE");
    expect(r.findings.map((f) => f.code)).not.toContain("ROUTE_IMPACT");
    expect(r.steps).toContain("LARGER_AMOUNT");
    expect(r.steps).not.toContain("REDUCE_AMOUNT");
    const f = r.findings.find((x) => x.code === "ROUTE_COST_SHARE")!;
    expect(f.severity).toBe("WARNING");
    // The real share is shown even when the fees exceed the reported difference (no silent cap).
    expect(f.params).toEqual({ impact: "8.43%", share: "14.37%" });
  });
  it("unknown fees (no USD on a taken-out line) keep the accepted finding", () => {
    for (const costUsd of [null, undefined, Number.NaN, -1, Infinity]) {
      const r = bridgeRules(bridge({ costUsd }));
      expect(r.findings.map((f) => f.code)).toContain("ROUTE_IMPACT");
      expect(r.steps).toContain("REDUCE_AMOUNT");
    }
  });
  it("small fees beside a large impact are market impact: accepted finding and advice", () => {
    const r = bridgeRules(
      bridge({ priceImpact: 0.05, outputUsd: 950, costUsd: 1 }),
    );
    expect(r.findings.map((f) => f.code)).toContain("ROUTE_IMPACT");
    expect(r.steps).toContain("REDUCE_AMOUNT");
  });
  it("severity and verdict level never differ from the accepted rule, on a grid of impacts and fee shares", () => {
    for (const impact of [
      0, 0.005, 0.01, 0.0299, 0.03, 0.05, 0.0999, 0.1, 0.3, 0.9,
    ]) {
      for (const share of [0, 0.001, 0.25, 0.5, 0.75, 1, 2]) {
        const out = 100;
        const input = impact < 1 ? out / (1 - impact) : out;
        const costUsd = input * impact * share;
        const repaired = bridgeRules(
          bridge({ priceImpact: impact, outputUsd: out, costUsd }),
        );
        const accepted = bridgeRules(
          bridge({ priceImpact: impact, outputUsd: out }),
        );
        expect(levelOf(repaired.findings), `${impact}/${share}`).toBe(
          levelOf(accepted.findings),
        );
        expect(repaired.checks).toBe(accepted.checks);
      }
    }
  });
  it("a CRITICAL impact stays BLOCK even when fees explain all of it (no bypass through costUsd)", () => {
    const v = review(bridge({ priceImpact: 0.4, outputUsd: 6, costUsd: 4 }));
    expect(v.level).toBe("BLOCK");
    expect(
      v.findings.find((f) => f.code === "ROUTE_COST_SHARE")?.severity,
    ).toBe("CRITICAL");
  });
  it("the fee share uses only the route source's figures and refuses to guess", () => {
    expect(
      routeCostShareBps({ priceImpact: 0.1, outputUsd: 90, costUsd: 5 }),
    ).toBe(500);
    expect(
      routeCostShareBps({
        priceImpact: 0.1,
        inputUsd: 200,
        outputUsd: 90,
        costUsd: 5,
      }),
    ).toBe(250);
    expect(
      routeCostShareBps({ priceImpact: 0, outputUsd: 90, costUsd: 5 }),
    ).toBeNull();
    expect(
      routeCostShareBps({ priceImpact: 1, outputUsd: 90, costUsd: 5 }),
    ).toBeNull();
    expect(
      routeCostShareBps({ priceImpact: 0.1, outputUsd: null, costUsd: 5 }),
    ).toBeNull();
    expect(
      routeCostShareBps({ priceImpact: null, outputUsd: 90, costUsd: 5 }),
    ).toBeNull();
  });
  it("a fact without costUsd (every accepted caller) produces the accepted findings", () => {
    expect(codes(bridge({}))).toContain("ROUTE_IMPACT");
  });
});

describe("G13 VBA-P1-03 catalog content comparison", () => {
  const net = (id: string) => ({
    id,
    key: `k${id}`,
    name: `N${id}`,
    ecosystem: "EVM" as const,
    mainnet: true,
    nativeAsset: {
      chainId: id,
      address: "0x0",
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
    },
    provider: "routing-core" as const,
    theme: {} as never,
  });
  it("same networks and tools are the same content whatever the timestamp; any difference is not", () => {
    const a = {
      networks: [net("1"), net("8453")],
      tools: [{ id: "x", name: "X", kind: "bridge" as const }],
    };
    expect(sameCatalogContent(a, structuredClone(a))).toBe(true);
    expect(sameCatalogContent(a, { ...a, networks: [net("1")] })).toBe(false);
    expect(sameCatalogContent(a, { ...a, tools: [] })).toBe(false);
    expect(
      sameCatalogContent(a, {
        ...a,
        networks: [net("1"), { ...net("8453"), name: "Other" }],
      }),
    ).toBe(false);
  });
});

describe("G13 VBA-P1-05 native ETH on networks the registry names by their governance token", () => {
  it("the table equals what the TVL catalog snapshot (the registry's own input) says, exactly", () => {
    const snap = JSON.parse(
      readFileSync("src/catalog/snapshot.json", "utf8"),
    ) as {
      raw: {
        chainId?: unknown;
        name?: unknown;
        tvl?: unknown;
        tokenSymbol?: unknown;
        gasTokenGeckoId?: unknown;
      }[];
    };
    const derived: Record<string, string | null> = {};
    for (const r of snap.raw)
      if (
        r.chainId != null &&
        /^\d{1,18}$/.test(String(r.chainId)) &&
        r.gasTokenGeckoId === "ethereum" &&
        typeof r.tvl === "number" &&
        r.tvl > 0 &&
        typeof r.name === "string" &&
        r.tokenSymbol !== "ETH"
      )
        derived[String(r.chainId)] =
          typeof r.tokenSymbol === "string" ? r.tokenSymbol : null;
    expect(derived).toEqual({ ...ETH_GAS_TVL_SYMBOL });
  });
  it("Manta Pacific and Zircuit natives read ETH; symbols from any other source are untouched", () => {
    expect(displayNativeSymbol("169", "MANTA")).toBe("ETH");
    expect(displayNativeSymbol("48900", "ZRC")).toBe("ETH");
    expect(displayNativeSymbol("1101", "?")).toBe("ETH");
    expect(displayNativeSymbol("2355", "-")).toBe("ETH");
    expect(displayNativeSymbol("169", "WETH")).toBe("WETH");
    expect(displayNativeSymbol("8453", "ETH")).toBe("ETH");
    expect(displayNativeSymbol("56", "BNB")).toBe("BNB");
    expect(displayNativeSymbol("5000", "MNT")).toBe("MNT");
    expect(displayNativeSymbol("1284", "GLMR")).toBe("GLMR");
  });
});

describe("G13 review fixes (independent review of Phase 1)", () => {
  it("RF1 es / it / pl group thousands too: 12.345 is refused as ambiguous, 0.002 and 1,5 still parse", () => {
    for (const locale of ["es", "it"] as const) {
      expect(() => normalizeAmountInput("12.345", locale, 18)).toThrow();
      expect(ambiguousAmountReadings("12.345", locale, 18)).toEqual({
        whole: "12345",
        decimal: "12,3450",
      });
      expect(normalizeAmountInput("0.002", locale, 18)).toBe("0.002");
      expect(normalizeAmountInput("1,5", locale, 18)).toBe("1.5");
    }
  });
  it("RF2 the ambiguity hint also reads full-width and Arabic-Indic digits", () => {
    expect(ambiguousAmountReadings("٤,٩٩٥", "tr", 6)).toEqual({
      whole: "4995",
      decimal: "4,9950",
    });
    expect(ambiguousAmountReadings("４,９９５", "tr", 6)).toEqual({
      whole: "4995",
      decimal: "4,9950",
    });
  });
  it("RF3 never 'send less' and 'send more' together, even when a value-loss figure is supplied", () => {
    const r = bridgeRules(bridge({ costUsd: 0.007185, inputUsd: 0.05 }));
    expect(r.steps).toContain("LARGER_AMOUNT");
    expect(r.steps).not.toContain("REDUCE_AMOUNT");
    expect(r.findings.map((f) => f.code)).toContain("ROUTE_VALUE_LOSS");
  });
  it("RF4 P1-05 side effect on the Guardian sweep: no false twin with the real MANTA token; a fake ETH token next to native ETH is caught", () => {
    const h = (address: string, symbol: string) => ({
      chainId: "169",
      address,
      symbol,
      spam: false,
      suspicious: false,
      usd: null,
    });
    const NATIVE = "0x0000000000000000000000000000000000000000";
    const MANTA_TOKEN = "0x95CeF13441Be50d20cA4558CC0a27B601aC544E5";
    const before = portfolioRules({
      kind: "portfolio",
      holdings: [h(NATIVE, "MANTA"), h(MANTA_TOKEN, "MANTA")],
    });
    expect(before.findings.map((f) => f.code)).toContain(
      "HOLDINGS_SAME_SYMBOL",
    );
    const after = portfolioRules({
      kind: "portfolio",
      holdings: [
        h(NATIVE, displayNativeSymbol("169", "MANTA")),
        h(MANTA_TOKEN, "MANTA"),
      ],
    });
    expect(after.findings.map((f) => f.code)).not.toContain(
      "HOLDINGS_SAME_SYMBOL",
    );
    const fake = portfolioRules({
      kind: "portfolio",
      holdings: [
        h(NATIVE, displayNativeSymbol("169", "MANTA")),
        h("0x7777777777777777777777777777777777777777", "ETH"),
      ],
    });
    expect(fake.findings.map((f) => f.code)).toContain("HOLDINGS_SAME_SYMBOL");
  });
});
