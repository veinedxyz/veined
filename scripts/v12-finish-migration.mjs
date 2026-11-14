import { readFile, writeFile } from "node:fs/promises";
for (const locale of ["en", "tr"]) {
  const path = `src/i18n/locales/${locale}.json`,
    d = JSON.parse(await readFile(path, "utf8")),
    tr = locale === "tr";
  Object.assign(d.ui, {
    searchLanguages: tr ? "Dil ara" : "Search languages",
    explorer: tr ? "Blok gezgini" : "Block explorer",
    slippage: tr ? "Fiyat kayması toleransı" : "Slippage tolerance",
    testnet: tr ? "Test ağı" : "Test network",
    custom: tr ? "Otherbridge özel rota" : "Otherbridge custom route",
    g5Blocked: tr
      ? "ONEchain · G5 doğrulaması eksik"
      : "ONEchain · G5 verification incomplete",
    readOnly: tr ? "Salt okunur" : "Read only",
    seconds: tr ? "{count} sn" : "{count} s",
    routeServiceFee: tr ? "Rota hizmet ücreti" : "Route service fee",
    networkFee: tr ? "Ağ ücreti" : "Network fee",
    intentRouting: tr ? "Niyet tabanlı rota" : "Intent routing",
    exchangeRouting: tr ? "Değişim rotası" : "Exchange routing",
    routeService: tr ? "Rota hizmeti" : "Route service",
  });
  Object.assign(d.states, {
    UNKNOWN: tr ? "Doğrulanamadı" : "Unverified",
    PENDING: tr ? "Bekliyor" : "Pending",
    PARTIAL: tr ? "Kısmi teslimat" : "Partial delivery",
    REFUNDED: tr ? "İade bildirildi" : "Refund reported",
    FAILED: tr ? "Başarısız" : "Failed",
    SOURCE_SUBMITTED: tr
      ? "Kaynak işlemi kaydedildi"
      : "Source transaction recorded",
    REORG_DETECTED: tr
      ? "Zincir yeniden düzenlendi; yeniden doğrula"
      : "Chain reorganized; revalidate",
    USER_REJECTED: tr ? "İstek reddedildi" : "Request rejected",
    MANUAL_ACTION_REQUIRED: tr
      ? "Manuel doğrulama gerekli"
      : "Manual verification required",
  });
  Object.assign(d.errors, {
    SOURCE_BUILD_MATCH_UNVERIFIED: tr
      ? "Kaynak sözleşmenin deployment build eşleşmesi doğrulanmadı. Gönderim kapalı."
      : "Source deployment build equivalence is unverified. Sending is disabled.",
    DESTINATION_BUILD_MATCH_UNVERIFIED: tr
      ? "Hedef sözleşmenin deployment build eşleşmesi doğrulanmadı. Gönderim kapalı."
      : "Destination deployment build equivalence is unverified. Sending is disabled.",
    INVALID_ADDRESS: d.routingErrors.INVALID_ADDRESS,
    INSUFFICIENT_BALANCE: tr
      ? "Tutar için bakiye yetersiz."
      : "Balance is insufficient for the amount.",
    INSUFFICIENT_GAS: tr
      ? "Kaynak gas bakiyesi yetersiz."
      : "Source gas balance is insufficient.",
    NETWORK_SWITCH_REJECTED: tr
      ? "Cüzdanda ağ değişikliği reddedildi."
      : "Network switch rejected in the wallet.",
    INVALID_RESPONSE: d.routingErrors.INVALID_RESPONSE,
    NO_EXECUTABLE_ROUTE: d.routingErrors.NO_EXECUTABLE_ROUTE,
  });
  d.meta = {
    title: tr
      ? "Otherbridge — Ağlar arası transfer"
      : "Otherbridge — Transfers between networks",
    description: tr
      ? "Ağları, varlıkları ve transfer risklerini incele. Salt okunur rota gözlemi; gerçek gönderim kapalı."
      : "Review networks, assets and transfer risks. Read-only route observation; real sending is disabled.",
  };
  d.kinds = {
    bridge: tr ? "Köprü" : "Bridge",
    exchange: tr ? "Değişim" : "Exchange",
    fee: tr ? "Ücret" : "Fee",
    gas: tr ? "Gas" : "Gas",
    unknown: tr ? "Bilinmiyor" : "Unknown",
  };
  d.counts = {
    networks: {
      one: tr ? "{count} ağ" : "{count} network",
      other: tr ? "{count} ağ" : "{count} networks",
    },
  };
  d.product.amountHint = tr
    ? "Yerel ondalık ayracını veya nokta kullan. En fazla 18 ondalık basamak; binlik ayraç ve boşluk kabul edilmez. Belirsiz giriş reddedilir."
    : "Use your locale decimal separator or a point. At most 18 decimal places; grouping and spaces are rejected. Ambiguous input is rejected.";
  d.errors.AMBIGUOUS_LOCALE = tr
    ? "Belirsiz tutar. Binlik ayraç ve boşlukları kaldır; yerel ondalık ayracını kullan."
    : "Ambiguous amount. Remove grouping separators and spaces; use the locale decimal separator.";
  await writeFile(path, JSON.stringify(d, null, 2) + "\n");
}
let product = await readFile("src/components/product.tsx", "utf8");
product = product
  .replace('import type { Locale } from "../i18n/config";\n', "")
  .replace("t: translate, setLocale: setLang", "t: translate");
