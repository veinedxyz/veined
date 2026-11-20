// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the swap lane's READ-ONLY capability (src/swap/lane/reads.ts). One
// frozen method list, pinned contracts only, the record's own account only, explicit block numbers, no state override,
// no value. A refused shape never reaches the transport (global fetch is spied and must stay untouched).
// SYNTHETIC_TEST_ONLY: the account 0x3333…3333 is synthetic; nothing here reaches a network.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SWAP_LANE_READ_METHODS,
  laneRead,
  laneReadBoth,
  laneReadProblem,
} from "../../src/swap/lane/reads";
import {
  SWAP_LANE_ROUTE_PINS,
  laneReadContracts,
} from "../../src/swap/lane/pins";
import { SWAP_LANE_ROUTES } from "../../src/swap/lane/scope";
import { LANE_TRANSPORT_METHODS } from "../../src/swap/lane/transport";
import { SwapError } from "../../src/swap/model";

/** The reviewed Base route: this file's fixture (every other route: swap-lane-routes.test.ts). */
const BASE = "base-usdc-weth-univ3-max1";
const BASE_ROUTE = SWAP_LANE_ROUTES[BASE];
const BASE_PINS = SWAP_LANE_ROUTE_PINS[BASE];
const SWAP_LANE_READ_CONTRACTS = laneReadContracts(BASE);
const OWNER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const B = "0x3722f32";
const HASH = "0x" + "ab".repeat(32);
const U = BASE_PINS.pay.address;
const balanceOf = "0x70a08231" + OWNER.slice(2).padStart(64, "0");
const call = (over: Record<string, unknown> = {}) => ({
  from: OWNER,
  to: U,
  data: balanceOf,
  ...over,
});
const sim = (
  over: Record<string, unknown> = {},
  calls: unknown[] = [call()],
  block: unknown = B,
) => [
  {
    blockStateCalls: [{ calls }],
    validation: false,
    traceTransfers: false,
    ...over,
  },
  block,
];
const ok = (
  method: string,
  params: unknown[],
  account: string | null = OWNER,
) =>
  expect(
    laneReadProblem(method, params, account, BASE_ROUTE),
    `${method} ${JSON.stringify(params)}`,
  ).toBeNull();
const no = (
  method: string,
  params: unknown[],
  code: string,
  account: string | null = OWNER,
) =>
  expect(
    laneReadProblem(method, params, account, BASE_ROUTE),
    `${method} ${JSON.stringify(params)}`,
  ).toBe(code);

afterEach(() => vi.restoreAllMocks());

describe("the allowed read shapes", () => {
  it("the method list is frozen and read-only", () => {
    expect(Object.isFrozen(SWAP_LANE_READ_METHODS)).toBe(true);
    for (const m of SWAP_LANE_READ_METHODS)
      expect(m).not.toMatch(
        /send|sign|personal|wallet_|debug_|admin_|txpool|engine_|miner_|getLogs|subscribe/i,
      );
    expect(SWAP_LANE_READ_CONTRACTS).toEqual(
      [
        BASE_PINS.pay.address,
        BASE_PINS.receive.address,
        BASE_PINS.router.address,
        BASE_PINS.quoter.address,
        BASE_PINS.factory.address,
        BASE_PINS.pool.address,
        BASE_PINS.gasPriceOracle!,
      ].map((a) => a.toLowerCase()),
    );
  });
  it("every shape the engine uses passes", () => {
    ok("eth_blockNumber", []);
    ok("eth_maxPriorityFeePerGas", []);
    ok("eth_getBlockByNumber", [B, false]);
    ok("eth_getBlockByNumber", ["0x0", false]);
    for (const c of SWAP_LANE_READ_CONTRACTS) {
      ok("eth_getCode", [c, B]);
      ok("eth_call", [{ to: c, data: "0x3850c7bd" }, B]);
    }
    ok("eth_getCode", [
      BASE_PINS.router.address.toUpperCase().replace("0X", "0x"),
      B,
    ]);
    ok("eth_getStorageAt", [U, BASE_PINS.pay.implementation!.slot, B]);
    ok("eth_call", [call(), B]);
    ok("eth_call", [{ to: U, data: balanceOf }, B]);
    ok("eth_call", [call({ value: "0x0", gas: "0x30d40" }), B]);
    ok("eth_estimateGas", [call(), B]);
    ok("eth_getBalance", [OWNER, B]);
    ok("eth_getBalance", [OWNER.toUpperCase().replace("0X", "0x"), "latest"]);
    ok("eth_getTransactionCount", [OWNER, "pending"]);
    ok("eth_getTransactionByHash", [HASH]);
    ok("eth_getTransactionReceipt", [HASH]);
    ok("eth_simulateV1", sim());
    ok(
      "eth_simulateV1",
      sim(
        {},
        Array.from({ length: 8 }, () => call()),
      ),
    );
    ok(
      "eth_simulateV1",
      sim({}, [
        { from: OWNER, to: BASE_PINS.router.address, data: "0x5ae401dc" },
      ]),
    );
  });
});

