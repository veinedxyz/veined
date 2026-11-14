import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { formatUsd, formatUsdCompact } from "../../src/i18n/amounts";
import { cssomFill } from "../../src/components/virtual";
import { shortAddress, tokenHue } from "../../src/components/ui";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import { locales } from "../../src/i18n/config";
// V1.10 product UI: display formatting, CSP-safe geometry, deterministic token marks and icon hygiene.
const fakeElement = () => {
  const set: Record<string, string> = {};
  return {
    set,
    el: {
      style: { setProperty: (k: string, v: string) => void (set[k] = v) },
    } as unknown as HTMLElement,
  };
};
describe("V1.10 display money", () => {
  it("formats ordinary balances to cents and keeps dust significant", () => {
    expect(formatUsd(9247.42, "en")).toBe("$9,247.42");
    expect(formatUsd(3360, "en")).toBe("$3,360.00");
    expect(formatUsd(0.0014, "en")).toBe("$0.0014");
    expect(formatUsd(0, "en")).toBe("$0.00");
    expect(formatUsd(1234.5, "tr")).toMatch(/1\.234,50/);
  });
  it("formats market sizes compactly in every locale", () => {
    expect(formatUsdCompact(54_416_095_865.49, "en")).toBe("$54.4B");
    for (const { id } of locales)
      expect(formatUsdCompact(54_416_095_865.49, id).length).toBeLessThan(16);
  });
});
describe("V1.10 CSSOM fills (CSP: no style attributes)", () => {
  it("writes one clamped --fill custom property and nothing else", () => {
    for (const [input, expected] of [
      [0.42, "0.42"],
      [1.7, "1"],
      [-3, "0"],
      [0.12345, "0.123"],
    ] as const) {
      const { el, set } = fakeElement();
      cssomFill(input)(el);
      expect(set).toEqual({ "--fill": expected });
    }
  });
  it("ignores non-finite input and missing elements", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const { el, set } = fakeElement();
      cssomFill(bad)(el);
      expect(set).toEqual({});
    }
    expect(() => cssomFill(0.5)(null)).not.toThrow();
  });
});
describe("V1.10 token marks and addresses", () => {
  it("token hue is deterministic and limited to the eight static classes", () => {
    for (const s of ["ETH", "USDC", "AERO", "", "ÇĞŞ", "🙂", "x".repeat(40)]) {
      expect(tokenHue(s)).toBe(tokenHue(s));
      expect(tokenHue(s)).toBeGreaterThanOrEqual(0);
      expect(tokenHue(s)).toBeLessThan(8);
    }
    const css = readFileSync("src/app/globals.css", "utf8");
    for (let i = 0; i < 8; i++) expect(css).toContain(`.tk-${i} {`);
  });
  it("short addresses keep both ends and leave short identifiers intact", () => {
    expect(shortAddress("0x3333333333333333333333333333333333333333")).toBe(
      "0x3333…3333",
    );
    expect(shortAddress("ETH")).toBe("ETH");
  });
});
describe("V1.10 source hygiene", () => {
  const components = readdirSync("src/components")
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => [f, readFileSync(`src/components/${f}`, "utf8")] as const);
  it("product UI uses the authored icon set, not Unicode glyphs as icons", () => {
    for (const [file, text] of components)
      expect(text, file).not.toMatch(/[☼◐◎◇↗↻✓✕]|>\s*[×↔↓]\s*</);
  });
  it("every v110 message key used by the UI exists in the canonical dictionary", () => {
    const used = new Set(
      components.flatMap(([, text]) =>
        [...text.matchAll(/"v110\.([A-Za-z0-9]+)"/g)].map((m) => m[1]),
      ),
    );
    expect(used.size).toBeGreaterThan(60);
    for (const key of used) expect(Object.keys(en.v110), key).toContain(key);
  });
  it("the first-load shell only draws core icons (extra icons ship with code-split views)", () => {
    const core = readFileSync("src/components/icons.tsx", "utf8");
    const coreNames = new Set(
      [
        ...core
          .slice(core.indexOf("const core = {"), core.indexOf("} as const;"))
          .matchAll(/^  ([a-zA-Z]+):/gm),
      ].map((m) => m[1]),
    );
    expect(coreNames.size).toBe(16);
    // Icon names drawn by an <Icon> tag: a literal, or the result branches of `cond ? "a" : "b"`.
    const iconNames = (text: string) =>
      (text.match(/<Icon\s[^>]*>/g) ?? []).flatMap((tag) => {
        const m = tag.match(/name=(?:"([a-zA-Z]+)"|\{([^}]*)\})/);
        if (!m) return [];
        if (m[1]) return [m[1]];
        const expr = m[2].includes("?") ? m[2].slice(m[2].indexOf("?")) : "";
        return [...expr.matchAll(/"([a-zA-Z]+)"/g)].map((x) => x[1]);
      });
    for (const file of ["product", "language-selector"]) {
      const names = iconNames(
        readFileSync(`src/components/${file}.tsx`, "utf8"),
      );
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of names)
        expect(coreNames, `${file}: ${name}`).toContain(name);
    }
    const firstLoad = ["product.tsx", "language-selector.tsx", "icons.tsx"];
    for (const file of readdirSync("src/components").filter((f) =>
      f.endsWith(".tsx"),
    ))
      if (!firstLoad.includes(file)) {
        const text = readFileSync(`src/components/${file}`, "utf8");
        const usesExtra = iconNames(text).some((n) => !coreNames.has(n));
        if (usesExtra)
          expect(
            /import "\.\/icons-extra";|from "\.\/ui"/.test(text),
            `${file} renders extra icons without registering them`,
          ).toBe(true);
      }
  });
  it("no new style attributes or inline style props", () => {
    for (const [file, text] of components) {
      expect(text, file).not.toMatch(/\sstyle=\{/);
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});
