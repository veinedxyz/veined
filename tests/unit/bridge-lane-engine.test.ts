// VEINED-MC1 (BRIDGE LANE): the bridge lane ENGINE (src/swap/lane/bridge-engine.ts) end to end over two in-memory FAKE
// CHAINS (two programmable operators each), a LI.FI quote double that builds real AcrossFacetV4 calldata with an
// independent ABI, an in-memory journal and a recording fake signer, on a fixed clock — for EVERY enabled pair.
// The bridge pin set is mocked ONLY in its code hashes (keccak256 of the fake chains' bytes; every address, slot,
// selector and topic is the real pin), because a real runtime-code preimage cannot be produced.
// SYNTHETIC_TEST_ONLY: owner, key, hashes, deposits and amounts are synthetic. Nothing here signs, sends or reaches a
// network (fetch is spied and must stay untouched).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import {
  AMOUNT,
  BLOCKED_PAIR_IDS,
  BRIDGED,
  DEFAULT_PAIR,
  DIAMOND,
  ENABLED_PAIR_IDS,
  FEE,
  FEE_COLLECTOR,
  FEE_RECIPIENT,
  FIRST_NONCE,
  KEY_DIGEST,
  MemStore,
  NOW,
  OTHER,
  OWNER,
  OWNER_KEY,
  RELAYER,
  b32,
  bridgeLane,
  bridged,
  effectiveOf,
  feeCall,
  fillAndBury,
  FakeBridgeChain,
  FakeBridgeSigner,
  recordFor,
  settleSource,
  step,
  type BridgeLane,
  type QuoteParts,
} from "./bridge-lane-fake";
import { fakeBridgeCodeOf } from "./bridge-lane-pin-mock";
import {
  BridgeLaneEngine,
  type BridgeLaneError,
} from "../../src/swap/lane/bridge-engine";
import {
  BRIDGE_LANE_CHAIN_PINS,
  bridgePinsOf,
} from "../../src/swap/lane/bridge-pins";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
  BRIDGE_LANE_SCOPE,
  pairById,
} from "../../src/swap/lane/bridge-scope";
import { bridgeLaneGateState } from "../../src/swap/lane/bridge-approval";
import { sendBridgeLaneTransaction } from "../../src/swap/lane/signer-adapter";
import type { CanaryDurableStore } from "../../src/execution/server/canary/durable-store";

vi.mock("../../src/swap/lane/bridge-pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/bridge-pins")>();
  const { fakeBridgePinModule } = await import("./bridge-lane-pin-mock");
  return fakeBridgePinModule(real);
});

const lc = (a: string) => a.toLowerCase();
const err = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e as BridgeLaneError;
  }
  throw new Error("EXPECTED_A_REFUSAL");
};
const code = async (p: Promise<unknown> | (() => unknown)) =>
  (await err(p)).code;
const PAIR = (id: string) => BRIDGE_LANE_PAIRS[id];
const NOW_SEC = Math.floor(NOW / 1000);
type Steps = Record<string, { state: string; hash?: string | null }>;
const stepsOf = (t: { steps: Record<string, unknown> }) => t.steps as Steps;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
/** Every eth_getLogs the destination served: explicit, <= 100 blocks, the pinned SpokePool, fixed topics. */
const logReads = (L: BridgeLane) =>
  L.dst.log
    .filter((x) => x.method === "eth_getLogs")
    .map(
      (x) =>
        x.params[0] as {
          address: string;
          fromBlock: string;
          toBlock: string;
          topics: string[];
        },
    );

describe("test set-up", () => {
  it("the mocked bridge pins differ from the real ones only in the code hashes", async () => {
    const real = await vi.importActual<
      typeof import("../../src/swap/lane/bridge-pins")
    >("../../src/swap/lane/bridge-pins");
    expect(Object.keys(BRIDGE_LANE_CHAIN_PINS)).toEqual(
      Object.keys(real.BRIDGE_LANE_CHAIN_PINS),
    );
    for (const id of Object.keys(real.BRIDGE_LANE_CHAIN_PINS)) {
      const m = BRIDGE_LANE_CHAIN_PINS[id],
        a = real.BRIDGE_LANE_CHAIN_PINS[id];
      expect(bridgePinsOf(id)).toBe(m);
      for (const k of [
        "diamond",
        "facet",
        "feeCollector",
        "spokePool",
        "usdc",
      ] as const) {
        expect(m[k].address).toBe(a[k].address);
        expect(m[k].codehash).toBe(keccak256(fakeBridgeCodeOf(m[k].address)));
        expect(m[k].codehash).not.toBe(a[k].codehash);
      }
      expect(m.spokePool.implementation.address).toBe(
        a.spokePool.implementation.address,
      );
      expect(m.usdc.implementation.slot).toBe(a.usdc.implementation.slot);
      expect(m.gasPriceOracle).toBe(a.gasPriceOracle);
      expect(m.set).toBe(a.set);
    }
  });
});

