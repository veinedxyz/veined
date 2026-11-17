// VEINED-MC1 (BRIDGE LANE): the bridge lane's read shapes (src/swap/lane/reads.ts bridgeReadProblem / bridgeRead /
// bridgeLifiQuote) and its two new transport functions (src/swap/lane/transport.ts laneGetLogs, laneLifiQuote), with
// global fetch MOCKED (nothing reaches a network). eth_getLogs: only the chain's pinned SpokePool, fixed topics, an
// explicit range of <= 100 blocks; the swap lane still never carries it. The LI.FI quote: exactly one GET of
// https://li.quest/v1/quote with the fixed query, redirect "error", no-store, no credentials, the 1 MB cap, stable codes.
// SYNTHETIC_TEST_ONLY: every response is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_LANE_READ_METHODS,
  SWAP_LANE_READ_METHODS,
  bridgeLifiQuote,
  bridgeRead,
  bridgeReadBoth,
  bridgeReadProblem,
  laneReadProblem,
} from "../../src/swap/lane/reads";
import {
  LANE_LIFI_QUOTE_URL,
  LANE_LOG_POOL,
  LANE_TRANSPORT_METHODS,
  SWAP_LANE_RPC_POOL,
  laneGetLogs,
  laneJsonRpc,
  laneLifiQuery,
  laneLifiQuote,
} from "../../src/swap/lane/transport";
import {
  BRIDGE_LANE_CHAIN_PINS,
  BRIDGE_LANE_TOPICS,
  bridgeReadContracts,
} from "../../src/swap/lane/bridge-pins";
import { BRIDGE_LANE_PAIRS, pairById } from "../../src/swap/lane/bridge-scope";
import { SWAP_LANE_ROUTES } from "../../src/swap/lane/scope";
import { SwapError } from "../../src/swap/model";

const OWNER = "0x3333333333333333333333333333333333333333";
const SECRET = "upstream-secret-detail-9c1d";
const live = () => new AbortController().signal;
const B = "0x" + (424_000_000).toString(16);
const W = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const filter = (chain: string, o: Record<string, unknown> = {}) => ({
  address: BRIDGE_LANE_CHAIN_PINS[chain].spokePool.address,
  fromBlock: "0x100",
  toBlock: "0x163",
  topics: [BRIDGE_LANE_TOPICS.filledRelay, W(8453n), W(4_926_614n)],
  ...o,
});
type FetchArgs = [string, RequestInit];
let fetchMock: ReturnType<typeof vi.spyOn>;
const calls = () => fetchMock.mock.calls as unknown as FetchArgs[];
const rpcOk = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
  });
beforeEach(() => {
  fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => rpcOk([]));
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
  expect((e as SwapError).message).toBe((e as SwapError).code);
  expect(String((e as SwapError).message)).not.toContain(SECRET);
  return (e as SwapError).code;
};

