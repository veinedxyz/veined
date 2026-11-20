// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the swap lane's OWN read transport (src/swap/lane/transport.ts) with
// global fetch MOCKED (nothing reaches a network). Only the two pool URLs of a chain, chosen by index; POST JSON-RPC
// with redirect "error" and no-store; a streamed 1 MB response cap; the JSON-RPC envelope checked; HTTP and upstream
// errors mapped to stable SwapError codes (no raw upstream text); reads go through the route's own chain.
// SYNTHETIC_TEST_ONLY: every response below is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LANE_TRANSPORT_LIMITS,
  LANE_TRANSPORT_METHODS,
  SWAP_LANE_RPC_POOL,
  laneJsonRpc,
  lanePool,
} from "../../src/swap/lane/transport";
import { laneRead, laneReadBoth } from "../../src/swap/lane/reads";
import { SWAP_LANE_ROUTES } from "../../src/swap/lane/scope";
import { SwapError } from "../../src/swap/model";

const OWNER = "0x3333333333333333333333333333333333333333";
const SECRET = "upstream-secret-detail-7f3a";
const live = () => new AbortController().signal;
const rpcOk = (result: unknown, over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result, ...over }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
type FetchArgs = [string, RequestInit];
let fetchMock: ReturnType<typeof vi.spyOn>;
const calls = () => fetchMock.mock.calls as unknown as FetchArgs[];
beforeEach(() => {
  fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => rpcOk("0x10"));
});
afterEach(() => vi.restoreAllMocks());
const code = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => {
      throw new Error("EXPECTED_A_REFUSAL");
    },
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SwapError);
  // the code is the whole message: no upstream text crosses the boundary
  expect((e as SwapError).message).toBe((e as SwapError).code);
  expect(String((e as SwapError).message)).not.toContain(SECRET);
  return (e as SwapError).code;
};

describe("the pool: two URLs per chain, by index only", () => {
  it("every chain and index reaches exactly its pool URL with a POST JSON-RPC body, redirect error, no-store", async () => {
    for (const [chain, pool] of Object.entries(SWAP_LANE_RPC_POOL))
      for (const op of [0, 1] as const) {
        fetchMock.mockClear();
        expect(
          await laneJsonRpc(chain, op, "eth_blockNumber", [], live()),
        ).toBe("0x10");
        expect(calls()).toHaveLength(1);
        const [url, init] = calls()[0];
        expect(url).toBe(pool[op].url);
        expect(init).toMatchObject({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "error",
          cache: "no-store",
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(String(init.body))).toEqual({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_blockNumber",
          params: [],
        });
      }
  });
  it("the pool is frozen, Base keeps publicnode + mainnet.base.org, Avalanche has none", () => {
    expect(Object.isFrozen(SWAP_LANE_RPC_POOL)).toBe(true);
    for (const pool of Object.values(SWAP_LANE_RPC_POOL)) {
      expect(Object.isFrozen(pool)).toBe(true);
      expect(Object.isFrozen(pool[0])).toBe(true);
    }
    expect(lanePool("8453")?.map((s) => s.url)).toEqual([
      "https://base-rpc.publicnode.com",
      "https://mainnet.base.org",
    ]);
    expect(Object.keys(SWAP_LANE_RPC_POOL).sort()).toEqual(
      ["1", "10", "137", "42161", "56", "8453"].sort(),
    );
  });
  it("no chain, index or method outside the pool and the read list is ever fetched", async () => {
    for (const chain of ["43114", "999", "__proto__", "constructor", ""])
      expect(
        await code(laneJsonRpc(chain, 0, "eth_blockNumber", [], live())),
      ).toBe("EXECUTION_CLOSED");
    expect(
      await code(laneJsonRpc(8453 as never, 0, "eth_blockNumber", [], live())),
    ).toBe("EXECUTION_CLOSED");
    for (const op of [2, -1, "0", 1.5, null])
      expect(
        await code(
          laneJsonRpc("8453", op as never, "eth_blockNumber", [], live()),
        ),
      ).toBe("EXECUTION_CLOSED");
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_getLogs",
      "debug_traceCall",
      "personal_sign",
      "",
    ])
      expect(await code(laneJsonRpc("8453", 0, method, [], live()))).toBe(
        "EXECUTION_CLOSED",
      );
    expect(
      await code(
        laneJsonRpc("8453", 0, "eth_blockNumber", {} as never, live()),
      ),
    ).toBe("REVIEW_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
    for (const m of LANE_TRANSPORT_METHODS)
      expect(m).not.toMatch(/send|sign|wallet_|debug_|admin_|getLogs/i);
  });
});