describe("every enabled pair: APPROVE then EXECUTE to SETTLED_VERIFIED", () => {
  it("there are exactly 20 enabled pairs", () => {
    expect(ENABLED_PAIR_IDS).toHaveLength(20);
  });
  it.each(ENABLED_PAIR_IDS)(
    "%s: exact bytes, the pair's chains, both operators, fill found, settled once",
    async (id) => {
      const L = bridgeLane({ pair: id });
      const p = PAIR(id),
        S = BRIDGE_LANE_CHAINS[p.source],
        D = BRIDGE_LANE_CHAINS[p.destination];
      // ---- APPROVE ----
      const r1 = await L.engine.review(OWNER_KEY);
      expect(r1.problems, id).toEqual([]);
      const eff = effectiveOf(L.lastParts!);
      expect(r1).toMatchObject({
        ready: true,
        step: "APPROVE",
        route: id,
        sourceChainId: p.source,
        destinationChainId: p.destination,
        amountIn: "5000000",
        minimumOut: "4900000",
        bridged: BRIDGED.toString(),
        feeTotal: FEE.toString(),
        effectiveOutput: eff.toString(),
        simulation: {
          usdcDelta: "-5000000",
          allowanceAfter: "0",
          gasUsed: { APPROVE: "55437", EXECUTE: "184360" },
        },
        gas: {
          limits: { APPROVE: "66524", EXECUTE: "221232" },
        },
        pins: { problems: [] },
      });
      expect(r1.guardian?.level).not.toMatch(/BLOCK|HOLD/);
      expect(r1.destinationBlock).toBe((L.dst.head - 1n).toString());
      const t1 = L.engine.authorize(r1.reviewId, OWNER_KEY);
      const d1 = await L.engine.dispatch(t1, OWNER_KEY);
      expect(d1).toMatchObject({ step: "APPROVE", outcome: "SENT" });
      expect(L.signer.calls[0].tx).toEqual({
        chainId: S.chainHex,
        from: OWNER,
        to: lc(S.usdc.address),
        value: "0x0",
        data:
          "0x095ea7b3" +
          "0000000000000000000000001231deb6f5749ef6ce6943a275a1d3e7486f4eae" +
          "00000000000000000000000000000000000000000000000000000000004c4b40",
        gas: "0x103dc",
        maxFeePerGas: "0x" + BigInt(r1.gas.maxFeePerGas).toString(16),
        maxPriorityFeePerGas:
          "0x" + BigInt(r1.gas.maxPriorityFeePerGas).toString(16),
      });
      expect(L.store.types()).toEqual([
        "REVIEW",
        "AUTH",
        "SIGNER_PREFLIGHT",
        "NONCE",
        "USE",
        "PREPARED",
        "DISPATCH",
      ]);
      expect(L.gateCalls).toHaveLength(1);
      expect(L.gateCalls[0].open).toBe(true);
      expect((await L.engine.track()).state).toBe("APPROVE_PENDING");
      L.src.mine();
      expect((await L.engine.track()).state).toBe("APPROVE_CONFIRMING");
      L.src.advance(S.confirmations - 2);
      expect(stepsOf(await L.engine.track()).APPROVE).toMatchObject({
        state: "CONFIRMING",
        confirmations: String(S.confirmations - 1),
      });
      L.src.advance(1);
      const t = await L.engine.track();
      expect(t.state).toBe("EXECUTE_NOT_DISPATCHED");
      expect(t.allowance).toEqual({ value: "5000000", agree: true });
      // ---- EXECUTE ----
      const r2 = await L.engine.review(OWNER_KEY);
      expect(r2.problems, id).toEqual([]);
      expect(r2).toMatchObject({
        step: "EXECUTE",
        balances: { allowance: "5000000" },
        simulation: { usdcDelta: "-5000000", allowanceAfter: "0" },
      });
      const t2 = L.engine.authorize(r2.reviewId, OWNER_KEY);
      const d2 = await L.engine.dispatch(t2, OWNER_KEY);
      expect(d2).toMatchObject({ step: "EXECUTE", outcome: "SENT" });
      expect(L.signer.calls[1]).toMatchObject({ step: "EXECUTE" });
      const bridgeTx = L.signer.calls[1].tx;
      expect(bridgeTx).toMatchObject({
        chainId: S.chainHex,
        from: OWNER,
        to: DIAMOND,
        value: "0x0",
        data: r2.data,
      });
      expect(BigInt(bridgeTx.gas)).toBeLessThanOrEqual(S.maxGas.EXECUTE);
      expect(BigInt(bridgeTx.maxFeePerGas)).toBeLessThanOrEqual(
        S.maxFeePerGasWei,
      );
      expect(r2.data!.slice(0, 10)).toBe("0x1794958f");
      // source pending, then final -> the deposit -> destination pending
      expect((await L.engine.track()).state).toBe("SOURCE_PENDING");
      L.dst.advance(3);
      settleSource(L);
      const t3 = await L.engine.track();
      expect(t3.state).toBe("DESTINATION_PENDING");
      const dep = L.src.deposits.at(-1)!;
      expect(t3.deposit).toMatchObject({
        depositId: dep.depositId.toString(),
        inputAmount: BRIDGED.toString(),
        outputAmount: eff.toString(),
        depositor: lc(b32(OWNER)),
        recipient: lc(b32(OWNER)),
      });
      expect(L.store.of("DEPOSIT")).toHaveLength(1);
      // the relayer fills on the destination; it counts once buried by the destination's confirmations
      fillAndBury(L, dep);
      const t4 = await L.engine.track();
      expect(t4.state, JSON.stringify(t4.settlement)).toBe("SETTLED_VERIFIED");
      expect(t4.settlement).toMatchObject({
        delivered: eff.toString(),
        fillAmount: eff.toString(),
        minimumOut: "4900000",
        problems: [],
      });
      expect(L.store.of("SETTLED")).toHaveLength(1);
      // a second track neither re-journals nor re-sends
      expect((await L.engine.track()).state).toBe("SETTLED_VERIFIED");
      expect(L.store.of("SETTLED")).toHaveLength(1);
      expect(L.signer.calls).toHaveLength(2);
      expect(L.engine.nextStep()).toBeNull();
      const r3 = await L.engine.review(OWNER_KEY);
      expect(r3.problems).toContain("LANE_ALREADY_USED");
      // every read inside the lane's read shape; every log read <= 100 blocks on the pinned destination SpokePool
      expect(L.src.violations).toEqual([]);
      expect(L.dst.violations).toEqual([]);
      const logs = logReads(L);
      expect(logs.length).toBeGreaterThan(0);
      for (const f of logs) {
        expect(lc(f.address)).toBe(
          lc(BRIDGE_LANE_CHAIN_PINS[D.chainId].spokePool.address),
        );
        expect(
          BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n,
        ).toBeLessThanOrEqual(100n);
        expect(f.topics[0]).toBe(
          "0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208",
        );
        expect(BigInt(f.topics[1])).toBe(BigInt(p.source));
        expect(BigInt(f.topics[2])).toBe(dep.depositId);
      }
      expect(BigInt(logs[0].fromBlock)).toBe(BigInt(r2.destinationBlock!));
      // the source never served eth_getLogs (the deposit comes from the source receipt)
      expect(L.src.log.some((x) => x.method === "eth_getLogs")).toBe(false);
    },
  );
});

// ---- adversarial review, per field, for every enabled pair ------------------------------------------------------------
type Case = [
  string,
  (L: BridgeLane) => void,
  string,
  Partial<
    import("../../src/swap/lane/bridge-approval").OwnerBridgeLaneApproval
  >?,
];
const OTHER_TOKEN = "0x6666666666666666666666666666666666666666";
const parts =
  (f: (p: QuoteParts, L: BridgeLane) => void) => (L: BridgeLane) => {
    L.mutate = (p) => f(p, L);
  };
