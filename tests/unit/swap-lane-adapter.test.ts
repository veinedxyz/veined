// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the swap lane's SEPARATE submission gate
// (src/swap/lane/signer-adapter.ts) and its server route (src/app/api/swap-lane/route.ts) in the DISARMED build.
// A dispatch authority is single use, bound to exactly one transaction of 8 fields and one step, and the adapter
// re-runs the protected lane gate (CLOSED here) before any signer is contacted: global fetch is spied and never called.
// The route answers 403 WRITE_DISABLED for every write action before the runtime is touched. Also: the fake chain of
// ./swap-lane-fake.ts against the UNMOCKED pin set (every code hash refused).
// SYNTHETIC_TEST_ONLY: owner, key and amounts are synthetic. Nothing here signs, sends or reaches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { maxUint256 } from "viem";
import {
  LANE_TX_FIELDS,
  LaneDispatchError,
  mintLaneDispatchAuthority,
  sameLaneTx,
  sendLaneTransaction,
  type LaneTx,
} from "../../src/swap/lane/signer-adapter";
import {
  swapLaneGateState,
  type SwapLaneStepFacts,
} from "../../src/swap/lane/approval";
import { approveCalldata } from "../../src/swap/lane/calldata";
import { swapLaneRuntime } from "../../src/swap/lane/runtime";
import { SWAP_LANE_ROUTES } from "../../src/swap/lane/scope";
import { GET, POST } from "../../src/app/api/swap-lane/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import {
  BASE,
  BASE_PINS,
  BASE_ROUTE,
  ENABLED_ROUTE_IDS,
  LANE_CONTRACTS,
  contractsOf,
  NOW,
  OTHER,
  OWNER,
  OWNER_KEY,
  lane,
} from "./swap-lane-fake";

// Spies only (the real implementations run): what the adapter hands to the gate, and whether the route reaches the
// runtime. No protected value is replaced.
vi.mock("../../src/swap/lane/approval", async (importOriginal) => {
  const m =
    await importOriginal<typeof import("../../src/swap/lane/approval")>();
  return { ...m, swapLaneGateState: vi.fn(m.swapLaneGateState) };
});
vi.mock("../../src/swap/lane/runtime", async (importOriginal) => {
  const m =
    await importOriginal<typeof import("../../src/swap/lane/runtime")>();
  return { ...m, swapLaneRuntime: vi.fn(m.swapLaneRuntime) };
});

const DISARMED = [
  "NO_OWNER_APPROVED_SWAP_LANE",
  "NO_OWNER_SWAP_LANE_KEY",
  "SWAP_LANE_NOT_WIRED",
];
const TX: LaneTx = Object.freeze({
  chainId: "0x2105",
  from: OWNER,
  to: BASE_PINS.pay.address.toLowerCase(),
  value: "0x0",
  data: approveCalldata(BASE_ROUTE, 1_000_000n),
  gas: "0xd7a0",
  maxFeePerGas: "0xa7d8c0",
  maxPriorityFeePerGas: "0xf4240",
});
const facts = (tx: LaneTx = TX): SwapLaneStepFacts => ({
  route: BASE,
  step: "APPROVE",
  exactAmount: "1000000",
  tx: { ...tx },
  operatorsAgree: true,
  reviewAttested: true,
  guardianPassed: true,
  gasWorstCaseTotalWei: 3_000_000_000_000n,
  now: NOW,
});
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => {
      throw new Error("EXPECTED_A_REFUSAL");
    },
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(LaneDispatchError);
  return e as LaneDispatchError;
};
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  vi.mocked(swapLaneGateState).mockClear();
  vi.mocked(swapLaneRuntime).mockClear();
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

