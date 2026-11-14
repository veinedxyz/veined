// Bounded local gallery verification. Owns and closes its HTTP server/browser.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const assetRoot = resolve("public/assets/veined/brand");
const evidence = resolve(
  (await readFile(".otherbridge/v120-evidence-path.txt", "utf8")).trim(),
  "brand",
);
await mkdir(evidence, { recursive: true });
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".ico": "image/x-icon",
};
const server = createServer(async (request, response) => {
  try {
    const path = resolve(
      assetRoot,
      `.${decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname)}`,
    );
    if (!path.startsWith(assetRoot + sep))
      throw new Error("Outside gallery root");
    const bytes = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
const browser = await chromium.launch();
const results = [];
try {
  for (const width of [360, 390, 768, 1440, 1920]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/review.html`, {
      waitUntil: "networkidle",
    });
    const state = await page.evaluate(() => ({
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      brokenImages: [...document.images]
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.src),
      externalLinks: [...document.querySelectorAll("a[href]")]
        .map((a) => a.getAttribute("href"))
        .filter((href) => /^https?:/.test(href)),
    }));
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    await page.keyboard.press("Tab");
    const skipFocused = await page
      .locator(".skip")
      .evaluate((node) => node === document.activeElement);
    if ([390, 1440].includes(width))
      await page.screenshot({
        path: resolve(evidence, `gallery-${width}.png`),
        fullPage: true,
      });
    results.push({
      width,
      ...state,
      errors,
      axeViolations: axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target),
      })),
      skipFocused,
    });
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
const passed = results.every(
  (row) =>
    row.documentWidth <= row.width &&
    row.brokenImages.length === 0 &&
    row.errors.length === 0 &&
    row.axeViolations.length === 0 &&
    row.skipFocused &&
    row.externalLinks.length === 0,
);
const report = {
  status: passed ? "PASS" : "FAIL",
  scope:
    "Static local brand review gallery only; product app checks are separate",
  widths: [360, 390, 768, 1440, 1920],
  reducedMotion: true,
  results,
  browserAndServerClosed: true,
};
await writeFile(
  resolve(evidence, "gallery-qa.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
