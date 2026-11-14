// G12 H03: the read-only economics of a quote (src/quotes/economics.ts). Pure; SYNTHETIC numbers except the two
// recorded G11 observations (F2: 5 USDC -> 5.007450 USDC expected; F3: a 0.30 USD cost on a 0.000001 USDC amount).
import { describe, expect, it } from "vitest";
import {
  ECONOMICS_POLICY,
  PLATFORM_FEE_READINESS,
  platformFeeToday,
  quoteEconomics,
  usdMicros,
  type EconomicsInput,
} from "../../src/quotes/economics";
import { platformFee, platformFeePolicy } from "../../src/routing/fee-policy";

const base = (over: Partial<EconomicsInput> = {}): EconomicsInput => ({
  sameAsset: true,
  amountIn: 5_000_000n,
  inDecimals: 6,
  expectedOut: 4_990_000n,
  minimumOut: 4_965_000n,
  outDecimals: 6,
  inputUsdMicros: 5_000_000n,
  outputUsdMicros: 4_990_000n,
  costs: [{ usdMicros: 10_000n, included: true }],
  ...over,
});

describe("G12 H03 F2: an estimate above the amount sent", () => {
  it("QE1 the recorded F2 quote (5 USDC -> 5.007450 USDC expected, minimum below the input) is a 14 bps NOTICE, numbers untouched", () => {
    const e = quoteEconomics(
      base({ expectedOut: 5_007_450n, minimumOut: 4_982_412n }),
    )!;
    expect(e.surplus).toEqual({
      basis: "SAME_ASSET",
      bps: 14,
      minimumAbove: false,
      level: "NOTICE",
    });
    expect(e.policy).toBe("qe1.2026-11");
  });
  it("QE2 a guaranteed minimum above the input is reported as such; above 1% the estimate is IMPLAUSIBLE", () => {
    expect(
      quoteEconomics(base({ expectedOut: 5_040_000n, minimumOut: 5_010_000n }))!
        .surplus,
    ).toMatchObject({ bps: 80, minimumAbove: true, level: "NOTICE" });
    expect(
      quoteEconomics(base({ expectedOut: 5_050_001n }))!.surplus,
    ).toMatchObject({ bps: 100, level: "NOTICE" });
    expect(
      quoteEconomics(base({ expectedOut: 5_051_000n }))!.surplus,
    ).toMatchObject({ bps: 102, level: "IMPLAUSIBLE" });
  });
  it("QE3 decimals are compared on a common scale: 6 -> 18 decimals of the same asset is not a surplus by itself", () => {
    expect(
      quoteEconomics(
        base({
          outDecimals: 18,
          expectedOut: 4_990_000_000_000_000_000n,
          minimumOut: 4_965_000_000_000_000_000n,
        }),
      )!.surplus,
    ).toBeNull();
    // A decimals mix-up on the provider side (output 1e12 times too large) is caught as IMPLAUSIBLE, never shown as a gain.
    expect(
      quoteEconomics(base({ expectedOut: 4_990_000_000_000_000_000n }))!
        .surplus,
    ).toMatchObject({ level: "IMPLAUSIBLE", bps: 100_000_000 });
  });
  it("QE4 different assets are never compared as amounts or by two price feeds: no surplus statement at all", () => {
    for (const outputUsdMicros of [5_040_000n, 5_060_000n, 500_000_000n, null])
      expect(
        quoteEconomics(
          base({ sameAsset: false, expectedOut: 9n ** 30n, outputUsdMicros }),
        )!.surplus,
      ).toBeNull();
  });
  it("QE4b a surplus below one basis point says nothing (never '0% more')", () => {
    expect(
      quoteEconomics(base({ expectedOut: 5_000_499n }))!.surplus,
    ).toBeNull();
    expect(
      quoteEconomics(base({ expectedOut: 5_000_500n }))!.surplus,
    ).toMatchObject({ bps: 1, level: "NOTICE" });
  });
  it("QE5 no surplus when the estimate is at or below the amount sent", () => {
    expect(quoteEconomics(base())!.surplus).toBeNull();
    expect(
      quoteEconomics(base({ expectedOut: 5_000_000n }))!.surplus,
    ).toBeNull();
  });
});

