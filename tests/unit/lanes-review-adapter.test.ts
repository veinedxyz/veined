// VEINED-MC1 lanes review (MAJOR-1, MINOR-5): the adapter's two new signer requests, byte-exact against
// D:/vnd/hk1/mc1/signer/CONTRACT-v5.md — the status preflight (POST {method: "sync"} then POST {method: "status"}, the
// lane's own endpoint and token, the body parsed strictly) and the CLEANUP revoke body ({method: "sign_send", declared:
// {lane: "CLEANUP", route, step: "REVOKE"}, tx}, no swapAmount). To observe the requests at all, THIS FILE ONLY
// replaces, in mocked approval modules, both endpoints (synthetic loopback URLs, token files in this run's temp
// directory) and both gates (OPEN); global fetch is mocked, so nothing reaches a network. The real disarmed gates are
// covered by swap-lane-adapter.test.ts / bridge-lane-adapter.test.ts.
// SYNTHETIC_TEST_ONLY: endpoints, tokens, owner and transactions are synthetic.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  OWNER_SWAP_LANE_SIGNER,
  type SwapLaneStepFacts,
} from "../../src/swap/lane/approval";
import {
  OWNER_BRIDGE_LANE_SIGNER,
  type BridgeLaneStepFacts,
} from "../../src/swap/lane/bridge-approval";
import {
  LaneDispatchError,
  laneSignerStatus,
  mintBridgeDispatchAuthority,
  mintLaneDispatchAuthority,
  sendBridgeLaneTransaction,
  sendLaneTransaction,
  type LaneTx,
} from "../../src/swap/lane/signer-adapter";
import { approveCalldata } from "../../src/swap/lane/calldata";
import { bridgeApproveCalldata } from "../../src/swap/lane/bridge-calldata";
import { SWAP_LANE_ROUTES } from "../../src/swap/lane/scope";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
} from "../../src/swap/lane/bridge-scope";

vi.mock("../../src/swap/lane/approval", async (importOriginal) => {
  const m =
    await importOriginal<typeof import("../../src/swap/lane/approval")>();
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const base = process.env.FL1 ? join(process.env.FL1, "temp") : tmpdir();
  mkdirSync(base, { recursive: true });
  const tokenFile = join(
    mkdtempSync(join(base, "lanes-review-swap-")),
    "token",
  );
  writeFileSync(tokenFile, "synthetic-swap-signer-token-0123456789\n");
  return {
    ...m,
    OWNER_SWAP_LANE_SIGNER: Object.freeze({
      url: "http://127.0.0.1:18545/",
      tokenFile,
    }),
    swapLaneGateState: vi.fn(() => ({
      state: "OPEN",
      open: true,
      reasons: [],
      scope: null,
      pinSet: null,
    })),
  };
});
vi.mock("../../src/swap/lane/bridge-approval", async (importOriginal) => {
  const m =
    await importOriginal<
      typeof import("../../src/swap/lane/bridge-approval")
    >();
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const base = process.env.FL1 ? join(process.env.FL1, "temp") : tmpdir();
  mkdirSync(base, { recursive: true });
  const tokenFile = join(
    mkdtempSync(join(base, "lanes-review-bridge-")),
    "token",
  );
  writeFileSync(tokenFile, "synthetic-bridge-signer-token-0123456789\n");
  return {
    ...m,
    OWNER_BRIDGE_LANE_SIGNER: Object.freeze({
      url: "http://127.0.0.1:18546/",
      tokenFile,
    }),
    bridgeLaneGateState: vi.fn(() => ({
      state: "OPEN",
      open: true,
      reasons: [],
      scope: null,
      pinSet: null,
    })),
  };
});

