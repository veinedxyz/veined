import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/evm-economic-mainnet.json";
import { simulateEvmEconomic } from "../../src/swap/server/evm-simulation";
import type { EvmBuild } from "../../src/swap/server/provider";
import type { SwapIntent, SwapQuote } from "../../src/swap/model";
const i = {
  ...fixture.result.intent,
  amount: BigInt(fixture.result.intent.amount),
} as SwapIntent;
const q = {
  ...fixture.result.quote,
  amountIn: BigInt(fixture.result.quote.amountIn),
  amountOut: BigInt(fixture.result.quote.amountOut),
  minAmountOut: BigInt(fixture.result.quote.minAmountOut),
  maxAmountIn: BigInt(fixture.result.quote.maxAmountIn),
} as unknown as SwapQuote;
const tx = fixture.result.build as EvmBuild;
function replay(change?: (method: string, result: unknown) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body),
        receipt = fixture.receipts.find(
          (r) =>
            r.request.method === request.method &&
            JSON.stringify(r.request.params) === JSON.stringify(request.params),
        );
      if (!receipt) throw Error("UNRECORDED_RPC_OR_CHANGED_TRANSACTION");
      const result = structuredClone(receipt.response.result);
      return Response.json({
        ...receipt.response,
        result: change ? change(request.method, result) : result,
      });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
describe("actual mainnet eth_simulateV1 economic replay", () => {
  it("verifies exact reviewed calldata and current balance changes without state overrides or a signature", async () => {
    replay();
    const simulation = await simulateEvmEconomic(
      tx,
      i,
      q,
      new AbortController().signal,
    );
    expect(simulation.tokenDeltas).toEqual(
      fixture.result.simulation.tokenDeltas,
    );
    expect(simulation.stateOverrides).toBe(false);
    expect(fixture.result.broadcasts).toBe(0);
  });
  it.each(["status", "output", "nativeDebit", "hiddenToken", "shape", "chain"])(
    "rejects hostile %s simulation evidence",
    async (mutation) => {
      replay((method, raw) => {
        if (method === "eth_chainId" && mutation === "chain") return "0x38";
        if (method !== "eth_simulateV1") return raw;
        const result = raw as {
          calls: {
            status: string;
            returnData: string;
            logs: { address: string; topics: string[]; data: string }[];
          }[];
        }[];
        const swap = result[0].calls[1];
        if (mutation === "status") swap.status = "0x0";
        if (mutation === "output")
          result[0].calls[2].returnData = "0x" + "0".repeat(64);
        if (mutation === "shape") result[0].calls.pop();
        if (mutation === "nativeDebit" || mutation === "hiddenToken")
          swap.logs.push({
            address:
              mutation === "nativeDebit"
                ? "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                : "0x1111111111111111111111111111111111111111",
            topics: [
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
              "0x" + i.taker.slice(2).toLowerCase().padStart(64, "0"),
              "0x" + "2".repeat(40).padStart(64, "0"),
            ],
            data: "0x" + "1".padStart(64, "0"),
          });
        return result;
      });
      await expect(
        simulateEvmEconomic(tx, i, q, new AbortController().signal),
      ).rejects.toThrow();
    },
  );
  it("refuses an altered transaction before accepting any recorded simulation", async () => {
    replay();
    await expect(
      simulateEvmEconomic(
        { ...tx, data: `${tx.data}00` as `0x${string}` },
        i,
        q,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});