describe("sendLaneTransaction", () => {
  it("an unknown authority -> AUTHORITY_UNKNOWN_OR_USED", async () => {
    for (const a of [
      {},
      Object.freeze(Object.create(null) as object),
      null,
      undefined,
      "authority",
      42,
      facts(),
      () => undefined,
    ])
      expect((await refusal(sendLaneTransaction(a, TX, "APPROVE"))).code).toBe(
        "AUTHORITY_UNKNOWN_OR_USED",
      );
    expect(swapLaneGateState).not.toHaveBeenCalled();
  });
  it("an authority is opaque (frozen, no prototype, no readable facts)", () => {
    const a = mintLaneDispatchAuthority(facts());
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.getPrototypeOf(a)).toBeNull();
    expect(Reflect.ownKeys(a)).toEqual([]);
  });
  it("in this disarmed build the exact transaction is refused by the gate: SWAP_LANE_GATE_CLOSED", async () => {
    const a = mintLaneDispatchAuthority(facts());
    const e = await refusal(sendLaneTransaction(a, { ...TX }, "APPROVE"));
    expect(e.code).toBe("SWAP_LANE_GATE_CLOSED");
    expect(e.problems).toEqual(DISARMED);
    // the gate the adapter ran is the PROTECTED one (no record / key / wiring passed in)
    expect(vi.mocked(swapLaneGateState).mock.calls).toHaveLength(1);
    expect(vi.mocked(swapLaneGateState).mock.calls[0]).toHaveLength(1);
  });
  it("an authority used twice -> the second is refused (single use, even after a refusal)", async () => {
    const a = mintLaneDispatchAuthority(facts());
    expect((await refusal(sendLaneTransaction(a, TX, "APPROVE"))).code).toBe(
      "SWAP_LANE_GATE_CLOSED",
    );
    expect((await refusal(sendLaneTransaction(a, TX, "APPROVE"))).code).toBe(
      "AUTHORITY_UNKNOWN_OR_USED",
    );
    // a failed compare burns the authority too: a retry with the right transaction is refused
    const b = mintLaneDispatchAuthority(facts());
    expect(
      (
        await refusal(
          sendLaneTransaction(b, { ...TX, gas: "0xd7a1" }, "APPROVE"),
        )
      ).code,
    ).toBe("TX_NOT_AUTHORIZED_TX");
    expect((await refusal(sendLaneTransaction(b, TX, "APPROVE"))).code).toBe(
      "AUTHORITY_UNKNOWN_OR_USED",
    );
    // and so does a step mismatch
    const c = mintLaneDispatchAuthority(facts());
    expect((await refusal(sendLaneTransaction(c, TX, "SWAP"))).code).toBe(
      "AUTHORITY_STEP_MISMATCH",
    );
    expect((await refusal(sendLaneTransaction(c, TX, "APPROVE"))).code).toBe(
      "AUTHORITY_UNKNOWN_OR_USED",
    );
  });
  it("a step other than the authorized one -> AUTHORITY_STEP_MISMATCH", async () => {
    const a = mintLaneDispatchAuthority(facts());
    expect((await refusal(sendLaneTransaction(a, TX, "SWAP"))).code).toBe(
      "AUTHORITY_STEP_MISMATCH",
    );
    const b = mintLaneDispatchAuthority(facts());
    expect(
      (await refusal(sendLaneTransaction(b, TX, "REVOKE" as never))).code,
    ).toBe("AUTHORITY_STEP_MISMATCH");
    expect(swapLaneGateState).not.toHaveBeenCalled();
  });
  const changed: [string, string][] = [
    ["chainId", "0x1"],
    ["from", OTHER],
    ["to", OTHER],
    ["value", "0x1"],
    ["data", approveCalldata(BASE_ROUTE, maxUint256)],
    ["gas", "0xd7a1"],
    ["maxFeePerGas", "0xa7d8c1"],
    ["maxPriorityFeePerGas", "0xf4241"],
  ];
  it("the 8 compared fields are exactly the lane transaction's fields", () => {
    expect([...LANE_TX_FIELDS].sort()).toEqual(changed.map(([k]) => k).sort());
  });
  it.each(changed)(
    "a transaction differing only in %s -> TX_NOT_AUTHORIZED_TX",
    async (field, value) => {
      const a = mintLaneDispatchAuthority(facts());
      const e = await refusal(
        sendLaneTransaction(a, { ...TX, [field]: value }, "APPROVE"),
      );
      expect(e.code).toBe("TX_NOT_AUTHORIZED_TX");
      expect(swapLaneGateState).not.toHaveBeenCalled();
    },
  );
  it("an extra or a missing field -> TX_NOT_AUTHORIZED_TX", async () => {
    const { gas: _g, ...missing } = TX;
    void _g;
    for (const tx of [
      { ...TX, nonce: "0x0" },
      { ...TX, accessList: [] },
      missing,
    ]) {
      const a = mintLaneDispatchAuthority(facts());
      expect(
        (await refusal(sendLaneTransaction(a, tx as never, "APPROVE"))).code,
      ).toBe("TX_NOT_AUTHORIZED_TX");
    }
  });
  const NON_STRING: unknown[] = [
    { ...TX, value: 0 },
    { ...TX, gas: 55_200 },
    { ...TX, data: null },
    null,
  ];
  it("a non-string field or no transaction at all is refused before the gate and before any send", async () => {
    for (const tx of NON_STRING) {
      const a = mintLaneDispatchAuthority(facts());
      await expect(
        sendLaneTransaction(a, tx as never, "APPROVE"),
      ).rejects.toThrow();
      // and the authority is spent
      expect((await refusal(sendLaneTransaction(a, TX, "APPROVE"))).code).toBe(
        "AUTHORITY_UNKNOWN_OR_USED",
      );
    }
    expect(swapLaneGateState).not.toHaveBeenCalled();
  });
  // Regression test for a bug this suite found (FIXED; signer-adapter.ts sameLaneTx): a presented transaction with a
  // non-string field (or null) used to throw a raw TypeError instead of LaneDispatchError("TX_NOT_AUTHORIZED_TX").
  it("a non-string field is the documented TX_NOT_AUTHORIZED_TX refusal", async () => {
    for (const tx of NON_STRING) {
      const a = mintLaneDispatchAuthority(facts());
      expect(
        (await refusal(sendLaneTransaction(a, tx as never, "APPROVE"))).code,
      ).toBe("TX_NOT_AUTHORIZED_TX");
    }
  });
  it("changing the caller's objects after minting changes nothing the adapter compares", async () => {
    const f = facts();
    const a = mintLaneDispatchAuthority(f);
    const tx = { ...TX };
    f.exactAmount = "999999";
    f.step = "SWAP";
    expect((await refusal(sendLaneTransaction(a, tx, "APPROVE"))).code).toBe(
      "SWAP_LANE_GATE_CLOSED",
    );
  });
  // Regression test for a bug this suite found (FIXED; signer-adapter.ts mintLaneDispatchAuthority): the grant's facts
  // used to keep the caller's own mutable tx, so the gate re-run could see another transaction than the one compared.
  it("the gate re-run sees exactly the transaction that is compared and sent", async () => {
    const f = facts();
    const a = mintLaneDispatchAuthority(f);
    f.tx.data = approveCalldata(BASE_ROUTE, maxUint256); // after minting
    await refusal(sendLaneTransaction(a, { ...TX }, "APPROVE"));
    const seen = vi.mocked(swapLaneGateState).mock
      .calls[0][0] as SwapLaneStepFacts;
    expect(seen.tx).toEqual(TX);
  });
  it("sameLaneTx: exact 8-field equality, hex case ignored", () => {
    expect(sameLaneTx(TX, { ...TX })).toBe(true);
    expect(
      sameLaneTx(TX, {
        ...TX,
        data: TX.data.toUpperCase().replace("0X", "0x"),
      }),
    ).toBe(true);
    expect(sameLaneTx(TX, { ...TX, data: TX.data + "00" })).toBe(false);
    expect(
      sameLaneTx(
        { ...TX, extra: "x" } as never,
        { ...TX, extra: "x" } as never,
      ),
    ).toBe(false);
  });
});

