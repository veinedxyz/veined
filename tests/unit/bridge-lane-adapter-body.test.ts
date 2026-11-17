// VEINED-MC1 (BRIDGE LANE): the request body the lane's signer adapter hands the LOCAL restricted signer for the
// bridge lane — the multi-chain signer contract {method: "sign_send", declared: {lane: "BRIDGE", route: <pair id>,
// step: "APPROVE" | "EXECUTE"}, tx}, with NO swapAmount (signer v5 reads none for the bridge lane). To observe the body
// at all, THIS FILE ONLY replaces, in a mocked bridge-approval module, the bridge signer endpoint (a synthetic loopback
// URL and a token file in this run's temp directory) and the bridge gate (OPEN); global fetch is mocked, so nothing
// reaches a network. bridge-lane-adapter.test.ts covers the real (disarmed) gate.
// SYNTHETIC_TEST_ONLY: the endpoint, token, owner and transactions are synthetic.
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
  OWNER_BRIDGE_LANE_SIGNER,
  bridgeLaneGateState,
  type BridgeLaneStepFacts,
} from "../../src/swap/lane/bridge-approval";
import { OWNER_SWAP_LANE_SIGNER } from "../../src/swap/lane/approval";
import {
  mintBridgeDispatchAuthority,
  sendBridgeLaneTransaction,
  type LaneTx,
} from "../../src/swap/lane/signer-adapter";
import { bridgeApproveCalldata } from "../../src/swap/lane/bridge-calldata";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
} from "../../src/swap/lane/bridge-scope";

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
    mkdtempSync(join(base, "bridge-lane-signer-")),
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
      state: "OPEN" as const,
      open: true,
      reasons: [],
      scope: null,
      pinSet: null,
    })),
  };
});

const OWNER = "0x3333333333333333333333333333333333333333";
const HASH = "0x" + "cd".repeat(32);
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const ENABLED = Object.values(BRIDGE_LANE_PAIRS)
  .filter((p) => p.status === "ENABLED")
  .map((p) => p.id);
const txOf = (id: string, step: "APPROVE" | "EXECUTE"): LaneTx => {
  const p = BRIDGE_LANE_PAIRS[id];
  const S = BRIDGE_LANE_CHAINS[p.source];
  return {
    chainId: S.chainHex,
    from: OWNER,
    to:
      step === "APPROVE"
        ? S.usdc.address.toLowerCase()
        : "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
    value: "0x0",
    data:
      step === "APPROVE"
        ? bridgeApproveCalldata(p.exactAmount)
        : "0x1794958f" + "00".repeat(32),
    gas: "0x103dc",
    maxFeePerGas: "0xf42400",
    maxPriorityFeePerGas: "0xf4240",
  };
};
const factsOf = (
  id: string,
  step: "APPROVE" | "EXECUTE",
  tx: LaneTx,
): BridgeLaneStepFacts => ({
  route: id,
  step,
  exactAmount: BRIDGE_LANE_PAIRS[id].exactAmount.toString(),
  tx,
  operatorsAgree: true,
  reviewAttested: true,
  guardianPassed: true,
  gasWorstCaseTotalWei: 1n,
  now: NOW,
});
let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response(JSON.stringify({ hash: HASH }), { status: 200 }),
    );
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  if (OWNER_BRIDGE_LANE_SIGNER)
    rmSync(dirname(OWNER_BRIDGE_LANE_SIGNER.tokenFile), {
      recursive: true,
      force: true,
    });
});

describe("the bridge signer request body (multi-chain signer contract)", () => {
  it.each(ENABLED)(
    "%s: {method, declared: {lane: BRIDGE, route, step}, tx} — exactly, in this order, no swapAmount, both steps",
    async (id) => {
      for (const step of ["APPROVE", "EXECUTE"] as const) {
        fetchMock.mockClear();
        const tx = txOf(id, step);
        const a = mintBridgeDispatchAuthority(factsOf(id, step, tx));
        expect(await sendBridgeLaneTransaction(a, { ...tx }, step)).toEqual({
          outcome: "SENT",
          hash: HASH,
          problems: [],
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [
          string,
          RequestInit,
        ];
        expect(url).toBe("http://127.0.0.1:18546/");
        expect(init).toMatchObject({
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-fl1-signer-token": readFileSync(
              OWNER_BRIDGE_LANE_SIGNER!.tokenFile,
              "utf8",
            ).trim(),
          },
        });
        expect(init.body).toBe(
          JSON.stringify({
            method: "sign_send",
            declared: { lane: "BRIDGE", route: id, step },
            tx,
          }),
        );
        expect(String(init.body)).not.toContain("swapAmount");
      }
    },
  );
  it("the declared route is the authority's own, and the gate re-run saw exactly those facts", async () => {
    const id = "bridge-10-137";
    const tx = txOf(id, "APPROVE");
    await sendBridgeLaneTransaction(
      mintBridgeDispatchAuthority(factsOf(id, "APPROVE", tx)),
      { ...tx },
      "APPROVE",
    );
    const body = JSON.parse(
      String(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
      ),
    ) as {
      declared: { route: string; lane: string };
    };
    expect(body.declared).toEqual({
      lane: "BRIDGE",
      route: id,
      step: "APPROVE",
    });
    const seen = vi.mocked(bridgeLaneGateState).mock.calls.at(-1)![0]!;
    expect(seen.route).toBe(id);
    expect(seen.tx).toEqual(tx);
  });
  it("the signer's answers: 403 refused -> REFUSED; anything else without a hash -> UNCERTAIN; never resent", async () => {
    const id = "bridge-1-8453";
    const tx = txOf(id, "APPROVE");
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ refused: true, problems: ["ROUTE_NOT_ENABLED"] }),
          { status: 403 },
        ),
    );
    expect(
      await sendBridgeLaneTransaction(
        mintBridgeDispatchAuthority(factsOf(id, "APPROVE", tx)),
        { ...tx },
        "APPROVE",
      ),
    ).toEqual({
      outcome: "REFUSED",
      hash: null,
      problems: ["ROUTE_NOT_ENABLED"],
    });
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ uncertain: true, hash: HASH }), {
          status: 502,
        }),
    );
    expect(
      await sendBridgeLaneTransaction(
        mintBridgeDispatchAuthority(factsOf(id, "APPROVE", tx)),
        { ...tx },
        "APPROVE",
      ),
    ).toMatchObject({
      outcome: "UNCERTAIN",
      hash: HASH,
    });
    fetchMock.mockImplementation(async () => {
      throw new TypeError("socket hang up");
    });
    expect(
      await sendBridgeLaneTransaction(
        mintBridgeDispatchAuthority(factsOf(id, "APPROVE", tx)),
        { ...tx },
        "APPROVE",
      ),
    ).toEqual({
      outcome: "UNCERTAIN",
      hash: null,
      problems: ["SIGNER_UNREACHABLE_AFTER_SEND"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("the swap lane's endpoint fact stays null: the bridge endpoint is its own", () => {
    expect(OWNER_SWAP_LANE_SIGNER).toBeNull();
    expect(OWNER_BRIDGE_LANE_SIGNER?.url).toBe("http://127.0.0.1:18546/");
  });
});