const OWNER = "0x3333333333333333333333333333333333333333";
const HASH = "0x" + "ef".repeat(32);
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const BASE = "base-usdc-weth-univ3-max1";
const PAIR = "bridge-8453-42161";
const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const token = (f: string) => readFileSync(f, "utf8").trim();
const swapRevokeTx = (): LaneTx => {
  const r = SWAP_LANE_ROUTES[BASE];
  return {
    chainId: r.chainHex,
    from: OWNER,
    to: r.pay.address.toLowerCase(),
    value: "0x0",
    data: approveCalldata(r, 0n),
    gas: "0xb3b0",
    maxFeePerGas: "0xf42400",
    maxPriorityFeePerGas: "0xf4240",
  };
};
const bridgeRevokeTx = (): LaneTx => {
  const S = BRIDGE_LANE_CHAINS[BRIDGE_LANE_PAIRS[PAIR].source];
  return {
    chainId: S.chainHex,
    from: OWNER,
    to: S.usdc.address.toLowerCase(),
    value: "0x0",
    data: bridgeApproveCalldata(0n),
    gas: "0xb3b0",
    maxFeePerGas: "0xf42400",
    maxPriorityFeePerGas: "0xf4240",
  };
};
const swapFacts = (
  tx: LaneTx,
  step: "APPROVE" | "SWAP" | "REVOKE" = "REVOKE",
): SwapLaneStepFacts => ({
  route: BASE,
  step,
  exactAmount: SWAP_LANE_ROUTES[BASE].maxAmount.toString(),
  tx,
  operatorsAgree: true,
  reviewAttested: true,
  guardianPassed: true,
  gasWorstCaseTotalWei: 1n,
  now: NOW,
});
const bridgeFacts = (
  tx: LaneTx,
  step: "APPROVE" | "EXECUTE" | "REVOKE" = "REVOKE",
): BridgeLaneStepFacts => ({
  route: PAIR,
  step,
  exactAmount: BRIDGE_LANE_PAIRS[PAIR].exactAmount.toString(),
  tx,
  operatorsAgree: true,
  reviewAttested: true,
  guardianPassed: true,
  gasWorstCaseTotalWei: 1n,
  now: NOW,
});
const statusBody = (route: string, chainId: string) => ({
  address: OWNER,
  pinsSha256: "a".repeat(64),
  sessionNotAfter: new Date(NOW + 3_600_000).toISOString(),
  enabledRoutes: [route],
  chains: {
    [chainId]: { firstNonce: "11", signedCount: 2, inFlight: 0, uncertain: 0 },
  },
  signed: { [`${route}:APPROVE`]: true },
  inFlight: 0,
  uncertain: 0,
});
const reply = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
  });
const calls = () => fetchMock.mock.calls as unknown as [string, RequestInit][];

let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => reply({ hash: HASH }));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  for (const s of [OWNER_SWAP_LANE_SIGNER, OWNER_BRIDGE_LANE_SIGNER])
    if (s) rmSync(dirname(s.tokenFile), { recursive: true, force: true });
});