describe("the unmocked pin set against the fake chain", () => {
  it("every pinned code hash is refused (CODE_CHANGED x 6): the review is not ready", async () => {
    const L = lane();
    const r = await L.engine.review(OWNER_KEY);
    expect(r.ready).toBe(false);
    expect(r.pins.problems).toEqual(
      LANE_CONTRACTS.map((p) => `CODE_CHANGED:${p.address}`),
    );
    expect(r.problems).toEqual(expect.arrayContaining(r.pins.problems));
    expect(() => L.engine.authorize(r.reviewId, OWNER_KEY)).toThrow(
      "REVIEW_NOT_READY",
    );
    expect(L.chain.violations).toEqual([]);
    expect(L.signer.calls).toHaveLength(0);
  });
  it.each(ENABLED_ROUTE_IDS.filter((id) => id !== BASE))(
    "%s: every pinned code hash (the verified pool hash included) is refused against the fake chain: CODE_CHANGED x 6",
    async (id) => {
      const L = lane({ route: id });
      const pool = SWAP_LANE_ROUTES[id].pool;
      // no pin of any route is unverified any more (B-matrix pool-codehashes.json)
      for (const p of contractsOf(id))
        expect(p.codehash, p.address).toMatch(/^0x[0-9a-f]{64}$/);
      const r = await L.engine.review(OWNER_KEY);
      expect(r.ready).toBe(false);
      expect(r.pins.problems).toEqual(
        contractsOf(id).map((p) => `CODE_CHANGED:${p.address}`),
      );
      expect(r.pins.problems).toContain(`CODE_CHANGED:${pool}`);
      // the pool code IS read now (on both operators) and compared
      expect(
        L.chain.log.some(
          (x) =>
            x.method === "eth_getCode" &&
            String(x.params[0]).toLowerCase() === pool.toLowerCase(),
        ),
      ).toBe(true);
      expect(() => L.engine.authorize(r.reviewId, OWNER_KEY)).toThrow(
        "REVIEW_NOT_READY",
      );
      expect(L.chain.violations).toEqual([]);
      expect(L.signer.calls).toHaveLength(0);
    },
  );
});

