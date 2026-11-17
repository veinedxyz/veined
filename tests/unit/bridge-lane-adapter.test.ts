// VEINED-MC1 (BRIDGE LANE): the bridge hand-off of the lane's ONE signer adapter (src/swap/lane/signer-adapter.ts
// mintBridgeDispatchAuthority / sendBridgeLaneTransaction) and the bridge lane's server route
// (src/app/api/bridge-lane/route.ts) in the DISARMED build. A bridge authority is single use, bound to one transaction
// of 8 fields and one step, separate from the swap lane's authorities, and the adapter re-runs the BRIDGE gate (CLOSED
// here) before any signer is contacted: global fetch is spied and never called. The route answers 403 WRITE_DISABLED
// for every write action before the runtime is touched.
// SYNTHETIC_TEST_ONLY: owner, key and amounts are synthetic. Nothing here signs, sends or reaches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  LaneDispatchError,
  mintBridgeDispatchAuthority,
  mintLaneDispatchAuthority,
  sendBridgeLaneTransaction,
  sendLaneTransaction,
  type LaneTx,
} from "../../src/swap/lane/signer-adapter";
import {
  bridgeLaneGateState,
  type BridgeLaneStepFacts,
} from "../../src/swap/lane/bridge-approval";
import { bridgeApproveCalldata } from "../../src/swap/lane/bridge-calldata";
import { bridgeLaneRuntime } from "../../src/swap/lane/bridge-runtime";
import { BRIDGE_LANE_PAIRS } from "../../src/swap/lane/bridge-scope";
import { GET, POST } from "../../src/app/api/bridge-lane/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import type { SwapLaneStepFacts } from "../../src/swap/lane/approval";

vi.mock("../../src/swap/lane/bridge-approval", async (importOriginal) => {
  const m =
    await importOriginal<
      typeof import("../../src/swap/lane/bridge-approval")
    >();
  return { ...m, bridgeLaneGateState: vi.fn(m.bridgeLaneGateState) };
});
vi.mock("../../src/swap/lane/bridge-runtime", async (importOriginal) => {
  const m =
    await importOriginal<typeof import("../../src/swap/lane/bridge-runtime")>();
  return { ...m, bridgeLaneRuntime: vi.fn(m.bridgeLaneRuntime) };
});

