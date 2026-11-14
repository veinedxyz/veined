// Deep refinement (ux5): the generated token medallion and the tide tags are deterministic and never empty, so a
// token without a reviewed logo is always shown with a stable, readable mark.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Medallion,
  TideTag,
  markHue,
  markInitials,
} from "../../src/components/ocean-glyphs";

describe("ocean marks", () => {
  it("derives a stable hue from the exact identity, case-insensitively, within the twelve static classes", () => {
    const a = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eB48";
    expect(markHue(a)).toBe(markHue(a.toLowerCase()));
    for (const seed of [
      "",
      "?",
      "USDC",
      "1:0xdead",
      "solana:So11111111111111111111111111111111111111112",
    ]) {
      const h = markHue(seed);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(12);
    }
  });
  it("keeps short symbols whole and trims long ones to three letters; punctuation never shows", () => {
    expect(markInitials("eth")).toBe("ETH");
    expect(markInitials("WETH")).toBe("WETH");
    expect(markInitials("USDC.e")).toBe("USD");
    expect(markInitials("cbBTC")).toBe("CBB");
    expect(markInitials("$")).toBe("");
    expect(markInitials("ステーブル")).toBe("ステー");
  });
  it("renders a medallion without inline styles and a tag whose meaning is in its text", () => {
    const medallion = renderToStaticMarkup(
      Medallion({ symbol: "XYZ", seed: "xyz" }),
    );
    expect(medallion).toContain("tmark-face is-medallion");
    expect(medallion).toContain(">XYZ<");
    expect(medallion).toContain('aria-hidden="true"');
    expect(medallion).not.toContain("style=");
    const empty = renderToStaticMarkup(Medallion({ symbol: "" }));
    expect(empty).toContain(">?<");
    const tag = renderToStaticMarkup(
      TideTag({
        kind: "reef",
        tone: "coral",
        children: "Same symbol, different contract",
      }),
    );
    expect(tag).toContain("tide tide-coral");
    expect(tag).toContain("Same symbol, different contract");
    expect(tag).not.toContain("style=");
  });
});
