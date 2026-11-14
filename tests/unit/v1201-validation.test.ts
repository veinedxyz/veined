import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { decodeRgbaPng } from "../helpers/png-rgba";
import { privyStyleInventory } from "../helpers/privy-style-inventory";

function chunk(type: string, body: Buffer) {
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length);
  result.write(type, 4, "ascii");
  body.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, 8 + body.length)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 8);
  return result;
}
const pixels = Buffer.from([
  20, 30, 40, 255, 80, 90, 100, 255, 10, 70, 120, 128, 30, 10, 255, 0,
]);
function fixture(filter: number, colorType = 6, truncatePixels = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = colorType;
  const scanlines = Buffer.alloc(18);
  for (let y = 0; y < 2; y++) {
    scanlines[y * 9] = filter;
    for (let x = 0; x < 8; x++) {
      const at = y * 8 + x,
        a = x < 4 ? 0 : pixels[at - 4],
        b = y ? pixels[at - 8] : 0,
        c = y && x >= 4 ? pixels[at - 12] : 0;
      const distances = [
        Math.abs(b - c),
        Math.abs(a - c),
        Math.abs(a + b - 2 * c),
      ];
      const paeth = [a, b, c][distances.indexOf(Math.min(...distances))];
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth][filter] ?? 0;
      scanlines[y * 9 + x + 1] = (pixels[at] - predictor) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(truncatePixels ? scanlines.subarray(1) : scanlines),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
describe("V1201 independent RGBA fixture validation", () => {
  it.each([0, 1, 2, 3, 4])(
    "decodes filter %i without losing RGB or alpha",
    (filter) => {
      expect(decodeRgbaPng(fixture(filter))).toEqual({
        data: pixels,
        info: { width: 2, height: 2 },
      });
    },
  );
  it("refuses corrupt CRC and truncated PNG bytes", () => {
    const corrupt = fixture(0);
    corrupt[45] ^= 1;
    expect(() => decodeRgbaPng(corrupt)).toThrow("PNG_CRC");
    expect(() => decodeRgbaPng(fixture(0).subarray(0, -1))).toThrow(
      "PNG_TRUNCATED",
    );
  });
  it("refuses unsupported pixel representation, filters and incomplete pixels", () => {
    expect(() => decodeRgbaPng(fixture(0, 2))).toThrow(
      "PNG_RGBA8_NONINTERLACED_REQUIRED",
    );
    expect(() => decodeRgbaPng(fixture(5))).toThrow("PNG_FILTER");
    expect(() => decodeRgbaPng(fixture(0, 6, true))).toThrow(
      "PNG_PIXEL_LENGTH",
    );
  });
});
describe("V1201 bounded, uncached SDK style inventory", () => {
  it("reads every ESM module, detects dynamic styles and observes changed installed bytes", async () => {
    const root = resolve(".otherbridge/v1201-unit-fixtures");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "styles-"));
    try {
      await Promise.all(
        Array.from({ length: 13 }, (_, i) =>
          writeFile(
            join(directory, `${i}.mjs`),
            i === 12
              ? 'jsx("style",{children:"a{color:red}"})'
              : "export default 0;",
          ),
        ),
      );
      await writeFile(
        join(directory, "ignored.map"),
        'jsx("style",{children:dynamic})',
      );
      const first = await privyStyleInventory(directory);
      expect(first.files).toHaveLength(13);
      expect(first.hashes).toEqual([
        `'sha256-${createHash("sha256").update("a{color:red}").digest("base64")}'`,
      ]);
      expect(first.dynamic).toBe(0);
      await writeFile(
        join(directory, "12.mjs"),
        'jsx("style",{children:dynamic}); jsx("style",{children:`b{color:blue}`})',
      );
      const second = await privyStyleInventory(directory);
      expect(second.files).toHaveLength(13);
      expect(second.dynamic).toBe(1);
      expect(second.hashes).toEqual([
        `'sha256-${createHash("sha256").update("b{color:blue}").digest("base64")}'`,
      ]);
    } finally {
      if (!resolve(directory).startsWith(root + sep))
        throw Error("OWNED_FIXTURE_PATH_REQUIRED");
      await rm(directory, { recursive: true });
    }
  });
});
