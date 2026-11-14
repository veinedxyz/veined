import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { assertSafeSvg } from "../../scripts/lib/veined-svg-safety.mjs";
import { decodeRgbaPng } from "../helpers/png-rgba";

const assetRoot = "public/assets/veined/brand";
type AssetRecord = {
  path: string;
  bytes: number;
  sha256: string;
  format?: string;
  width?: number;
  height?: number;
};
const manifest: {
  candidate: string;
  status: string;
  ownerApproved: boolean;
  legalClearance: string;
  socialAccountControl: string;
  evaluation: { type: string };
  assets: AssetRecord[];
  sources: AssetRecord[];
} = JSON.parse(readFileSync(`${assetRoot}/asset-manifest.json`, "utf8"));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("V1.20 original vector brand asset contracts", () => {
  it("keeps recommendation separate from owner/legal/social approval", () => {
    expect(manifest.candidate).toBe("QUIET CURRENT");
    expect(manifest.status).toBe("RECOMMENDED_FOR_OWNER_REVIEW");
    expect(manifest.ownerApproved).toBe(false);
    expect(manifest.legalClearance).toBe("not asserted");
    expect(manifest.socialAccountControl).toBe("unconfirmed");
    expect(manifest.evaluation.type).toContain("designer judgment");
  });

  it("matches every recorded output and editable source to actual bytes and SHA-256", () => {
    const paths = new Set<string>();
    for (const entry of [...manifest.assets, ...manifest.sources]) {
      expect(paths.has(entry.path), entry.path).toBe(false);
      paths.add(entry.path);
      expect(entry.path).not.toContain("..");
      const bytes = readFileSync(entry.path);
      expect(bytes.length, entry.path).toBe(entry.bytes);
      expect(sha256(bytes), entry.path).toBe(entry.sha256);
    }
    const allFiles = readdirSync(assetRoot, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(entry.parentPath, entry.name));
    const recorded = new Set(
      manifest.assets.map((entry: { path: string }) => resolve(entry.path)),
    );
    for (const file of allFiles) {
      if (file.endsWith("asset-manifest.json")) continue;
      expect(recorded.has(file), file).toBe(true);
    }
  });

  it("has complete genuinely different concept families and exact six-glyph VEINED lettering", () => {
    const geometries = [];
    for (const id of ["a-vein-nexus", "b-mantle-graph", "c-quiet-current"]) {
      const prefix = `${assetRoot}/concepts/${id}`;
      for (const name of [
        "icon.svg",
        "icon-light.svg",
        "wordmark.svg",
        "wordmark-light.svg",
        "lockup.svg",
        "lockup-light.svg",
        "mono-white.svg",
        "mono-dark.svg",
        "dark-background.svg",
        "light-background.svg",
      ]) {
        const svg = readFileSync(`${prefix}/${name}`, "utf8");
        expect(assertSafeSvg(svg).sanitized).toBe(true);
        expect(svg).not.toMatch(/<(?:image|text)\b/);
      }
      const icon = readFileSync(`${prefix}/icon.svg`, "utf8");
      geometries.push(
        [...icon.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]).join(" "),
      );
      const wordmark = readFileSync(`${prefix}/wordmark.svg`, "utf8");
      expect(wordmark).toContain("VEINED");
      expect(wordmark.match(/<path /g)).toHaveLength(6);
      for (const size of [16, 24, 32, 64, 128, 256]) {
        expect(
          readFileSync(`${prefix}/preview-${size}.png`).readUInt32BE(16),
        ).toBe(size);
        expect(
          readFileSync(`${prefix}/preview-light-${size}.png`).readUInt32BE(16),
        ).toBe(size);
      }
    }
    expect(new Set(geometries).size).toBe(3);
    // The explicit topology candidate has eight branches, each an open stroked route.
    expect(
      readFileSync(`${assetRoot}/concepts/a-vein-nexus/icon.svg`, "utf8").match(
        /stroke-linecap="round"/g,
      ),
    ).toHaveLength(8);
  });

  it("validates every generated SVG with the fail-closed parser", () => {
    for (const entry of [...manifest.assets, ...manifest.sources].filter(
      (entry) => entry.path.endsWith(".svg"),
    )) {
      const result = assertSafeSvg(readFileSync(entry.path, "utf8"));
      expect(result.externalResources, entry.path).toBe(0);
      expect(result.width, entry.path).toBe(entry.width);
      expect(result.height, entry.path).toBe(entry.height);
    }
  });

  it("reads actual PNG dimensions independently of the raster generator", () => {
    for (const entry of manifest.assets.filter(
      (entry) => entry.format === "png",
    )) {
      const bytes = readFileSync(entry.path);
      expect(bytes.subarray(0, 8).equals(pngSignature), entry.path).toBe(true);
      expect(bytes.toString("ascii", 12, 16), entry.path).toBe("IHDR");
      expect(bytes.readUInt32BE(16), entry.path).toBe(entry.width);
      expect(bytes.readUInt32BE(20), entry.path).toBe(entry.height);
    }
    for (const [file, width, height] of [
      ["icon-192.png", 192, 192],
      ["icon-512.png", 512, 512],
      ["apple-touch-icon.png", 180, 180],
      ["maskable-icon-512.png", 512, 512],
      ["og-image.png", 1200, 630],
      ["twitter-card.png", 1200, 630],
      ["x-banner.png", 1500, 500],
      ["social-avatar.png", 1024, 1024],
      ["github-avatar.png", 512, 512],
    ] as const) {
      const bytes = readFileSync(`${assetRoot}/${file}`);
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([
        width,
        height,
      ]);
    }
  });

  it("has four valid bounded ICO frames rather than a renamed PNG", () => {
    const bytes = readFileSync(`${assetRoot}/favicon.ico`);
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(bytes.readUInt16LE(4)).toBe(4);
    let previousEnd = 70;
    for (const [index, size] of [16, 32, 48, 64].entries()) {
      const entry = 6 + index * 16;
      expect(bytes[entry]).toBe(size);
      expect(bytes[entry + 1]).toBe(size);
      const length = bytes.readUInt32LE(entry + 8);
      const offset = bytes.readUInt32LE(entry + 12);
      expect(offset).toBe(previousEnd);
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
      expect(bytes.subarray(offset, offset + 8).equals(pngSignature)).toBe(
        true,
      );
      expect(bytes.readUInt32BE(offset + 16)).toBe(size);
      expect(bytes.readUInt32BE(offset + 20)).toBe(size);
      previousEnd = offset + length;
    }
    expect(previousEnd).toBe(bytes.length);
  });

  it("keeps maskable foreground pixels inside the standard centered 80% safe circle", () => {
    const { data, info } = decodeRgbaPng(
      readFileSync(`${assetRoot}/maskable-icon-512.png`),
    );
    expect([info.width, info.height]).toEqual([512, 512]);
    let foreground = 0;
    let opaque = true;
    let furthestForegroundPixel = 0;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const index = (y * info.width + x) * 4;
        opaque &&= data[index + 3] === 255;
        if (data[index] > 40) {
          foreground++;
          furthestForegroundPixel = Math.max(
            furthestForegroundPixel,
            Math.hypot(x + 0.5 - 256, y + 0.5 - 256),
          );
        }
      }
    expect(foreground).toBeGreaterThan(10_000);
    expect(opaque).toBe(true);
    expect(furthestForegroundPixel).toBeLessThan(512 * 0.4);
  });

  it("serves an inert accessible local gallery without active unverified social links", () => {
    const html = readFileSync(`${assetRoot}/review.html`, "utf8");
    expect(html).toContain('lang="en"');
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).toContain("Owner approval open");
    expect(html).not.toMatch(
      /<script\b|style=|onload=|href="https?:\/\/(?:www\.)?(?:x|twitter)\.com/i,
    );
    for (const img of html.matchAll(/<img\b[^>]*>/g))
      expect(img[0]).toMatch(/alt="[^"]+"/);
  });
});

