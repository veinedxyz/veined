// V1.11 sync-time JPEG rasterization (dev tooling only; never in the app or its server). Chromium's sandboxed
// image decoder turns a JPEG into pixels inside an offline page (every network request aborted, the image passed as
// a data: URL); our own code then downscales and re-encodes a canonical PNG, which must pass the sanitizer again.
// SVG is NOT rasterized here: untrusted SVG stays refused.
import { chromium, type Browser } from "@playwright/test";
import {
  downscale,
  encodePng,
  sanitizeImage,
  sniffImage,
} from "../../src/assets/image-sanitize";

let browser: Promise<Browser> | null = null;
export async function closeRasterizer() {
  if (browser) await (await browser).close();
  browser = null;
}
export async function rasterizeJpeg(bytes: Buffer, size: number) {
  if (sniffImage(bytes) !== "jpeg" || bytes.length > 600_000) return null;
  browser ??= chromium.launch({ args: ["--disable-gpu"] });
  const context = await (
    await browser
  ).newContext({ offline: true, javaScriptEnabled: true });
  try {
    await context.route("**/*", (r) => r.abort());
    const page = await context.newPage();
    await page.setContent("<!doctype html><title>r</title>");
    const out = await page.evaluate(async (b64) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      if (bmp.width > 1024 || bmp.height > 1024 || !bmp.width || !bmp.height)
        return null;
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let bin = "";
      for (let i = 0; i < d.length; i += 0x8000)
        bin += String.fromCharCode(...d.subarray(i, i + 0x8000));
      return { w: bmp.width, h: bmp.height, rgba: btoa(bin) };
    }, bytes.toString("base64"));
    if (!out) return null;
    const scaled = downscale(
      Buffer.from(out.rgba, "base64"),
      out.w,
      out.h,
      size,
    );
    const png = encodePng(scaled.data, scaled.width, scaled.height);
    const again = sanitizeImage(png, { outputSize: size });
    return again.ok ? again : null;
  } finally {
    await context.close();
  }
}
