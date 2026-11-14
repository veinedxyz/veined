// V1.11 public site: docs renderer safety, live documentation constants, docs freshness, social/SEO config and the
// landing/docs bundle boundary (no wallet, portfolio, routing client, firewall or G7 code reachable from them).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  plainText,
  renderMarkdown,
  safeHref,
  slugify,
} from "../../src/docs/markdown";
import {
  BSC_PIN_MAX_AGE_SEC,
  docConstants,
  substitute,
} from "../../src/docs/constants";
import { DOCS } from "../../src/docs/content.generated";
import { DOC_LOCALES, DOC_PAGES, docLocaleFor } from "../../src/docs/pages";
import { BSC_PIN_POLICY } from "../../src/g7/policy";
import { platformFeePolicy } from "../../src/routing/fee-policy";
import { G5_STATUS } from "../../src/g5/status";
import { GLOBAL_EXECUTION_ENABLED } from "../../src/g5/route-pins";
import {
  indexable,
  publicOrigin,
  safeExternalUrl,
  socialLinks,
} from "../../src/server/site";
import { publicBrandDenylist } from "../../src/content/public-labels";

const html = (md: string) =>
  renderToStaticMarkup(createElement("div", null, renderMarkdown(md).nodes));

describe("V1.11 docs renderer", () => {
  it("never emits raw HTML: tags, event handlers and script are escaped text", () => {
    const out = html(
      "# T\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n**<b>bold</b>**",
    );
    expect(out).not.toMatch(/<script|<img|<b>/i);
    expect(out).toContain("&lt;script&gt;");
  });
  it("links: same-site paths, anchors and https only; javascript:/data:/protocol-relative render as text", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "//evil.com",
      "http://evil.com",
      "/..//etc",
      "vbscript:x",
      "https://u:p@evil.com",
    ])
      expect(safeHref(bad), bad).toBeNull();
    expect(safeHref("/docs/safety")).toEqual({
      href: "/docs/safety",
      external: false,
    });
    expect(safeHref("#rpc-consensus")).toEqual({
      href: "#rpc-consensus",
      external: false,
    });
    expect(safeHref("https://example.org/a")?.external).toBe(true);
    const out = html("[x](javascript:alert(1)) [y](https://example.org)");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('rel="noopener noreferrer external"');
  });
  it("headings get stable unique ids; tables, lists, code and quotes render", () => {
    const r = renderMarkdown(
      "# Title\n\n## Same\n\n## Same\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two\n\n```\ncode <x>\n```\n\n> note",
    );
    expect(r.title).toBe("Title");
    expect(r.headings.map((h) => h.id)).toEqual(["same", "same-2"]);
    const out = renderToStaticMarkup(createElement("div", null, r.nodes));
    expect(out).toContain("<table>");
    expect(out).toContain("<li>two</li>");
    expect(out).toContain("code &lt;x&gt;");
    expect(out).toContain("<blockquote>");
    expect(slugify("Token seviyeleri")).toBe("token-seviyeleri");
    expect(plainText("**a** [b](/c) `d`")).toBe("a b d");
  });
});

