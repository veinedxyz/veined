import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const directory = "src/i18n/locales";
const flatten = (value, prefix = "") =>
  typeof value === "string"
    ? { [prefix]: value }
    : Object.assign(
        {},
        ...Object.entries(value).map(([key, child]) =>
          flatten(child, prefix ? `${prefix}.${key}` : key),
        ),
      );
const params = (text) =>
  [
    ...new Set([...text.matchAll(/\{([a-zA-Z][\w.]*)\}/g)].map((m) => m[1])),
  ].sort();
const en = flatten(JSON.parse(await readFile(`${directory}/en.json`, "utf8"))),
  results = [];
const files = (await readdir(directory)).filter((name) =>
  name.endsWith(".json"),
);
const expected = [
  "tr",
  "en",
  "es",
  "pt-BR",
  "fr",
  "de",
  "it",
  "nl",
  "pl",
  "ru",
  "uk",
  "ar",
  "fa",
  "he",
  "ur",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "hi",
  "bn",
  "id",
  "vi",
  "th",
];
if (
  files.length !== expected.length ||
  expected.some((locale) => !files.includes(`${locale}.json`))
)
  throw Error("LOCALE_SET_MISMATCH");
for (const file of files) {
  const raw = await readFile(`${directory}/${file}`, "utf8"),
    d = flatten(JSON.parse(raw));
  const missing = Object.keys(en).filter((k) => !(k in d)),
    obsolete = Object.keys(d).filter((k) => !(k in en)),
    malformed = Object.keys(d).filter(
      (k) =>
        !d[k].trim() ||
        /[<>]/.test(d[k]) ||
        JSON.stringify(params(en[k] ?? "")) !== JSON.stringify(params(d[k])),
    );
  const result = {
    locale: file.slice(0, -5),
    keys: Object.keys(d).length,
    missing,
    obsolete,
    malformed,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
  results.push(result);
}
const report = {
  at: new Date().toISOString(),
  canonical: "en",
  results,
  pass: results.every(
    (r) => !r.missing.length && !r.obsolete.length && !r.malformed.length,
  ),
};
if (process.env.OTHERBRIDGE_EVIDENCE_ROOT) {
  await mkdir(process.env.OTHERBRIDGE_EVIDENCE_ROOT, { recursive: true });
  await writeFile(
    `${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/i18n-schema.json`,
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
