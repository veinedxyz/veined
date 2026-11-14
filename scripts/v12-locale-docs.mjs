import { readFile, writeFile } from "node:fs/promises";
const source = await readFile("src/i18n/config.ts", "utf8");
const entries = [
  ...source.matchAll(
    /id: "([^"]+)",[\s\S]*?nativeName: "([^"]+)",[\s\S]*?name: "([^"]+)",[\s\S]*?dir: "([^"]+)"/g,
  ),
].map((m) => ({ id: m[1], native: m[2], name: m[3], dir: m[4] }));
if (entries.length !== 24) throw Error("LOCALE_DOC_SET");
let doc =
  "# Shipped Otherbridge V1.2 locales\n\nAll 24 locales ship the exact canonical 313 message leaves. Build rejects missing, obsolete, empty or malformed keys. A locale is active only after its complete dictionary validates. No per-key English fallback is used.\n\n| Locale | Native name | Direction | Keys |\n|---|---|---|---|\n";
for (const l of entries)
  doc += `| ${l.id} | ${l.native} | ${l.dir.toUpperCase()} | 313 |\n`;
doc +=
  "\nEnglish is the fallback for an unsupported locale preference/browser language, not missing translations. Locale URLs are unchanged. See I18N_ARCHITECTURE.md for preference precedence and I18N_TEST_MATRIX.md for test boundaries.\n";
await writeFile("docs/I18N_LOCALES.md", doc);
const terms = {
  Wallet: "product.wallet",
  "Source network": "product.from",
  "Destination network": "product.to",
  Fee: "kinds.fee",
  Balance: "product.balance",
  "Expected delivery": "product.receive",
  "Reserve accounting bound": "product.reserveBound",
  "Read only": "ui.readOnly",
  "Observed minimum": "product.observedMinimum",
  "Confirmation / delivery warning": "product.boundNote",
};
const get = (d, k) => k.split(".").reduce((v, p) => v[p], d);
let glossary =
  "# Otherbridge V1.2 terminology\n\nFinancial wording must distinguish amount from fee, custody from spendable reserve, source confirmation from destination delivery, and historical evidence from a current executable quote. A reverted simulation is failure. G5 remains incomplete and real sending disabled in every locale. Proper names, asset symbols, hashes, token/network IDs and API codes remain technical identifiers.\n\nCanonical glossary below is derived from the shipped dictionaries, including the complete reserve warning so the bound is never presented as verified spendable liquidity. New locale terms received semantic review; independent native-speaker certification was not performed.\n";
for (const l of entries) {
  const d = JSON.parse(await readFile(`src/i18n/locales/${l.id}.json`, "utf8"));
  glossary += `\n## ${l.native} (${l.id})\n\n| Canonical concept | Shipped text |\n|---|---|\n`;
  for (const [name, key] of Object.entries(terms))
    glossary += `| ${name} | ${get(d, key).replaceAll("\n", " ").replaceAll("|", "\\|")} |\n`;
}
await writeFile("docs/I18N_GLOSSARY.md", glossary);
console.log("Locale and glossary docs: 24 locales");