const quote = (f: (q: Record<string, unknown>) => void) => (L: BridgeLane) => {
  L.mutateQuote = (q) => {
    const c = structuredClone(q) as unknown as Record<string, unknown>;
    f(c);
    return c;
  };
};
const feeStep = (
  L: BridgeLane,
  entries: { recipient: string; amount: bigint }[],
) => feeCall(BRIDGE_LANE_CHAINS[PAIR(L.pairId).source].usdc.address, entries);
const CASES: Case[] = [
  [
    "wrong destination chain",
    parts((p, L) => {
      p.destinationChainId = PAIR(L.pairId).destination === "10" ? 137n : 10n;
    }),
    "BRIDGE_DESTINATION_NOT_PAIR",
  ],
  [
    "wrong BridgeData receiver",
    parts((p) => void (p.receiver = OTHER)),
    "BRIDGE_RECEIVER_NOT_OWNER",
  ],
  [
    "wrong Across receiver",
    parts((p) => void (p.across.receiverAddress = b32(OTHER))),
    "ACROSS_RECEIVER_NOT_OWNER",
  ],
  [
    "wrong refund (= depositor)",
    parts((p) => void (p.across.refundAddress = b32(OTHER))),
    "ACROSS_REFUND_NOT_OWNER",
  ],
  [
    "a non-EVM bytes32 receiver",
    parts((p) => {
      p.across.receiverAddress = ("0x" +
        "ff".repeat(12) +
        OWNER.slice(2)) as Hex;
    }),
    "BRIDGE_NON_EVM_ADDRESS",
  ],
  [
    "a non-EVM exclusive relayer",
    parts((p) => {
      p.across.exclusiveRelayer = ("0x" + "01".repeat(32)) as Hex;
      p.across.exclusivityParameter = 10;
    }),
    "BRIDGE_NON_EVM_ADDRESS",
  ],
  [
    "wrong sending asset",
    parts((p) => void (p.sendingAssetId = OTHER_TOKEN)),
    "BRIDGE_ASSET_NOT_SOURCE_USDC",
  ],
  [
    "wrong Across input token",
    parts((p) => void (p.across.sendingAssetId = b32(OTHER_TOKEN))),
    "ACROSS_INPUT_NOT_SOURCE_USDC",
  ],
  [
    "wrong output token",
    parts((p) => void (p.across.receivingAssetId = b32(OTHER_TOKEN))),
    "ACROSS_OUTPUT_NOT_DESTINATION_USDC",
  ],
  [
    "fee recipient not pinned",
    parts((p, L) => {
      p.steps[0].callData = feeStep(L, [{ recipient: OTHER, amount: FEE }]);
    }),
    "BRIDGE_FEE_RECIPIENT_NOT_PINNED",
  ],
  [
    "fee above 25 bps",
    parts((p, L) => {
      p.steps[0].callData = feeStep(L, [
        { recipient: FEE_RECIPIENT, amount: FEE + 1n },
      ]);
      p.minAmount = AMOUNT - FEE - 1n;
    }),
    "BRIDGE_FEE_ABOVE_25_BPS",
  ],
  [
    "two fee entries",
    parts((p, L) => {
      p.steps[0].callData = feeStep(L, [
        { recipient: FEE_RECIPIENT, amount: FEE - 1n },
        { recipient: FEE_RECIPIENT, amount: 1n },
      ]);
    }),
    "BRIDGE_FEE_ENTRIES",
  ],
  [
    "fees + bridged != amount",
    parts((p) => void (p.minAmount = BRIDGED - 1n)),
    "BRIDGE_FEE_ARITHMETIC",
  ],
  [
    "the fee in another token",
    parts((p) => {
      p.steps[0].callData = feeCall(OTHER_TOKEN, [
        { recipient: FEE_RECIPIENT, amount: FEE },
      ]);
    }),
    "BRIDGE_FEE_TOKEN",
  ],
  [
    "a second source step",
    parts((p) => void p.steps.push({ ...p.steps[0] })),
    "BRIDGE_STEP_COUNT",
  ],
  ["no source step", parts((p) => void (p.steps = [])), "BRIDGE_STEP_COUNT"],
  [
    "a step that is not the FeeCollector",
    parts((p) => {
      p.steps[0].callTo = OTHER;
      p.steps[0].approveTo = OTHER;
    }),
    "BRIDGE_STEP_NOT_FEE_COLLECTOR",
  ],
  [
    "a step without requiresDeposit",
    parts((p) => void (p.steps[0].requiresDeposit = false)),
    "BRIDGE_STEP_REQUIRES_DEPOSIT",
  ],
  [
    "a step from another amount",
    parts((p) => void (p.steps[0].fromAmount = AMOUNT + 1n)),
    "BRIDGE_INPUT_NOT_EXACT",
  ],
  [
    "a destination call",
    parts((p) => void (p.hasDestinationCall = true)),
    "BRIDGE_DESTINATION_CALL",
  ],
  [
    "a non-empty message",
    parts((p) => void (p.across.message = "0x1234")),
    "BRIDGE_MESSAGE_NOT_EMPTY",
  ],
  [
    "no source swaps flag",
    parts((p) => void (p.hasSourceSwaps = false)),
    "BRIDGE_EXPECTS_FEE_STEP",
  ],
  [
    "a referrer",
    parts((p) => void (p.referrer = OTHER)),
    "BRIDGE_REFERRER_SET",
  ],
  [
    "a 65-character integrator",
    parts((p) => void (p.integrator = "x".repeat(65))),
    "BRIDGE_INTEGRATOR_TOO_LONG",
  ],
  [
    "another bridge name",
    parts((p) => void (p.bridge = "stargate")),
    "BRIDGE_TOOL_NOT_ACROSS",
  ],
  [
    "output below the minimum",
    parts(
      (p) => void (p.across.outputAmountMultiplier = 982_000_000_000_000_000n),
    ),
    "BRIDGE_OUTPUT_BELOW_MINIMUM",
  ],
  [
    "multiplier above 1e18",
    parts((p) => void (p.across.outputAmountMultiplier = 10n ** 18n + 1n)),
    "BRIDGE_MULTIPLIER_BOUNDS",
  ],
  [
    "multiplier 0",
    parts((p) => void (p.across.outputAmountMultiplier = 0n)),
    "BRIDGE_MULTIPLIER_BOUNDS",
  ],
  [
    "a stale quote timestamp",
    parts((p) => void (p.across.quoteTimestamp = NOW_SEC - 601)),
    "BRIDGE_QUOTE_TIMESTAMP_SKEW",
  ],
  [
    "a future quote timestamp",
    parts((p) => void (p.across.quoteTimestamp = NOW_SEC + 601)),
    "BRIDGE_QUOTE_TIMESTAMP_SKEW",
  ],
  [
    "a fill window below 30 min",
    parts((p) => void (p.across.fillDeadline = NOW_SEC + 1_799)),
    "BRIDGE_FILL_DEADLINE_WINDOW",
  ],
  [
    "a fill window above 6 h",
    parts((p) => void (p.across.fillDeadline = NOW_SEC + 21_601)),
    "BRIDGE_FILL_DEADLINE_WINDOW",
  ],
  [
    "exclusivity above 300 s",
    parts((p) => {
      p.across.exclusivityParameter = 301;
      p.across.exclusiveRelayer = b32(RELAYER);
    }),
    "BRIDGE_EXCLUSIVITY",
  ],
  [
    "a relayer without a window",
    parts((p) => void (p.across.exclusiveRelayer = b32(RELAYER))),
    "BRIDGE_EXCLUSIVE_RELAYER_WITHOUT_WINDOW",
  ],
  [
    "a window without a relayer",
    parts((p) => void (p.across.exclusivityParameter = 60)),
    "BRIDGE_EXCLUSIVITY_WITHOUT_RELAYER",
  ],
  [
    "cost above the record's cap",
    () => undefined,
    "BRIDGE_COST_ABOVE_CAP",
    { maxCostBps: 1 },
  ],
  // the quote itself
  [
    "the quote tool is not across",
    quote((q) => void (q.tool = "stargateV2")),
    "QUOTE_TOOL_NOT_ACROSS",
  ],
  [
    "the quote targets another contract",
    quote(
      (q) =>
        void ((q.transactionRequest as Record<string, unknown>).to = OTHER),
    ),
    "QUOTE_TARGET_NOT_DIAMOND",
  ],
  [
    "the quote carries native value",
    quote(
      (q) =>
        void ((q.transactionRequest as Record<string, unknown>).value = "0x1"),
    ),
    "QUOTE_NATIVE_VALUE",
  ],
  [
    "the quote's approval address is not the Diamond",
    quote(
      (q) =>
        void ((q.estimate as Record<string, unknown>).approvalAddress = OTHER),
    ),
    "QUOTE_SPENDER_NOT_DIAMOND",
  ],
  [
    "the quote's gas limit is unbounded",
    quote(
      (q) =>
        void ((q.transactionRequest as Record<string, unknown>).gasLimit =
          "0x" + (3_000_001).toString(16)),
    ),
    "QUOTE_GAS_LIMIT_UNBOUNDED",
  ],
  [
    "another selector",
    quote((q) => {
      const t = q.transactionRequest as Record<string, string>;
      t.data = "0xdeadbeef" + t.data.slice(10);
    }),
    "QUOTE_SELECTOR_NOT_ACROSS_V4",
  ],
  [
    "non-canonical calldata (a planted trailing word)",
    quote((q) => {
      const t = q.transactionRequest as Record<string, string>;
      t.data = t.data + "00".repeat(32);
    }),
    "BRIDGE_CALLDATA_NOT_CANONICAL",
  ],
  [
    "the quote is from another account",
    quote(
      (q) =>
        void ((q.transactionRequest as Record<string, unknown>).from = OTHER),
    ),
    "QUOTE_FROM_NOT_OWNER",
  ],
  [
    "the quote is on another chain",
    quote(
      (q) =>
        void ((q.transactionRequest as Record<string, unknown>).chainId = 56),
    ),
    "QUOTE_CHAIN_NOT_SOURCE",
  ],
  [
    "the quoted minimum above the calldata's output",
    quote((q) => {
      const e = q.estimate as Record<string, string>;
      e.toAmountMin = (BigInt(e.toAmountMin) + 1n).toString();
    }),
    "QUOTE_MINIMUM_ABOVE_CALLDATA_OUTPUT",
  ],
  [
    "the quote is unavailable",
    (L) =>
      void (L.quoteError = Object.assign(new Error("x"), {
        code: "RATE_LIMITED",
      })),
    "QUOTE_UNAVAILABLE:RATE_LIMITED",
  ],
  // pins on the source and the destination
  [
    "the Diamond's selector re-routed to another facet",
    (L) => void (L.src.facetFor = OTHER),
    "FACET_REROUTED",
  ],
  [
    "the facet's SPOKEPOOL re-pointed",
    (L) => void (L.src.spokeOfFacet = OTHER),
    "SPOKEPOOL_CHANGED",
  ],
  [
    "the Diamond's code changed",
    (L) => void L.src.code.set(DIAMOND, "0x6080"),
    `CODE_CHANGED:0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`,
  ],
  [
    "the facet's code changed",
    (L) =>
      void L.src.code.set(
        lc("0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd"),
        "0x6080",
      ),
    "CODE_CHANGED:0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd",
  ],
  [
    "the FeeCollector's code changed",
    (L) => void L.src.code.set(FEE_COLLECTOR, "0x6080"),
    `CODE_CHANGED:${FEE_COLLECTOR}`,
  ],
  [
    "the source USDC implementation re-pointed",
    (L) => {
      for (const k of L.src.slots.keys())
        if (k.startsWith(L.src.A.usdc)) L.src.slots.set(k, OTHER);
    },
    "USDC_IMPLEMENTATION_CHANGED",
  ],
  [
    "the source SpokePool implementation re-pointed",
    (L) => {
      for (const k of L.src.slots.keys())
        if (k.startsWith(L.src.A.spokePool)) L.src.slots.set(k, OTHER);
    },
    "SPOKEPOOL_IMPLEMENTATION_CHANGED",
  ],
  [
    "the destination SpokePool's code changed",
    (L) => void L.dst.code.set(L.dst.A.spokePool, "0x6080"),
    "DESTINATION_CODE_CHANGED:",
  ],
  [
    "the destination USDC implementation re-pointed",
    (L) => {
      for (const k of L.dst.slots.keys())
        if (k.startsWith(L.dst.A.usdc)) L.dst.slots.set(k, OTHER);
    },
    "DESTINATION_USDC_IMPLEMENTATION_CHANGED",
  ],
  // the two operators
  [
    "the source operators disagree on a code hash",
    (L) => {
      L.src.tamper = (op, method, params) =>
        op === 1 &&
        method === "eth_getCode" &&
        lc(params[0] as string) === DIAMOND
          ? "0x60"
          : undefined;
    },
    "OPERATORS_NOT_PROVEN",
  ],
  [
    "the destination operators disagree on a code hash",
    (L) => {
      L.dst.tamper = (op, method) =>
        op === 0 && method === "eth_getCode" ? "0x60" : undefined;
    },
    "DESTINATION_CODE_DISAGREE:",
  ],
  [
    "the source operators' heads too far apart",
    (L) => {
      L.src.tamper = (op, method) =>
        op === 1 && method === "eth_blockNumber"
          ? "0x" +
            (L.src.head + BigInt(L.src.chain.maxHeadSkewBlocks) + 1n).toString(
              16,
            )
          : undefined;
    },
    "OPERATOR_HEADS_TOO_FAR_APART",
  ],
  [
    "the destination operators' heads too far apart",
    (L) => {
      L.dst.tamper = (op, method) =>
        op === 1 && method === "eth_blockNumber"
          ? "0x" +
            (L.dst.head + BigInt(L.dst.chain.maxHeadSkewBlocks) + 1n).toString(
              16,
            )
          : undefined;
    },
    "DESTINATION_OPERATOR_HEADS_TOO_FAR_APART",
  ],
  [
    "the simulation disagrees between the operators",
    (L) => {
      L.src.tamper = (op, method, _p, honest) =>
        op === 1 && method === "eth_simulateV1"
          ? (() => {
              const h = structuredClone(honest) as {
                calls: { returnData: string }[];
              }[];
              h[0].calls[0].returnData = "0x" + "0".repeat(63) + "1";
              return h;
            })()
          : undefined;
    },
    "SIMULATION_OPERATORS_DISAGREE",
  ],
  // the simulation
  [
    "the bridge call reverts in the simulation",
    (L) => void (L.src.bridgeReverts = true),
    "SIMULATION_REVERTED",
  ],
  [
    "the simulated USDC delta is not exactly the amount",
    (L) => void (L.src.pullDelta = -1n),
    "SIMULATED_USDC_DELTA_NOT_EXACT",
  ],
  [
    "an allowance left after the simulated bridge",
    (L) => void (L.src.pullDelta = -1n),
    "SIMULATED_ALLOWANCE_LEFT",
  ],
  // balances, nonce, fees, budget
  [
    "USDC balance below the amount",
    (L) => void (L.src.usdc = AMOUNT - 1n),
    "USDC_BALANCE_BELOW_AMOUNT",
  ],
  [
    "an allowance already standing",
    (L) => void (L.src.allowance = 1n),
    "ALLOWANCE_NOT_ZERO_BEFORE_APPROVE",
  ],
  [
    "a nonce not anchored to the journal",
    (L) => void (L.src.baseNonce = FIRST_NONCE + 1n),
    "NONCE_NOT_ANCHORED_TO_JOURNAL",
  ],
  [
    "native balance below the worst case",
    (L) => void (L.src.native = 1n),
    "NATIVE_BELOW_WORST_CASE",
  ],
  [
    "a record budget below the worst case",
    () => undefined,
    "GAS_BUDGET",
    { nativeGasBudgetWei: "1" },
  ],
  [
    "a base fee above the signer ceiling",
    (L) => void (L.src.baseFee = L.src.chain.maxFeePerGasWei),
    "FEE_CAP_ABOVE_SIGNER_POLICY",
  ],
  [
    "a source block older than the chain allows",
    (L) => void (L.src.lagSec = L.src.chain.maxReviewBlockAgeSec + 5),
    "REVIEW_BLOCK_TOO_OLD",
  ],
  [
    "a simulated gas need above the step cap",
    (L) => void (L.src.gas.EXECUTE = 600_000n),
    "GAS_ABOVE_CAP:EXECUTE",
  ],
];
describe.each(ENABLED_PAIR_IDS)("adversarial review: %s", (id) => {
  it.each(CASES)("%s -> refused (%s)", async (_name, apply, want, over) => {
    const L = bridgeLane({
      pair: id,
      ...(over ? { record: recordFor(id, over) } : {}),
    });
    apply(L);
    const r = await L.engine.review(OWNER_KEY);
    expect(r.ready).toBe(false);
    expect(
      r.problems.some((x) =>
        want.endsWith(":") ? x.startsWith(want) : x === want,
      ),
      `${id}: ${r.problems.join(",")}`,
    ).toBe(true);
    // a refused review authorizes nothing and nothing is sent
    expect(await code(() => L.engine.authorize(r.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_READY",
    );
    expect(L.signer.calls).toHaveLength(0);
    expect(L.store.of("NONCE")).toHaveLength(0);
  });
  it("OP_STACK sources: a non-zero or unread operator fee is refused; other sources never read it", async () => {
    const L = bridgeLane({ pair: id });
    const op = L.src.chain.feeModel === "OP_STACK";
    L.src.operatorFee = 1n;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems.includes("OP_STACK_OPERATOR_FEE_NONZERO")).toBe(op);
    expect(r.ready).toBe(!op);
    expect(
      L.src.log.some(
        (x) =>
          x.method === "eth_call" &&
          (x.params[0] as { data: string }).data.startsWith("0x275aedd2"),
      ),
    ).toBe(op);
    if (op) {
      // the L1 fee of BOTH remaining transactions is reserved twice
      const L2 = bridgeLane({ pair: id });
      const r2 = await L2.engine.review(OWNER_KEY);
      expect(BigInt(r2.gas.l1FeeWei)).toBe(L2.src.l1Fee * 2n * 2n);
    }
  });
});

describe("single use, replay, the gate, the signer", () => {
  it("a token is spent once; a second dispatch is refused (TOKEN_REPLAYED) and nothing is re-sent", async () => {
    const L = bridgeLane();
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    await L.engine.dispatch(t, OWNER_KEY);
    expect(await code(L.engine.dispatch(t, OWNER_KEY))).toBe("TOKEN_REPLAYED");
    expect(L.signer.calls).toHaveLength(1);
  });
  it("the step is single use: a second token for the same step is refused before anything is spent", async () => {
    const L = bridgeLane();
    const r = await L.engine.review(OWNER_KEY);
    const t1 = L.engine.authorize(r.reviewId, OWNER_KEY);
    const t2 = L.engine.authorize(r.reviewId, OWNER_KEY);
    await L.engine.dispatch(t1, OWNER_KEY);
    expect(await code(L.engine.dispatch(t2, OWNER_KEY))).toBe(
      "REVIEW_STEP_STALE",
    );
    expect(L.store.of("USE")).toHaveLength(1);
    expect(L.signer.calls).toHaveLength(1);
  });
  it("an APPROVE token cannot drive the EXECUTE step", async () => {
    const L = bridgeLane();
    const r = await L.engine.review(OWNER_KEY);
    const t1 = L.engine.authorize(r.reviewId, OWNER_KEY);
    const spare = L.engine.authorize(r.reviewId, OWNER_KEY);
    await L.engine.dispatch(t1, OWNER_KEY);
    settleSource(L);
    await L.engine.track();
    expect(await code(L.engine.dispatch(spare, OWNER_KEY))).toBe(
      "REVIEW_STEP_STALE",
    );
    expect(L.signer.calls).toHaveLength(1);
  });
  it("a forged or tampered token is refused", async () => {
    const L = bridgeLane();
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    const body = JSON.parse(
      Buffer.from(t, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const forged = Buffer.from(
      JSON.stringify({ ...body, step: "EXECUTE" }),
    ).toString("base64url");
    expect(await code(L.engine.dispatch(forged, OWNER_KEY))).toBe(
      "TOKEN_INVALID",
    );
    expect(await code(L.engine.dispatch("not-a-token", OWNER_KEY))).toBe(
      "TOKEN_INVALID",
    );
    expect(L.signer.calls).toHaveLength(0);
  });
  it("an expired review or token is refused", async () => {
    const L = bridgeLane();
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    L.clock.t += BRIDGE_LANE_SCOPE.reviewTtlSec * 1000;
    expect(await code(L.engine.dispatch(t, OWNER_KEY))).toBe("TOKEN_EXPIRED");
    expect(await code(() => L.engine.authorize(r.reviewId, OWNER_KEY))).toBe(
      "REVIEW_EXPIRED",
    );
  });
  it("a closed gate spends nothing: no NONCE, USE or PREPARED, no hand-off, GATE_CLOSED journaled", async () => {
    const record = recordFor(DEFAULT_PAIR);
    const L = bridgeLane({
      gate: (f) => bridgeLaneGateState(f, record, KEY_DIGEST, false),
    });
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    const e = await err(L.engine.dispatch(t, OWNER_KEY));
    expect(e.code).toBe("BRIDGE_LANE_GATE_CLOSED");
    expect(e.detail).toContain("BRIDGE_LANE_NOT_WIRED");
    expect(L.store.of("NONCE")).toHaveLength(0);
    expect(L.store.of("USE")).toHaveLength(0);
    expect(L.store.of("PREPARED")).toHaveLength(0);
    expect(L.store.of("GATE_CLOSED")).toHaveLength(1);
    expect(L.signer.calls).toHaveLength(0);
    // nothing was spent: the step is still the next one
    expect(L.engine.nextStep()).toBe("APPROVE");
  });
  it("the real disarmed gate refuses (no record, no key, not wired) and nothing is sent", async () => {
    const L = bridgeLane({ gate: bridgeLaneGateState });
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    const e = await err(L.engine.dispatch(t, OWNER_KEY));
    expect(e.code).toBe("BRIDGE_LANE_GATE_CLOSED");
    expect(e.detail).toEqual([
      "NO_OWNER_APPROVED_BRIDGE_LANE",
      "NO_OWNER_BRIDGE_LANE_KEY",
      "BRIDGE_LANE_NOT_WIRED",
    ]);
    expect(L.signer.calls).toHaveLength(0);
  });
  it("signer REFUSED: journaled, never resent; the lane then never reviews EXECUTE as ready", async () => {
    const L = bridgeLane();
    L.signer.answer = () => ({
      outcome: "REFUSED",
      hash: null,
      problems: ["FEE_CAP_ABOVE_POLICY"],
    });
    const { d } = await step(L);
    expect(d).toMatchObject({
      outcome: "REFUSED",
      problems: ["FEE_CAP_ABOVE_POLICY"],
    });
    expect(L.store.of("DISPATCH")[0].data).toMatchObject({
      outcome: "REFUSED",
    });
    expect((await L.engine.track()).state).toBe("APPROVE_REFUSED");
    const r = await L.engine.review(OWNER_KEY);
    expect(r.step).toBe("EXECUTE");
    expect(r.problems).toContain("APPROVAL_NOT_FINAL");
    expect(L.signer.calls).toHaveLength(1);
  });
  it("signer UNCERTAIN: never resent; the nonce anchor counts it, so nothing reviews ready until it is resolved", async () => {
    const L = bridgeLane();
    L.signer.answer = () => ({
      outcome: "UNCERTAIN",
      hash: null,
      problems: ["SIGNER_HTTP_502"],
    });
    const { d } = await step(L);
    expect(d.outcome).toBe("UNCERTAIN");
    expect((await L.engine.track()).state).toBe("APPROVE_UNCERTAIN");
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        "APPROVAL_NOT_FINAL",
        "NONCE_NOT_ANCHORED_TO_JOURNAL",
      ]),
    );
    expect(L.signer.calls).toHaveLength(1);
  });
  it("a hand-off that throws is journaled REFUSED_BEFORE_SIGNER (the step stays spent)", async () => {
    const L = bridgeLane();
    L.signer.answer = () => {
      throw Object.assign(new Error("x"), { code: "NO_LOCAL_SIGNER" });
    };
    const { d } = await step(L);
    expect(d).toMatchObject({
      outcome: "REFUSED_BEFORE_SIGNER",
      problems: ["NO_LOCAL_SIGNER"],
    });
    expect(L.engine.nextStep()).toBe("EXECUTE");
  });
  it("the REAL signer adapter behind an open engine gate still refuses (its own disarmed BRIDGE gate), fetch never called", async () => {
    // the real adapter's send, with the fake signer's status (the preflight passes; the adapter's own gate refuses)
    const ref = bridgeLane();
    const L = bridgeLane({
      signer: {
        send: (a, tx, s) => sendBridgeLaneTransaction(a, tx, s),
        status: () => ref.signer.status(),
      },
    });
    const { d } = await step(L);
    expect(d.outcome).toBe("REFUSED_BEFORE_SIGNER");
    expect(d.problems[0]).toBe("BRIDGE_LANE_GATE_CLOSED");
    expect(d.problems).toContain("NO_OWNER_APPROVED_BRIDGE_LANE");
  });
  it("a used step with no dispatch record (a crash between the two) is never reviewed past", async () => {
    const L = bridgeLane();
    L.store.append("USE", {
      key: `${DEFAULT_PAIR}:${OWNER}:${"0x" + "2c".repeat(32)}:APPROVE`,
      step: "APPROVE",
    });
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toContain("LANE_RECOVERY_REQUIRED:APPROVE");
    expect((await L.engine.track()).state).toBe(
      "APPROVE_UNCERTAIN_NO_DISPATCH_RECORD",
    );
  });
  it("a wrong owner key is refused before anything is read or quoted", async () => {
    const L = bridgeLane();
    expect(await code(L.engine.review("00".repeat(32)))).toBe(
      "OWNER_KEY_MISMATCH",
    );
    expect(await code(L.engine.review("6B".repeat(32)))).toBe(
      "OWNER_KEY_INVALID",
    );
    expect(L.quotes).toBe(0);
    expect(L.src.log).toHaveLength(0);
  });
});

