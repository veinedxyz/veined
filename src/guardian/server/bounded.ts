// Bounded upstream body reader for Guardian's fixed-origin adapters (1Click, NEAR RPC, NEAR AI Cloud). A declared
// Content-Length above the bound is refused before reading; the body is otherwise streamed and abandoned as soon as
// it grows past the bound, so an upstream can never make the server buffer an arbitrarily large response.
export class BodyTooLarge extends Error {
  constructor() {
    super("BODY_TOO_LARGE");
    this.name = "BodyTooLarge";
  }
}
export async function readBounded(r: Response, maxBytes: number) {
  const declared = Number(r.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await r.body?.cancel().catch(() => {});
    throw new BodyTooLarge();
  }
  if (!r.body) return "";
  const reader = r.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
