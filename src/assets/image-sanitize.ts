// V1.11 server-side image sanitizer for externally sourced chain/token logos. Untrusted bytes in, a clean local
// asset out — or a refusal. Nothing here renders, executes or forwards the original bytes.
//   PNG : signature, chunk CRCs, IHDR policy, no trailing data, bounded inflate (decompression-bomb guard), full
//         scanline unfiltering, conversion to RGBA8, area downscale, deterministic re-encode with ONLY IHDR/IDAT/
//         IEND. Every ancillary chunk (tEXt/iTXt/zTXt/eXIf/iCCP/tIME/APNG …) is dropped by construction.
//   WebP: RIFF container validation, exact size, key-frame VP8/VP8L bitstream header dimensions (must match VP8X),
//         animation refused, metadata chunks (EXIF/XMP/ICCP/unknown) dropped, container rebuilt. WebP pixels are not
//         decoded here (no codec dependency); the dimension cap still applies and the browser decodes a clean
//         container served same-origin with `nosniff`.
//   Anything else — SVG, HTML/XML, JPEG, GIF, unknown magic — is refused (SVG can carry script; no rasterizer).
import { createHash } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";

export type ImageRejection =
  | "EMPTY"
  | "TOO_LARGE"
  | "SVG_REJECTED"
  | "HTML_REJECTED"
  | "UNSUPPORTED_FORMAT"
  | "BAD_SIGNATURE"
  | "BAD_CHUNK"
  | "BAD_CRC"
  | "BAD_IHDR"
  | "DIMENSIONS_TOO_LARGE"
  | "INTERLACE_UNSUPPORTED"
  | "UNKNOWN_CRITICAL_CHUNK"
  | "TRAILING_DATA"
  | "MISSING_IDAT"
  | "DECOMPRESSION_LIMIT"
  | "CORRUPT_DATA"
  | "BAD_FILTER"
  | "BAD_PALETTE"
  | "ANIMATED_REJECTED"
  | "BAD_WEBP";
export interface SanitizedImage {
  ok: true;
  format: "png" | "webp";
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
  sourceSha256: string;
  dropped: string[];
}
export type SanitizeResult =
  SanitizedImage | { ok: false; reason: ImageRejection; sourceSha256: string };
