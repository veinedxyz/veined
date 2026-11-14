import { BridgeError } from "../core/model";
export async function boundedBody(
  request: Request,
  limit = 16000,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new BridgeError("INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new BridgeError("REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
