// G12 H04: 25/50/75/100 % of a read balance (src/quotes/percent.ts). Pure bigint; SYNTHETIC numbers.
import { describe, expect, it } from "vitest";
import {
  amountInput,
  GAS_RESERVE_MARGIN_BPS,
  PERCENTS,
  percentAmount,
  unitsText,
  type PercentInput,
} from "../../src/quotes/percent";

const token = (over: Partial<PercentInput> = {}): PercentInput => ({
  balance: 12_345_678n,
  decimals: 6,
  percent: 100,
  native: false,
  networkFee: null,
  ...over,
});
const ok = (i: PercentInput) => {
  const r = percentAmount(i);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("G12 H04 percent buttons: exact amounts", () => {
  it("PC1 a token: floor of the exact share, text without grouping or trailing zeros, 100% = the whole balance", () => {
    expect(PERCENTS).toEqual([25, 50, 75, 100]);
    expect(ok(token({ percent: 25 }))).toMatchObject({
      raw: 3_086_419n,
      text: "3.086419",
    });
    expect(ok(token({ percent: 50 })).text).toBe("6.172839");
    expect(ok(token({ percent: 75 })).raw).toBe(9_259_258n);
    expect(ok(token({ percent: 100 }))).toMatchObject({
      raw: 12_345_678n,
      text: "12.345678",
      reserved: 0n,
    });
    // A token never needs the network fee to be known: the fee is paid in the native coin.
    expect(ok(token({ percent: 100, networkFee: 5n })).raw).toBe(12_345_678n);
  });
  it("PC2 the amount never exceeds the balance and never rounds up, at any precision", () => {
    for (const decimals of [0, 2, 6, 8, 9, 18, 36])
      for (const balance of [1n, 3n, 7n, 999n, 10n ** 30n + 1n, 2n ** 255n])
        for (const percent of PERCENTS) {
          const r = percentAmount(token({ balance, decimals, percent }));
          if (!r.ok) {
            expect(r.reason).toBe("TOO_SMALL");
            expect((balance * BigInt(percent)) / 100n).toBe(0n);
            continue;
          }
          expect(r.raw).toBeLessThanOrEqual(balance);
          expect(r.raw).toBe((balance * BigInt(percent)) / 100n);
          expect(r.text).toBe(unitsText(r.raw, decimals));
          expect(r.text).not.toMatch(/[eE,\s]/);
        }
  });
  it("PC3 unitsText is exact: 18 decimals, tiny and huge values, no float anywhere", () => {
    expect(unitsText(1n, 18)).toBe("0.000000000000000001");
    expect(unitsText(1_500_000_000_000_000_000n, 18)).toBe("1.5");
    expect(unitsText(12n, 0)).toBe("12");
    expect(unitsText(0n, 6)).toBe("0");
    expect(unitsText(123_456_789_012_345_678_901_234_567_890n, 18)).toBe(
      "123456789012.34567890123456789",
    );
    expect(() => unitsText(-1n, 6)).toThrow();
    expect(() => unitsText(1n, 37)).toThrow();
  });
});

describe("G12 H04 percent buttons: the text typed into the amount field", () => {
  it("PC3b review M1: never exactly three fraction digits (ambiguous where a dot groups thousands); the value is unchanged", () => {
    expect(amountInput("0.125", 18)).toBe("0.1250");
    expect(amountInput("12.345", 6)).toBe("12.3450");
    expect(amountInput("0.25", 18)).toBe("0.25");
    expect(amountInput("0.1234", 18)).toBe("0.1234");
    expect(amountInput("1000", 6)).toBe("1000");
    // A three-decimal token cannot take a fourth digit: left as it is (the field refuses it in those locales).
    expect(amountInput("0.125", 3)).toBe("0.125");
    const r = ok(token({ balance: 500_000n, percent: 25 }));
    expect(r).toMatchObject({ raw: 125_000n, text: "0.125", input: "0.1250" });
    for (const decimals of [4, 6, 18])
      for (const balance of [1n, 500n, 123_456n, 10n ** 18n])
        for (const percent of PERCENTS) {
          const x = percentAmount(token({ balance, decimals, percent }));
          if (!x.ok) continue;
          expect(x.input).not.toMatch(/^\d+\.\d{3}$/);
          expect(Number(x.input)).toBe(Number(x.text));
        }
  });
});

describe("G12 H04 percent buttons: fail-closed", () => {
  it("PC4 no read balance -> nothing offered (never an invented 0); a read zero is its own reason", () => {
    expect(percentAmount(token({ balance: null }))).toEqual({
      ok: false,
      reason: "BALANCE_UNKNOWN",
    });
    expect(percentAmount(token({ balance: 0n }))).toEqual({
      ok: false,
      reason: "BALANCE_ZERO",
    });
    for (const bad of [
      { balance: -1n },
      { decimals: -1 },
      { decimals: 1.5 },
      { percent: 10 as never },
      { percent: 101 as never },
      { networkFee: -1n },
    ] as Partial<PercentInput>[])
      expect(percentAmount(token(bad))).toEqual({
        ok: false,
        reason: "BALANCE_UNKNOWN",
      });
  });
  it("PC5 native coin, fee not known: 25/50/75 leave the rest for the fee; 100% is refused with FEE_UNKNOWN", () => {
    const eth = (percent: PercentInput["percent"]) =>
      percentAmount(
        token({
          balance: 10n ** 18n,
          decimals: 18,
          native: true,
          percent,
        }),
      );
    expect(eth(25)).toMatchObject({ ok: true, text: "0.25" });
    expect(eth(75)).toMatchObject({ ok: true, text: "0.75" });
    expect(eth(100)).toEqual({ ok: false, reason: "FEE_UNKNOWN" });
  });
  it("PC6 native coin, fee known: 100% = balance minus the fee with its 20% margin (rounded up), never more", () => {
    expect(GAS_RESERVE_MARGIN_BPS).toBe(12000);
    const r = ok(
      token({
        balance: 10n ** 18n,
        decimals: 18,
        native: true,
        networkFee: 1_000_000_000_000_001n,
      }),
    );
    // reserve = ceil(fee * 1.2)
    expect(r.reserved).toBe(1_200_000_000_000_002n);
    expect(r.raw).toBe(10n ** 18n - 1_200_000_000_000_002n);
    expect(r.text).toBe("0.998799999999999998");
    // A smaller share that already leaves the reserve is not reduced further.
    expect(
      ok(
        token({
          balance: 10n ** 18n,
          decimals: 18,
          native: true,
          percent: 50,
          networkFee: 10n ** 15n,
        }),
      ).text,
    ).toBe("0.5");
    // A share that would eat into the reserve is capped to what is spendable.
    expect(
      ok(
        token({
          balance: 1000n,
          decimals: 18,
          native: true,
          percent: 75,
          networkFee: 400n,
        }),
      ).raw,
    ).toBe(520n);
  });
  it("PC7 native coin, the fee does not fit: refused with FEE_EXCEEDS_BALANCE at every percent, never a negative or zero amount", () => {
    for (const percent of PERCENTS)
      for (const networkFee of [834n, 1000n, 10n ** 30n])
        expect(
          percentAmount(
            token({ balance: 1000n, native: true, percent, networkFee }),
          ),
        ).toEqual({ ok: false, reason: "FEE_EXCEEDS_BALANCE" });
    // Just below the boundary one unit is still spendable.
    expect(
      ok(token({ balance: 1000n, native: true, networkFee: 832n })).raw,
    ).toBe(1n);
  });
});