describe("settlement", () => {
  it("a fill seen by ONE destination operator only never settles; the search does not advance past it", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    fillAndBury(L, deposit);
    L.dst.tamper = (op, method) =>
      op === 1 && method === "eth_getLogs" ? [] : undefined;
    const t = await L.engine.track();
    expect(t.state).toBe("DESTINATION_PENDING");
    expect(t.destination).toMatchObject({
      detail: "FILL_SEARCH_OPERATORS_DISAGREE",
    });
    expect(L.store.of("SETTLED")).toHaveLength(0);
    // an operator that cannot answer is not "no fill" either
    L.dst.tamper = (op, method) => {
      if (op === 0 && method === "eth_getLogs") throw new Error("HTTP_4XX");
      return undefined;
    };
    expect((await L.engine.track()).destination).toMatchObject({
      detail: "FILL_SEARCH_UNREADABLE",
    });
    L.dst.tamper = null;
    expect((await L.engine.track()).state).toBe("SETTLED_VERIFIED");
  });
  it("a fill of the deposit id with another recipient (a different relay) is ignored; never settled", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    fillAndBury(L, deposit, { recipient: b32(OTHER) });
    const t = await L.engine.track();
    expect(t.state).toBe("DESTINATION_PENDING");
    expect(L.store.of("SETTLED")).toHaveLength(0);
  });
  it("the matching fill pays someone else -> DISCREPANCY (FILL_NOT_PAID_TO_OWNER)", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    fillAndBury(L, deposit, { paidTo: OTHER });
    const t = await L.engine.track();
    expect(t.state).toBe("DISCREPANCY");
    expect(t.settlement).toMatchObject({
      problems: ["FILL_NOT_PAID_TO_OWNER"],
    });
    expect(L.store.of("SETTLED")).toHaveLength(0);
  });
  it("output below the minimum (review NIT-2): a payment or a slow fill below the minimum is DISCREPANCY_FILL_BELOW_MINIMUM, never refund pending", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    fillAndBury(L, deposit, { paid: 4_899_999n });
    const t = await L.engine.track();
    expect(t.state).toBe("DISCREPANCY");
    expect(t.settlement).toMatchObject({
      problems: ["DISCREPANCY_FILL_BELOW_MINIMUM"],
    });
    // paid above the minimum but below the fill's own amount: underpaid
    const L1 = bridgeLane();
    const b1 = await bridged(L1);
    fillAndBury(L1, b1.deposit, { paid: b1.deposit.outputAmount - 1n });
    expect((await L1.engine.track()).settlement).toMatchObject({
      problems: ["FILL_UNDERPAID_TO_OWNER"],
    });
    // a slow fill (root-based, cannot be fabricated) of THIS relay below the minimum
    const L2 = bridgeLane();
    const b2 = await bridged(L2);
    fillAndBury(L2, b2.deposit, {
      fillType: 2,
      updatedOutputAmount: 4_899_999n,
    });
    const t2 = await L2.engine.track();
    expect(t2.state).toBe("DISCREPANCY");
    expect(t2.settlement).toMatchObject({
      problems: ["DISCREPANCY_FILL_BELOW_MINIMUM"],
    });
    expect(L2.store.of("SETTLED")).toHaveLength(0);
    // ... and it stays a DISCREPANCY past the fill deadline (never REFUND_PENDING)
    L2.clock.t += 7 * 3_600_000;
    L2.dst.advance(20_000);
    expect((await L2.engine.track()).state).toBe("DISCREPANCY");
  });
  it("no fill until past the fill deadline -> REFUND_PENDING (never settled); refund evidence on the source if seen", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    expect((await L.engine.track()).state).toBe("DESTINATION_PENDING");
    // the clock and the destination move past the deadline; no fill was ever emitted
    const blocks =
      Math.ceil((deposit.fillDeadline - Math.floor(L.clock.t / 1000)) / 2) +
      400;
    L.clock.t += blocks * 2000;
    L.src.advance(10);
    L.dst.advance(blocks);
    let t = await L.engine.track();
    for (let i = 0; i < 10 && t.state === "DESTINATION_PENDING"; i++)
      t = await L.engine.track();
    expect(t.state).toBe("REFUND_PENDING");
    expect(t.settlement).toMatchObject({
      refund: { evidence: null, code: "NO_REFUND_SEEN_YET" },
    });
    expect(L.store.of("SETTLED")).toHaveLength(0);
    // the search stops once past the deadline: no further log reads
    const before = logReads(L).length;
    const sourceBlock = BigInt(
      (L.store.of("DEPOSIT")[0].data as { sourceBlock: string }).sourceBlock,
    );
    const atDeposit = L.src.usdc;
    L.src.usdcAtBlock = (b) => (b <= sourceBlock ? atDeposit : undefined);
    L.src.usdc += BRIDGED;
    t = await L.engine.track();
    expect(t.state).toBe("REFUND_PENDING");
    expect(logReads(L).length).toBe(before);
    expect(t.settlement).toMatchObject({
      refund: {
        evidence: "SOURCE_USDC_BALANCE_ROSE",
        code: "BALANCE_EVIDENCE_ONLY",
      },
    });
    expect(L.signer.calls).toHaveLength(2);
  });
  it("reorg: the source receipt's block replaced -> SOURCE_PENDING (REORGED), nothing deposited", async () => {
    const L = bridgeLane();
    await step(L);
    settleSource(L);
    await L.engine.track();
    await step(L);
    const n = settleSource(L);
    L.src.forks.set(n, "reorg");
    const t = await L.engine.track();
    expect(t.state).toBe("SOURCE_PENDING");
    expect(stepsOf(t).EXECUTE.state).toBe("REORGED");
    expect(L.store.of("DEPOSIT")).toHaveLength(0);
  });
  it("reorg: the fill's block replaced on the destination -> DESTINATION_PENDING, not settled", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    const h = fillAndBury(L, deposit);
    const blk = BigInt(L.dst.receipts.get(h)!.blockNumber);
    L.dst.forks.set(blk, "reorg");
    const t = await L.engine.track();
    expect(t.state).toBe("DESTINATION_PENDING");
    expect(L.store.of("SETTLED")).toHaveLength(0);
  });
  it("getLogs chunk boundaries: contiguous windows of at most 100 blocks from the review's destination block; a fill at a window edge is found", async () => {
    for (const offset of [0n, 99n, 100n, 199n, 3_000n, 3_099n]) {
      const L = bridgeLane();
      const { e, deposit } = await bridged(L);
      const start = BigInt(e.r.destinationBlock!);
      const at = start + offset;
      if (at > L.dst.head) L.dst.head = at - 1n;
      L.dst.fill(deposit, BigInt(L.src.chainId), { at });
      L.dst.head =
        (at > L.dst.head ? at : L.dst.head) + BigInt(L.dst.chain.confirmations);
      let t = await L.engine.track();
      for (let i = 0; i < 5 && t.state === "DESTINATION_PENDING"; i++)
        t = await L.engine.track();
      expect(t.state, `offset ${offset}`).toBe("SETTLED_VERIFIED");
      const reads = logReads(L);
      expect(BigInt(reads[0].fromBlock)).toBe(start);
      for (let i = 0; i < reads.length; i++) {
        const from = BigInt(reads[i].fromBlock),
          to = BigInt(reads[i].toBlock);
        expect(to - from + 1n).toBeLessThanOrEqual(100n);
        expect(to).toBeGreaterThanOrEqual(from);
        if (i > 0) expect(from).toBe(BigInt(reads[i - 1].toBlock) + 1n);
      }
      expect(BigInt(reads.at(-1)!.toBlock)).toBeGreaterThanOrEqual(at);
      // one track() reads at most 30 windows; the cursor is journaled and resumed
      const scans = L.store
        .of("FILL_SCAN")
        .map((x) => x.data as { from: string; to: string });
      for (let i = 1; i < scans.length; i++)
        expect(BigInt(scans[i].from)).toBe(BigInt(scans[i - 1].to) + 1n);
      expect(L.dst.violations).toEqual([]);
    }
  });
  it("only FINAL destination blocks are searched (a fill younger than the destination's confirmations waits)", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    L.dst.fill(deposit, BigInt(L.src.chainId));
    L.dst.advance(L.dst.chain.confirmations - 2);
    expect((await L.engine.track()).state).toBe("DESTINATION_PENDING");
    L.dst.advance(1);
    expect((await L.engine.track()).state).toBe("SETTLED_VERIFIED");
  });
  it("a deposit that is not the reviewed relay -> DISCREPANCY (recipient, output, deadline)", async () => {
    for (const tamper of [
      (d: import("./bridge-lane-fake").FakeDeposit) => ({
        ...d,
        recipient: b32(OTHER),
      }),
      (d: import("./bridge-lane-fake").FakeDeposit) => ({
        ...d,
        outputAmount: d.outputAmount - 1n,
      }),
      (d: import("./bridge-lane-fake").FakeDeposit) => ({
        ...d,
        fillDeadline: d.fillDeadline + 1,
      }),
      (d: import("./bridge-lane-fake").FakeDeposit) => ({
        ...d,
        depositor: b32(OTHER),
      }),
    ]) {
      const L = bridgeLane();
      await step(L);
      settleSource(L);
      await L.engine.track();
      await step(L);
      L.src.depositTamper = tamper;
      settleSource(L);
      const t = await L.engine.track();
      expect(t.state).toBe("DISCREPANCY");
      expect(t.settlement).toMatchObject({
        problems: ["DEPOSIT_NOT_THE_REVIEWED_RELAY"],
      });
      expect(L.store.of("DEPOSIT")).toHaveLength(0);
    }
  });
  it("two different fills matching the deposit -> DISCREPANCY (MULTIPLE_MATCHING_FILLS)", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    const at = L.dst.head + 1n;
    L.dst.fill(deposit, BigInt(L.src.chainId), { at });
    L.dst.fill(deposit, BigInt(L.src.chainId), { at });
    L.dst.advance(L.dst.chain.confirmations);
    const t = await L.engine.track();
    expect(t.state).toBe("DISCREPANCY");
    expect(t.settlement).toMatchObject({
      problems: ["MULTIPLE_MATCHING_FILLS"],
    });
  });
  it("a FilledRelay from a contract other than the pinned SpokePool never counts", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    const h = fillAndBury(L, deposit);
    // the same fill, re-labelled to another emitter in the receipt AND in the log index the operators serve
    L.dst.receipts.get(lc(h))!.logs[0].address = OTHER;
    expect((await L.engine.track()).state).toBe("DESTINATION_PENDING");
  });
  it("a destination SpokePool changed since the review never settles as verified", async () => {
    const L = bridgeLane();
    const { deposit } = await bridged(L);
    fillAndBury(L, deposit);
    L.dst.code.set(L.dst.A.spokePool, "0x6080");
    const t = await L.engine.track();
    expect(t.state).toBe("DISCREPANCY");
    expect(JSON.stringify(t.settlement)).toContain(
      "DESTINATION_PINS:DESTINATION_CODE_CHANGED",
    );
  });
  it("the source receipt is bound to the PREPARED transaction (another input under the hash -> DISCREPANCY)", async () => {
    const L = bridgeLane();
    await step(L);
    settleSource(L);
    await L.engine.track();
    const { d } = await step(L);
    settleSource(L);
    L.src.sent.get(lc(d.hash!))!.data = "0x1794958f" + "00".repeat(64);
    const t = await L.engine.track();
    expect(t.state).toBe("DISCREPANCY");
    expect(stepsOf(t).EXECUTE.state).toBe("DISCREPANCY_TX");
  });
  it("a reverted bridge transaction -> SOURCE_FAILED; nothing is resent", async () => {
    const L = bridgeLane();
    await step(L);
    settleSource(L);
    await L.engine.track();
    await step(L);
    L.src.failNext = true;
    settleSource(L);
    expect((await L.engine.track()).state).toBe("SOURCE_FAILED");
    expect(L.signer.calls).toHaveLength(2);
  });
});

