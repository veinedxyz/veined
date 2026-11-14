import { getCachedImage } from "../../../../assets/image-cache";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// V1.11: sanitized, content-addressed logo bytes (src/assets/image-cache.ts). Only a 64-hex id is accepted; the
// response can only ever be a re-encoded PNG or a rebuilt WebP container, served with nosniff and a CSP that
// forbids everything, so a byte stream can never be interpreted as a document.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const image = getCachedImage(id);
  if (!image)
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.format === "png" ? "image/png" : "image/webp",
      "Content-Length": String(image.bytes.length),
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
