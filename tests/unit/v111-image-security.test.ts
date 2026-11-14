// V1.11 logo ingestion security: image sanitizer (src/assets/image-sanitize.ts) and SSRF-safe fetcher
// (src/assets/safe-fetch.ts). Every input is synthesized in-test; no network.
import { describe, expect, it } from "vitest";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  encodePng,
  sanitizeImage,
  sniffImage,
} from "../../src/assets/image-sanitize";
import {
  SafeFetchError,
  admitFetchUrl,
  safeGet,
  safeJsonParse,
  type SafeFetchDeps,
} from "../../src/assets/safe-fetch";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer, badCrc = false) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(
    (crc32(Buffer.concat([head.subarray(4), data])) ^ (badCrc ? 1 : 0)) >>> 0,
    0,
  );
  return Buffer.concat([head, data, crc]);
}
function ihdr(w: number, h: number, depth = 8, color = 6, interlace = 0) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = depth;
  b[9] = color;
  b[12] = interlace;
  return b;
}
function rgbaPng(w: number, h: number, extra: Buffer[] = [], fill = 0x80) {
  const raw = Buffer.alloc(h * (w * 4 + 1), fill);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr(w, h)),
    ...extra,
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const chunkTypes = (png: Buffer) => {
  const out: string[] = [];
  for (let p = 8; p < png.length;) {
    const len = png.readUInt32BE(p);
    out.push(png.toString("latin1", p + 4, p + 8));
    p += 12 + len;
  }
  return out;
};