describe("the response: 1 MB cap, envelope, stable error codes", () => {
  const body = (n: number) => {
    // a valid JSON-RPC body of exactly n bytes
    const head = '{"jsonrpc":"2.0","id":1,"result":"0x',
      tail = '"}';
    return head + "a".repeat(n - head.length - tail.length) + tail;
  };
  it("a body of exactly the cap is read; one byte more is refused", async () => {
    expect(LANE_TRANSPORT_LIMITS.maxResponseBytes).toBe(1_000_000);
    fetchMock.mockImplementation(
      async () => new Response(body(1_000_000), { status: 200 }),
    );
    const exact = body(1_000_000);
    expect(new TextEncoder().encode(exact).length).toBe(1_000_000);
    expect(await laneJsonRpc("1", 0, "eth_getCode", [], live())).toBe(
      (JSON.parse(exact) as { result: string }).result,
    );
    fetchMock.mockImplementation(
      async () => new Response(body(1_000_001), { status: 200 }),
    );
    expect(await code(laneJsonRpc("1", 0, "eth_getCode", [], live()))).toBe(
      "INVALID_SCHEMA",
    );
  });
  it("an endless streamed body is cut at the cap and the stream is cancelled", async () => {
    let pulled = 0,
      cancelled = false;
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              pulled++;
              c.enqueue(new Uint8Array(400_000).fill(0x20));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    expect(await code(laneJsonRpc("137", 1, "eth_call", [], live()))).toBe(
      "INVALID_SCHEMA",
    );
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(6);
  });
  it("HTTP errors map to stable codes and never carry the upstream text", async () => {
    for (const [status, want] of [
      [429, "RATE_LIMITED"],
      [401, "CREDENTIAL_REQUIRED"],
      [403, "CREDENTIAL_REQUIRED"],
      [500, "HTTP_5XX"],
      [503, "HTTP_5XX"],
      [404, "HTTP_4XX"],
      [400, "HTTP_4XX"],
    ] as const) {
      fetchMock.mockImplementation(
        async () => new Response(`error: ${SECRET}`, { status }),
      );
      expect(
        await code(laneJsonRpc("42161", 0, "eth_blockNumber", [], live())),
        String(status),
      ).toBe(want);
    }
  });
  it("a JSON-RPC error or a malformed envelope is refused (SIMULATION_FAILED for calls, else INVALID_SCHEMA)", async () => {
    const errorBody = () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: 3, message: `execution reverted: ${SECRET}` },
        }),
        { status: 200 },
      );
    fetchMock.mockImplementation(async () => errorBody());
    expect(await code(laneJsonRpc("10", 0, "eth_call", [], live()))).toBe(
      "SIMULATION_FAILED",
    );
    expect(
      await code(laneJsonRpc("10", 0, "eth_estimateGas", [], live())),
    ).toBe("SIMULATION_FAILED");
    expect(await code(laneJsonRpc("10", 0, "eth_getCode", [], live()))).toBe(
      "INVALID_SCHEMA",
    );
    for (const bad of [
      () => rpcOk("0x1", { id: 2 }),
      () => rpcOk("0x1", { jsonrpc: "1.0" }),
      () =>
        new Response(
          JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "0x1" }]),
        ),
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
      () => new Response(`<html>${SECRET}</html>`),
      () => new Response(""),
      () => new Response("null"),
      () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1", error: null }),
        ),
    ]) {
      fetchMock.mockImplementation(async () => bad());
      expect(
        await code(laneJsonRpc("10", 1, "eth_blockNumber", [], live())),
      ).toBe("INVALID_SCHEMA");
    }
  });
  it("a failed request is PROVIDER_UNAVAILABLE; an aborted one PROVIDER_TIMEOUT", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError(`fetch failed: ${SECRET}`);
    });
    expect(
      await code(laneJsonRpc("8453", 1, "eth_blockNumber", [], live())),
    ).toBe("PROVIDER_UNAVAILABLE");
    const c = new AbortController();
    c.abort();
    fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => {
      if ((init as RequestInit).signal?.aborted)
        throw new DOMException("aborted", "AbortError");
      return rpcOk("0x1");
    });
    expect(
      await code(laneJsonRpc("8453", 1, "eth_blockNumber", [], c.signal)),
    ).toBe("PROVIDER_TIMEOUT");
    // a redirect is an error by construction (redirect: "error" makes fetch reject)
    fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => {
      if ((init as RequestInit).redirect === "error")
        throw new TypeError("unexpected redirect");
      return rpcOk("0x1");
    });
    expect(
      await code(laneJsonRpc("8453", 0, "eth_blockNumber", [], live())),
    ).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("reads reach the transport through their route's chain only", () => {
  it("laneRead on the Ethereum route goes to the Ethereum pool by index", async () => {
    const eth = SWAP_LANE_ROUTES["eth-usdc-weth-univ3-max1"];
    expect(await laneRead(eth, 1, "eth_blockNumber", [], OWNER, live())).toBe(
      "0x10",
    );
    expect(calls()[0][0]).toBe("https://ethereum-rpc.publicnode.com");
  });
  it("laneReadBoth on the Polygon route reads both Polygon operators and compares them", async () => {
    const pol = SWAP_LANE_ROUTES["pol-usdc-wpol-univ3-max1"];
    const both = await laneReadBoth(pol, "eth_blockNumber", [], OWNER, live());
    expect(both).toEqual({ values: ["0x10", "0x10"], agree: true, errors: [] });
    expect(
      calls()
        .map((c) => c[0])
        .sort(),
    ).toEqual(
      [
        "https://polygon-bor-rpc.publicnode.com",
        "https://polygon.drpc.org",
      ].sort(),
    );
  });
  it("a BLOCKED route (BNB, which has a pool) and a refused shape never reach fetch", async () => {
    const bnb = SWAP_LANE_ROUTES["bnb-usdc-wbnb-univ3-max1"];
    expect(lanePool("56")).not.toBeNull();
    expect(
      await code(laneRead(bnb, 0, "eth_blockNumber", [], OWNER, live())),
    ).toBe("REVIEW_REQUIRED");
    const base = SWAP_LANE_ROUTES["base-usdc-weth-univ3-max1"];
    expect(
      await code(
        laneRead(
          base,
          0,
          "eth_getBalance",
          ["0x" + "44".repeat(20), "0x1"],
          OWNER,
          live(),
        ),
      ),
    ).toBe("REVIEW_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
