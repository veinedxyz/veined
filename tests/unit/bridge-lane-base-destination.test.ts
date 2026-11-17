// VEINED-MC1 (BRIDGE LANE): a Base DESTINATION end to end through the REAL read path (src/swap/lane/reads.ts ->
// transport.ts) with global fetch MOCKED as the evidence's Base operators behave (A-rpc.json): mainnet.base.org serves
// receipts and state but refuses eth_getLogs ("-32011 request limit reached"); base-rpc.publicnode.com and
// base.drpc.org serve eth_getLogs over <= 100-block windows. The fill search reads the LOG pool (publicnode + dRPC)
// ONLY; every other destination read uses the RPC pool (publicnode + mainnet.base.org). The bridge pin set is mocked
// ONLY in its code hashes, as in bridge-lane-engine.test.ts.
// SYNTHETIC_TEST_ONLY: every response is the fake chain's (./bridge-lane-fake.ts). Nothing reaches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEY_DIGEST,
  OWNER,
  OWNER_KEY,
  bridgeLane,
  honestParts,
  quoteOf,
  recordFor,
  settleSource,
  type BridgeLane,
} from "./bridge-lane-fake";
import { BridgeLaneEngine } from "../../src/swap/lane/bridge-engine";
import { bridgeLaneGateState } from "../../src/swap/lane/bridge-approval";
import { bridgeReadBoth } from "../../src/swap/lane/reads";
import type { CanaryDurableStore } from "../../src/execution/server/canary/durable-store";

vi.mock("../../src/swap/lane/bridge-pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/bridge-pins")>();
  const { fakeBridgePinModule } = await import("./bridge-lane-pin-mock");
  return fakeBridgePinModule(real);
});

const PUBLICNODE = "https://base-rpc.publicnode.com";
const COINBASE = "https://mainnet.base.org";
const DRPC = "https://base.drpc.org";
type Hit = { url: string; method: string };
let hits: Hit[] = [];
/** Wires global fetch to the fake destination chain, as the three Base operators behave in the evidence. */
function wire(
  L: BridgeLane,
  over: (url: string, method: string) => unknown = () => undefined,
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = String(u);
    const body = JSON.parse(String((init as RequestInit).body)) as {
      method: string;
      params: unknown[];
    };
    hits.push({ url, method: body.method });
    const rpc = (x: Record<string, unknown>) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...x }), {
        status: 200,
      });
    if (![PUBLICNODE, COINBASE, DRPC].includes(url))
      throw new Error(`UNEXPECTED_URL ${url}`);
    if (url === COINBASE && body.method === "eth_getLogs")
      return rpc({
        error: { code: -32011, message: "request limit reached" },
      });
    const o = over(url, body.method);
    if (o !== undefined) return rpc({ result: o });
    const r = await L.dst.both(body.method, body.params);
    return r.errors.length
      ? rpc({ error: { code: -32000, message: "x" } })
      : rpc({ result: r.values[0] });
  });
}
function laneOverRealTransport(id = "bridge-42161-8453") {
  const L = bridgeLane({ pair: id });
  const record = recordFor(id);
  const engine = new BridgeLaneEngine({
    store: L.store as unknown as CanaryDurableStore,
    record,
    keyDigest: KEY_DIGEST,
    chains: {
      source: L.src,
      destination: {
        both: (method, params, pick) =>
          bridgeReadBoth(
            "8453",
            method,
            params,
            OWNER,
            new AbortController().signal,
            pick,
          ),
      },
      quote: async () =>
        quoteOf(id, honestParts(id, Math.floor(L.clock.t / 1000))),
    },
    signer: L.signer,
    now: () => L.clock.t,
    gate: (f) => bridgeLaneGateState(f, record, KEY_DIGEST, true),
  });
  return { L, engine };
}
async function stepOf(engine: BridgeLaneEngine) {
  const r = await engine.review(OWNER_KEY);
  expect(r.problems).toEqual([]);
  return engine.dispatch(engine.authorize(r.reviewId, OWNER_KEY), OWNER_KEY);
}
beforeEach(() => {
  hits = [];
});
afterEach(() => vi.restoreAllMocks());

describe("a Base destination fill is found on the LOG pool and settles", () => {
  it.each([
    "bridge-1-8453",
    "bridge-42161-8453",
    "bridge-10-8453",
    "bridge-137-8453",
  ])(
    "%s: SETTLED_VERIFIED; eth_getLogs only to publicnode + dRPC, never mainnet.base.org; dRPC serves nothing else",
    async (id) => {
      const { L, engine } = laneOverRealTransport(id);
      wire(L);
      await stepOf(engine);
      settleSource(L);
      await engine.track();
      await stepOf(engine);
      L.dst.advance(5);
      settleSource(L);
      const deposit = L.src.deposits.at(-1)!;
      L.dst.fill(deposit, BigInt(L.src.chainId));
      L.dst.advance(L.dst.chain.confirmations - 1);
      const t = await engine.track();
      expect(t.state, JSON.stringify(t.destination)).toBe("SETTLED_VERIFIED");
      expect(L.store.of("SETTLED")).toHaveLength(1);
      const logHits = hits.filter((h) => h.method === "eth_getLogs");
      expect(logHits.length).toBeGreaterThan(0);
      expect(new Set(logHits.map((h) => h.url))).toEqual(
        new Set([PUBLICNODE, DRPC]),
      );
      expect(
        hits.some((h) => h.url === COINBASE && h.method === "eth_getLogs"),
      ).toBe(false);
      expect(
        hits
          .filter((h) => h.url === DRPC)
          .every((h) => h.method === "eth_getLogs"),
      ).toBe(true);
      // the fill receipt and the block-hash re-check came from the RPC pool (publicnode + mainnet.base.org)
      expect(
        new Set(
          hits
            .filter((h) => h.method === "eth_getTransactionReceipt")
            .map((h) => h.url),
        ),
      ).toEqual(new Set([PUBLICNODE, COINBASE]));
      expect(L.dst.violations).toEqual([]);
    },
  );
  it("the LOG pool's two operators must still agree: dRPC without the fill -> DESTINATION_PENDING, not settled", async () => {
    const { L, engine } = laneOverRealTransport();
    wire(L, (url, method) =>
      url === DRPC && method === "eth_getLogs" ? [] : undefined,
    );
    await stepOf(engine);
    settleSource(L);
    await engine.track();
    await stepOf(engine);
    settleSource(L);
    L.dst.fill(L.src.deposits.at(-1)!, BigInt(L.src.chainId));
    L.dst.advance(L.dst.chain.confirmations - 1);
    const t = await engine.track();
    expect(t.state).toBe("DESTINATION_PENDING");
    expect(t.destination).toMatchObject({
      detail: "FILL_SEARCH_OPERATORS_DISAGREE",
    });
    expect(L.store.of("SETTLED")).toHaveLength(0);
  });
});