describe("V1.11 docs content and live constants", () => {
  it("every page exists in English and Turkish and the generated module matches the Markdown sources", () => {
    for (const page of DOC_PAGES)
      for (const l of DOC_LOCALES)
        expect(DOCS[page][l].length, `${page}/${l}`).toBeGreaterThan(200);
    expect(() =>
      execFileSync(process.execPath, ["scripts/docs-build.mjs", "--check"], {
        stdio: "pipe",
      }),
    ).not.toThrow();
    expect(docLocaleFor("tr")).toBe("tr");
    expect(docLocaleFor("de")).toBe("en");
  });
  it("constants come from the product: fee policy, G5 status, execution gate, G7 pin policy", () => {
    const c = docConstants("en");
    expect(c.FEE_BPS).toBe(String(platformFeePolicy.bps));
    expect(c.G5_STATUS).toBe(G5_STATUS);
    expect(c.SENDING).toBe(GLOBAL_EXECUTION_ENABLED ? "enabled" : "disabled");
    expect(docConstants("tr").SENDING).toBe(
      GLOBAL_EXECUTION_ENABLED ? "açık" : "kapalı",
    );
    expect(BSC_PIN_MAX_AGE_SEC).toBe(BSC_PIN_POLICY.maxPinAgeSec);
    expect(() => substitute("{{NOT_A_CONSTANT}}", c)).toThrow(
      "UNKNOWN_DOC_CONSTANT",
    );
  });
  it("all docs resolve every token and contain no stale or overclaiming statements", () => {
    for (const page of DOC_PAGES)
      for (const l of DOC_LOCALES) {
        const md = substitute(DOCS[page][l], docConstants(l));
        expect(md, `${page}/${l}`).not.toMatch(/\{\{/);
        // stale V1.x facts
        expect(md, `${page}/${l}`).not.toMatch(
          /G5[^\n]{0,20}BLOCKED|G5 is blocked|G5 engell/i,
        );
        // no safety overclaims (negated forms are allowed in the safety page)
        expect(md, `${page}/${l}`).not.toMatch(
          /100\s*% (safe|güvenli)|guaranteed (safe|delivery)|fully audited|completely trustless/i,
        );
        expect(md, `${page}/${l}`).not.toMatch(publicBrandDenylist);
      }
    expect(substitute(DOCS.fees.en, docConstants("en"))).toContain(
      docConstants("en").FEE_PERCENT,
    );
  });
});

describe("V1.11 site configuration (SEO, social)", () => {
  it("social links: https on the official host with a real profile path; unset or invalid values are hidden (no placeholders)", () => {
    expect(socialLinks({})).toEqual([]);
    expect(
      socialLinks({
        OTHERBRIDGE_SOCIAL_X: "https://x.com/veinedxyz",
        OTHERBRIDGE_SOCIAL_X_CONFIRMED: "true",
        OTHERBRIDGE_SOCIAL_GITHUB: "https://evil.com/otherbridge",
        OTHERBRIDGE_SOCIAL_TELEGRAM: "http://t.me/x",
        OTHERBRIDGE_SOCIAL_DISCORD: "https://discord.gg/",
        OTHERBRIDGE_STATUS_URL: "javascript:alert(1)",
        OTHERBRIDGE_DOCS_URL: "#",
      }),
    ).toEqual([{ key: "x", href: "https://x.com/veinedxyz" }]);
    expect(safeExternalUrl("https://127.0.0.1/x", null, false)).toBeNull();
    expect(safeExternalUrl("https://status.example/x", null, false)).toBeNull();
    expect(safeExternalUrl("https://status.otherbridge.app", null, false)).toBe(
      "https://status.otherbridge.app/",
    );
  });
  it("indexing is opt-in and needs a canonical https origin", () => {
    expect(indexable({})).toBe(false);
    expect(indexable({ OTHERBRIDGE_PUBLIC_INDEXING: "true" })).toBe(false);
    expect(
      indexable({
        OTHERBRIDGE_PUBLIC_INDEXING: "true",
        OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
        OTHERBRIDGE_PUBLIC_ORIGIN: "https://veined.xyz",
      }),
    ).toBe(true);
    expect(
      publicOrigin({
        OTHERBRIDGE_PUBLIC_ORIGIN: "https://otherbridge.app/path",
      }),
    ).toBeNull();
    expect(
      publicOrigin({ OTHERBRIDGE_PUBLIC_ORIGIN: "http://otherbridge.app" }),
    ).toBeNull();
  });
});

describe("V1.11 landing/docs bundle boundary", () => {
  // Static import graph from the marketing route group: it must never reach the app shell or financial modules.
  const FORBIDDEN = [
    /src[\\/]components[\\/]product\.tsx$/,
    /src[\\/]features[\\/]wallet[\\/]/,
    /src[\\/]g7[\\/]/,
    /scripts[\\/]g7-pilot[\\/]/,
    /src[\\/]security[\\/]firewall\.ts$/,
    /src[\\/]portfolio[\\/]/,
    /src[\\/]routing[\\/]client\.ts$/,
    /src[\\/]adapters[\\/]/,
    /src[\\/]data[\\/]/,
    /@privy-io/,
  ];
  function graph(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const text = readFileSync(entry, "utf8");
    for (const m of text.matchAll(
      /(?:import|export)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g,
    )) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith("@privy-io")) seen.add(spec);
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(entry), spec);
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
      ])
        try {
          if (readFileSync(candidate) && /\.(ts|tsx)$/.test(candidate)) {
            graph(candidate, seen);
            break;
          }
        } catch {
          /* next candidate */
        }
    }
    return seen;
  }
  it("landing, docs and the marketing layout import no wallet, portfolio, routing client, firewall or G7 code", () => {
    const root = resolve("src/app/(marketing)");
    const entries = [
      join(root, "layout.tsx"),
      join(root, "page.tsx"),
      join(root, "docs", "[[...slug]]", "page.tsx"),
    ];
    for (const e of entries) {
      const reach = [...graph(e)];
      for (const f of FORBIDDEN)
        expect(
          reach.filter((x) => f.test(x)),
          `${e} reaches ${f}`,
        ).toEqual([]);
    }
    // the root layout no longer mounts the app shell
    expect(readFileSync("src/app/layout.tsx", "utf8")).not.toMatch(
      /components\/product|g7-local-pilot/,
    );
    expect(readdirSync("src/app")).not.toContain("[[...path]]");
  });
  it("no client module imports a locale dictionary statically (the browser receives it from the server)", () => {
    const clientFiles: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(ts|tsx)$/.test(f)) clientFiles.push(f);
      }
    };
    walk("src");
    // A value import (not `import type`) of any locales/<id>.json.
    const STATIC_LOCALE =
      /^import\s+(?!type\s)[^;]*from\s+["'][^"']*locales\/[a-zA-Z-]+\.json["']/m;
    const posix = (f: string) => f.split("\\").join("/");
    const offenders = clientFiles.map(posix).filter((f) => {
      // Server/test compatibility module (components import it for types only, checked below).
      if (f === "src/content/messages.ts") return false;
      return STATIC_LOCALE.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
    for (const f of clientFiles
      .map(posix)
      .filter((x) => x.startsWith("src/components/")))
      expect(readFileSync(f, "utf8")).not.toMatch(
        /^import\s+(?!type\s)[^;]*content\/messages["']/m,
      );
  });
});
