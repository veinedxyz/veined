// One-time, syntax-aware migration. It does not call translation services.
import ts from "typescript";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const original = await readFile("src/content/messages.ts", "utf8");
const js = ts.transpileModule(original, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const old = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);
const dictionary = (lang, index) => ({
  product: { ...old.messages[lang] },
  errors: Object.fromEntries(
    Object.entries(old.errors).map(([k, v]) => [k, v[index]]),
  ),
  states: Object.fromEntries(
    Object.entries(old.stateLabels).map(([k, v]) => [k, v[index]]),
  ),
  faq: Object.fromEntries(
    old.faq.flatMap((v, i) => [
      [`${i}q`, v[index === 0 ? 0 : 2]],
      [`${i}a`, v[index === 0 ? 1 : 3]],
    ]),
  ),
  ui: {},
});
const en = dictionary("en", 1),
  tr = dictionary("tr", 0);
// Read only the self-contained object, never execute feature modules.
const routingObject = (await readFile("src/routing/client.ts", "utf8")).match(
  /export const routingMessages[\s\S]*?(?=export function routingMessage)/,
)[0];
const routingData = await import(
  `data:text/javascript;base64,${Buffer.from(ts.transpileModule(routingObject, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText).toString("base64")}`
);
en.routingErrors = Object.fromEntries(
  Object.entries(routingData.routingMessages).map(([k, v]) => [k, v[1]]),
);
tr.routingErrors = Object.fromEntries(
  Object.entries(routingData.routingMessages).map(([k, v]) => [k, v[0]]),
);
const pairs = new Map();
function key(a, b) {
  const pair = JSON.stringify([a, b]);
  if (pairs.has(pair)) return pairs.get(pair);
  const name =
    b
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .map((w, i) => (i ? w[0]?.toUpperCase() + w.slice(1) : w.toLowerCase()))
      .join("") || "label";
  let id = name,
    i = 2;
  while (en.ui[id] !== undefined) id = `${name}${i++}`;
  en.ui[id] = b;
  tr.ui[id] = a;
  const k = `ui.${id}`;
  pairs.set(pair, k);
  return k;
}
const factory = ts.factory;
function paired(a, b) {
  if (ts.isStringLiteralLike(a) && ts.isStringLiteralLike(b))
    return factory.createCallExpression(
      factory.createIdentifier("t"),
      undefined,
      [factory.createStringLiteral(key(a.text, b.text))],
    );
  if (
    ts.isConditionalExpression(a) &&
    ts.isConditionalExpression(b) &&
    a.condition.getText() === b.condition.getText()
  )
    return factory.createConditionalExpression(
      a.condition,
      a.questionToken,
      paired(a.whenTrue, b.whenTrue),
      a.colonToken,
      paired(a.whenFalse, b.whenFalse),
    );
  throw Error(`Manual translation required: ${a.getText()} / ${b.getText()}`);
}
const files = [
  "product",
  "multichain-bridge",
  "multichain-catalog",
  "network-selector",
  "routing-activity",
  "routing-observation",
];
for (const name of files) {
  const path = `src/components/${name}.tsx`;
  let source = await readFile(path, "utf8");
  source = source.replaceAll('lang: "tr" | "en"', "lang: Locale");
  if (name === "product") {
    source = source.replace(
      /import \{\s+messages,[\s\S]*?from "\.\.\/content\/messages";/,
      'import type { TextKey } from "../content/messages";',
    );
    source = source.replace(
      'const [lang, setLang] = useState<Language>("tr");',
      "const { lang, t: translate, setLocale: setLang } = useI18n();",
    );
    source = source.replace(
      "const t = (key: TextKey) => messages[lang][key];",
      'const t = (key: TextKey | MessageKey) => translate(key.includes(".") ? key as MessageKey : `product.${key}` as MessageKey);',
    );
    source = source.replace(
      /const explain = \(code: string\) =>[\s\S]*?const updateHealth =/,
      "const explain = (code: string) => errorMessage(lang, code);\n  const stateName = (state: string) => stateMessage(lang, state);\n  const updateHealth =",
    );
    source = source.replace(
      'const language = localStorage.getItem("otherbridge.language");',
      "",
    );
    source = source.replace(
      /setLang\([\s\S]*?\);\s+setTheme\(appearance/,
      "setTheme(appearance",
    );
    source = source.replace(
      'localStorage.setItem("otherbridge.language", lang);',
      "",
    );
    source = source.replace(
      /<button\s+className="icon-button"\s+aria-label=\{t\("language"\)\}[\s\S]*?\{lang.toUpperCase\(\)\}[\s\S]*?<\/button>/,
      "<LanguageSelector />",
    );
    source = source.replace(
      /\{faq.map\(\(\[q, a, eq, ea\]\) => \([\s\S]*?\)\)\}/,
      "{[0,1,2,3,4,5].map((i) => (<details key={i}><summary>{t(`faq.${i}q` as MessageKey)}<span>+</span></summary><p>{t(`faq.${i}a` as MessageKey)}</p></details>))}",
    );
    source = source.replace(
      /<label>\s+\{t\("language"\)\}[\s\S]*?<\/label>/,
      "<LanguageSelector expanded />",
    );
  } else {
    source = source.replace(
      /const tr = lang === "tr",\s+text = \(a: string, b: string\) => \(tr \? a : b\);/,
      "const { t } = useI18n();",
    );
    source = source.replace(
      'const tr = lang === "tr";',
      "const { t } = useI18n();",
    );
  }
  const ast = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const result = ts.transform(ast, [
    (context) => {
      const visitor = (node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(ast) === "text" &&
          node.arguments.length === 2
        )
          return paired(node.arguments[0], node.arguments[1]);
        if (
          ts.isConditionalExpression(node) &&
          ["tr", 'lang === "tr"'].includes(node.condition.getText(ast))
        )
          return paired(node.whenTrue, node.whenFalse);
        return ts.visitEachChild(node, visitor, context);
      };
      return (root) => ts.visitNode(root, visitor);
    },
  ]);
  source = ts.createPrinter().printFile(result.transformed[0]);
  result.dispose();
  source = source.replace(
    '"use client";',
    '"use client";\nimport { useI18n } from "../i18n/provider";\nimport type { Locale } from "../i18n/config";\n' +
      (name === "product"
        ? 'import { errorMessage, stateMessage, type MessageKey } from "../i18n/messages";\nimport { LanguageSelector } from "./language-selector";\n'
        : ""),
  );
  await writeFile(path, source);
}
await mkdir("src/i18n/locales", { recursive: true });
for (const [locale, data] of Object.entries({ en, tr }))
  await writeFile(
    `src/i18n/locales/${locale}.json`,
    JSON.stringify(data, null, 2) + "\n",
  );
console.log(
  JSON.stringify({
    keys: Object.values(en).reduce((sum, x) => sum + Object.keys(x).length, 0),
    uiKeys: Object.keys(en.ui).length,
  }),
);
