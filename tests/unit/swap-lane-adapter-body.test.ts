// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the request body the lane's signer adapter (src/swap/lane/signer-adapter.ts)
// hands to the LOCAL restricted signer — the multi-chain signer contract {method: "sign_send", declared: {lane: "SWAP",
// route, step}, swapAmount, tx}. To observe the body at all, THIS FILE ONLY replaces, in a mocked approval module, the
// signer endpoint (a synthetic loopback URL and a token file in this run's temp directory) and the gate (OPEN); global
// fetch is mocked, so nothing reaches a network. swap-lane-adapter.test.ts covers the real (disarmed) gate.
// SYNTHETIC_TEST_ONLY: the endpoint, token, owner and transaction are synthetic.
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
  swapLaneGateState,
  type SwapLaneStepFacts,
} from "../../src/swap/lane/approval";
import {
  mintLaneDispatchAuthority,
  sendLaneTransaction,
  type LaneTx,
} from "../../src/swap/lane/signer-adapter";
import { approveCalldata, swapCalldata } from "../../src/swap/lane/calldata";
import { SWAP_LANE_ROUTES } from "../../src/swap/lane/scope";

vi.mock("../../src/swap/lane/approval", async (importOriginal) => {
  const m =
    await importOriginal<typeof import("../../src/swap/lane/approval")>();
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const base = process.env.FL1 ? join(process.env.FL1, "temp") : tmpdir();
  mkdirSync(base, { recursive: true });
  const tokenFile = join(mkdtempSync(join(base, "swap-lane-signer-")), "token");
  writeFileSync(tokenFile, "synthetic-signer-token-0123456789\n");
  return {
    ...m,
    OWNER_SWAP_LANE_SIGNER: Object.freeze({
      url: "http://127.0.0.1:18545/",
      tokenFile,
    }),
    swapLaneGateState: vi.fn(() => ({
      state: "OPEN" as const,
      open: true,
      reasons: [],
      scope: null,
      pinSet: null,
    })),
  };
});

const OWNER = "0x3333333333333333333333333333333333333333";
const HASH = "0x" + "ab".repeat(32);
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const txOf = (id: string, step: "APPROVE" | "SWAP"): LaneTx => {
  const r = SWAP_LANE_ROUTES[id];
  return {
    chainId: r.chainHex,
    from: OWNER,
    to: (step === "APPROVE" ? r.pay.address : r.router).toLowerCase(),
    value: "0x0",
    data:
      step === "APPROVE"
        ? approveCalldata(r, r.maxAmount)
        : swapCalldata(r, {
            owner: OWNER,
            amountIn: r.maxAmount,
            amountOutMinimum: 1n,
            deadline: BigInt(Math.floor(NOW / 1000) + 300),
          }),
    gas: "0xd7a0",
    maxFeePerGas: "0xf42400",
    maxPriorityFeePerGas: "0xf4240",
  };
};
const factsOf = (
  id: string,
  step: "APPROVE" | "SWAP",
  tx: LaneTx,
): SwapLaneStepFacts => ({
  route: id,
  step,
  exactAmount: SWAP_LANE_ROUTES[id].maxAmount.toString(),
  tx,
  amountOutMinimum: step === "SWAP" ? 1n : undefined,
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
  if (OWNER_SWAP_LANE_SIGNER)
    rmSync(dirname(OWNER_SWAP_LANE_SIGNER.tokenFile), {
      recursive: true,
      force: true,
    });
});

describe("the signer request body (multi-chain signer contract)", () => {
  it.each(
    Object.keys(SWAP_LANE_ROUTES).filter(
      (id) => SWAP_LANE_ROUTES[id].status === "ENABLED",
    ),
  )(
    "%s: {method, declared: {lane, route, step}, swapAmount, tx} — exactly, in this order, for both steps",
    async (id) => {
      for (const [step, declared] of [
        ["APPROVE", "APPROVE"],
        ["SWAP", "EXECUTE"],
      ] as const) {
        fetchMock.mockClear();
        const tx = txOf(id, step);
        const a = mintLaneDispatchAuthority(factsOf(id, step, tx));
        expect(await sendLaneTransaction(a, { ...tx }, step)).toEqual({
          outcome: "SENT",
          hash: HASH,
          problems: [],
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [
          string,
          RequestInit,
        ];
        expect(url).toBe("http://127.0.0.1:18545/");
        expect(init).toMatchObject({
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-fl1-signer-token": readFileSync(
              OWNER_SWAP_LANE_SIGNER!.tokenFile,
              "utf8",
            ).trim(),
          },
        });
        expect(init.body).toBe(
          JSON.stringify({
            method: "sign_send",
            declared: { lane: "SWAP", route: id, step: declared },
            swapAmount: SWAP_LANE_ROUTES[id].maxAmount.toString(),
            tx,
          }),
        );
      }
    },
  );
  it("the declared route is the authority's own (from the minted facts), not anything the caller presents", async () => {
    const id = "op-usdc-weth-univ3-max1";
    const tx = txOf(id, "APPROVE");
    const a = mintLaneDispatchAuthority(factsOf(id, "APPROVE", tx));
    await sendLaneTransaction(a, { ...tx }, "APPROVE");
    const body = JSON.parse(
      String(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
      ),
    ) as { declared: { route: string } };
    expect(body.declared.route).toBe(id);
    // the adapter re-ran the (mocked) gate on exactly these facts, route included
    const seen = vi.mocked(swapLaneGateState).mock.calls.at(-1)![0]!;
    expect(seen.route).toBe(id);
    expect(seen.tx).toEqual(tx);
  });
});
