import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  locales,
  localeDirection,
  resolveLocale,
  acceptedLanguages,
} from "../../src/i18n/config";
import {
  flatten,
  getDictionary,
  loadDictionary,
  validateDictionary,
  translate,
  plural,
  errorMessage,
  stateMessage,
  parameters,
} from "../../src/i18n/messages";
import {
  normalizeAmountInput,
  formatTokenAmount,
  formatFiat,
  formatPercent,
  formatRelative,
} from "../../src/i18n/amounts";
import {
  publicBrandDenylist,
  publicFeeLabel,
  publicToolLabel,
  publicStepKindLabel,
} from "../../src/content/public-labels";
import { currentReserveEvidence } from "../../src/adapters/reserve-evidence";
describe("24 complete local dictionaries and safe financial language", () => {
  it("real provider protocol steps and unknown kinds are safe in every locale", async () => {
    for (const { id } of locales) {
      const dictionary = await loadDictionary(id);
      expect(publicStepKindLabel("protocol", id)).toBe(
        dictionary.kinds.protocol,
      );
      expect(publicStepKindLabel("NEW_PROVIDER_KIND", id)).toBe(
        dictionary.kinds.unknown,
      );
    }
  });
  it.each(locales)(
    "$id schema, interpolation, formatting, plural, direction and public brand",
    async ({ id, dir }) => {
      const dictionary = await loadDictionary(id);
      expect(() => validateDictionary(dictionary)).not.toThrow();
      expect(Object.keys(flatten(dictionary)).length).toBe(
        Object.keys(flatten(getDictionary("en"))).length,
      );
      expect(JSON.stringify(dictionary)).not.toMatch(publicBrandDenylist);
      expect(localeDirection(id)).toBe(dir);
      expect(translate(id, "product.writeDisabled")).toBeTruthy();
      expect(errorMessage(id, "RAW_VENDOR_ERROR_SECRET")).toBe(
        translate(id, "errors.PROVIDER_UNAVAILABLE"),
      );
      expect(stateMessage(id, "UNKNOWN_PROVIDER_STATUS")).toBe(
        translate(id, "states.UNKNOWN"),
      );
      for (const count of [0, 1, 2, 3, 11, 101])
        expect(plural(id, "networks", count)).toContain(
          new Intl.NumberFormat(id).format(count),
        );
      expect(new Intl.DateTimeFormat(id).format(new Date(0))).toBeTruthy();
      expect(formatFiat(1.25, id)).toBeTruthy();
      expect(formatPercent(0.5, id)).toBeTruthy();
      expect(formatRelative(-2, id)).toBeTruthy();
      expect(publicToolLabel("LI.FI Intents", id)).not.toMatch(
        publicBrandDenylist,
      );
      expect(publicFeeLabel("Jumper fee", id)).not.toMatch(publicBrandDenylist);
      if (!["en", "tr"].includes(id))
        for (const key of [
          "product.writeDisabled",
          "product.boundNote",
          "product.riskReview",
          "errors.SUBMISSION_UNKNOWN",
          "errors.MANUAL_ACTION_REQUIRED",
        ] as const)
          expect(translate(id, key)).not.toBe(translate("en", key));
    },
  );
  it("schema fails closed on missing, obsolete, empty, rich markup and parameter drift", () => {
    for (const mutation of [
      (d: Record<string, unknown>) => delete d.product,
      (d: Record<string, unknown>) => (d.extra = "obsolete"),
      (d: Record<string, unknown>) =>
        ((d.meta as Record<string, unknown>).title = ""),
      (d: Record<string, unknown>) =>
        ((d.meta as Record<string, unknown>).title =
          "<a href='https://unsafe'>x</a>"),
      (d: Record<string, unknown>) =>
        ((d.ui as Record<string, unknown>).seconds = "{missing}"),
    ]) {
      const clone = structuredClone(getDictionary("en"));
      mutation(clone);
      expect(() => validateDictionary(clone)).toThrow();
    }
    expect(parameters("{recipient.address} and {amount.baseUnits}")).toEqual([
      "amount.baseUnits",
      "recipient.address",
    ]);
    expect(() => translate("en", "ui.seconds")).toThrow(
      "INVALID_INTERPOLATION",
    );
  });
  it("SSR preference and browser matching are independent of wallet or network", () => {
    expect(resolveLocale("ar", ["tr-TR"])).toBe("ar");
    expect(resolveLocale("invalid", ["es-MX"])).toBe("es");
    expect(resolveLocale(undefined, ["zh-Hant-HK"])).toBe("zh-TW");
    expect(resolveLocale(undefined, ["pt-PT"])).toBe("pt-BR");
    expect(resolveLocale(undefined, ["unsupported"])).toBe("en");
    expect(
      resolveLocale(undefined, acceptedLanguages("de;q=0,ja;q=0.9,en;q=0.5")),
    ).toBe("ja");
  });
  it.each([
    ["1,5", "tr", 18, "1.5"],
    ["1.5", "tr", 18, "1.5"],
    ["1.5", "en", 18, "1.5"],
    ["١٫٥", "ar", 18, "1.5"],
    ["1٫5", "ar", 18, "1.5"],
    ["1.5", "ar", 18, "1.5"],
    ["۱٫۵", "fa", 18, "1.5"],
    ["１.５", "ja", 18, "1.5"],
    ["0.123456789012345678", "en", 18, "0.123456789012345678"],
  ] as const)("canonical %s (%s)", (raw, locale, decimals, canonical) =>
    expect(normalizeAmountInput(raw, locale, decimals)).toBe(canonical),
  );
  it.each([
    ["1,5", "en"],
    ["1,234", "tr"],
    ["1.234", "de"],
    ["1٬234", "ar"],
    ["1,234.5", "en"],
    ["1.234,5", "tr"],
    ["1 234", "fr"],
    ["1 234", "fr"],
    ["1 234", "en"],
    ["1.1234567890123456789", "en"],
    ["1e18", "en"],
    ["١٫٥٫٢", "ar"],
    ["-1", "en"],
    ["01.5", "en"],
  ] as const)("ambiguous/malformed %s (%s) is rejected", (raw, locale) =>
    expect(() => normalizeAmountInput(raw, locale, 18)).toThrow(),
  );
  it("token display uses bigint across values beyond JS safe integers", () => {
    expect(
      formatTokenAmount(900719925474099312345678901234567890n, 18, "en", 18),
    ).toBe("900,719,925,474,099,312.34567890123456789");
    expect(formatTokenAmount(1500000000000000000n, 18, "ar", 18)).toBe("١٫٥");
    expect(currentReserveEvidence().verified).toBe(false);
  });
  it("feature code has no language branches, dictionary fetch service or raw status fallback", () => {
    for (const file of [
      "product",
      "multichain-bridge",
      "multichain-catalog",
      "network-selector",
      "routing-activity",
      "routing-observation",
    ]) {
      const text = readFileSync(`src/components/${file}.tsx`, "utf8");
      expect(text).not.toMatch(
        /lang\s*===\s*["'](?:tr|en)["']|const tr =|text\(\s*["']/,
      );
      expect(text).not.toMatch(
        /translate\.google|translate_a|state\.replaceAll/,
      );
    }
  });
});