describe("POST /api/swap-lane in the disarmed build", () => {
  const ORIGIN = "http://127.0.0.1:3100";
  beforeEach(() => setAppLimiterForTests(new MemoryRateLimiter()));
  afterEach(() => setAppLimiterForTests(undefined));
  const api = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await POST(
      new NextRequest(`${ORIGIN}/api/swap-lane`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3100",
          origin: ORIGIN,
          "content-type": "application/json",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
  it("swap-lane-review -> 403 WRITE_DISABLED with the CLOSED gate, the runtime is never reached", async () => {
    const r = await api({ action: "swap-lane-review", ownerKey: OWNER_KEY });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("WRITE_DISABLED");
    expect(r.json.gate).toMatchObject({
      state: "CLOSED",
      open: false,
      reasons: DISARMED,
    });
    expect(swapLaneRuntime).not.toHaveBeenCalled();
  });
  it("every other write action -> 403 WRITE_DISABLED, the runtime is never reached", async () => {
    for (const body of [
      {
        action: "swap-lane-authorize",
        reviewId: "0x" + "ab".repeat(16),
        ownerKey: OWNER_KEY,
      },
      {
        action: "swap-lane-dispatch",
        token: "x".repeat(40),
        ownerKey: OWNER_KEY,
      },
      { action: "swap-lane-track" },
      // lanes review MINOR-5: the CLEANUP revoke is a write action like every other
      { action: "swap-lane-revoke", ownerKey: OWNER_KEY },
    ]) {
      const r = await api(body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.json.error).toBe("WRITE_DISABLED");
    }
    expect(swapLaneRuntime).not.toHaveBeenCalled();
  });
  it("swap-lane-status and GET report the lane disarmed", async () => {
    const r = await api({ action: "swap-lane-status" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      armed: false,
      reasons: [
        "NO_OWNER_APPROVED_SWAP_LANE",
        "NO_OWNER_SWAP_LANE_KEY",
        "NO_LOCAL_SIGNER",
        "SWAP_LANE_NOT_WIRED",
      ],
      gate: { state: "CLOSED", scope: null, pinSet: null },
    });
    // the route table: every route with its status and its exact one-unit maximum; Base keeps 1 USDC
    const routes = r.json.routes as {
      id: string;
      chainId: string;
      status: string;
      maxAmount: string;
    }[];
    expect(routes.find((x) => x.id === BASE)).toEqual({
      id: BASE,
      chainId: "8453",
      status: "ENABLED",
      blockReason: null,
      maxAmount: "1000000",
    });
    expect(routes.map((x) => x.id)).toEqual(Object.keys(SWAP_LANE_ROUTES));
    expect(routes.find((x) => x.chainId === "56")).toMatchObject({
      status: "BLOCKED",
      blockReason: "NO_CIRCLE_USDC",
    });
    const g = GET();
    expect(g.status).toBe(200);
    expect(((await g.json()) as { armed: boolean }).armed).toBe(false);
    expect(swapLaneRuntime).not.toHaveBeenCalled();
  });
  it("malformed requests -> 400 INVALID_REQUEST (strict schema), never the runtime", async () => {
    for (const body of [
      { action: "swap-lane-review", ownerKey: OWNER_KEY, record: {} },
      { action: "swap-lane-review", ownerKey: "AB".repeat(32) },
      { action: "swap-lane-review" },
      { action: "swap-lane-send", tx: {} },
      "{not json",
    ]) {
      const r = await api(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe("INVALID_REQUEST");
    }
    const ct = await api(
      { action: "swap-lane-review", ownerKey: OWNER_KEY },
      { "content-type": "text/plain" },
    );
    expect(ct.status).toBe(400);
    expect(swapLaneRuntime).not.toHaveBeenCalled();
  });
  it("a foreign origin is refused before anything else", async () => {
    const r = await api(
      { action: "swap-lane-review", ownerKey: OWNER_KEY },
      { origin: "http://evil.example" },
    );
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("ORIGIN_REJECTED");
    expect(swapLaneRuntime).not.toHaveBeenCalled();
  });
});