describe("V1.11 image sanitizer", () => {
  it("re-encodes a valid PNG deterministically with ONLY IHDR/IDAT/IEND (metadata stripped)", () => {
    const text = chunk(
      "tEXt",
      Buffer.from("Comment\0<script>alert(1)</script>"),
    );
    const exif = chunk("eXIf", Buffer.from("MM\0*GPSsecret"));
    const iccp = chunk("iCCP", Buffer.from("profile\0\0" + "x".repeat(40)));
    const src = rgbaPng(16, 16, [text, exif, iccp]);
    const r = sanitizeImage(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.format).toBe("png");
    expect(chunkTypes(r.bytes)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(r.dropped).toEqual(["tEXt", "eXIf", "iCCP"]);
    expect(r.bytes.includes(Buffer.from("script"))).toBe(false);
    expect(r.bytes.includes(Buffer.from("GPSsecret"))).toBe(false);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sanitizeImage(src)).toEqual(r); // deterministic
  });

  it("downscales large logos to the output cap and keeps the aspect ratio", () => {
    const r = sanitizeImage(rgbaPng(512, 256), { outputSize: 64 });
    expect(r.ok && [r.width, r.height]).toEqual([64, 32]);
  });

  it("decodes every PNG colour type / bit depth it accepts (palette + tRNS, gray 1-bit, 16-bit RGBA)", () => {
    // palette, 2 colours, transparent index 0
    const pal = Buffer.concat([
      SIG,
      chunk("IHDR", ihdr(2, 1, 1, 3)),
      chunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255])),
      chunk("tRNS", Buffer.from([0])),
      chunk("IDAT", deflateSync(Buffer.from([0, 0b01000000]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const p = sanitizeImage(pal);
    expect(p.ok).toBe(true);
    if (p.ok) {
      const raw = inflateSync(
        p.bytes.subarray(8 + 25 + 8, p.bytes.length - 12 - 4),
      );
      expect([...raw.subarray(1, 9)]).toEqual([255, 0, 0, 0, 0, 0, 255, 255]);
    }
    const gray = Buffer.concat([
      SIG,
      chunk("IHDR", ihdr(8, 1, 1, 0)),
      chunk("IDAT", deflateSync(Buffer.from([0, 0b10101010]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(sanitizeImage(gray).ok).toBe(true);
    const deep = Buffer.concat([
      SIG,
      chunk("IHDR", ihdr(1, 1, 16, 6)),
      chunk(
        "IDAT",
        deflateSync(Buffer.from([0, 0xff, 0, 0x80, 0, 0, 0, 0xff, 0xff])),
      ),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(sanitizeImage(deep).ok).toBe(true);
  });

  it("refuses a decompression bomb (IDAT inflating beyond the IHDR-declared size) without allocating it", () => {
    // Declares 64x64 RGBA but inflates to 50 MB of zeros.
    const bomb = Buffer.concat([
      SIG,
      chunk("IHDR", ihdr(64, 64)),
      chunk("IDAT", deflateSync(Buffer.alloc(50_000_000), { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(bomb.length).toBeLessThan(600_000);
    expect(sanitizeImage(bomb)).toMatchObject({
      ok: false,
      reason: "DECOMPRESSION_LIMIT",
    });
  });

  it("refuses dimension bombs and oversized inputs", () => {
    const huge = Buffer.concat([
      SIG,
      chunk("IHDR", ihdr(30000, 30000)),
      chunk("IDAT", deflateSync(Buffer.alloc(10))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(sanitizeImage(huge)).toMatchObject({
      ok: false,
      reason: "DIMENSIONS_TOO_LARGE",
    });
    expect(sanitizeImage(Buffer.alloc(700_000, 1))).toMatchObject({
      ok: false,
      reason: "TOO_LARGE",
    });
    expect(sanitizeImage(Buffer.alloc(0))).toMatchObject({
      ok: false,
      reason: "EMPTY",
    });
  });

  it.each([
    [
      "bad CRC",
      Buffer.concat([SIG, chunk("IHDR", ihdr(1, 1), true)]),
      "BAD_CRC",
    ],
    [
      "trailing data after IEND (polyglot)",
      Buffer.concat([rgbaPng(1, 1), Buffer.from("<html><script>x</script>")]),
      "TRAILING_DATA",
    ],
    [
      "unknown critical chunk",
      rgbaPng(1, 1, [chunk("ZZZZ", Buffer.from("x"))]),
      "UNKNOWN_CRITICAL_CHUNK",
    ],
    [
      "first chunk not IHDR",
      Buffer.concat([SIG, chunk("IDAT", Buffer.alloc(1))]),
      "BAD_IHDR",
    ],
    [
      "interlaced",
      Buffer.concat([
        SIG,
        chunk("IHDR", ihdr(1, 1, 8, 6, 1)),
        chunk("IDAT", deflateSync(Buffer.alloc(5))),
        chunk("IEND", Buffer.alloc(0)),
      ]),
      "INTERLACE_UNSUPPORTED",
    ],
    [
      "invalid filter type",
      Buffer.concat([
        SIG,
        chunk("IHDR", ihdr(1, 1)),
        chunk("IDAT", deflateSync(Buffer.from([9, 1, 2, 3, 4]))),
        chunk("IEND", Buffer.alloc(0)),
      ]),
      "BAD_FILTER",
    ],
    [
      "truncated pixel data",
      Buffer.concat([
        SIG,
        chunk("IHDR", ihdr(4, 4)),
        chunk("IDAT", deflateSync(Buffer.alloc(3))),
        chunk("IEND", Buffer.alloc(0)),
      ]),
      "CORRUPT_DATA",
    ],
    [
      "palette index outside PLTE",
      Buffer.concat([
        SIG,
        chunk("IHDR", ihdr(1, 1, 8, 3)),
        chunk("PLTE", Buffer.from([1, 2, 3])),
        chunk("IDAT", deflateSync(Buffer.from([0, 7]))),
        chunk("IEND", Buffer.alloc(0)),
      ]),
      "BAD_PALETTE",
    ],
    ["missing IEND", rgbaPng(1, 1).subarray(0, -12), "BAD_CHUNK"],
  ] as const)("malformed PNG: %s", (_n, bytes, reason) => {
    expect(sanitizeImage(Buffer.from(bytes))).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("APNG animation chunks are dropped, the default image survives", () => {
    const r = sanitizeImage(rgbaPng(2, 2, [chunk("acTL", Buffer.alloc(8))]));
    expect(r.ok && r.dropped).toEqual(["acTL"]);
  });

  it.each([
    [
      "SVG with script",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "SVG_REJECTED",
    ],
    [
      "SVG behind an XML prolog",
      '<?xml version="1.0"?>\n<svg onload="alert(1)"/>',
      "SVG_REJECTED",
    ],
    [
      "HTML pretending to be an image",
      "<!DOCTYPE html><html><body>logo.png</body></html>",
      "HTML_REJECTED",
    ],
    [
      "HTML with BOM and whitespace",
      "\uFEFF  \n<html><script>1</script>",
      "HTML_REJECTED",
    ],
    ["JPEG", "\xff\xd8\xff\xe0JFIF", "UNSUPPORTED_FORMAT"],
    ["GIF", "GIF89a....", "UNSUPPORTED_FORMAT"],
    ["random bytes", "hello", "UNSUPPORTED_FORMAT"],
  ])("refuses %s", (_n, text, reason) => {
    const bytes = /[^ -ÿ]/.test(text)
      ? Buffer.from(text, "utf8")
      : Buffer.from(text, "latin1");
    expect(sanitizeImage(bytes)).toMatchObject({ ok: false, reason });
  });

  it("sniffs by magic bytes, never by name or declared type", () => {
    expect(sniffImage(rgbaPng(1, 1))).toBe("png");
    expect(sniffImage(Buffer.from("<svg/>"))).toBe("svg");
    expect(sniffImage(Buffer.from("<html>"))).toBe("html");
  });

  function riff(chunks: [string, Buffer][]) {
    const body = Buffer.concat(
      chunks.map(([t, d]) => {
        const h = Buffer.alloc(8);
        h.write(t, 0, "latin1");
        h.writeUInt32LE(d.length, 4);
        return Buffer.concat([
          h,
          d,
          d.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0),
        ]);
      }),
    );
    const payload = Buffer.concat([Buffer.from("WEBP"), body]);
    const head = Buffer.alloc(8);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(payload.length, 4);
    return Buffer.concat([head, payload]);
  }
  const vp8l = (w: number, h: number) => {
    const d = Buffer.alloc(10);
    d[0] = 0x2f;
    d.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
    return d;
  };
  it("WebP: container rebuilt, EXIF/XMP/ICCP dropped, dimensions validated, animation refused", () => {
    const r = sanitizeImage(
      riff([
        ["VP8L", vp8l(32, 32)],
        ["EXIF", Buffer.from("GPS-secret")],
        ["XMP ", Buffer.from("<x:xmpmeta>")],
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.format).toBe("webp");
      expect([r.width, r.height]).toEqual([32, 32]);
      expect(r.dropped).toEqual(["EXIF", "XMP"]);
      expect(r.bytes.includes(Buffer.from("GPS-secret"))).toBe(false);
    }
    expect(
      sanitizeImage(
        riff([
          ["ANIM", Buffer.alloc(6)],
          ["VP8L", vp8l(8, 8)],
        ]),
      ),
    ).toMatchObject({
      ok: false,
      reason: "ANIMATED_REJECTED",
    });
    expect(sanitizeImage(riff([["VP8L", vp8l(4000, 10)]]))).toMatchObject({
      ok: false,
      reason: "DIMENSIONS_TOO_LARGE",
    });
    const bad = riff([["VP8L", vp8l(8, 8)]]);
    bad.writeUInt32LE(bad.readUInt32LE(4) + 4, 4); // RIFF size lies
    expect(sanitizeImage(bad)).toMatchObject({ ok: false, reason: "BAD_WEBP" });
  });

  it("encodePng output round-trips through the sanitizer unchanged (cache key stability)", () => {
    const png = encodePng(Buffer.alloc(4 * 4 * 4, 200), 4, 4);
    const r = sanitizeImage(png);
    expect(r.ok && r.bytes.equals(png)).toBe(true);
  });
});

describe("V1.11 SSRF-safe fetcher", () => {
  const allowed = ["raw.githubusercontent.com", "*.coingecko.com"];
  const deps = (
    answers: Record<string, string[]>,
    routes: Record<
      string,
      { status: number; headers?: Record<string, string>; body?: string }
    >,
  ): SafeFetchDeps & { seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      lookup: async (host) => {
        if (!answers[host]) throw new Error("ENOTFOUND");
        return answers[host].map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        }));
      },
      get: async (url, pinned, init) => {
        seen.push(`${url.toString()}@${pinned.address}`);
        const r = routes[url.toString()] ?? { status: 404 };
        const body = Buffer.from(r.body ?? "");
        if (body.length > init.maxBytes) throw new SafeFetchError("TOO_LARGE");
        return { status: r.status, headers: r.headers ?? {}, body };
      },
    };
  };
  it.each([
    ["http://raw.githubusercontent.com/x.png", "URL_REJECTED"],
    ["https://user:pw@raw.githubusercontent.com/x.png", "URL_REJECTED"],
    ["https://raw.githubusercontent.com:8443/x.png", "URL_REJECTED"],
    ["https://127.0.0.1/x.png", "URL_REJECTED"],
    ["https://[::1]/x.png", "URL_REJECTED"],
    ["https://evil.example/x.png", "URL_REJECTED"],
    ["https://evil.com/x.png", "HOST_NOT_ALLOWED"],
    ["https://raw.githubusercontent.com.evil.com/x.png", "HOST_NOT_ALLOWED"],
    ["https://coingecko.com.evil.com/x.png", "HOST_NOT_ALLOWED"],
    ["https://metadata.internal/x", "URL_REJECTED"],
  ])("refuses %s before any request", (url, code) => {
    expect(() => admitFetchUrl(url, allowed)).toThrow(code);
  });
  it("accepts allowlisted hosts and subdomain families", () => {
    expect(
      admitFetchUrl(
        "https://assets.coingecko.com/a.png?x=1#frag",
        allowed,
      ).toString(),
    ).toBe("https://assets.coingecko.com/a.png?x=1");
  });
  it("refuses private/loopback/link-local/metadata DNS answers (rebinding pinned per hop)", async () => {
    for (const ip of [
      "10.0.0.5",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "fd00::1",
    ]) {
      const d = deps(
        { "raw.githubusercontent.com": ["185.199.108.133", ip] },
        {},
      );
      await expect(
        safeGet(
          "https://raw.githubusercontent.com/x.png",
          { allowedHosts: allowed, maxBytes: 1000 },
          d,
        ),
      ).rejects.toMatchObject({ code: "UNSAFE_DNS" });
      expect(d.seen).toEqual([]);
    }
  });
  it("follows a bounded number of redirects and re-admits every hop", async () => {
    const d = deps(
      {
        "raw.githubusercontent.com": ["185.199.108.133"],
        "assets.coingecko.com": ["104.18.1.1"],
      },
      {
        "https://raw.githubusercontent.com/a.png": {
          status: 302,
          headers: { location: "https://assets.coingecko.com/b.png" },
        },
        "https://assets.coingecko.com/b.png": {
          status: 200,
          headers: { "content-type": "image/png" },
          body: "PNGDATA",
        },
      },
    );
    const r = await safeGet(
      "https://raw.githubusercontent.com/a.png",
      { allowedHosts: allowed, maxBytes: 1000 },
      d,
    );
    expect(r.body.toString()).toBe("PNGDATA");
    expect(r.redirects).toEqual(["https://assets.coingecko.com/b.png"]);
    // redirect to a non-allowlisted / internal target is refused
    const evil = deps(
      { "raw.githubusercontent.com": ["185.199.108.133"] },
      {
        "https://raw.githubusercontent.com/a.png": {
          status: 301,
          headers: { location: "http://169.254.169.254/latest" },
        },
      },
    );
    await expect(
      safeGet(
        "https://raw.githubusercontent.com/a.png",
        { allowedHosts: allowed, maxBytes: 1000 },
        evil,
      ),
    ).rejects.toMatchObject({ code: "URL_REJECTED" });
    // redirect loop is bounded
    const loop = deps(
      { "raw.githubusercontent.com": ["185.199.108.133"] },
      {
        "https://raw.githubusercontent.com/a.png": {
          status: 302,
          headers: { location: "/a.png" },
        },
      },
    );
    await expect(
      safeGet(
        "https://raw.githubusercontent.com/a.png",
        { allowedHosts: allowed, maxBytes: 1000, maxRedirects: 3 },
        loop,
      ),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    expect(loop.seen).toHaveLength(4);
  });
  it("caps the body size and maps 429", async () => {
    const d = deps(
      { "raw.githubusercontent.com": ["185.199.108.133"] },
      {
        "https://raw.githubusercontent.com/big": {
          status: 200,
          body: "x".repeat(2000),
        },
        "https://raw.githubusercontent.com/slow": { status: 429 },
      },
    );
    await expect(
      safeGet(
        "https://raw.githubusercontent.com/big",
        { allowedHosts: allowed, maxBytes: 1000 },
        d,
      ),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(
      safeGet(
        "https://raw.githubusercontent.com/slow",
        { allowedHosts: allowed, maxBytes: 1000 },
        d,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
  it("JSON from upstream refuses prototype-pollution keys", () => {
    expect(() => safeJsonParse('{"__proto__":{"admin":true}}')).toThrow();
    expect(() =>
      safeJsonParse('{"a":{"constructor":{"prototype":1}}}'),
    ).toThrow();
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });
});