describe("BLOCKED pairs and Avalanche", () => {
  it.each(BLOCKED_PAIR_IDS)(
    "%s: the engine refuses a BLOCKED pair at construction",
    async (id) => {
      expect(PAIR(id)).toMatchObject({
        status: "BLOCKED",
        blockReason: "NO_CIRCLE_USDC",
      });
      const chain = new FakeBridgeChain(() => NOW, "8453", 1n);
      const e = await err(
        () =>
          new BridgeLaneEngine({
            store: new MemStore() as unknown as CanaryDurableStore,
            record: { ...recordFor(DEFAULT_PAIR), route: id },
            keyDigest: KEY_DIGEST,
            chains: {
              source: chain,
              destination: chain,
              quote: async () => null,
            },
            signer: new FakeBridgeSigner(chain),
          }),
      );
      expect(e.code).toBe("ROUTE_NOT_ENABLED");
    },
  );
  it("no Avalanche pair exists in either direction; unknown ids are refused at construction", async () => {
    for (const id of [
      "bridge-43114-1",
      "bridge-1-43114",
      "bridge-8453-43114",
      "bridge-8453-8453",
      "__proto__",
      "",
    ]) {
      expect(pairById(id)).toBeNull();
      const chain = new FakeBridgeChain(() => NOW, "8453", 1n);
      const e = await err(
        () =>
          new BridgeLaneEngine({
            store: new MemStore() as unknown as CanaryDurableStore,
            record: { ...recordFor(DEFAULT_PAIR), route: id },
            keyDigest: KEY_DIGEST,
            chains: {
              source: chain,
              destination: chain,
              quote: async () => null,
            },
            signer: new FakeBridgeSigner(chain),
          }),
      );
      expect(e.code).toBe("ROUTE_NOT_ENABLED");
    }
  });
});