describe("G12 H03 F3: costs out of proportion to the amount", () => {
  it("QE6 the recorded F3 shape (0.30 USD of costs on 0.000001 USDC) is SEVERE, never a normal route", () => {
    const e = quoteEconomics(
      base({
        amountIn: 1n,
        expectedOut: 0n,
        minimumOut: 0n,
        inputUsdMicros: 1n,
        outputUsdMicros: 0n,
        costs: [{ usdMicros: 300_000n, included: false }],
      }),
    )!;
    expect(e.cost).toEqual({
      knownUsdMicros: 300_000n,
      complete: true,
      shareBps: 100_000_000,
      level: "SEVERE",
    });
  });
  it("QE7 thresholds: under 10% OK, from 10% UNECONOMIC, from 50% SEVERE (included and excluded costs both count)", () => {
    const at = (usd: bigint) =>
      quoteEconomics(
        base({
          costs: [
            { usdMicros: usd / 2n, included: true },
            { usdMicros: usd - usd / 2n, included: false },
          ],
        }),
      )!.cost;
    expect(at(499_999n)).toMatchObject({ shareBps: 999, level: "OK" });
    expect(at(500_000n)).toMatchObject({ shareBps: 1000, level: "UNECONOMIC" });
    expect(at(2_499_999n)).toMatchObject({ level: "UNECONOMIC" });
    expect(at(2_500_000n)).toMatchObject({ shareBps: 5000, level: "SEVERE" });
    expect(ECONOMICS_POLICY).toMatchObject({
      uneconomicCostBps: 1000,
      severeCostBps: 5000,
      implausibleSurplusBps: 100,
    });
  });
  it("QE8 unknown stays unknown: a cost without a USD value can prove a route unsuitable, never suitable; no input value -> UNKNOWN", () => {
    const partial = (known: bigint) =>
      quoteEconomics(
        base({
          costs: [
            { usdMicros: known, included: false },
            { usdMicros: null, included: false },
          ],
        }),
      )!.cost;
    expect(partial(10_000n)).toMatchObject({
      complete: false,
      level: "UNKNOWN",
    });
    expect(partial(600_000n)).toMatchObject({
      complete: false,
      level: "UNECONOMIC",
    });
    expect(quoteEconomics(base({ inputUsdMicros: null }))!.cost).toMatchObject({
      shareBps: null,
      level: "UNKNOWN",
    });
    expect(quoteEconomics(base({ costs: [] }))!.cost).toMatchObject({
      knownUsdMicros: 0n,
      level: "OK",
    });
  });
  it("QE9 invalid input is refused (null), never repaired: zero or negative amounts, bad decimals, negative values", () => {
    for (const bad of [
      { amountIn: 0n },
      { amountIn: -1n },
      { expectedOut: -1n },
      { minimumOut: -1n },
      { inDecimals: 37 },
      { outDecimals: 1.5 },
      { inputUsdMicros: -1n },
      { costs: [{ usdMicros: -1n, included: false }] },
    ] as Partial<EconomicsInput>[])
      expect(quoteEconomics(base(bad))).toBeNull();
  });
  it("QE10 a provider's decimal USD string is read exactly; anything else is unknown, never 0", () => {
    expect(usdMicros("0.30")).toBe(300_000n);
    expect(usdMicros("5.0074509")).toBe(5_007_450n);
    expect(usdMicros("12")).toBe(12_000_000n);
    for (const v of [undefined, null, "", "1e-7", "-1", "NaN", "1,5", " 1"])
      expect(usdMicros(v)).toBeNull();
  });
});

describe("G12 H03: the VEINED fee stays closed", () => {
  it("QE11 no fee today, no recipient anywhere, and the protected fee policy is unchanged", () => {
    expect(platformFeeToday()).toEqual({ enabled: false, bps: 0, amount: "0" });
    expect(PLATFORM_FEE_READINESS).toMatchObject({
      enabled: false,
      bps: 0,
      recipient: null,
    });
    expect(JSON.stringify(PLATFORM_FEE_READINESS)).not.toMatch(
      /0x[0-9a-fA-F]{40}|\.near\b/,
    );
    expect(platformFeePolicy).toEqual({
      enabled: false,
      bps: 0,
      maxBps: 10,
      recipientMode: "disabled",
    });
    expect(platformFee("1000000000")).toBe("0");
    for (const id of PLATFORM_FEE_READINESS.unsupported)
      expect(Object.keys(PLATFORM_FEE_READINESS.mechanisms)).not.toContain(id);
  });
});
