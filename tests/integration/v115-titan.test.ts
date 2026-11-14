import { describe, it, expect, vi } from "vitest";
import { base58 } from "@scure/base";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "../../swap-providers/runtime";
import { types } from "../../swap-providers/compatibility";
import type { TitanConnection } from "../../src/swap/server/titan-transport";
import { titan, normalizeTitan } from "../../src/swap/server/providers/titan";
import { solIntent } from "../fixtures/swap";
type Frame = Parameters<typeof normalizeTitan>[0];
function frame(): Frame {
  const i = solIntent(),
    inputMint = base58.decode(i.tokenIn.address),
    outputMint = base58.decode(i.tokenOut.address);
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(i.taker),
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message(),
  );
  return {
    id: "synthetic",
    inputMint,
    outputMint,
    swapMode: types.common.SwapMode.ExactIn,
    amount: Number(i.amount),
    quotes: {
      fixture: {
        inAmount: Number(i.amount),
        outAmount: 1000000,
        slippageBps: 50,
        steps: [
          {
            ammKey: outputMint,
            label: "Fixture venue",
            inputMint,
            outputMint,
            inAmount: Number(i.amount),
            outAmount: 1000000,
            allocPpb: 1000000000,
          },
        ],
        instructions: [],
        addressLookupTables: [],
        transaction: tx.serialize(),
        contextSlot: 1,
      },
    },
  };
}
function sdk(frames: Frame[]) {
  const close = vi.fn(async () => {}),
    newSwapQuoteStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(c) {
          for (const f of frames) c.enqueue(f);
          c.close();
        },
      }),
    }));
  const connect = vi.fn(
    async () => ({ close, newSwapQuoteStream }) as unknown as TitanConnection,
  );
  return { connect, close, newSwapQuoteStream };
}
describe("V115 official Titan stream contract fixtures", () => {
  it("blocks an unreviewed live endpoint even when credentials are configured", async () => {
    await expect(
      titan("wss://example.invalid", "synthetic-token").quote(
        solIntent(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("BUILD_REVIEW_REQUIRED");
  });
  it("forwards DEX/provider/venue filters and normalizes refreshed frames", async () => {
    const f = frame(),
      second = structuredClone(f);
    second.quotes.fixture.outAmount = 1100000;
    const s = sdk([f, second]),
      filters = {
        dexes: ["Fixture venue"],
        providers: ["fixture"],
        venueAllowlist: [f.outputMint],
        venueBanlist: [f.inputMint],
      };
    const a = titan(
        "wss://example.invalid/quote",
        "synthetic-token",
        filters,
        s.connect,
      ),
      seen: string[] = [];
    const q = await a.quote(solIntent(), new AbortController().signal, (r) =>
      seen.push(r.id),
    );
    expect(q).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(q[1].amountOut).toBe(1100000n);
    expect(s.newSwapQuoteStream.mock.calls[0]).toEqual([
      expect.objectContaining({ swap: expect.objectContaining(filters) }),
    ]);
    expect(s.close).toHaveBeenCalledOnce();
    const b = await a.build!(q[0], solIntent(), new AbortController().signal);
    expect(b.ecosystem).toBe("SVM");
    expect(b).toHaveProperty("lastValidBlockHeight", null);
  });
  it("reconnects once and never exposes a credential-bearing SDK error", async () => {
    const connect = vi
      .fn<(url: string, signal: AbortSignal) => Promise<TitanConnection>>()
      .mockRejectedValue(
        new Error("wss://example.invalid?auth=synthetic-token"),
      );
    await expect(
      titan("wss://example.invalid", "synthetic-token", {}, connect).quote(
        solIntent(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/^PROVIDER_UNAVAILABLE$/);
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("recovers from the first failed connection", async () => {
    const s = sdk([frame()]);
    const connect = vi
      .fn<(url: string, signal: AbortSignal) => Promise<TitanConnection>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(s.connect);
    expect(
      await titan(
        "wss://example.invalid",
        "synthetic-token",
        {},
        connect,
      ).quote(solIntent(), new AbortController().signal),
    ).toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("credential block performs no connection", async () => {
    const s = sdk([]);
    await expect(
      titan("", "", {}, s.connect).quote(
        solIntent(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("CREDENTIAL_REQUIRED");
    expect(s.connect).not.toHaveBeenCalled();
  });
  it.each(["amount", "allocation", "mode"])("rejects mutated %s", (field) => {
    const f = frame();
    if (field === "amount") f.quotes.fixture.inAmount++;
    else if (field === "allocation") f.quotes.fixture.steps[0].allocPpb = -1;
    else f.swapMode = types.common.SwapMode.ExactOut;
    expect(() => normalizeTitan(f, solIntent())).toThrow("INVALID_SCHEMA");
  });
});
