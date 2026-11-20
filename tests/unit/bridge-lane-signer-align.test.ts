// VEINED-MC1 (BRIDGE LANE): app <-> restricted signer v5 alignment. For EVERY enabled pair, the EXACT transactions the
// bridge lane engine builds (APPROVE and EXECUTE, over the fake chains of ./bridge-lane-fake.ts) and the declaration
// the adapter sends ({lane: "BRIDGE", route: <pair id>, step}) are judged by the signer's own pure policy
// (D:/vnd/hk1/mc1/signer/policy-v5.mjs check(), with its own offline fixtures and injected reads: no key, no network,
// nothing started). A step the lane reviews as ready must be one the signer accepts; and a few adversarial calldata
// shapes the lane refuses are refused by the signer too. Skipped when the read-only signer tree is not on this machine.
// SYNTHETIC_TEST_ONLY: the owner, fees and reads are synthetic.
import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ENABLED_PAIR_IDS,
  FEE,
  FIXTURES,
  OTHER,
  OWNER,
  OWNER_KEY,
  bridgeLane,
  feeCall,
  settleSource,
} from "./bridge-lane-fake";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
} from "../../src/swap/lane/bridge-scope";

vi.mock("../../src/swap/lane/bridge-pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/bridge-pins")>();
  const { fakeBridgePinModule } = await import("./bridge-lane-pin-mock");
  return fakeBridgePinModule(real);
});

const SIGNER = "D:/vnd/hk1/mc1/signer";
const have =
  existsSync(`${SIGNER}/policy-v5.mjs`) &&
  existsSync(`${SIGNER}/fixtures-v5.mjs`);
type Verdict = { ok: boolean; problems: string[] };
interface Fixtures {
  P: {
    ROUTES: Record<
      string,
      { id: string; chainId: number; exactAmount: bigint }
    >;
    validateInstance: (raw: unknown) => {
      ok: boolean;
      problems: string[];
      instance: unknown;
    };
    check: (tx: unknown, ctx: unknown) => Verdict;
  };
  instanceRaw: (o: { routes: string[] }) => Record<string, unknown>;
  FIRST_NONCE: Record<number, number>;
  reads: (
    route: unknown,
    o: Record<string, unknown>,
  ) => Record<string, unknown>;
  journal: (o?: Record<string, unknown>) => unknown;
  afterApprove: (route: unknown) => unknown;
  pair: (v: unknown) => [string, string];
  honestNonces: (inst: unknown, j: unknown) => unknown;
}
const load = async () =>
  (await import(pathToFileURL(`${SIGNER}/fixtures-v5.mjs`).href)) as Fixtures;