describe("refused methods", () => {
  it.each([
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "eth_signTransaction",
    "eth_sign",
    "personal_sign",
    "eth_signTypedData_v4",
    "wallet_sendCalls",
    "wallet_grantPermissions",
    "debug_traceCall",
    "debug_traceTransaction",
    "debug_setHead",
    "admin_addPeer",
    "eth_getLogs",
    "eth_subscribe",
    "eth_newFilter",
    "eth_accounts",
    "eth_requestAccounts",
    "eth_createAccessList",
    "ETH_CALL",
    "eth_call ",
    "",
    "constructor",
    "__proto__",
    "toString",
  ])("%s -> METHOD", (method) => {
    no(method, [], "METHOD");
    no(method, [call(), B], "METHOD");
  });
});

describe("refused params", () => {
  it("eth_call / eth_getCode / eth_getStorageAt to a non-pinned contract", () => {
    no("eth_call", [call({ to: OTHER }), B], "CONTRACT");
    no("eth_call", [call({ to: undefined }), B], "CONTRACT");
    no(
      "eth_call",
      [call({ to: "0x000000000022D473030F116dDEE9F6B43aC78BA3" }), B],
      "CONTRACT",
    );
    no("eth_estimateGas", [call({ to: OTHER }), B], "CONTRACT");
    no("eth_getCode", [OTHER, B], "PARAMS");
    no(
      "eth_getStorageAt",
      [OTHER, BASE_PINS.pay.implementation!.slot, B],
      "PARAMS",
    );
  });
  it('"latest" (or any tag / malformed number) where an explicit block is required', () => {
    for (const tag of [
      "latest",
      "pending",
      "safe",
      "finalized",
      "earliest",
      "0x01",
      "0X10",
      "16",
      16,
      null,
      "0x" + "f".repeat(17),
      { blockHash: HASH },
    ]) {
      no("eth_call", [call(), tag], "PARAMS");
      no("eth_estimateGas", [call(), tag], "PARAMS");
      no("eth_getCode", [U, tag], "PARAMS");
      no(
        "eth_getStorageAt",
        [U, BASE_PINS.pay.implementation!.slot, tag],
        "PARAMS",
      );
      no("eth_getBlockByNumber", [tag, false], "PARAMS");
      no("eth_simulateV1", sim({}, [call()], tag), "PARAMS");
    }
    no("eth_call", [call()], "PARAMS");
    no("eth_getCode", [U], "PARAMS");
  });
  it("full transactions in a block read, a non-32-byte slot", () => {
    no("eth_getBlockByNumber", [B, true], "PARAMS");
    no("eth_getBlockByNumber", [B], "PARAMS");
    no("eth_getStorageAt", [U, "0x0", B], "PARAMS");
    no("eth_getStorageAt", [U, "0x" + "0".repeat(63), B], "PARAMS");
  });
  it("account reads for another account (or with no lane account)", () => {
    no("eth_getBalance", [OTHER, B], "PARAMS");
    no("eth_getTransactionCount", [OTHER, "latest"], "PARAMS");
    no("eth_getBalance", [U, B], "PARAMS");
    no("eth_getBalance", [OWNER, B], "PARAMS", null);
    no("eth_getBalance", [OWNER, "earliest"], "PARAMS");
    no("eth_getBalance", [OWNER], "PARAMS");
    no("eth_call", [call(), B], "FROM", null);
    no("eth_simulateV1", sim(), "SIM_CALL", null);
  });
  it("eth_call / eth_estimateGas from another account, with value, with extra fields or a state override", () => {
    no("eth_call", [call({ from: OTHER }), B], "FROM");
    no("eth_estimateGas", [call({ from: OTHER }), B], "FROM");
    for (const value of ["0x1", "0x00", "0", 0, "0xde0b6b3a7640000"]) {
      no("eth_call", [call({ value }), B], "VALUE");
      no("eth_estimateGas", [call({ value }), B], "VALUE");
    }
    for (const k of [
      "input",
      "gasPrice",
      "maxFeePerGas",
      "nonce",
      "accessList",
      "stateOverride",
      "blobVersionedHashes",
    ])
      no("eth_call", [call({ [k]: "0x1" }), B], "CALL_FIELD");
    no("eth_call", [call(), B, { [OWNER]: { balance: "0xffff" } }], "PARAMS");
    no("eth_call", [call({ data: "0x" + "00".repeat(2048) }), B], "DATA");
    no("eth_call", [call({ data: undefined }), B], "DATA");
    no("eth_call", [null, B], "PARAMS");
    no("eth_call", ["0x", B], "PARAMS");
  });
  it("transaction lookups only by a 32-byte hash", () => {
    no("eth_getTransactionReceipt", ["0x1234"], "PARAMS");
    no("eth_getTransactionReceipt", [HASH, B], "PARAMS");
    no("eth_getTransactionByHash", [null], "PARAMS");
    no("eth_blockNumber", [B], "PARAMS");
    no("eth_maxPriorityFeePerGas", ["latest"], "PARAMS");
  });
});