product = product.replace(
  "import { formatAmount, maximum, parseAmount }",
  "import { maximum, parseAmount }",
);
product = product.replace(
  'import { LanguageSelector } from "./language-selector";',
  'import { LanguageSelector } from "./language-selector";\nimport { normalizeAmountInput, formatTokenAmount } from "../i18n/amounts";',
);
product = product.replace(
  "const { lang, t: translate } = useI18n();",
  "const { lang, t: translate } = useI18n();\n    const formatAmount = (value: bigint, places=6) => formatTokenAmount(value,18,lang,places);\n    const canonicalAmount = (value: string) => normalizeAmountInput(value,lang,18);",
);
product = product
  .replaceAll("parseAmount(amount)", "parseAmount(canonicalAmount(amount))")
  .replace("amount,\n", "amount: canonicalAmount(amount),\n");
// MAX must remain canonical input, never a formatted display number.
product = product.replace(
  /changeAmount\(\s+formatAmount\(\s+maximum\(([\s\S]*?)\),\s+18,\s+\),\s+\);/,
  'changeAmount((maximum($1)).toString().padStart(19,"0").replace(/(\\d{18})$/, ".$1").replace(/\\.?0+$/, ""));',
);
product = product
  .replaceAll("<code>{value}</code>", '<code dir="ltr">{value}</code>')
  .replace("Explorer ↗", '{t("ui.explorer")} ↗')
  .replaceAll('name="sourceHash"', 'name="sourceHash" dir="ltr"');
await writeFile("src/components/product.tsx", product);
let bridge = await readFile("src/components/multichain-bridge.tsx", "utf8");
bridge = bridge.replace(
  "import { useI18n }",
  'import { normalizeAmountInput, formatTokenAmount, formatFiat, formatPercent } from "../i18n/amounts";\nimport type { MessageKey } from "../i18n/messages";\nimport { useI18n }',
);
bridge = bridge.replace(
  'if (!/^\\d+(\\.\\d+)?$/.test(amount) ||\n            (amount.split(".")[1] ?? "").length > from.decimals)\n            throw Error();\n        baseAmount = parseUnits(amount, from.decimals).toString();',
  "baseAmount = parseUnits(normalizeAmountInput(amount,lang,from.decimals), from.decimals).toString();",
);
bridge = bridge
  .replaceAll(
    "formatUnits(BigInt(quote.expected), to.decimals)",
    "formatTokenAmount(BigInt(quote.expected), to.decimals,lang)",
  )
  .replaceAll(
    "formatUnits(BigInt(quote.minimum), to.decimals)",
    "formatTokenAmount(BigInt(quote.minimum), to.decimals,lang)",
  )
  .replaceAll(
    "formatUnits(BigInt(f.amount), f.asset.decimals)",
    "formatTokenAmount(BigInt(f.amount), f.asset.decimals,lang)",
  )
  .replaceAll(
    "`${(quote.priceImpact * 100).toFixed(2)}%`",
    "formatPercent(quote.priceImpact,lang)",
  )
  .replaceAll("`$${sumUSD.toFixed(4)}`", "formatFiat(sumUSD,lang)")
  .replace(
    "{Math.ceil(quote.duration)} s",
    '{t("ui.seconds",{count:new Intl.NumberFormat(lang).format(Math.ceil(quote.duration))})}',
  );