export interface SanitizeOptions {
  /** Maximum accepted input size (bytes). */
  maxInputBytes?: number;
  /** Maximum accepted source width/height. */
  maxSourceDimension?: number;
  /** PNG output is downscaled to fit within this square. */
  outputSize?: number;
  /** Maximum WebP width/height (not downscaled). */
  maxWebpDimension?: number;
}
const DEFAULTS = {
  maxInputBytes: 600_000,
  maxSourceDimension: 1024,
  outputSize: 128,
  maxWebpDimension: 512,
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
class Reject extends Error {
  constructor(readonly reason: ImageRejection) {
    super(reason);
  }
}

// Magic-byte sniffing; the declared Content-Type is never trusted.
export function sniffImage(
  b: Buffer,
): "png" | "webp" | "svg" | "html" | "jpeg" | "gif" | "unknown" {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (
    b.length >= 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP"
  )
    return "webp";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "jpeg";
  if (b.toString("latin1", 0, 4) === "GIF8") return "gif";
  const head = b
    .toString("utf8", 0, Math.min(b.length, 1024))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (head.includes("<svg")) return "svg";
  if (/^<(\?xml|!doctype|html|head|body|script|!--)/.test(head)) return "html";
  return "unknown";
}

export function sanitizeImage(
  input: Buffer,
  options: SanitizeOptions = {},
): SanitizeResult {
  const o = { ...DEFAULTS, ...options };
  const sourceSha256 = sha(input);
  try {
    if (!input.length) throw new Reject("EMPTY");
    if (input.length > o.maxInputBytes) throw new Reject("TOO_LARGE");
    const kind = sniffImage(input);
    if (kind === "svg") throw new Reject("SVG_REJECTED");
    if (kind === "html") throw new Reject("HTML_REJECTED");
    if (kind === "png") return { ...sanitizePng(input, o), sourceSha256 };
    if (kind === "webp") return { ...sanitizeWebp(input, o), sourceSha256 };
    throw new Reject("UNSUPPORTED_FORMAT");
  } catch (e) {
    if (e instanceof Reject)
      return { ok: false, reason: e.reason, sourceSha256 };
    return { ok: false, reason: "CORRUPT_DATA", sourceSha256 };
  }
}

// ------------------------------------------------------------------------------------------------- PNG
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
function sanitizePng(input: Buffer, o: typeof DEFAULTS) {
  let pos = 8;
  const dropped: string[] = [];
  let ihdr: Buffer | null = null,
    plte: Buffer | null = null,
    trns: Buffer | null = null,
    sawIdat = false,
    idatClosed = false,
    ended = false;
  const idat: Buffer[] = [];
  while (pos < input.length) {
    if (ended) throw new Reject("TRAILING_DATA");
    if (pos + 12 > input.length) throw new Reject("BAD_CHUNK");
    const length = input.readUInt32BE(pos);
    const type = input.toString("latin1", pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > 0x7fffffff)
      throw new Reject("BAD_CHUNK");
    const end = pos + 12 + length;
    if (end > input.length) throw new Reject("BAD_CHUNK");
    const data = input.subarray(pos + 8, pos + 8 + length);
    const crc = input.readUInt32BE(pos + 8 + length);
    if (crc32(input.subarray(pos + 4, pos + 8 + length)) !== crc)
      throw new Reject("BAD_CRC");
    if (!ihdr && type !== "IHDR") throw new Reject("BAD_IHDR");
    if (type !== "IDAT" && sawIdat) idatClosed = true;
    switch (type) {
      case "IHDR":
        if (ihdr || length !== 13) throw new Reject("BAD_IHDR");
        ihdr = Buffer.from(data);
        break;
      case "PLTE":
        if (plte || sawIdat || length % 3 || !length || length > 768)
          throw new Reject("BAD_PALETTE");
        plte = Buffer.from(data);
        break;
      case "tRNS":
        if (trns || sawIdat) throw new Reject("BAD_CHUNK");
        trns = Buffer.from(data);
        break;
      case "IDAT":
        if (idatClosed) throw new Reject("BAD_CHUNK"); // IDAT chunks must be consecutive
        sawIdat = true;
        idat.push(data);
        break;
      case "IEND":
        if (length) throw new Reject("BAD_CHUNK");
        ended = true;
        break;
      case "acTL":
      case "fcTL":
      case "fdAT":
        // APNG: the default image is kept, the animation is dropped.
        dropped.push(type);
        break;
      default:
        // Critical (uppercase first letter) unknown chunks cannot be ignored safely; ancillary ones are metadata.
        if (type[0] === type[0].toUpperCase())
          throw new Reject("UNKNOWN_CRITICAL_CHUNK");
        dropped.push(type);
    }
    pos = end;
  }
  if (!ended) throw new Reject("BAD_CHUNK");
  if (!ihdr) throw new Reject("BAD_IHDR");
  if (!sawIdat) throw new Reject("MISSING_IDAT");
  const width = ihdr.readUInt32BE(0),
    height = ihdr.readUInt32BE(4),
    depth = ihdr[8],
    color = ihdr[9];
  if (
    !CHANNELS[color] ||
    !DEPTHS[color].includes(depth) ||
    ihdr[10] ||
    ihdr[11]
  )
    throw new Reject("BAD_IHDR");
  if (ihdr[12] === 1) throw new Reject("INTERLACE_UNSUPPORTED");
  if (ihdr[12] !== 0) throw new Reject("BAD_IHDR");
  if (
    !width ||
    !height ||
    width > o.maxSourceDimension ||
    height > o.maxSourceDimension
  )
    throw new Reject("DIMENSIONS_TOO_LARGE");
  if (color === 3 && (!plte || plte.length / 3 > 1 << depth))
    throw new Reject("BAD_PALETTE");
  const channels = CHANNELS[color];
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const expected = height * (rowBytes + 1);
  let raw: Buffer;
  try {
    // The decompressed size is exactly known from IHDR: anything larger is a bomb, anything smaller is corrupt.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (e) {
    throw new Reject(
      /ERR_BUFFER_TOO_LARGE|larger than|maxOutputLength/i.test(String(e))
        ? "DECOMPRESSION_LIMIT"
        : "CORRUPT_DATA",
    );
  }
  if (raw.length !== expected) throw new Reject("CORRUPT_DATA");
  const pixels = unfilter(raw, height, rowBytes, bpp);
  const rgba = toRgba(
    pixels,
    width,
    height,
    rowBytes,
    color,
    depth,
    plte,
    trns,
  );
  const scaled = downscale(rgba, width, height, o.outputSize);
  const bytes = encodePng(scaled.data, scaled.width, scaled.height);
  return {
    ok: true as const,
    format: "png" as const,
    bytes,
    width: scaled.width,
    height: scaled.height,
    sha256: sha(bytes),
    dropped,
  };
}
function unfilter(raw: Buffer, height: number, rowBytes: number, bpp: number) {
  const out = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    if (filter > 4) throw new Reject("BAD_FILTER");
    const line = y * (rowBytes + 1) + 1,
      row = y * rowBytes,
      prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0,
        b = y ? out[prev + x] : 0,
        c = x >= bpp && y ? out[prev + x - bpp] : 0;
      let v = raw[line + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = v & 0xff;
    }
  }
  return out;
}
function toRgba(
  px: Buffer,
  width: number,
  height: number,
  rowBytes: number,
  color: number,
  depth: number,
  plte: Buffer | null,
  trns: Buffer | null,
) {
  const out = Buffer.alloc(width * height * 4);
  const channels = CHANNELS[color];
  const max = (1 << depth) - 1;
  const sample = (row: number, index: number) => {
    if (depth === 8) return px[row + index];
    if (depth === 16) return px.readUInt16BE(row + index * 2);
    const bit = index * depth;
    return (px[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (v: number) =>
    depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max);
  const key = (i: number) =>
    trns && trns.length >= i * 2 + 2 ? trns.readUInt16BE(i * 2) : -1;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = (c: number) => sample(row, x * channels + c);
      if (color === 0) {
        const g = s(0);
        out[o] = out[o + 1] = out[o + 2] = to8(g);
        out[o + 3] = g === key(0) ? 0 : 255;
      } else if (color === 2) {
        const r = s(0),
          g = s(1),
          b = s(2);
        out[o] = to8(r);
        out[o + 1] = to8(g);
        out[o + 2] = to8(b);
        out[o + 3] = r === key(0) && g === key(1) && b === key(2) ? 0 : 255;
      } else if (color === 3) {
        const i = s(0);
        if (i * 3 + 2 >= plte!.length) throw new Reject("BAD_PALETTE");
        out[o] = plte![i * 3];
        out[o + 1] = plte![i * 3 + 1];
        out[o + 2] = plte![i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (color === 4) {
        out[o] = out[o + 1] = out[o + 2] = to8(s(0));
        out[o + 3] = to8(s(1));
      } else {
        out[o] = to8(s(0));
        out[o + 1] = to8(s(1));
        out[o + 2] = to8(s(2));
        out[o + 3] = to8(s(3));
      }
    }
  }
  return out;
}
// Area-average downscale with premultiplied alpha (no colour fringes at transparent edges).
export function downscale(
  rgba: Buffer,
  width: number,
  height: number,
  max: number,
) {
  if (width <= max && height <= max) return { data: rgba, width, height };
  const scale = Math.min(max / width, max / height);
  const w = Math.max(1, Math.round(width * scale)),
    h = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(w * h * 4);
  const sx = width / w,
    sy = height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy,
      y1 = y0 + sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx,
        x1 = x0 + sx;
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx),
            weight = wx * wy,
            i = (yy * width + xx) * 4,
            alpha = rgba[i + 3] / 255;
          r += rgba[i] * alpha * weight;
          g += rgba[i + 1] * alpha * weight;
          b += rgba[i + 2] * alpha * weight;
          a += alpha * weight;
          area += weight;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / area) * 255);
    }
  }
  return { data: out, width: w, height: h };
}
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
// Deterministic RGBA8 PNG: IHDR + one IDAT (filter 0, zlib level 9) + IEND. No metadata of any kind.
export function encodePng(rgba: Buffer, width: number, height: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------------------------------------- WebP
function sanitizeWebp(input: Buffer, o: typeof DEFAULTS) {
  const size = input.readUInt32LE(4);
  if (size + 8 !== input.length || size < 12) throw new Reject("BAD_WEBP");
  const chunks: { type: string; data: Buffer }[] = [];
  let pos = 12;
  while (pos < input.length) {
    if (pos + 8 > input.length) throw new Reject("BAD_WEBP");
    const type = input.toString("latin1", pos, pos + 4);
    const length = input.readUInt32LE(pos + 4);
    const end = pos + 8 + length + (length & 1);
    if (!/^[A-Z0-9 ]{4}$/.test(type) || end > input.length)
      throw new Reject("BAD_WEBP");
    chunks.push({ type, data: input.subarray(pos + 8, pos + 8 + length) });
    pos = end;
  }
  const dropped: string[] = [];
  const keep = (t: string) => chunks.filter((c) => c.type === t);
  if (keep("ANIM").length || keep("ANMF").length)
    throw new Reject("ANIMATED_REJECTED");
  for (const c of chunks)
    if (!["VP8 ", "VP8L", "VP8X", "ALPH"].includes(c.type))
      dropped.push(c.type.trim());
  const vp8 = keep("VP8 "),
    vp8l = keep("VP8L"),
    vp8x = keep("VP8X"),
    alph = keep("ALPH");
  if (vp8.length + vp8l.length !== 1 || vp8x.length > 1 || alph.length > 1)
    throw new Reject("BAD_WEBP");
  let width: number, height: number;
  if (vp8.length) {
    const d = vp8[0].data;
    if (
      d.length < 10 ||
      d[0] & 1 ||
      d[3] !== 0x9d ||
      d[4] !== 0x01 ||
      d[5] !== 0x2a
    )
      throw new Reject("BAD_WEBP");
    width = d.readUInt16LE(6) & 0x3fff;
    height = d.readUInt16LE(8) & 0x3fff;
  } else {
    const d = vp8l[0].data;
    if (d.length < 5 || d[0] !== 0x2f) throw new Reject("BAD_WEBP");
    const bits = d.readUInt32LE(1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
    if (bits >>> 29 !== 0) throw new Reject("BAD_WEBP"); // version must be 0
  }
  if (!width || !height) throw new Reject("BAD_WEBP");
  if (width > o.maxWebpDimension || height > o.maxWebpDimension)
    throw new Reject("DIMENSIONS_TOO_LARGE");
  if (vp8x.length) {
    const d = vp8x[0].data;
    if (d.length !== 10) throw new Reject("BAD_WEBP");
    if (d[0] & 0x02) throw new Reject("ANIMATED_REJECTED");
    const cw = (d.readUIntLE(4, 3) & 0xffffff) + 1,
      ch = (d.readUIntLE(7, 3) & 0xffffff) + 1;
    if (cw !== width || ch !== height) throw new Reject("BAD_WEBP");
  }
  if (alph.length && !vp8.length) throw new Reject("BAD_WEBP");
  const riffChunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([
      head,
      data,
      data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0),
    ]);
  };
  const body: Buffer[] = [];
  if (alph.length) {
    const x = Buffer.alloc(10);
    x[0] = 0x10; // alpha only: ICC/EXIF/XMP/animation flags cleared
    x.writeUIntLE(width - 1, 4, 3);
    x.writeUIntLE(height - 1, 7, 3);
    body.push(riffChunk("VP8X", x), riffChunk("ALPH", alph[0].data));
  }
  body.push(
    vp8.length
      ? riffChunk("VP8 ", vp8[0].data)
      : riffChunk("VP8L", vp8l[0].data),
  );
  const payload = Buffer.concat([Buffer.from("WEBP", "latin1"), ...body]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  const bytes = Buffer.concat([header, payload]);
  return {
    ok: true as const,
    format: "webp" as const,
    bytes,
    width,
    height,
    sha256: sha(bytes),
    dropped,
  };
}
