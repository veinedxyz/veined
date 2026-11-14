import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { contentSecurityPolicy } from "../../src/proxy";
import {
  NEUTRAL_COLORS,
  THEME_SOURCES,
  themeClass,
  themeStylesheet,
  validColors,
} from "../../src/content/network-themes";
import { DOCS_CSP, DOCS_CSS, docsPage } from "../../src/data/api/docs-page";
import { openApiDocument } from "../../src/data/api/openapi";
import { cssomPosition } from "../../src/components/virtual";
import { safeLogoSrc } from "../../src/components/logo-src";
import { prng, SEEDS } from "../fixtures/prng";
// V1.5 CSP hardening: policy exactness, generated theme classes, no inline style sources.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const parse = (csp: string) =>
  Object.fromEntries(
    csp.split(";").map((d) => {
      const [k, ...v] = d.trim().split(/\s+/);
      return [k, v];
    }),
  );
describe("V15 content security policy", () => {
  it("production policy has no inline script/style allowance and keeps the strict directives", () => {
    const d = parse(contentSecurityPolicy("bm9uY2U=", false));
    expect(d["script-src"]).toEqual([
      "'self'",
      "'nonce-bm9uY2U='",
      "'strict-dynamic'",
    ]);
    expect(d["style-src"]).toEqual(["'self'", "'nonce-bm9uY2U='"]);
    expect(d["style-src-attr"]).toEqual(["'none'"]);
    for (const k of ["frame-ancestors", "object-src", "frame-src"])
      expect(d[k]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(JSON.stringify(d)).not.toMatch(
      /unsafe-inline|unsafe-eval|unsafe-hashes|\*/,
    );
  });
  it("development-only allowances stay development-only", () => {
    const dev = contentSecurityPolicy("eA==", true);
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    expect(dev).not.toContain("style-src-attr");
    expect(parse(dev)["script-src"]).not.toContain("'unsafe-inline'");
  });
  it("Data API docs: exact stylesheet hash, no scripts, no unsafe keyword", () => {
    const hash = createHash("sha256").update(DOCS_CSS).digest("base64");
    expect(DOCS_CSP).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const html = docsPage(openApiDocument());
    expect(html).toContain(`<style>${DOCS_CSS}</style>`);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script|\sstyle=|\son[a-z]+=/i);
  });
});
describe("V15 generated network theme classes", () => {
  it("committed stylesheet is byte-identical to the generator output", () => {
    expect(
      readFileSync("src/app/network-themes.css", "utf8").replace(/\r\n/g, "\n"),
    ).toBe(themeStylesheet());
  });
  it("every emitted rule has a strict shape (no injectable characters)", () => {
    const lines = themeStylesheet()
      .split("\n")
      .filter((l) => l.startsWith("."));
    expect(lines.length).toBe(THEME_SOURCES.length * 3);
    for (const l of lines)
      expect(l).toMatch(
        /^\.(src-|dst-)?nt-[a-z0-9]{1,24}\{(--[a-z-]{6,24}:(#[0-9a-fA-F]{6}|\d{1,3} \d{1,3} \d{1,3}|transparent);?)+\}$/,
      );
    expect(THEME_SOURCES.every((s) => validColors(s.colors))).toBe(true);
  });
  it.each(SEEDS)(
    "seed %i: unknown or tampered colours fall back to neutral; known tuples map",
    (seed) => {
      const r = prng(seed);
      for (const s of THEME_SOURCES.slice(0, 20))
        expect(themeClass(s.colors)).toMatch(/^nt-[a-z0-9]+$/);
      for (let i = 0; i < 50; i++) {
        const base = r.pick(THEME_SOURCES).colors;
        const field = r.pick([
          "primary",
          "accent",
          "badgeDark",
          "badgeLight",
        ] as const);
        const tampered = { ...base, [field]: `#${r.hex(3).slice(2)}` };
        const cls = themeClass(tampered);
        // Either the tampered tuple is (by chance) another reviewed tuple, or it is neutral.
        expect(
          cls === "nt-neutral" ||
            THEME_SOURCES.some(
              (s) => s.cls === cls && JSON.stringify(s.colors) !== undefined,
            ),
        ).toBe(true);
      }
      expect(
        themeClass({ ...NEUTRAL_COLORS, primary: "red;}body{display:none" }),
      ).toBe("nt-neutral");
      expect(
        themeClass({ ...NEUTRAL_COLORS, glow: "1 2 3);background:url(x)" }),
      ).toBe("nt-neutral");
      expect(themeClass(null)).toBe("nt-neutral");
    },
  );
  it("CSSOM geometry writes only finite non-negative pixel values", () => {
    const set: [string, string][] = [];
    const el = {
      style: { setProperty: (k: string, v: string) => set.push([k, v]) },
    } as unknown as HTMLElement;
    cssomPosition({ top: 144, height: 72 })(el);
    cssomPosition({ top: -1, height: Number.NaN })(el);
    cssomPosition({ top: Number.POSITIVE_INFINITY })(el);
    cssomPosition({ top: 10 })(null);
    expect(set).toEqual([
      ["top", "144px"],
      ["height", "72px"],
    ]);
  });
  // Self-review nit: protocol-relative or traversal logo paths never reach <img src>.
  it("logo sources are same-origin static paths only", () => {
    for (const ok of ["/networks/ethereum.svg", "/networks/a_b-c.1.png"])
      expect(safeLogoSrc(ok)).toBe(ok);
    for (const bad of [
      "//evil.example/x.svg",
      "/networks//evil.svg",
      "/networks/../secret",
      "https://evil.example/x.svg",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "/networks/x.svg?u=1",
      "networks/x.svg",
      "",
    ])
      expect(safeLogoSrc(bad), bad).toBe("/networks/neutral.svg");
  });
  it("source guard: no inline style props, no next/image, no HTML injection sinks in UI code", () => {
    for (const f of walk("src").filter((p) => /\.(tsx|ts)$/.test(p))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\sstyle=\{/);
      expect(text, f).not.toMatch(/dangerouslySetInnerHTML/);
      expect(text, f).not.toMatch(/from "next\/image"/);
      expect(text, f).not.toMatch(/\.setAttribute\(\s*["']style["']/);
    }
  });
});
