import { Encoder, Decoder, WebSocket } from "../../../swap-providers/runtime";
import { SwapError } from "../model";
import { z } from "zod";
const u64 = z
  .union([z.bigint(), z.number().int().safe()])
  .refine((v) => BigInt(v) >= 0n && BigInt(v) < 1n << 64n);
const bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array);
const key = bytes.refine((v) => v.length === 32);
const route = z.object({
  inAmount: u64,
  outAmount: u64,
  slippageBps: z.number().int().min(0).max(300),
  platformFee: z
    .object({ amount: u64, fee_bps: z.number().int().min(0).max(300) })
    .optional(),
  steps: z
    .array(
      z.object({
        ammKey: key,
        label: z.string().min(1).max(80),
        inputMint: key,
        outputMint: key,
        inAmount: u64,
        outAmount: u64,
        allocPpb: z.number().int().positive().max(1_000_000_000),
        feeMint: key.optional(),
        feeAmount: u64.optional(),
        contextSlot: z.number().int().safe().optional(),
      }),
    )
    .min(1)
    .max(32),
  transaction: bytes.refine((v) => v.length <= 1232).optional(),
  instructions: z.array(z.unknown()).max(32),
  addressLookupTables: z.array(key).max(8),
  contextSlot: z.number().int().safe().optional(),
  expiresAtMs: z.number().int().safe().optional(),
  expiresAfterSlot: z.number().int().safe().optional(),
});
export const titanFrameSchema = z.object({
  id: z.string().min(1).max(128),
  inputMint: key,
  outputMint: key,
  swapMode: z.enum(["ExactIn", "ExactOut"]),
  amount: u64,
  quotes: z
    .record(z.string().max(80), route)
    .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 16),
});
export type TitanFrame = z.infer<typeof titanFrameSchema>;
export type TitanRequest = {
  swap: {
    inputMint: Uint8Array;
    outputMint: Uint8Array;
    amount: bigint;
    swapMode: string;
    slippageBps: number;
    [key: string]: unknown;
  };
  transaction: { userPublicKey: Uint8Array; feeBps: number };
  update: { numQuotes: number; intervalMs: number };
};
export type TitanConnection = {
  close(): Promise<void>;
  newSwapQuoteStream(
    request: TitanRequest,
  ): Promise<{ stream: ReadableStream<TitanFrame> }>;
};
const protocol = "v1.api.titan.ag";
const MAX_FRAME = 256 * 1024;
/** Official uncompressed MessagePack subprotocol, one connection/stream, no raw errors or packet logging. */
export async function connectTitan(
  url: string,
  signal: AbortSignal,
): Promise<TitanConnection> {
  const endpoint = new URL(url);
  if (
    endpoint.origin !== "wss://api.titan.exchange" ||
    endpoint.pathname !== "/api/v1/ws" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    [...endpoint.searchParams.keys()].some((k) => k !== "auth")
  )
    throw new SwapError("BUILD_REVIEW_REQUIRED");
  if (signal.aborted) throw new SwapError("CANCELLED");
  const encoder = new Encoder({ useBigInt64: true }),
    decoder = new Decoder({
      useBigInt64: true,
      maxStrLength: 8192,
      maxBinLength: MAX_FRAME,
      maxArrayLength: 128,
      maxMapLength: 64,
      maxExtLength: 0,
    });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [protocol], {
      maxPayload: MAX_FRAME,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 5000,
    });
    let closed = false,
      opened = false,
      started = false,
      streamId: number | undefined,
      seq: number | undefined,
      controller: ReadableStreamDefaultController<TitanFrame> | undefined;
    let pending:
      | {
          resolve: (v: { stream: ReadableStream<TitanFrame> }) => void;
          reject: (e: SwapError) => void;
        }
      | undefined;
    const timer = setTimeout(() => fail("PROVIDER_TIMEOUT"), 8000);
    function finish() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      ws.terminate();
    }
    function fail(
      code:
        | "PROVIDER_UNAVAILABLE"
        | "PROVIDER_TIMEOUT"
        | "INVALID_SCHEMA"
        | "CANCELLED",
    ) {
      if (closed) return;
      const error = new SwapError(code);
      pending?.reject(error);
      pending = undefined;
      try {
        controller?.error(error);
      } catch {}
      reject(error);
      finish();
    }
    function abort() {
      fail("CANCELLED");
    }
    const close = async () => {
      if (closed) return;
      if (streamId !== undefined && ws.readyState === WebSocket.OPEN)
        ws.send(
          encoder.encode({ id: 2, data: { StopStream: { id: streamId } } }),
        );
      try {
        controller?.close();
      } catch {}
      pending?.reject(new SwapError("CANCELLED"));
      pending = undefined;
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
    ws.on("error", () => fail("PROVIDER_UNAVAILABLE"));
    ws.on("close", () => {
      if (!closed) fail("PROVIDER_UNAVAILABLE");
    });
    ws.on("open", () => {
      if (signal.aborted) return abort();
      if (ws.protocol !== protocol) return fail("INVALID_SCHEMA");
      opened = true;
      resolve({
        close,
        newSwapQuoteStream: async (request) => {
          if (closed || !opened || started)
            throw new SwapError("INVALID_SCHEMA");
          started = true;
          return new Promise((res, rej) => {
            pending = { resolve: res, reject: rej };
            try {
              ws.send(
                encoder.encode({
                  id: 1,
                  data: { NewSwapQuoteStream: request },
                }),
              );
            } catch {
              fail("INVALID_SCHEMA");
            }
          });
        },
      });
    });
    ws.on("message", (bytes, binary) => {
      if (closed) return;
      try {
        const packet =
          bytes instanceof ArrayBuffer
            ? new Uint8Array(bytes)
            : Buffer.isBuffer(bytes)
              ? bytes
              : Buffer.concat(bytes);
        if (!binary || packet.length > MAX_FRAME) throw Error();
        const value = decoder.decode(packet);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== 1
        )
          throw Error();
        const m = value as Record<string, unknown>;
        if ("Response" in m) {
          const r = z
            .object({
              requestId: z.literal(1),
              data: z.object({ NewSwapQuoteStream: z.unknown() }).strict(),
              stream: z
                .object({
                  id: z.number().int().nonnegative(),
                  dataType: z.literal("SwapQuotes"),
                })
                .strict(),
            })
            .strict()
            .parse(m.Response);
          if (!pending || streamId !== undefined) throw Error();
          streamId = r.stream.id;
          const stream = new ReadableStream<TitanFrame>(
            {
              start(c) {
                controller = c;
              },
              cancel: close,
            },
            { highWaterMark: 4 },
          );
          pending.resolve({ stream });
          pending = undefined;
        } else if ("StreamData" in m) {
          const r = z
            .object({
              id: z.number().int(),
              seq: z.number().int().nonnegative(),
              payload: z.object({ SwapQuotes: titanFrameSchema }).strict(),
            })
            .strict()
            .parse(m.StreamData);
          if (
            r.id !== streamId ||
            !controller ||
            (seq !== undefined && r.seq !== seq + 1) ||
            (controller.desiredSize ?? 0) <= 0
          )
            throw Error();
          seq = r.seq;
          controller.enqueue(r.payload.SwapQuotes);
        } else if ("StreamEnd" in m) {
          const r = z
            .object({
              id: z.number().int(),
              errorCode: z.number().optional(),
              errorMessage: z.string().max(8192).optional(),
            })
            .strict()
            .parse(m.StreamEnd);
          if (r.id !== streamId || r.errorCode !== undefined) throw Error();
          void close();
        } else throw Error();
      } catch {
        fail("INVALID_SCHEMA");
      }
    });
  });
}
