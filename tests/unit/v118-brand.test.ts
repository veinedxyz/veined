import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { brand } from "../../src/content/brand";
import { brandMetadata } from "../../src/server/brand-metadata";
import { indexable, socialLinks } from "../../src/server/site";
import manifest from "../../src/app/manifest";
import sitemap from "../../src/app/sitemap";
import robots from "../../src/app/robots";
import {
  locales,
  localeDirection,
  localeCookie,
  localePreference,
} from "../../src/i18n/config";
import { flatten, loadDictionary, translate } from "../../src/i18n/messages";
import { GLOBAL_EXECUTION_ENABLED } from "../../src/g5/route-pins";
import { platformFeePolicy } from "../../src/routing/fee-policy";
import { DOCS } from "../../src/docs/content.generated";
import { docConstants, substitute } from "../../src/docs/constants";

afterEach(() => vi.unstubAllEnvs());
describe("V1.18 public identity and compatibility", () => {
  it("has one canonical identity and visual-only owner approval with external gates open", () => {
    expect(brand.name).toBe("VEINED");
    expect(brand.publicOrigin).toBe("https://veined.xyz");
    expect(brand.social.x).toEqual({ handle: "@veinedxyz", confirmed: false });
    expect(brand.assetStatus).toBe("OWNER_APPROVED_VISUAL_IDENTITY");
    expect(brand.ownerLogoApproval).toBe("OWNER_APPROVED_VISUAL_IDENTITY");
    const approval = JSON.parse(
      readFileSync(brand.visualApprovalRecord, "utf8"),
    );
    expect(approval.status).toBe(brand.ownerLogoApproval);
    expect(approval.acceptedSourceCheckpoint).toBe(
      "bc58358415084b5c069ee1cbe397435a4d440f172e25e1ac62183604468960ee",
    );
    expect(brand.legalTrademarkClearance).toBe("OPEN");
    expect(brand.sloganApproval).toBe("NOT_APPROVED");
    expect(brand.productionReleaseApproval).toBe("OPEN");
    expect(approval.execution).toBe("CLOSED");
    expect(brand.recommendedConcept).toBe("quiet-current");
    expect(Object.isFrozen(brand)).toBe(true);
  });
  it.each(locales.map((row) => row.id))(
    "%s preserves localized text, placeholders and untranslatable identity",
    async (locale) => {
      const dictionary = await loadDictionary(locale);
      const values = Object.values(flatten(dictionary));
      expect(values.join("\n")).not.toMatch(/other[- ]?bridge/i);
      expect(translate(locale, "meta.title")).toContain(brand.name);
      expect(translate(locale, "landing.metaTitle")).toContain(brand.name);
      expect(translate(locale, "docs.metaSuffix")).toContain(brand.name);
      expect(values.some((s) => s.includes(brand.name))).toBe(true);
    },
  );
  it.each(["ar", "fa", "he", "ur"] as const)(
    "%s retains RTL direction",
    (locale) => {
      expect(localeDirection(locale)).toBe("rtl");
    },
  );
  it("preserves cookie and local-storage contracts", () => {
    expect(localeCookie).toBe("otherbridge.locale");
    expect(localePreference).toBe("otherbridge.language");
  });
  it("metadata is canonical but does not infer that the planned host is deployed", () => {
    vi.stubEnv("OTHERBRIDGE_PUBLIC_INDEXING", "false");
    const m = brandMetadata("VEINED Portfolio", "Read-only coverage", "/docs");
    expect(new URL(String(m.metadataBase)).origin).toBe(brand.publicOrigin);
    expect(m.alternates?.canonical).toBe("/docs");
    expect(m.openGraph).toMatchObject({
      siteName: brand.name,
      url: "/docs",
      images: [{ url: "/assets/veined/brand-octopus/og-image.png" }],
    });
    expect(m.twitter).toMatchObject({ card: "summary_large_image" });
    expect(m.twitter).not.toHaveProperty("site");
    expect(m.robots).toMatchObject({ index: false, follow: false });
  });
  it("indexing needs a separately authorized public deployment and exact planned canonical origin", () => {
    const base = {
      OTHERBRIDGE_PUBLIC_INDEXING: "true",
      OTHERBRIDGE_PUBLIC_ORIGIN: brand.publicOrigin,
    };
    expect(indexable(base)).toBe(false);
    expect(indexable({ ...base, OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true" })).toBe(
      true,
    );
    for (const origin of [
      "http://127.0.0.1:3101",
      "https://otherbridge.io",
      "https://preview.veined.xyz",
      "https://veined.xyz/path",
    ])
      expect(
        indexable({
          ...base,
          OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
          OTHERBRIDGE_PUBLIC_ORIGIN: origin,
        }),
      ).toBe(false);
  });
  it("preview robots deny crawling and the sitemap is empty", () => {
    vi.stubEnv("OTHERBRIDGE_PUBLIC_DEPLOYMENT", "false");
    vi.stubEnv("OTHERBRIDGE_PUBLIC_INDEXING", "true");
    vi.stubEnv("OTHERBRIDGE_PUBLIC_ORIGIN", brand.publicOrigin);
    expect(sitemap()).toEqual([]);
    expect(robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });
  it("future public sitemap never contains private portfolio/activity/settings or wallet addresses", () => {
    vi.stubEnv("OTHERBRIDGE_PUBLIC_DEPLOYMENT", "true");
    vi.stubEnv("OTHERBRIDGE_PUBLIC_INDEXING", "true");
    vi.stubEnv("OTHERBRIDGE_PUBLIC_ORIGIN", brand.publicOrigin);
    const urls = sitemap().map((row) => row.url);
    expect(urls.length).toBeGreaterThan(10);
    expect(urls.every((url) => url.startsWith(brand.publicOrigin))).toBe(true);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.pathname).not.toMatch(
        /^\/(portfolio|activity|settings)(\/|$)/,
      );
      expect(parsed.search).toBe("");
    }
  });
  it("unconfirmed social handles do not become live links", () => {
    expect(
      socialLinks({ OTHERBRIDGE_SOCIAL_X: "https://x.com/veinedxyz" }),
    ).toEqual([]);
    expect(socialLinks({})).toEqual([]);
  });
  it("web manifest and vector icons identify the owner-review candidate", () => {
    expect(manifest()).toMatchObject({
      name: brand.name,
      short_name: brand.name,
      start_url: "/",
    });
    // Guardian finalization preview: the vector icon embeds the owner-approved octopus raster verbatim (no tracing),
    // and it is exactly the published 128 px tile.
    const icon = readFileSync("src/app/icon.svg", "utf8");
    expect(icon).toContain("owner-approved artwork");
    expect(icon).not.toContain("M5 23V13");
    const embedded = /href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(
      icon,
    )?.[1];
    expect(embedded).toBeTruthy();
    expect(Buffer.from(embedded!, "base64")).toEqual(
      readFileSync("public/assets/veined/brand-octopus/tile-128.png"),
    );
    expect(brand.previewIdentity).toMatchObject({
      candidate: "octopus-v1",
      sourceSha256:
        "7ec4859a5c6dbe3b682423d5b7bd0a38b087e988e76bf9c55ffcd3f87aac0274",
      canonical: "NOT_APPLIED",
    });
    expect(manifest().icons).toContainEqual({
      src: "/assets/veined/brand-octopus/maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    });
  });
  it("all public EN/TR docs resolve the shared brand constant with no legacy presentation", () => {
    for (const translations of Object.values(DOCS))
      for (const locale of ["en", "tr"]) {
        const text = substitute(
          translations[locale as "en" | "tr"],
          docConstants(locale),
        );
        expect(text).not.toMatch(/otherbridge|\{\{BRAND\}\}/i);
      }
    expect(readdirSync("src/i18n/locales").length).toBe(24);
  });
  it("preserves all 107 active protected hashes, zero fee and closed financial execution", () => {
    const pointer = readFileSync(
      ".otherbridge/g7-protected-baseline.txt",
      "utf8",
    ).trim();
    const hashes = JSON.parse(readFileSync(pointer, "utf8")) as Record<
      string,
      string
    >;
    expect(Object.keys(hashes)).toHaveLength(107);
    for (const [path, expected] of Object.entries(hashes))
      expect(
        createHash("sha256").update(readFileSync(path)).digest("hex"),
        path,
      ).toBe(expected);
    expect(GLOBAL_EXECUTION_ENABLED).toBe(false);
    expect(platformFeePolicy.bps).toBe(0);
  });
});
