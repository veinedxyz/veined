import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
await page.goto("http://127.0.0.1:3100");
await page.addStyleTag({ content: "html {zoom:2}" });
console.log(
  await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("*")]
      .filter((e) => e.getBoundingClientRect().right > innerWidth)
      .map((e) => ({
        tag: e.tagName,
        cls: e.className,
        right: e.getBoundingClientRect().right,
      }))
      .slice(0, 25),
  })),
);
await browser.close();