bridge = bridge
  .replace(
    '<label htmlFor="routing-slippage">Slippage</label>',
    '<label htmlFor="routing-slippage">{t("ui.slippage")}</label>',
  )
  .replaceAll("{s.type}", "{t(`kinds.${s.type}` as MessageKey)}")
  .replaceAll("{f.kind}", "{t(`kinds.${f.kind}`)}");
bridge = bridge
  .replace(
    "<option value={0.005}>0.5%</option>",
    "<option value={0.005}>{formatPercent(0.005,lang)}</option>",
  )
  .replace(
    "<option value={0.01}>1%</option>",
    "<option value={0.01}>{formatPercent(0.01,lang)}</option>",
  )
  .replace(
    "<option value={0.03}>3%</option>",
    "<option value={0.03}>{formatPercent(0.03,lang)}</option>",
  );
bridge = bridge
  .replaceAll(
    'autoComplete="off" value={sender}',
    'autoComplete="off" dir="ltr" value={sender}',
  )
  .replaceAll(
    'autoComplete="off" value={recipient}',
    'autoComplete="off" dir="ltr" value={recipient}',
  );
await writeFile("src/components/multichain-bridge.tsx", bridge);
let catalog = await readFile("src/components/multichain-catalog.tsx", "utf8");
catalog = catalog
  .replace('"Testnet · "', '`${t("ui.testnet")} · `')
  .replace('"Otherbridge custom · G5 BLOCKED"', 't("ui.g5Blocked")')
  .replace('"Read only"', 't("ui.readOnly")');
await writeFile("src/components/multichain-catalog.tsx", catalog);
let selector = await readFile("src/components/network-selector.tsx", "utf8");
selector = selector
  .replace('" · Testnet"', '` · ${t("ui.testnet")}`')
  .replace('" · Otherbridge custom"', '` · ${t("ui.custom")}`');
await writeFile("src/components/network-selector.tsx", selector);
let observation = await readFile(
  "src/components/routing-observation.tsx",
  "utf8",
);
observation = observation
  .replace(
    "import { useI18n }",
    'import { stateMessage } from "../i18n/messages";\nimport { useI18n }',
  )
  .replace("? status.status", "? stateMessage(lang,status.status)");
await writeFile("src/components/routing-observation.tsx", observation);
let client = await readFile("src/routing/client.ts", "utf8");
client =
  client.slice(0, client.indexOf("export const routingMessages")) +
  "export function routingMessage(code: string, lang: Locale) { return errorMessage(lang,code,true); }\n";
client =
  'import { errorMessage } from "../i18n/messages";\nimport type { Locale } from "../i18n/config";\n' +
  client;
await writeFile("src/routing/client.ts", client);
let labels = await readFile("src/content/public-labels.ts", "utf8");
labels = labels.slice(0, labels.indexOf("const trLabels"));
labels =
  'import { translate, type MessageKey } from "../i18n/messages";\nimport type { Locale } from "../i18n/config";\n' +
  labels +
  'const labelKeys: Record<string, MessageKey> = { "Route service fee":"ui.routeServiceFee", "Network fee":"ui.networkFee", "Intent routing":"ui.intentRouting", "Exchange routing":"ui.exchangeRouting", "Route service":"ui.routeService" };\nexport function publicToolLabel(name: string, lang: Locale) { const neutral=neutralToolName(name); return labelKeys[neutral] ? translate(lang,labelKeys[neutral]) : neutral; }\nexport function publicFeeLabel(name: string, lang: Locale, kind: "fee" | "gas"="fee") {const neutral=neutralFeeName(name,kind);return labelKeys[neutral] ? translate(lang,labelKeys[neutral]) : neutral;}\n';
await writeFile("src/content/public-labels.ts", labels);
await writeFile(
  "src/content/messages.ts",
  '// Compatibility exports for accepted baseline tests; product copy lives in i18n assets.\nimport en from "../i18n/locales/en.json";\nimport tr from "../i18n/locales/tr.json";\nexport const messages = {en:en.product,tr:tr.product};\nexport type Language = import("../i18n/config").Locale;\nexport type TextKey = keyof typeof en.product;\n',
);