describe("eth_simulateV1 is one plain block from the owner to pinned contracts", () => {
  it("stateOverrides / blockOverrides in the block", () => {
    const over = (extra: Record<string, unknown>) => [
      {
        blockStateCalls: [{ calls: [call()], ...extra }],
        validation: false,
        traceTransfers: false,
      },
      B,
    ];
    no(
      "eth_simulateV1",
      over({ stateOverrides: { [OWNER]: { balance: "0xffffffff" } } }),
      "SIM_OVERRIDE",
    );
    no(
      "eth_simulateV1",
      over({ blockOverrides: { time: "0x0" } }),
      "SIM_OVERRIDE",
    );
    no(
      "eth_simulateV1",
      [
        {
          blockStateCalls: [{ stateOverrides: {}, calls: [call()] }],
          validation: false,
          traceTransfers: false,
        },
        B,
      ],
      "SIM_OVERRIDE",
    );
  });
  it("validation true / traceTransfers true / extra or missing options", () => {
    no("eth_simulateV1", sim({ validation: true }), "SIM_OPTIONS");
    no("eth_simulateV1", sim({ traceTransfers: true }), "SIM_OPTIONS");
    no("eth_simulateV1", sim({ validation: "false" }), "SIM_OPTIONS");
    no("eth_simulateV1", sim({ returnFullTransactions: false }), "SIM_OPTIONS");
    no(
      "eth_simulateV1",
      [{ blockStateCalls: [{ calls: [call()] }] }, B],
      "SIM_OPTIONS",
    );
  });
  it("2 blocks / 0 blocks / not an array", () => {
    no(
      "eth_simulateV1",
      [
        {
          blockStateCalls: [{ calls: [call()] }, { calls: [call()] }],
          validation: false,
          traceTransfers: false,
        },
        B,
      ],
      "SIM_BLOCKS",
    );
    no(
      "eth_simulateV1",
      [{ blockStateCalls: [], validation: false, traceTransfers: false }, B],
      "SIM_BLOCKS",
    );
    no(
      "eth_simulateV1",
      [
        {
          blockStateCalls: { calls: [call()] },
          validation: false,
          traceTransfers: false,
        },
        B,
      ],
      "SIM_BLOCKS",
    );
  });
  it("9 calls / 0 calls", () => {
    no(
      "eth_simulateV1",
      sim(
        {},
        Array.from({ length: 9 }, () => call()),
      ),
      "SIM_CALLS",
    );
    no("eth_simulateV1", sim({}, []), "SIM_CALLS");
  });
  it("a call from another account / to a non-pinned contract / with oversize data", () => {
    no("eth_simulateV1", sim({}, [call(), call({ from: OTHER })]), "SIM_CALL");
    no("eth_simulateV1", sim({}, [call({ from: undefined })]), "SIM_CALL");
    no("eth_simulateV1", sim({}, [call({ to: OTHER })]), "SIM_CALL");
    no(
      "eth_simulateV1",
      sim({}, [call({ data: "0x" + "00".repeat(2048) })]),
      "SIM_CALL",
    );
  });
  it("a call with value (or gas, nonce, fee fields, input)", () => {
    for (const k of [
      "value",
      "gas",
      "nonce",
      "maxFeePerGas",
      "input",
      "gasPrice",
    ])
      no("eth_simulateV1", sim({}, [call({ [k]: "0x0" })]), "SIM_CALL_FIELD");
    no("eth_simulateV1", sim({}, [null]), "SIM_CALL_FIELD");
  });
  it("a missing or extra top-level param", () => {
    no("eth_simulateV1", [sim()[0]], "PARAMS");
    no("eth_simulateV1", [...sim(), true], "PARAMS");
    no("eth_simulateV1", [null, B], "PARAMS");
  });
});