const OWNER = "0x3333333333333333333333333333333333333333";
const OWNER_KEY = "6b".repeat(32);
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const DISARMED = [
  "NO_OWNER_APPROVED_BRIDGE_LANE",
  "NO_OWNER_BRIDGE_LANE_KEY",
  "BRIDGE_LANE_NOT_WIRED",
];
const TX: LaneTx = Object.freeze({
  chainId: "0x2105",
  from: OWNER,
  to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  value: "0x0",
  data: bridgeApproveCalldata(5_000_000n),
  gas: "0x103dc",
  maxFeePerGas: "0xf42400",
  maxPriorityFeePerGas: "0xf4240",
});
const facts = (tx: LaneTx = TX): BridgeLaneStepFacts => ({
  route: "bridge-8453-42161",
  step: "APPROVE",
  exactAmount: "5000000",
  tx: { ...tx },
  operatorsAgree: true,
  reviewAttested: true,
  guardianPassed: true,
  gasWorstCaseTotalWei: 1n,
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
  vi.mocked(bridgeLaneGateState).mockClear();
  vi.mocked(bridgeLaneRuntime).mockClear();
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

describe("the bridge dispatch authority", () => {
  it("an authority minted for exactly this tx: the adapter re-runs the BRIDGE gate on its facts and refuses (disarmed)", async () => {
    const a = mintBridgeDispatchAuthority(facts());
    const e = await refusal(sendBridgeLaneTransaction(a, { ...TX }, "APPROVE"));
    expect(e.code).toBe("BRIDGE_LANE_GATE_CLOSED");
    expect(e.problems).toEqual(DISARMED);
    const seen = vi.mocked(bridgeLaneGateState).mock.calls.at(-1)![0]!;
    expect(seen.tx).toEqual(TX);
    expect(seen.route).toBe("bridge-8453-42161");
  });
  it("single use: the same authority a second time is unknown", async () => {
    const a = mintBridgeDispatchAuthority(facts());
    await refusal(sendBridgeLaneTransaction(a, { ...TX }, "APPROVE"));
    expect(
      (await refusal(sendBridgeLaneTransaction(a, { ...TX }, "APPROVE"))).code,
    ).toBe("AUTHORITY_UNKNOWN_OR_USED");
  });
  it("another step, another tx, a forged object: refused before the gate", async () => {
    expect(
      (
        await refusal(
          sendBridgeLaneTransaction(
            mintBridgeDispatchAuthority(facts()),
            { ...TX },
            "EXECUTE",
          ),
        )
      ).code,
    ).toBe("AUTHORITY_STEP_MISMATCH");
    expect(
      (
        await refusal(
          sendBridgeLaneTransaction(
            mintBridgeDispatchAuthority(facts()),
            { ...TX, gas: "0x103dd" },
            "APPROVE",
          ),
        )
      ).code,
    ).toBe("TX_NOT_AUTHORIZED_TX");
    expect(
      (
        await refusal(
          sendBridgeLaneTransaction(
            mintBridgeDispatchAuthority(facts()),
            { ...TX, extra: "1" } as never,
            "APPROVE",
          ),
        )
      ).code,
    ).toBe("TX_NOT_AUTHORIZED_TX");
    for (const forged of [
      null,
      {},
      Object.freeze(Object.create(null)),
      "authority",
    ])
      expect(
        (await refusal(sendBridgeLaneTransaction(forged, { ...TX }, "APPROVE")))
          .code,
      ).toBe("AUTHORITY_UNKNOWN_OR_USED");
    expect(vi.mocked(bridgeLaneGateState)).not.toHaveBeenCalled();
  });
  it("the two lanes' authorities never cross: a swap authority is unknown to the bridge send and vice versa", async () => {
    const swapFacts = {
      ...facts(),
      route: "base-usdc-weth-univ3-max1",
      amountOutMinimum: undefined,
    } as unknown as SwapLaneStepFacts;
    const s = mintLaneDispatchAuthority(swapFacts);
    expect(
      (await refusal(sendBridgeLaneTransaction(s, { ...TX }, "APPROVE"))).code,
    ).toBe("AUTHORITY_UNKNOWN_OR_USED");
    const b = mintBridgeDispatchAuthority(facts());
    expect(
      (await refusal(sendLaneTransaction(b, { ...TX }, "APPROVE"))).code,
    ).toBe("AUTHORITY_UNKNOWN_OR_USED");
  });
});

describe("POST /api/bridge-lane in the disarmed build", () => {
  const ORIGIN = "http://127.0.0.1:3100";
  beforeEach(() => setAppLimiterForTests(new MemoryRateLimiter()));
  afterEach(() => setAppLimiterForTests(undefined));
  const api = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await POST(
      new NextRequest(`${ORIGIN}/api/bridge-lane`, {
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
  it("every write action -> 403 WRITE_DISABLED with the CLOSED gate; the runtime is never reached", async () => {
    for (const body of [
      { action: "bridge-lane-review", ownerKey: OWNER_KEY },
      {
        action: "bridge-lane-authorize",
        reviewId: "0x" + "ab".repeat(16),
        ownerKey: OWNER_KEY,
      },
      {
        action: "bridge-lane-dispatch",
        token: "x".repeat(40),
        ownerKey: OWNER_KEY,
      },
      { action: "bridge-lane-track" },
      // lanes review MINOR-5: the CLEANUP revoke is a write action like every other
      { action: "bridge-lane-revoke", ownerKey: OWNER_KEY },
    ]) {
      const r = await api(body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.json.error).toBe("WRITE_DISABLED");
      expect(r.json.gate).toMatchObject({
        state: "CLOSED",
        open: false,
        reasons: DISARMED,
      });
    }
    expect(bridgeLaneRuntime).not.toHaveBeenCalled();
  });
  it("bridge-lane-status and GET report the lane disarmed and the pair table (20 ENABLED, BNB BLOCKED, no Avalanche)", async () => {
    const r = await api({ action: "bridge-lane-status" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      lane: "BRIDGE",
      armed: false,
      reasons: [
        "NO_OWNER_APPROVED_BRIDGE_LANE",
        "NO_OWNER_BRIDGE_LANE_KEY",
        "NO_LOCAL_SIGNER",
        "BRIDGE_LANE_NOT_WIRED",
      ],
      gate: { state: "CLOSED", scope: null, pinSet: null },
    });
    const pairs = r.json.pairs as {
      id: string;
      status: string;
      blockReason: string | null;
      exactAmount: string;
    }[];
    expect(pairs.map((x) => x.id)).toEqual(Object.keys(BRIDGE_LANE_PAIRS));
    expect(pairs.filter((x) => x.status === "ENABLED")).toHaveLength(20);
    expect(
      pairs
        .filter((x) => x.status === "BLOCKED")
        .every((x) => x.blockReason === "NO_CIRCLE_USDC"),
    ).toBe(true);
    expect(pairs.some((x) => x.id.includes("43114"))).toBe(false);
    expect(pairs.find((x) => x.id === "bridge-8453-42161")).toEqual({
      id: "bridge-8453-42161",
      sourceChainId: "8453",
      destinationChainId: "42161",
      status: "ENABLED",
      blockReason: null,
      exactAmount: "5000000",
      minimumOut: "4900000",
      maxCostBps: 300,
    });
    const g = GET();
    expect(g.status).toBe(200);
    expect(((await g.json()) as { armed: boolean }).armed).toBe(false);
    expect(bridgeLaneRuntime).not.toHaveBeenCalled();
  });
  it("malformed requests -> 400 INVALID_REQUEST (strict schema), never the runtime", async () => {
    for (const body of [
      {
        action: "bridge-lane-review",
        ownerKey: OWNER_KEY,
        pair: "bridge-1-10",
      },
      { action: "bridge-lane-review", ownerKey: "AB".repeat(32) },
      { action: "bridge-lane-review" },
      { action: "swap-lane-review", ownerKey: OWNER_KEY },
      { action: "bridge-lane-send", tx: {} },
      "{not json",
    ]) {
      const r = await api(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe("INVALID_REQUEST");
    }
    expect(
      (
        await api(
          { action: "bridge-lane-review", ownerKey: OWNER_KEY },
          { "content-type": "text/plain" },
        )
      ).status,
    ).toBe(400);
    expect(bridgeLaneRuntime).not.toHaveBeenCalled();
  });
  it("a foreign origin is refused before anything else", async () => {
    const r = await api(
      { action: "bridge-lane-review", ownerKey: OWNER_KEY },
      { origin: "http://evil.example" },
    );
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("ORIGIN_REJECTED");
    expect(bridgeLaneRuntime).not.toHaveBeenCalled();
  });
  it("the runtime itself refuses while disarmed (WRITE_DISABLED), opening nothing", () => {
    expect(() => bridgeLaneRuntime()).toThrow("WRITE_DISABLED");
  });
});
