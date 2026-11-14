// Offline, typography-only development assets. Final logo artwork remains an owner handoff.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { brand } from "../src/content/brand.ts";
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    offline: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await context.route("**/*", (r) => r.abort());
  const html = (size, content) =>
    `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;margin:0}body{width:${size[0]}px;height:${size[1]}px;background:#0c0d10;color:#bdccb9;font-family:Arial,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:64px}h1{font-size:92px;letter-spacing:.08em}p{font-size:30px;color:#f1f0ec;margin-top:32px}small{font-size:20px;color:#b0afb5;margin-top:52px}</style></head><body>${content}</body></html>`;
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(
    html(
      [1200, 630],
      `<h1>${brand.name}</h1><p>${brand.category}</p><small>Development preview · Execution closed</small>`,
    ),
  );
  mkdirSync("public/og", { recursive: true });
  await page.screenshot({ path: "public/og/veined-preview.png" });
  // Compatibility URL; artwork is current and provisional.
  await page.screenshot({ path: "public/og/otherbridge-og.png" });
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(
    "<html><head><style>*{margin:0}body{width:180px;height:180px;background:#0c0d10;color:#bdccb9;display:grid;place-items:center;font:120px Arial,sans-serif}</style></head><body>V</body></html>",
  );
  await page.screenshot({ path: "src/app/apple-icon.png" });
} finally {
  await browser.close();
}
