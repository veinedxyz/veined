import { readFile, writeFile } from "node:fs/promises";
let css = await readFile("src/app/globals.css", "utf8");
css = css
  .replaceAll("margin-left:", "margin-inline-start:")
  .replaceAll("margin-right:", "margin-inline-end:")
  .replaceAll("padding-left:", "padding-inline-start:")
  .replaceAll("padding-right:", "padding-inline-end:")
  .replaceAll("border-left:", "border-inline-start:")
  .replaceAll("border-right:", "border-inline-end:")
  .replaceAll("text-align: left", "text-align: start")
  .replaceAll("text-align: right", "text-align: end")
  .replace(/(^\s*)left:/gm, "$1inset-inline-start:")
  .replace(/(^\s*)right:/gm, "$1inset-inline-end:");
css += `\n/* Locale direction and technical identifier isolation. Logos never mirror. */
.language-entry { white-space: nowrap; min-width: 52px; }
.language-picker { max-width: min(440px, calc(100vw - 24px)); }
.language-list { display: grid; gap: 6px; max-height: 55vh; overflow-y: auto; margin-block-start: 12px; }
.language-list button { display:flex; justify-content:space-between; text-align:start; min-height:44px; }
.language-list button[aria-pressed="true"] { border-color:var(--teal); }
.language-picker input { width:100%; }
.native-address, .address code, .network-id, .hash-row code, input[name="sourceHash"], #routing-sender, #routing-recipient, #routing-amount, #amount { direction:ltr; unicode-bidi:isolate; }
.route-identity, .route-line { direction:ltr; unicode-bidi:isolate; }
.network-badge span, .network-box strong, .picker-option strong { unicode-bidi:isolate; }
.routing-summary dd, .fees strong { unicode-bidi:isolate; }
.routing-review code, code.native-address { direction:ltr; unicode-bidi:isolate; }
.card, .data-row, .routing-summary > div, .header-actions { min-width:0; }
.data-row span, .routing-summary dt, button, .badge, .notice { overflow-wrap:anywhere; }
.picker-option > span { min-width:0; }
.picker-option strong { display:block; white-space:normal; line-height:1.2; }
.picker-option small { direction:ltr; unicode-bidi:isolate; }
[dir="rtl"] .timeline li > span { direction:ltr; unicode-bidi:isolate; }
body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Noto Sans Arabic", "Noto Sans Hebrew", "Noto Sans CJK JP", sans-serif; }
@media(max-width:600px) { .header-actions { flex-wrap:wrap; gap:6px; } .wallet-button { max-width:210px; white-space:normal; } .header nav { flex-wrap:wrap; } .header { align-items:flex-start; } }
`;
await writeFile("src/app/globals.css", css);
for (const file of [
  "tests/e2e/product.spec.ts",
  "tests/e2e/multichain.spec.ts",
  "scripts/production-multichain.mjs",
]) {
  let code = await readFile(file, "utf8");
  code = code.replace(
    'if (lang === "en")\n      await page.getByRole("button", { name: "Dil", exact: true }).click();',
    'if (lang === "en") {\n      await page.getByRole("button", { name: "Dil", exact: true }).click();\n      await page.locator(".language-picker[open]").getByRole("button", { name: "English", exact: true }).click();\n    }',
  );
  if (file.endsWith("product.spec.ts"))
    code = code.replace(
      'await page.getByRole("button", { name: "Dil", exact: true }).click();',
      'await page.getByRole("button", { name: "Dil", exact: true }).click();\n  await page.locator(".language-picker[open]").getByRole("button", { name: "English", exact: true }).click();',
    );
  if (file.endsWith("production-multichain.mjs"))
    code = code
      .replace(
        'await page.getByRole("button", { name: "Dil" }).click();',
        'await page.getByRole("button", { name: "Dil" }).click();\n    await page.locator(".language-picker[open]").getByRole("button", { name: "English", exact: true }).click();',
      )
      .replace(
        'await page.getByRole("button", { name: "Language" }).click();',
        'await page.getByRole("button", { name: "Language" }).click();\n    await page.locator(".language-picker[open]").getByRole("button", { name: "Türkçe", exact: true }).click();',
      );
  await writeFile(file, code);
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["i18n:check"] = "node scripts/i18n-check.mjs";
pkg.scripts.build = "node scripts/i18n-check.mjs && next build";
await writeFile("package.json", JSON.stringify(pkg, null, 2) + "\n");