describe("a refused read never reaches the transport", () => {
  it("laneRead throws REVIEW_REQUIRED and fetch is never called", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const signal = new AbortController().signal;
    for (const [m, p] of [
      ["eth_sendRawTransaction", ["0x02f8"]],
      ["eth_call", [call({ to: OTHER }), B]],
      ["eth_call", [call(), "latest"]],
      ["eth_getBalance", [OTHER, B]],
      ["eth_simulateV1", sim({ validation: true })],
    ] as [string, unknown[]][]) {
      const e = await laneRead(BASE_ROUTE, 0, m, p, OWNER, signal).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(SwapError);
      expect((e as SwapError).code).toBe("REVIEW_REQUIRED");
    }
    const both = await laneReadBoth(
      BASE_ROUTE,
      "debug_traceCall",
      [call(), B],
      OWNER,
      signal,
    );
    expect(both).toEqual({
      values: [null, null],
      agree: false,
      errors: ["REVIEW_REQUIRED", "REVIEW_REQUIRED"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reads are bound to ONE route of the frozen table", () => {
  const ETH = SWAP_LANE_ROUTES["eth-usdc-weth-univ3-max1"];
  const BNB = SWAP_LANE_ROUTES["bnb-usdc-wbnb-univ3-max1"];
  it("the transport carries exactly the read module's method list", () => {
    expect([...LANE_TRANSPORT_METHODS]).toEqual([...SWAP_LANE_READ_METHODS]);
  });
  it("a look-alike route object (not the table entry) is refused before any shape check", () => {
    for (const r of [
      { ...BASE_ROUTE },
      { ...BASE_ROUTE, status: "ENABLED" },
      { id: BASE },
      null,
      undefined,
      "base-usdc-weth-univ3-max1",
    ])
      expect(
        laneReadProblem("eth_blockNumber", [], OWNER, r as never),
        String(typeof r === "object" && r ? (r as { id?: string }).id : r),
      ).toBe("ROUTE");
  });
  it("a BLOCKED route reads nothing", () => {
    expect(BNB.status).toBe("BLOCKED");
    expect(laneReadProblem("eth_blockNumber", [], OWNER, BNB)).toBe(
      "ROUTE_BLOCKED",
    );
    expect(laneReadProblem("eth_getCode", [BNB.router, B], OWNER, BNB)).toBe(
      "ROUTE_BLOCKED",
    );
  });
  it("each route's contracts only: Base contracts are refused on Ethereum and the reverse", () => {
    expect(
      laneReadProblem("eth_getCode", [ETH.router, B], OWNER, ETH),
    ).toBeNull();
    expect(
      laneReadProblem("eth_getCode", [BASE_ROUTE.router, B], OWNER, ETH),
    ).toBe("PARAMS");
    expect(
      laneReadProblem(
        "eth_call",
        [call({ to: BASE_ROUTE.pay.address }), B],
        OWNER,
        ETH,
      ),
    ).toBe("CONTRACT");
    expect(
      laneReadProblem(
        "eth_call",
        [call({ to: ETH.pay.address }), B],
        OWNER,
        BASE_ROUTE,
      ),
    ).toBe("CONTRACT");
    // no GasPriceOracle on a route that is not OP_STACK
    expect(ETH.feeModel).toBe("PLAIN");
    expect(
      laneReadProblem(
        "eth_call",
        [
          {
            to: "0x420000000000000000000000000000000000000F",
            data: "0x49948e0e",
          },
          B,
        ],
        OWNER,
        ETH,
      ),
    ).toBe("CONTRACT");
    expect(
      laneReadProblem(
        "eth_call",
        [
          {
            to: "0x420000000000000000000000000000000000000F",
            data: "0x49948e0e",
          },
          B,
        ],
        OWNER,
        BASE_ROUTE,
      ),
    ).toBeNull();
  });
  it("eth_estimateGas keeps the eth_call shape on every route", () => {
    expect(
      laneReadProblem(
        "eth_estimateGas",
        [{ from: OWNER, to: ETH.router, data: "0x5ae401dc" }, B],
        OWNER,
        ETH,
      ),
    ).toBeNull();
    expect(
      laneReadProblem(
        "eth_estimateGas",
        [{ from: OWNER, to: ETH.router, data: "0x5ae401dc" }, "latest"],
        OWNER,
        ETH,
      ),
    ).toBe("PARAMS");
    expect(
      laneReadProblem(
        "eth_estimateGas",
        [{ from: OWNER, to: ETH.router, data: "0x", value: "0x1" }, B],
        OWNER,
        ETH,
      ),
    ).toBe("VALUE");
  });
});
