import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  neutralToolName,
  neutralFeeName,
  publicToolLabel,
  publicFeeLabel,
} from "../../src/content/public-labels";
import { messages } from "../../src/content/messages";
import { normalizeQuote } from "../../src/routing/normalize";
import { normalizeTools, assetSchema } from "../../src/routing/catalog";
import { fixtureCatalog, fixtureInput } from "../fixtures/routing";
import rawQuote from "../fixtures/routing-live-eth-base.json" with { type: "json" };
const denylist =
  /(?<![\p{L}\p{N}])li[ .-]?fi(?![\p{L}\p{N}])|jumper|routing\s+infrastructure|rota\s+altyap[ıi]s[ıi]|powered\s+by/iu;
function publicDocs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "INTERNAL"
        ? []
        : publicDocs(`${dir}/${entry.name}`)
      : entry.name.endsWith(".md")
        ? [`${dir}/${entry.name}`]
        : [],
  );
}
describe("Public brand copy regression", () => {
  it("recognizes brand tokens without mistaking Turkish teklifi/teklifin for a brand", () => {
    expect(neutralToolName("Teklifin durumu")).toBe("Teklifin durumu");
    expect(neutralFeeName("Sentetik UI test teklifi")).toBe(
      "Sentetik UI test teklifi",
    );
    expect(publicToolLabel("LIFI_intents", "en")).toBe("Intent routing");
    expect(publicToolLabel("li.fi", "en")).toBe("Route service");
  });
  it.each([
    "LI.FI Fixed Fee",
    "LIFI Fixed Fee",
    "Routing infrastructure Fixed Fee",
    "Jumper fee",
    "powered by LI-FI",
    "Integrator Fee",
  ])("neutralizes vendor fee %s without charging as Otherbridge", (raw) => {
    expect(neutralFeeName(raw)).toBe("Route service fee");
    expect(publicFeeLabel(raw, "tr")).toBe("Rota hizmet ücreti");
    expect(publicFeeLabel(raw, "en")).toBe("Route service fee");
    expect(publicFeeLabel(raw, "en")).not.toContain("Otherbridge");
  });
  it.each([
    "LI.FI Intents",
    "lifi DEX Aggregator",
    "JUMPER.EXCHANGE",
    "Integrator Fee",
    "feeCollection",
    "Routing infrastructure",
  ])(
    "neutralizes dynamic provider tool %s including old fallback IDs",
    (raw) => {
      expect(neutralToolName(raw)).not.toMatch(denylist);
      expect(publicToolLabel(raw, "tr")).not.toMatch(denylist);
      expect(publicToolLabel(raw, "en")).not.toMatch(denylist);
    },
  );
  it.each(["AcrossV4", "Stargate", "CCTP", "Bridge fee"])(
    "preserves true protocol/cost identity %s",
    (name) => {
      expect(neutralToolName(name)).toBe(name);
      expect(neutralFeeName(name)).toBe(name);
    },
  );
  it("normalizes tool display names while preserving raw keys and kinds", () => {
    expect(
      normalizeTools({
        bridges: [
          { key: "lifi-intents", name: "LI.FI Intents" },
          { key: "acrossv4", name: "AcrossV4" },
        ],
        exchanges: [{ key: "lifi-dex", name: "LI.FI DEX Aggregator" }],
      }),
    ).toEqual([
      { id: "lifi-intents", name: "Intent routing", kind: "bridge" },
      { id: "acrossv4", name: "AcrossV4", kind: "bridge" },
      { id: "lifi-dex", name: "Exchange routing", kind: "exchange" },
    ]);
  });
  it("real captured quote fee amounts, tokens, included flags and cost order remain exact", () => {
    const quote = normalizeQuote(rawQuote, fixtureInput(), fixtureCatalog());
    const fees = rawQuote.estimate.feeCosts;
    expect(
      quote.fees
        .filter((f) => f.kind === "fee")
        .map(({ amount, usd, asset, included }) => ({
          amount,
          usd,
          asset,
          included,
        })),
    ).toEqual(
      fees.map((f) => ({
        amount: f.amount,
        usd: f.amountUSD,
        asset: assetSchema.parse(f.token),
        included: f.included ?? false,
      })),
    );
    expect(
      quote.fees.filter((f) => f.kind === "fee").map((f) => f.name),
    ).toContain("Route service fee");
    expect(quote.steps.map((s) => s.toolName).join(" ")).not.toMatch(denylist);
    expect(quote.steps.find((s) => s.tool === "feeCollection")?.toolName).toBe(
      "Route service fee",
    );
    expect(quote.executable).toBe(false);
  });
  it("both locale dictionaries retain risk copy without infrastructure/footer attribution", () => {
    expect(JSON.stringify(messages)).not.toMatch(denylist);
    for (const lang of ["tr", "en"] as const) {
      expect(messages[lang].footer).not.toMatch(
        /altyap|infrastructure|ONEbridge/i,
      );
      expect(messages[lang].safety).not.toMatch(/altyap|infrastructure/i);
    }
  });
  it("all normal public docs are neutral with explicit internal/legal-only exceptions", () => {
    const files = [
      "README.md",
      "OTHERBRIDGE_V1_HANDOFF.md",
      ...publicDocs("docs"),
    ];
    expect(files).toContain("docs/MULTICHAIN_NETWORK_CATALOG.md");
    expect(files).not.toContain("docs/INTERNAL/THIRD_PARTY_NOTICES.md");
    for (const path of files)
      expect(readFileSync(path, "utf8"), path).not.toMatch(denylist);
    expect(readFileSync("package.json", "utf8")).toContain("@lifi/sdk");
    expect(
      readFileSync("docs/INTERNAL/THIRD_PARTY_NOTICES.md", "utf8"),
    ).toContain("@lifi/sdk");
  });
});
