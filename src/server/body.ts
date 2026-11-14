import { BridgeError } from "../core/model";
export async function boundedBody(
  request: Request,
  limit = 16000,
  totalMs = 10000,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new BridgeError("INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Overall deadline as well as a per-chunk one: trickled bodies cannot hold a handler open.
  const deadline = Date.now() + totalMs;
  let timedOut = false;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              // Reject before cancelling: cancel() resolves the pending read with done=true, which
              // must never be mistaken for a complete (truncated) body.
              timedOut = true;
              reject(new BridgeError("REQUEST_TIMEOUT"));
              void reader.cancel();
            },
            Math.max(1, Math.min(8000, deadline - Date.now())),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (timedOut) throw new BridgeError("REQUEST_TIMEOUT");
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
