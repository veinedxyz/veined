import { inflateSync } from "node:zlib";

// Small, independent decoder for the non-interlaced 8-bit RGBA brand fixture.
// Avoid loading the native image pipeline merely to inspect 512x512 pixels.
export function decodeRgbaPng(png: Buffer) {
  if (
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw Error("PNG_SIGNATURE");
  let width = 0,
    height = 0,
    ended = false;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    if (offset + 12 > png.length) throw Error("PNG_TRUNCATED");
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw Error("PNG_TRUNCATED");
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== png.readUInt32BE(offset + 8 + length))
      throw Error("PNG_CRC");
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw Error("PNG_HEADER");
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (
        !width ||
        !height ||
        width > 2048 ||
        height > 2048 ||
        body[8] !== 8 ||
        body[9] !== 6 ||
        body[10] ||
        body[11] ||
        body[12]
      )
        throw Error("PNG_RGBA8_NONINTERLACED_REQUIRED");
    } else if (type === "IDAT") chunks.push(body);
    else if (type === "IEND") {
      if (length || end !== png.length) throw Error("PNG_END");
      ended = true;
    } else if (type[0] === type[0].toUpperCase())
      throw Error("PNG_UNKNOWN_CRITICAL_CHUNK");
    offset = end;
  }
  if (!width || !height || !chunks.length || !ended)
    throw Error("PNG_INCOMPLETE");
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(chunks), {
    maxOutputLength: (stride + 1) * height,
  });
  if (raw.length !== (stride + 1) * height) throw Error("PNG_PIXEL_LENGTH");
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw Error("PNG_FILTER");
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= 4 ? data[at - 4] : 0;
      const up = y ? data[at - stride] : 0;
      const upperLeft = y && x >= 4 ? data[at - stride - 4] : 0;
      const p = left + up - upperLeft;
      const pa = Math.abs(p - left),
        pb = Math.abs(p - up),
        pc = Math.abs(p - upperLeft);
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][
        filter
      ];
      data[at] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  return { data, info: { width, height } };
}