describe.skipIf(!have)(
  "signer v5 accepts exactly what the bridge lane builds",
  () => {
    it.each(ENABLED_PAIR_IDS)(
      "%s: APPROVE and EXECUTE as built and declared by the lane pass signer v5 check()",
      async (id) => {
        const F = await load();
        const route = F.P.ROUTES[id];
        const v = F.P.validateInstance({
          ...F.instanceRaw({ routes: [id] }),
          burner: OWNER,
        });
        expect(v.problems).toEqual([]);
        const firstNonce = F.FIRST_NONCE[route.chainId];
        const src = BRIDGE_LANE_PAIRS[id].source;
        const S = BRIDGE_LANE_CHAINS[src];
        const f = FIXTURES[src];
        const L = bridgeLane({ pair: id });
        const reads = (o: Record<string, unknown>) =>
          F.reads(route, {
            baseFee: f.baseFee,
            blockAgeSec: 2,
            headSkew: S.maxHeadSkewBlocks,
            l1: S.feeModel === "OP_STACK" ? f.l1Fee : undefined,
            ...o,
          });
        // ---- APPROVE: what the engine hands the adapter, with the adapter's own declaration ----
        const r1 = await L.engine.review(OWNER_KEY);
        expect(r1.problems).toEqual([]);
        await L.engine.dispatch(
          L.engine.authorize(r1.reviewId, OWNER_KEY),
          OWNER_KEY,
        );
        const approve = L.signer.calls[0];
        const declaredA = { lane: "BRIDGE", route: id, step: approve.step };
        const a = F.P.check(approve.tx, {
          now: L.clock.t,
          instance: v.instance,
          journal: F.journal(),
          chainNonces: F.honestNonces(v.instance, F.journal()),
          declared: declaredA,
          reads: reads({
            nonce: firstNonce,
            allow: 0,
            estimate: F.pair(L.src.gas.APPROVE + L.src.l1Gas.APPROVE),
            arbL1: F.pair(L.src.l1Gas.APPROVE),
          }),
        });
        expect(a.problems, `${id} APPROVE`).toEqual([]);
        expect(a.ok).toBe(true);
        // ---- EXECUTE ----
        settleSource(L);
        await L.engine.track();
        const r2 = await L.engine.review(OWNER_KEY);
        expect(r2.problems).toEqual([]);
        await L.engine.dispatch(
          L.engine.authorize(r2.reviewId, OWNER_KEY),
          OWNER_KEY,
        );
        const exec = L.signer.calls[1];
        expect(exec.step).toBe("EXECUTE");
        const e = F.P.check(exec.tx, {
          now: L.clock.t,
          instance: v.instance,
          journal: F.afterApprove(route),
          chainNonces: F.honestNonces(v.instance, F.afterApprove(route)),
          declared: { lane: "BRIDGE", route: id, step: exec.step },
          reads: reads({
            nonce: firstNonce + 1,
            allow: route.exactAmount,
            estimate: F.pair(L.src.gas.EXECUTE + L.src.l1Gas.EXECUTE),
            arbL1: F.pair(L.src.l1Gas.EXECUTE),
          }),
        });
        expect(e.problems, `${id} EXECUTE`).toEqual([]);
        expect(e.ok).toBe(true);
        // the app's "EXECUTE" step name is the signer's; a SWAP declaration of the same bytes is refused
        const wrong = F.P.check(exec.tx, {
          now: L.clock.t,
          instance: v.instance,
          journal: F.afterApprove(route),
          chainNonces: F.honestNonces(v.instance, F.afterApprove(route)),
          declared: { lane: "SWAP", route: id, step: "EXECUTE" },
          reads: reads({ nonce: firstNonce + 1, allow: route.exactAmount }),
        });
        expect(wrong.problems).toContain("DECLARED_STEP_MISMATCH");
      },
    );
    it.each([
      ["a fee recipient that is not pinned", "BRIDGE_FEE_RECIPIENT_NOT_PINNED"],
      ["a receiver that is not the owner", "BRIDGE_RECEIVER_NOT_BURNER"],
    ] as const)(
      "%s: refused by the lane AND by the signer",
      async (name, signerCode) => {
        const F = await load();
        const id = "bridge-8453-42161";
        const route = F.P.ROUTES[id];
        const v = F.P.validateInstance({
          ...F.instanceRaw({ routes: [id] }),
          burner: OWNER,
        });
        const L = bridgeLane({ pair: id });
        L.mutate = (p) => {
          if (name.startsWith("a fee"))
            p.steps[0].callData = feeCall(
              BRIDGE_LANE_CHAINS["8453"].usdc.address,
              [{ recipient: OTHER, amount: FEE }],
            );
          else p.receiver = OTHER;
        };
        const r = await L.engine.review(OWNER_KEY);
        expect(r.ready).toBe(false);
        const tx = {
          chainId: "0x2105",
          from: OWNER,
          to: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
          value: "0x0",
          data: (L.lastParts &&
            (await import("./bridge-lane-fake")).encodeBridge(L.lastParts))!,
          gas: "0x36030",
          maxFeePerGas: "0xf42400",
          maxPriorityFeePerGas: "0xf4240",
        };
        const s = F.P.check(tx, {
          now: L.clock.t,
          instance: v.instance,
          journal: F.afterApprove(route),
          chainNonces: F.honestNonces(v.instance, F.afterApprove(route)),
          declared: { lane: "BRIDGE", route: id, step: "EXECUTE" },
          reads: F.reads(route, {
            nonce: F.FIRST_NONCE[8453] + 1,
            allow: route.exactAmount,
            l1: FIXTURES["8453"].l1Fee,
          }),
        });
        expect(s.problems).toContain(signerCode);
      },
    );
  },
);
