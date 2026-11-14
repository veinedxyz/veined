// Offline authoring aid only. This script is never imported by the application.
// Drafts require financial/safety terminology and semantic review before delivery.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const en = JSON.parse(await readFile("src/i18n/locales/en.json", "utf8"));
const flatten = (value, prefix = "") =>
  typeof value === "string"
    ? { [prefix]: value }
    : Object.assign(
        {},
        ...Object.entries(value).map(([key, child]) =>
          flatten(child, prefix ? `${prefix}.${key}` : key),
        ),
      );
const entries = Object.entries(flatten(en));
const tokens = [
  "Otherbridge",
  "ONEchain",
  "ONEbridge",
  "CROSS",
  "ONECHAIN",
  "BNB SMART CHAIN",
  "ONE",
  "BNB",
  "BSC",
  "ERC20",
  "CEX",
  "DEX",
  "RPC",
  "MAX",
  "USD",
  "G5",
  "V1",
  "V2",
  "V3",
  "ABI",
  "EVM",
  "150 KB",
  "{count}",
];
const protect = (text) =>
  tokens.reduce(
    (text, token, i) =>
      text.replace(
        new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        `ZXQ${String(i).padStart(3, "0")}QXZ`,
      ),
    text,
  );
const restore = (text) =>
  tokens.reduce(
    (text, token, i) =>
      text.replaceAll(`ZXQ${String(i).padStart(3, "0")}QXZ`, token),
    text,
  );
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
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
const base = `${(await readFile(".otherbridge/v12-evidence-path.txt", "utf8")).trim()}/i18n-authoring`;
await mkdir(base, { recursive: true });
const audit = [];
for (const locale of targets) {
  const values = {},
    batches = [];
  let batch = [],
    length = 0;
  for (const [key, value] of entries) {
    const line = `[[${entries.findIndex(([k]) => k === key)}]] ${protect(value).replaceAll("\n", " ")}`;
    if (length + line.length > 3800 && batch.length) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push({ key, line });
    length += line.length + 1;
  }
  if (batch.length) batches.push(batch);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b],
      q = batch.map((entry) => entry.line).join("\n");
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    for (const [k, v] of Object.entries({
      client: "gtx",
      sl: "en",
      tl: locale,
      dt: "t",
      q,
    }))
      url.searchParams.set(k, v);
    let result;
    try {
      result = JSON.parse(
        await readFile(`${base}/${locale}-${b}.json`, "utf8"),
      ).result;
    } catch {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok) throw Error(`DRAFT_HTTP:${locale}:${response.status}`);
      result = await response.json();
      await writeFile(
        `${base}/${locale}-${b}.json`,
        JSON.stringify(
          {
            locale,
            batch: b,
            at: new Date().toISOString(),
            source: batch,
            result,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    }
    const text = result[0]
      .map((segment) => segment[0])
      .join("")
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));
    const matches = [
      ...text.matchAll(
        /^\s*\[{1,2}\s*([0-9]+)\s*\]{1,2}\s*([\s\S]*?)(?=\n\s*\[{1,2}\s*[0-9]+\s*\]{1,2}|$)/gm,
      ),
    ];
    if (matches.length !== batch.length) {
      // Discard the entire misaligned batch. No neighbor text or fallback is shipped.
      for (let start = 0; start < batch.length; start += 3)
        await Promise.all(
          batch.slice(start, start + 3).map(async (entry) => {
            const index = entries.findIndex(([key]) => key === entry.key),
              original = entries[index][1];
            let single;
            try {
              single = JSON.parse(
                await readFile(
                  `${base}/${locale}-single-${index}.json`,
                  "utf8",
                ),
              ).result;
            } catch {
              const singleUrl = new URL(url);
              singleUrl.searchParams.set("q", protect(original));
              const response = await fetch(singleUrl, {
                signal: AbortSignal.timeout(15000),
                redirect: "error",
              });
              if (!response.ok)
                throw Error(`DRAFT_HTTP:${locale}:${response.status}`);
              single = await response.json();
              await writeFile(
                `${base}/${locale}-single-${index}.json`,
                JSON.stringify({
                  locale,
                  key: entry.key,
                  original,
                  result: single,
                }),
                { flag: "wx" },
              );
            }
            const translated = restore(
              single[0].map((segment) => segment[0]).join(""),
            );
            if (/ZXQ|QXZ/.test(translated))
              throw Error(`PROTECTED_TOKEN_CORRUPTED:${locale}:${entry.key}`);
            values[entry.key] = translated;
            if (
              original === "0" ||
              original === "MAX" ||
              entry.key === "product.eyebrow"
            )
              values[entry.key] = original;
          }),
        );
      continue;
    }
    for (const match of matches) {
      const index = Number(match[1]),
        [key, original] = entries[index];
      const translated = restore(match[2].trim());
      if (/ZXQ|QXZ/.test(translated))
        throw Error(`PROTECTED_TOKEN_CORRUPTED:${locale}:${key}`);
      values[key] = translated;
      if (original === "0" || original === "MAX" || key === "product.eyebrow")
        values[key] = original;
    }
  }
  const dictionary = {};
  for (const [key, value] of Object.entries(values)) {
    const parts = key.split(".");
    let object = dictionary;
    for (const part of parts.slice(0, -1)) object = object[part] ??= {};
    object[parts.at(-1)] = value;
  }
  const raw = JSON.stringify(dictionary, null, 2) + "\n";
  await writeFile(`src/i18n/locales/${locale}.json`, raw, { flag: "wx" });
  audit.push({
    locale,
    keys: Object.keys(values).length,
    sha256: createHash("sha256").update(raw).digest("hex"),
    state: "DRAFT_REQUIRES_SEMANTIC_REVIEW",
  });
  await writeFile(`${base}/drafts.json`, JSON.stringify(audit, null, 2));
  console.log(`${locale}: ${Object.keys(values).length} offline draft keys`);
}