describe("the CLEANUP revoke body (CONTRACT-v5.md: declared {lane: CLEANUP, route, step: REVOKE}, no swapAmount)", () => {
  it("swap lane: exactly the contract body, to the swap endpoint, with the swap token", async () => {
    const tx = swapRevokeTx();
    expect(
      await sendLaneTransaction(
        mintLaneDispatchAuthority(swapFacts(tx)),
        { ...tx },
        "REVOKE",
      ),
    ).toEqual({
      outcome: "SENT",
      hash: HASH,
      problems: [],
    });
    expect(calls()).toHaveLength(1);
    const [url, init] = calls()[0];
    expect(url).toBe("http://127.0.0.1:18545/");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-fl1-signer-token": token(OWNER_SWAP_LANE_SIGNER!.tokenFile),
      },
    });
    expect(init.body).toBe(
      JSON.stringify({
        method: "sign_send",
        declared: { lane: "CLEANUP", route: BASE, step: "REVOKE" },
        tx,
      }),
    );
    expect(String(init.body)).not.toContain("swapAmount");
  });
  it("bridge lane: exactly the contract body, to the bridge endpoint, with the bridge token", async () => {
    const tx = bridgeRevokeTx();
    expect(tx.data).toBe(
      "0x095ea7b3" + "0".repeat(24) + DIAMOND.slice(2) + "0".repeat(64),
    );
    expect(
      await sendBridgeLaneTransaction(
        mintBridgeDispatchAuthority(bridgeFacts(tx)),
        { ...tx },
        "REVOKE",
      ),
    ).toEqual({
      outcome: "SENT",
      hash: HASH,
      problems: [],
    });
    const [url, init] = calls()[0];
    expect(url).toBe("http://127.0.0.1:18546/");
    expect((init.headers as Record<string, string>)["x-fl1-signer-token"]).toBe(
      token(OWNER_BRIDGE_LANE_SIGNER!.tokenFile),
    );
    expect(init.body).toBe(
      JSON.stringify({
        method: "sign_send",
        declared: { lane: "CLEANUP", route: PAIR, step: "REVOKE" },
        tx,
      }),
    );
  });
  it("a REVOKE authority is never usable as another step, nor another step's authority as REVOKE (nothing is sent)", async () => {
    const tx = swapRevokeTx();
    for (const [a, step] of [
      [mintLaneDispatchAuthority(swapFacts(tx, "REVOKE")), "APPROVE"],
      [mintLaneDispatchAuthority(swapFacts(tx, "APPROVE")), "REVOKE"],
    ] as const)
      await expect(
        sendLaneTransaction(a, { ...tx }, step),
      ).rejects.toMatchObject({ code: "AUTHORITY_STEP_MISMATCH" });
    const btx = bridgeRevokeTx();
    for (const [a, step] of [
      [mintBridgeDispatchAuthority(bridgeFacts(btx, "REVOKE")), "EXECUTE"],
      [mintBridgeDispatchAuthority(bridgeFacts(btx, "APPROVE")), "REVOKE"],
    ] as const)
      await expect(
        sendBridgeLaneTransaction(a, { ...btx }, step),
      ).rejects.toMatchObject({
        code: "AUTHORITY_STEP_MISMATCH",
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("laneSignerStatus: sync, then status, on the lane's own endpoint", () => {
  it.each([
    ["SWAP", "http://127.0.0.1:18545/", BASE, "8453"],
    ["BRIDGE", "http://127.0.0.1:18546/", PAIR, "8453"],
  ] as const)(
    "%s: two POSTs in order with the lane's token; the body parsed strictly",
    async (lane, url, route, chainId) => {
      const body = statusBody(route, chainId);
      fetchMock
        .mockImplementationOnce(async () => reply({ receipts: [] }))
        .mockImplementationOnce(async () => reply(body));
      const s = await laneSignerStatus(lane);
      expect(calls().map(([u, i]) => [u, i.body])).toEqual([
        [url, JSON.stringify({ method: "sync" })],
        [url, JSON.stringify({ method: "status" })],
      ]);
      const file =
        lane === "SWAP" ? OWNER_SWAP_LANE_SIGNER! : OWNER_BRIDGE_LANE_SIGNER!;
      for (const [, init] of calls())
        expect(init).toMatchObject({
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: { "x-fl1-signer-token": token(file.tokenFile) },
        });
      expect(s).toMatchObject({
        address: OWNER,
        enabledRoutes: [route],
        inFlight: 0,
        uncertain: 0,
        signed: [`${route}:APPROVE`],
      });
      expect(s.chains[chainId]).toEqual({
        firstNonce: 11n,
        signedCount: 2,
        inFlight: 0,
        uncertain: 0,
      });
    },
  );
  it("a failed sync never asks for the status; a malformed status is unavailable; nothing is retried", async () => {
    const fail = async (lane: "SWAP" | "BRIDGE") => {
      try {
        await laneSignerStatus(lane);
      } catch (e) {
        expect(e).toBeInstanceOf(LaneDispatchError);
        return [
          (e as LaneDispatchError).code,
          ...(e as LaneDispatchError).problems,
        ];
      }
      throw new Error("EXPECTED_A_REFUSAL");
    };
    fetchMock.mockImplementation(async () =>
      reply({ error: "SESSION_EXPIRED" }, 403),
    );
    expect(await fail("SWAP")).toEqual(["SIGNER_STATUS_UNAVAILABLE", "SYNC"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset().mockImplementation(async () => {
      throw new TypeError("connect ECONNREFUSED");
    });
    expect(await fail("BRIDGE")).toEqual(["SIGNER_STATUS_UNAVAILABLE", "SYNC"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const bad of [
      { ...statusBody(BASE, "8453"), extra: 1 },
      { ...statusBody(BASE, "8453"), address: "not-an-address" },
      {
        ...statusBody(BASE, "8453"),
        chains: {
          "8453": {
            firstNonce: "0x0b",
            signedCount: 0,
            inFlight: 0,
            uncertain: 0,
          },
        },
      },
      "not json",
    ]) {
      fetchMock
        .mockReset()
        .mockImplementationOnce(async () => reply({ receipts: [] }))
        .mockImplementationOnce(async () => reply(bad));
      expect(await fail("SWAP"), JSON.stringify(bad)).toEqual([
        "SIGNER_STATUS_UNAVAILABLE",
        "STATUS",
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
    // a status answered with a non-200 is not a status
    fetchMock
      .mockReset()
      .mockImplementationOnce(async () => reply({ receipts: [] }))
      .mockImplementationOnce(async () => reply(statusBody(BASE, "8453"), 500));
    expect(await fail("SWAP")).toEqual(["SIGNER_STATUS_UNAVAILABLE", "STATUS"]);
  });
});