describe("bridge read shapes", () => {
  it("the method list is the swap lane's plus eth_getLogs only; the swap lane and laneJsonRpc still refuse eth_getLogs", async () => {
    expect([...BRIDGE_LANE_READ_METHODS]).toEqual([
      ...SWAP_LANE_READ_METHODS,
      "eth_getLogs",
    ]);
    expect(LANE_TRANSPORT_METHODS).not.toContain("eth_getLogs");
    expect(
      laneReadProblem(
        "eth_getLogs",
        [filter("8453")],
        OWNER,
        SWAP_LANE_ROUTES["base-usdc-weth-univ3-max1"],
      ),
    ).toBe("METHOD");
    expect(
      await code(
        laneJsonRpc("8453", 0, "eth_getLogs", [filter("8453")], live()),
      ),
    ).toBe("EXECUTION_CLOSED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["1", "8453", "42161", "10", "137"])(
    "chain %s: the allowed log shape passes (FilledRelay and FundsDeposited)",
    (c) => {
      expect(
        bridgeReadProblem(c, "eth_getLogs", [filter(c)], OWNER),
      ).toBeNull();
      expect(
        bridgeReadProblem(
          c,
          "eth_getLogs",
          [
            filter(c, {
              topics: [BRIDGE_LANE_TOPICS.fundsDeposited, W(1n), W(2n)],
            }),
          ],
          OWNER,
        ),
      ).toBeNull();
      // exactly 100 blocks is the cap; a single block is fine
      expect(
        bridgeReadProblem(
          c,
          "eth_getLogs",
          [filter(c, { fromBlock: "0x1", toBlock: "0x64" })],
          OWNER,
        ),
      ).toBeNull();
      expect(
        bridgeReadProblem(
          c,
          "eth_getLogs",
          [filter(c, { fromBlock: "0x64", toBlock: "0x64" })],
          OWNER,
        ),
      ).toBeNull();
    },
  );
  it("every other log shape is refused before the transport", () => {
    const no = (f: unknown, want: string, c = "8453") =>
      expect(
        bridgeReadProblem(c, "eth_getLogs", [f], OWNER),
        JSON.stringify(f),
      ).toBe(want);
    no(filter("8453", { fromBlock: "0x1", toBlock: "0x65" }), "LOG_RANGE"); // 101 blocks
    no(filter("8453", { fromBlock: "0x10", toBlock: "0xf" }), "LOG_RANGE"); // reversed
    no(filter("8453", { fromBlock: "latest" }), "LOG_RANGE");
    no(filter("8453", { toBlock: "0x0100" }), "LOG_RANGE"); // leading zero
    no(
      filter("8453", { address: BRIDGE_LANE_CHAIN_PINS["8453"].usdc.address }),
      "LOG_ADDRESS",
    );
    no(
      filter("8453", {
        address: BRIDGE_LANE_CHAIN_PINS["42161"].spokePool.address,
      }),
      "LOG_ADDRESS",
    ); // another chain's
    no(
      filter("8453", { topics: [BRIDGE_LANE_TOPICS.transfer, W(1n), W(2n)] }),
      "LOG_TOPICS",
    );
    no(
      filter("8453", { topics: [BRIDGE_LANE_TOPICS.filledRelay] }),
      "LOG_TOPICS",
    );
    no(
      filter("8453", { topics: [BRIDGE_LANE_TOPICS.filledRelay, null, W(2n)] }),
      "LOG_TOPICS",
    );
    no(
      filter("8453", {
        topics: [BRIDGE_LANE_TOPICS.filledRelay, "0x1", W(2n)],
      }),
      "LOG_TOPICS",
    );
    no(
      filter("8453", {
        topics: [BRIDGE_LANE_TOPICS.filledRelay, W(1n), W(2n), W(3n)],
      }),
      "LOG_TOPICS",
    );
    no({ ...filter("8453"), blockHash: "0x" + "ab".repeat(32) }, "LOG_FILTER");
    no(
      { address: filter("8453").address, topics: filter("8453").topics },
      "LOG_FILTER",
    );
    expect(
      bridgeReadProblem(
        "8453",
        "eth_getLogs",
        [filter("8453"), "extra"],
        OWNER,
      ),
    ).toBe("PARAMS");
    expect(bridgeReadProblem("8453", "eth_getLogs", [], OWNER)).toBe("PARAMS");
  });
  it("BLOCKED and unknown chains read nothing (BNB, Avalanche, inherited keys)", () => {
    expect(bridgeReadProblem("56", "eth_blockNumber", [], OWNER)).toBe(
      "CHAIN_BLOCKED",
    );
    for (const c of ["43114", "__proto__", "999", ""])
      expect(bridgeReadProblem(c, "eth_blockNumber", [], OWNER)).toBe("CHAIN");
  });
  it("calls and code reads name only the chain's pinned contracts; account reads only the owner", () => {
    const c = "42161";
    for (const a of bridgeReadContracts(c)) {
      expect(bridgeReadProblem(c, "eth_getCode", [a, B], OWNER)).toBeNull();
      expect(
        bridgeReadProblem(
          c,
          "eth_call",
          [{ to: a, data: "0x70a08231" }, B],
          OWNER,
        ),
      ).toBeNull();
    }
    // the router of the swap lane is not a bridge contract
    expect(
      bridgeReadProblem(
        c,
        "eth_getCode",
        [SWAP_LANE_ROUTES["arb-usdc-weth-univ3-max1"].router, B],
        OWNER,
      ),
    ).toBe("PARAMS");
    expect(
      bridgeReadProblem(
        c,
        "eth_call",
        [{ to: "0x" + "77".repeat(20), data: "0x" }, B],
        OWNER,
      ),
    ).toBe("CONTRACT");
    expect(
      bridgeReadProblem(
        c,
        "eth_getBalance",
        ["0x" + "44".repeat(20), B],
        OWNER,
      ),
    ).toBe("PARAMS");
    expect(bridgeReadProblem(c, "eth_sendRawTransaction", ["0x"], OWNER)).toBe(
      "METHOD",
    );
    // the OP-stack oracle is a bridge read contract on OP-stack chains only
    expect(bridgeReadContracts("8453")).toContain(
      "0x420000000000000000000000000000000000000f",
    );
    expect(bridgeReadContracts("1")).not.toContain(
      "0x420000000000000000000000000000000000000f",
    );
  });
  it("a refused shape never reaches fetch; an allowed log read goes to the chain's pool by index", async () => {
    expect(
      await code(
        bridgeRead(
          "8453",
          0,
          "eth_getLogs",
          [filter("8453", { toBlock: "0x1000" })],
          OWNER,
          live(),
        ),
      ),
    ).toBe("REVIEW_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
    const r = await bridgeReadBoth(
      "42161",
      "eth_getLogs",
      [filter("42161")],
      OWNER,
      live(),
    );
    expect(r).toEqual({ values: [[], []], agree: true, errors: [] });
    expect(
      calls()
        .map((x) => x[0])
        .sort(),
    ).toEqual(["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"]);
    expect(JSON.parse(String(calls()[0][1].body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [filter("42161")],
    });
    expect(calls()[0][1]).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
  });
});

describe("the LOG pool (laneGetLogs only)", () => {
  it("the allowlist: six bridge chains, two organisations each; Base = publicnode + dRPC (mainnet.base.org refuses logs); every other chain = its RPC pool", () => {
    expect(Object.isFrozen(LANE_LOG_POOL)).toBe(true);
    expect(Object.keys(LANE_LOG_POOL).sort()).toEqual(
      ["1", "8453", "42161", "10", "137", "56"].sort(),
    );
    for (const [c, pool] of Object.entries(LANE_LOG_POOL)) {
      expect(
        Object.isFrozen(pool) &&
          Object.isFrozen(pool[0]) &&
          Object.isFrozen(pool[1]),
      ).toBe(true);
      expect(pool).toHaveLength(2);
      expect(pool[0].operator).not.toBe(pool[1].operator);
      for (const s of pool) {
        expect(s.url).toMatch(/^https:\/\/[a-z0-9.-]+(?:\/[a-z0-9]+)?$/);
        expect(s.url).not.toBe("https://mainnet.base.org");
      }
      if (c !== "8453")
        expect(pool.map((s) => s.url)).toEqual(
          SWAP_LANE_RPC_POOL[c as keyof typeof SWAP_LANE_RPC_POOL].map(
            (s) => s.url,
          ),
        );
    }
    expect(LANE_LOG_POOL["8453"]).toEqual([
      {
        operator: "allnodes-publicnode",
        url: "https://base-rpc.publicnode.com",
      },
      { operator: "drpc", url: "https://base.drpc.org" },
    ]);
    expect(Object.keys(LANE_LOG_POOL)).not.toContain("43114");
  });
  it("eth_getLogs on Base goes to publicnode / dRPC by index; every RPC method goes to publicnode / mainnet.base.org, never dRPC", async () => {
    await laneGetLogs("8453", 0, filter("8453"), live());
    await laneGetLogs("8453", 1, filter("8453"), live());
    expect(calls().map((c) => c[0])).toEqual([
      "https://base-rpc.publicnode.com",
      "https://base.drpc.org",
    ]);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => rpcOk("0x10"));
    for (const m of LANE_TRANSPORT_METHODS) {
      await laneJsonRpc("8453", 0, m, [], live());
      await laneJsonRpc("8453", 1, m, [], live());
    }
    expect(new Set(calls().map((c) => c[0]))).toEqual(
      new Set(["https://base-rpc.publicnode.com", "https://mainnet.base.org"]),
    );
  });
  it.each(["1", "42161", "10", "137"])(
    "chain %s: the log reads go to the chain's RPC pool members",
    async (c) => {
      await laneGetLogs(c, 0, filter(c), live());
      await laneGetLogs(c, 1, filter(c), live());
      expect(calls().map((x) => x[0])).toEqual(
        SWAP_LANE_RPC_POOL[c as keyof typeof SWAP_LANE_RPC_POOL].map(
          (s) => s.url,
        ),
      );
    },
  );
});

describe("laneGetLogs (transport)", () => {
  it("re-checks the filter shape itself and refuses a non-array result", async () => {
    expect(await code(laneGetLogs("8453", 0, { address: "0x1" }, live()))).toBe(
      "REVIEW_REQUIRED",
    );
    expect(await code(laneGetLogs("43114", 0, filter("8453"), live()))).toBe(
      "EXECUTION_CLOSED",
    );
    expect(
      await code(laneGetLogs("8453", 2 as never, filter("8453"), live())),
    ).toBe("EXECUTION_CLOSED");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => rpcOk({ logs: [] }));
    expect(await code(laneGetLogs("8453", 0, filter("8453"), live()))).toBe(
      "INVALID_SCHEMA",
    );
    fetchMock.mockImplementation(
      async () => new Response(`err ${SECRET}`, { status: 429 }),
    );
    expect(await code(laneGetLogs("8453", 1, filter("8453"), live()))).toBe(
      "RATE_LIMITED",
    );
  });
});

describe("the ONE LI.FI quote (transport)", () => {
  const Q = {
    fromChain: "8453",
    toChain: "42161",
    fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    toToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    fromAmount: "5000000",
    account: OWNER,
  };
  it("exactly the URL and the fixed query; GET, redirect error, no-store, no credentials", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ tool: "across" }), { status: 200 }),
    );
    expect(await laneLifiQuote(Q, live())).toEqual({ tool: "across" });
    expect(calls()).toHaveLength(1);
    const [url, init] = calls()[0];
    expect(LANE_LIFI_QUOTE_URL).toBe("https://li.quest/v1/quote");
    expect(url).toBe(
      "https://li.quest/v1/quote?fromChain=8453&toChain=42161&fromToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" +
        "&toToken=0xaf88d065e77c8cC2239327C5EDb3A432268e5831&fromAmount=5000000" +
        `&fromAddress=${OWNER}&toAddress=${OWNER}&slippage=0.005&order=CHEAPEST&fee=0&allowDestinationCall=false&allowBridges=across`,
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(LANE_LIFI_QUOTE_URL);
    expect([...u.searchParams.keys()]).toEqual([
      "fromChain",
      "toChain",
      "fromToken",
      "toToken",
      "fromAmount",
      "fromAddress",
      "toAddress",
      "slippage",
      "order",
      "fee",
      "allowDestinationCall",
      "allowBridges",
    ]);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("the query schema is fixed: no extra field, no policy override, from = to = the account", async () => {
    const bad = [
      { ...Q, slippage: "0.5" },
      { ...Q, toAddress: "0x" + "44".repeat(20) },
      { ...Q, fromChain: "8453", toChain: "8453" },
      { ...Q, fromAmount: "05000000" },
      { ...Q, fromAmount: "5e6" },
      { ...Q, account: "0x" + "0".repeat(40) },
      { ...Q, fromToken: "usdc" },
      { ...Q, fromChain: "0" },
    ];
    for (const q of bad) {
      expect(() => laneLifiQuery(q as never), JSON.stringify(q)).toThrow(
        SwapError,
      );
      expect(await code(laneLifiQuote(q as never, live()))).toBe(
        "REVIEW_REQUIRED",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("responses: stable codes only, the 1 MB cap, a JSON object or nothing", async () => {
    for (const [status, want] of [
      [429, "RATE_LIMITED"],
      [404, "HTTP_4XX"],
      [403, "CREDENTIAL_REQUIRED"],
      [502, "HTTP_5XX"],
    ] as const) {
      fetchMock.mockImplementation(
        async () => new Response(`no quote ${SECRET}`, { status }),
      );
      expect(await code(laneLifiQuote(Q, live()))).toBe(want);
    }
    for (const body of ["[]", "null", "1", `<html>${SECRET}</html>`, ""]) {
      fetchMock.mockImplementation(
        async () => new Response(body, { status: 200 }),
      );
      expect(await code(laneLifiQuote(Q, live()))).toBe("INVALID_SCHEMA");
    }
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ pad: "x".repeat(1_000_000) }), {
          status: 200,
        }),
    );
    expect(await code(laneLifiQuote(Q, live()))).toBe("INVALID_SCHEMA");
    fetchMock.mockImplementation(async () => {
      throw new TypeError(`fetch failed ${SECRET}`);
    });
    expect(await code(laneLifiQuote(Q, live()))).toBe("PROVIDER_UNAVAILABLE");
    const c = new AbortController();
    c.abort();
    fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => {
      if ((init as RequestInit).signal?.aborted)
        throw new DOMException("aborted", "AbortError");
      return new Response("{}");
    });
    expect(await code(laneLifiQuote(Q, c.signal))).toBe("PROVIDER_TIMEOUT");
  });
  it("bridgeLifiQuote builds the query from the frozen ENABLED pair and the account only", async () => {
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 200 }),
    );
    const p = pairById("bridge-137-10")!;
    await bridgeLifiQuote(p, OWNER, live());
    const u = new URL(calls()[0][0]);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      fromChain: "137",
      toChain: "10",
      fromToken: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      toToken: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      fromAmount: "5000000",
      fromAddress: OWNER,
      toAddress: OWNER,
    });
    fetchMock.mockClear();
    // a BLOCKED pair, a look-alike pair object, a bad account: refused before fetch
    expect(
      await code(
        bridgeLifiQuote(BRIDGE_LANE_PAIRS["bridge-56-1"], OWNER, live()),
      ),
    ).toBe("REVIEW_REQUIRED");
    expect(await code(bridgeLifiQuote({ ...p }, OWNER, live()))).toBe(
      "REVIEW_REQUIRED",
    );
    expect(await code(bridgeLifiQuote(p, "0x12", live()))).toBe(
      "REVIEW_REQUIRED",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