describe("V1.20 SVG export sanitizer adversarial checks", () => {
  const wrap = (inside: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${inside}</svg>`;
  it.each([
    "<script>alert(1)</script>",
    '<foreignObject width="10" height="10"><p>html</p></foreignObject>',
    '<image href="https://example.invalid/image.png"/>',
    '<use href="#mark"/>',
    '<path d="M0 0" onload="alert(1)"/>',
    '<path d="M0 0" style="fill:red"/>',
    '<path d="M0 0" fill="url(https://example.invalid/a.svg)"/>',
    '<path d="M0 0" fill="url(#missing)"/>',
    '<path d="M0 0" fill="javascript:alert(1)"/>',
    '<path id="a" d="M0 0"/><path id="a" d="M1 1"/>',
    '<animate attributeName="x"/>',
    "<style>path { fill: red }</style>",
    '<path d="M0 0"></g>',
  ])("rejects active, malformed or unresolved SVG: %s", (inside) => {
    expect(() => assertSafeSvg(wrap(inside))).toThrow();
  });
  it("rejects external entity declarations and processing instructions", () => {
    expect(() =>
      assertSafeSvg(
        '<!DOCTYPE svg [<!ENTITY remote SYSTEM "file:///secret">]>' + wrap(""),
      ),
    ).toThrow();
    expect(() =>
      assertSafeSvg(
        '<?xml-stylesheet href="https://example.invalid/style.css"?>' +
          wrap(""),
      ),
    ).toThrow();
  });
  it("allows inert local gradient references needed by social masters", () => {
    expect(
      assertSafeSvg(
        wrap(
          '<defs><linearGradient id="shade"><stop offset="0" stop-color="#000000"/></linearGradient></defs><rect width="64" height="64" fill="url(#shade)"/>',
        ),
      ).externalResources,
    ).toBe(0);
  });
});
