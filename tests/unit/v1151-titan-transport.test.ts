import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Encoder, Decoder } from "../../swap-providers/runtime";
import { base58 } from "@scure/base";
import { solIntent, swapIntent, swapQuote } from "../fixtures/swap";
import { QuoteCoordinator } from "../../src/swap/server/coordinator";
const sockets = vi.hoisted(() => ({ all: [] as MockSocket[] }));
class MockSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  protocol = "v1.api.titan.ag";
  sent: Uint8Array[] = [];
  terminate = vi.fn();
  constructor(
    readonly url: string,
    readonly protocols: string[],
    readonly options: unknown,
  ) {
    super();
    sockets.all.push(this);
    queueMicrotask(() => this.emit("open"));
  }
  send(b: Uint8Array) {
    this.sent.push(b);
  }
}
vi.mock("../../swap-providers/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get WebSocket() {
    return MockSocket;
  },
}));
import { connectTitan } from "../../src/swap/server/titan-transport";
const encoder = new Encoder({ useBigInt64: true }),
  decoder = new Decoder({ useBigInt64: true });
function send(s: MockSocket, v: unknown) {
  s.emit("message", Buffer.from(encoder.encode(v)), true);
}
function frame() {
  const i = solIntent(),
    a = base58.decode(i.tokenIn.address),
    b = base58.decode(i.tokenOut.address);
  return {
    id: "fixture",
    inputMint: a,
    outputMint: b,
    amount: i.amount,
    swapMode: "ExactIn",
    quotes: {
      fixture: {
        inAmount: i.amount,
        outAmount: 1_000_000n,
        slippageBps: 50,
        steps: [
          {
            ammKey: b,
            label: "Fixture",
            inputMint: a,
            outputMint: b,
            inAmount: i.amount,
            outAmount: 1_000_000n,
            allocPpb: 1_000_000_000,
          },
        ],
        instructions: [],
        addressLookupTables: [],
      },
    },
  };
}
async function stream() {
  const abort = new AbortController(),
    connection = await connectTitan(
      "wss://api.titan.exchange/api/v1/ws?auth=synthetic-secret",
      abort.signal,
    ),
    s = sockets.all.at(-1)!;
  const f = frame(),
    result = connection.newSwapQuoteStream({
      swap: {
        inputMint: f.inputMint,
        outputMint: f.outputMint,
        amount: f.amount,
        swapMode: "ExactIn",
        slippageBps: 50,
      },
      transaction: { userPublicKey: f.inputMint, feeBps: 0 },
      update: { numQuotes: 3, intervalMs: 1000 },
    });
  send(s, {
    Response: {
      requestId: 1,
      data: { NewSwapQuoteStream: {} },
      stream: { id: 4, dataType: "SwapQuotes" },
    },
  });
  return { connection, s, abort, reader: (await result).stream.getReader() };
}
afterEach(() => {
  sockets.all = [];
  vi.restoreAllMocks();
});
describe("bounded Titan wire transport", () => {
  it("uses official uncompressed protocol and preserves u64 values", async () => {
    const { s, reader, connection } = await stream();
    expect(s.options).toMatchObject({
      maxPayload: 262144,
      perMessageDeflate: false,
      followRedirects: false,
    });
    const request = decoder.decode(s.sent[0]);
    expect(request).toMatchObject({
      id: 1,
      data: { NewSwapQuoteStream: { swap: { amount: frame().amount } } },
    });
    send(s, {
      StreamData: { id: 4, seq: 0, payload: { SwapQuotes: frame() } },
    });
    expect((await reader.read()).value?.amount).toBe(frame().amount);
    await connection.close();
    expect(s.terminate).toHaveBeenCalledOnce();
  });
  it.each([
    "wrong-stream",
    "sequence",
    "shape",
    "oversized",
    "text",
    "compressed",
  ])("closes on %s without raw log output", async (kind) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {}),
      err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { s, reader } = await stream();
    if (kind === "sequence") {
      send(s, {
        StreamData: { id: 4, seq: 0, payload: { SwapQuotes: frame() } },
      });
      await reader.read();
    }
    const pending = reader.read();
    if (kind === "oversized") s.emit("message", Buffer.alloc(262145), true);
    else if (kind === "text") s.emit("message", Buffer.from("secret"), false);
    else if (kind === "compressed")
      s.emit("message", Buffer.from([0x1f, 0x8b, 0x08]), true);
    else if (kind === "shape")
      send(s, { Error: { message: "synthetic-secret" } });
    else
      send(s, {
        StreamData: {
          id: kind === "wrong-stream" ? 5 : 4,
          seq: 3,
          payload: { SwapQuotes: frame() },
        },
      });
    await expect(pending).rejects.toThrow(/^INVALID_SCHEMA$/);
    expect(s.terminate).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
  it("bounds unread frames and aborts immediately", async () => {
    const { s, abort, reader } = await stream();
    const p = reader.read();
    abort.abort();
    await expect(p).rejects.toThrow(/^CANCELLED$/);
    expect(s.terminate).toHaveBeenCalledOnce();
  });
  it("rejects compressed subprotocol negotiation", async () => {
    const p = connectTitan(
      "wss://api.titan.exchange/api/v1/ws",
      new AbortController().signal,
    );
    sockets.all.at(-1)!.protocol = "v1.api.titan.ag+gzip";
    await expect(p).rejects.toThrow("INVALID_SCHEMA");
  });
});
describe("upstream cancellation", () => {
  it("last subscriber abort releases even an uncooperative upstream without cooldown", async () => {
    let signal: AbortSignal | undefined;
    const i = swapIntent(),
      quote = vi.fn(async (_i, s: AbortSignal) => {
        signal = s;
        return new Promise<ReturnType<typeof swapQuote>[]>(() => {});
      });
    const c = new QuoteCoordinator(
        [
          {
            mode: "UNISWAP",
            provider: "Uniswap",
            chains: ["1"],
            exactOut: true,
            quote,
          },
        ],
        5000,
      ),
      abort = new AbortController();
    const pending = c.compete(i, abort.signal, () => {});
    await Promise.resolve();
    abort.abort();
    await pending;
    expect(signal?.aborted).toBe(true);
    quote.mockImplementation(async () => [swapQuote(i)]);
    await c.compete(i, new AbortController().signal, () => {});
    expect(quote).toHaveBeenCalledTimes(2);
    expect(c.health()[0].status).toBe("OK");
  });
});
