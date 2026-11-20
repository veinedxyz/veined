// VEINED-MC1 dry-review item 8 (the live read-only dry review of the real engines, tools/dry-review): an operator read
// that FAILS (an HTTP 400 / 429, a timeout, a rate limit, a malformed answer) is reported as OPERATOR_READ_FAILED:<what>,
// never as a state mismatch; a mismatch code is kept for values BOTH operators did answer. Each site is driven twice
// over the fakes — one operator erroring, one operator answering a different value — and both stay NOT ready (fail
// closed). Plus: a read block slightly AHEAD of the host clock (the host runs 2-4 s behind chain time) is fresh (age 0,
// never a negative age), and one further ahead than signer v5 accepts (blockAgeSec >= -15) is not.
// SYNTHETIC_TEST_ONLY: fakes only, no network (fetch is spied and must stay untouched).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE_ROUTE,
  BASE_PINS,
  OWNER_KEY as SWAP_KEY,
  lane,
} from "./swap-lane-fake";
import {
  OWNER_KEY as BRIDGE_KEY,
  bridgeLane,
  settleSource,
  step as bridgeStep,
} from "./bridge-lane-fake";
import {
  BRIDGE_LANE_SELECTORS,
  BRIDGE_LIFI_DIAMOND,
  bridgePinsOf,
} from "../../src/swap/lane/bridge-pins";

vi.mock("../../src/swap/lane/pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/pins")>();
  const { fakeCodePinModule } = await import("./swap-lane-pin-mock");
  return fakeCodePinModule(real);
});
vi.mock("../../src/swap/lane/bridge-pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/bridge-pins")>();
  const { fakeBridgePinModule } = await import("./bridge-lane-pin-mock");
  return fakeBridgePinModule(real);
});

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const lc = (a: string) => a.toLowerCase();
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const word = (a: string) => "0x" + lc(a).replace(/^0x/, "").padStart(64, "0");
const OTHER_ADDRESS = "0x" + "5a".repeat(20);
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error & { code: string; detail: readonly string[] };
  }
  throw new Error("EXPECTED_A_REFUSAL");
};
type Params = readonly unknown[];
interface Site {
  /** The site and the code a FAILED read must give. */
  failed: string;
  /** The mismatch code a different (well-formed) answer must give. */
  mismatch: string;
  method: string;
  match?: (p: Params) => boolean;
  /** The different answer (op 1 only unless `both`). */
  differ: (honest: unknown) => unknown;
  both?: boolean;
  chain?: "source" | "destination";
}
const callTo = (to: string, sel?: string) => (p: Params) => {
  const c = p[0] as { to?: string; data?: string };
  return (
    lc(String(c?.to)) === lc(to) &&
    (sel === undefined || String(c?.data).slice(0, 10) === sel)
  );
};
const failing = (s: Site) => (op: 0 | 1, m: string, p: Params) => {
  if (op === 0 && m === s.method && (s.match?.(p) ?? true))
    throw new Error("HTTP_429");
  return undefined;
};
const differing =
  (s: Site) => (op: 0 | 1, m: string, p: Params, honest: unknown) =>
    (s.both || op === 1) && m === s.method && (s.match?.(p) ?? true)
      ? s.differ(honest)
      : undefined;
const expectSite = (problems: readonly string[], want: string, not: string) => {
  expect(
    problems.some((x) => x === want || x.startsWith(`${want}:`)),
    `${want} in ${problems.join(",")}`,
  ).toBe(true);
  expect(
    problems.some((x) => x === not || x.startsWith(`${not}:`)),
    `${not} not in ${problems.join(",")}`,
  ).toBe(false);
};

// ---- the swap lane (Base, OP-stack) ------------------------------------------------------------------------------------
const R = BASE_ROUTE;
const SWAP_REVIEW: [string, Site][] = [
  [
    "eth_chainId",
    {
      method: "eth_chainId",
      failed: "OPERATOR_READ_FAILED:CHAIN_ID",
      mismatch: "OPERATOR_CHAIN_ID_MISMATCH",
      differ: () => "0x1",
    },
  ],
  [
    "the nonce at B",
    {
      method: "eth_getTransactionCount",
      failed: "OPERATOR_READ_FAILED:NONCE",
      mismatch: "NONCE_NOT_ANCHORED_TO_JOURNAL",
      differ: (h) => hex(BigInt(h as string) + 1n),
      both: true,
    },
  ],
  [
    "a pinned code hash (router)",
    {
      method: "eth_getCode",
      match: (p) => lc(String(p[0])) === lc(R.router),
      failed: "OPERATOR_READ_FAILED:CODE",
      mismatch: "CODE_DISAGREE",
      differ: () => "0x6001",
    },
  ],
  [
    "a pinned code hash changed on both (router)",
    {
      method: "eth_getCode",
      match: (p) => lc(String(p[0])) === lc(R.router),
      failed: "OPERATOR_READ_FAILED:CODE",
      mismatch: "CODE_CHANGED",
      differ: () => "0x6001",
      both: true,
    },
  ],
  [
    "the USDC implementation slot",
    {
      method: "eth_getStorageAt",
      match: (p) => lc(String(p[0])) === lc(R.pay.address),
      failed: "OPERATOR_READ_FAILED:USDC_IMPLEMENTATION",
      mismatch: "USDC_IMPLEMENTATION_CHANGED",
      differ: () => word(OTHER_ADDRESS),
      both: true,
    },
  ],
  [
    "the factory's pool",
    {
      method: "eth_call",
      match: callTo(R.factory),
      failed: "OPERATOR_READ_FAILED:FACTORY_POOL",
      mismatch: "FACTORY_POOL_MISMATCH",
      differ: () => word(OTHER_ADDRESS),
      both: true,
    },
  ],
  [
    "the pool's token0",
    {
      method: "eth_call",
      match: callTo(R.pool, "0x0dfe1681"),
      failed: "OPERATOR_READ_FAILED:POOL_SHAPE",
      mismatch: "POOL_SHAPE_MISMATCH",
      differ: () => word(OTHER_ADDRESS),
      both: true,
    },
  ],
  [
    "the OP-stack operator fee",
    {
      method: "eth_call",
      match: (p) =>
        String((p[0] as { data?: string })?.data).slice(0, 10) === "0x275aedd2",
      failed: "OPERATOR_READ_FAILED:OP_STACK_OPERATOR_FEE",
      mismatch: "OP_STACK_OPERATOR_FEE_NONZERO",
      differ: () => "0x" + "0".repeat(63) + "1",
    },
  ],
];

describe("dry-review item 8: swap review — a failed read is named as a failed read, a different value as a mismatch", () => {
  it("control: the honest fake is ready", async () => {
    expect((await lane().engine.review(SWAP_KEY)).problems).toEqual([]);
  });
  it.each(SWAP_REVIEW)("%s: one operator failing", async (_n, s) => {
    const L = lane();
    L.chain.tamper = failing(s);
    const r = await L.engine.review(SWAP_KEY);
    expect(r.ready).toBe(false);
    expectSite(r.problems, s.failed, s.mismatch);
  });
  it.each(SWAP_REVIEW)("%s: a different answer", async (_n, s) => {
    const L = lane();
    L.chain.tamper = differing(s);
    const r = await L.engine.review(SWAP_KEY);
    expect(r.ready).toBe(false);
    expectSite(r.problems, s.mismatch, "OPERATOR_READ_FAILED");
  });
  it("the pinned code list really contains the router (the site above reads it)", () => {
    expect(
      Object.values(BASE_PINS).some(
        (v) =>
          typeof v === "object" &&
          v !== null &&
          lc(String((v as { address?: string }).address)) === lc(R.router),
      ),
    ).toBe(true);
  });
});

async function swapRefusedAfterApprove() {
  const L = lane();
  await L.engine.dispatch(
    L.engine.authorize((await L.engine.review(SWAP_KEY)).reviewId, SWAP_KEY),
    SWAP_KEY,
  );
  L.chain.mine();
  L.chain.advance(BASE_ROUTE.confirmations);
  await L.engine.track();
  L.signer.answer = () => ({
    outcome: "REFUSED",
    hash: null,
    problems: ["EARLIER_TX_UNDECIDED"],
  });
  await L.engine.dispatch(
    L.engine.authorize((await L.engine.review(SWAP_KEY)).reviewId, SWAP_KEY),
    SWAP_KEY,
  );
  L.signer.answer = (_s, tx) => ({
    outcome: "SENT",
    hash: L.chain.submit(tx),
    problems: [],
  });
  return L;
}
const REVOKE_SITES = (usdc: string): [string, Site][] => [
  [
    "eth_chainId",
    {
      method: "eth_chainId",
      failed: "OPERATOR_READ_FAILED:CHAIN_ID",
      mismatch: "OPERATOR_CHAIN_ID_MISMATCH",
      differ: () => "0x1",
    },
  ],
  [
    "the nonce at B",
    {
      method: "eth_getTransactionCount",
      failed: "OPERATOR_READ_FAILED:NONCE",
      mismatch: "NONCE_NOT_ANCHORED_TO_JOURNAL",
      differ: (h) => hex(BigInt(h as string) + 1n),
      both: true,
    },
  ],
  [
    "the allowance",
    {
      method: "eth_call",
      match: callTo(usdc, "0xdd62ed3e"),
      failed: "OPERATOR_READ_FAILED:ALLOWANCE",
      mismatch: "OPERATORS_DISAGREE:ALLOWANCE",
      differ: () => word("0x7"),
    },
  ],
  [
    "the OP-stack operator fee",
    {
      method: "eth_call",
      match: (p) =>
        String((p[0] as { data?: string })?.data).slice(0, 10) === "0x275aedd2",
      failed: "OPERATOR_READ_FAILED:OP_STACK_OPERATOR_FEE",
      mismatch: "OP_STACK_OPERATOR_FEE_NONZERO",
      differ: () => "0x" + "0".repeat(63) + "1",
    },
  ],
];
describe("dry-review item 8: swap CLEANUP revoke — the same distinction, nothing spent", () => {
  it.each(REVOKE_SITES(R.pay.address))("%s", async (_n, s) => {
    for (const [mode, want, not] of [
      [failing(s), s.failed, s.mismatch],
      [differing(s), s.mismatch, "OPERATOR_READ_FAILED"],
    ] as const) {
      const L = await swapRefusedAfterApprove();
      L.chain.tamper = mode;
      const e = await err(L.engine.revoke(SWAP_KEY));
      expect(e.code).toBe("REVOKE_NOT_READY");
      expectSite(e.detail, want, not);
      expect(L.signer.calls.some((c) => c.step === "REVOKE")).toBe(false);
    }
  });
});

// ---- the bridge lane (Base -> Arbitrum; Base is OP-stack) ----------------------------------------------------------------
const SP = bridgePinsOf("8453")!;
const DP = bridgePinsOf("42161")!;
const BRIDGE_REVIEW: [string, Site][] = [
  [
    "source eth_chainId",
    {
      method: "eth_chainId",
      failed: "OPERATOR_READ_FAILED:CHAIN_ID",
      mismatch: "OPERATOR_CHAIN_ID_MISMATCH",
      differ: () => "0x1",
    },
  ],
  [
    "destination eth_chainId",
    {
      method: "eth_chainId",
      chain: "destination",
      failed: "OPERATOR_READ_FAILED:DESTINATION_CHAIN_ID",
      mismatch: "DESTINATION_OPERATOR_CHAIN_ID_MISMATCH",
      differ: () => "0x1",
    },
  ],
  [
    "the source nonce at B",
    {
      method: "eth_getTransactionCount",
      failed: "OPERATOR_READ_FAILED:NONCE",
      mismatch: "NONCE_NOT_ANCHORED_TO_JOURNAL",
      differ: (h) => hex(BigInt(h as string) + 1n),
      both: true,
    },
  ],
  [
    "a source code hash (the Diamond)",
    {
      method: "eth_getCode",
      match: (p) => lc(String(p[0])) === lc(BRIDGE_LIFI_DIAMOND),
      failed: "OPERATOR_READ_FAILED:CODE",
      mismatch: "CODE_DISAGREE",
      differ: () => "0x6001",
    },
  ],
  [
    "a destination code hash (the SpokePool)",
    {
      method: "eth_getCode",
      chain: "destination",
      match: (p) => lc(String(p[0])) === lc(DP.spokePool.address),
      failed: "OPERATOR_READ_FAILED:DESTINATION_CODE",
      mismatch: "DESTINATION_CODE_DISAGREE",
      differ: () => "0x6001",
    },
  ],
  [
    "the source USDC implementation slot",
    {
      method: "eth_getStorageAt",
      match: (p) => lc(String(p[0])) === lc(SP.usdc.address),
      failed: "OPERATOR_READ_FAILED:USDC_IMPLEMENTATION",
      mismatch: "USDC_IMPLEMENTATION_CHANGED",
      differ: () => word(OTHER_ADDRESS),
      both: true,
    },
  ],
  [
    "the source SpokePool implementation slot",
    {
      method: "eth_getStorageAt",
      match: (p) => lc(String(p[0])) === lc(SP.spokePool.address),
      failed: "OPERATOR_READ_FAILED:SPOKEPOOL_IMPLEMENTATION",
      mismatch: "SPOKEPOOL_IMPLEMENTATION_CHANGED",
      differ: () => word(OTHER_ADDRESS),
      both: true,
    },
  ],
  [
    "the Diamond's facet for the bridge selector",
    {
      method: "eth_call",
      match: callTo(BRIDGE_LIFI_DIAMOND, "0xcdffacc6"),
      failed: "OPERATOR_READ_FAILED:FACET",
      mismatch: "FACET_REROUTED",
      differ: () => word(OTHER_ADDRESS),
      both: true,
    },
  ],
  [
    "the facet's SpokePool",
    {
      method: "eth_call",
      match: callTo(SP.facet.address, BRIDGE_LANE_SELECTORS.spokePool),
      failed: "OPERATOR_READ_FAILED:SPOKEPOOL",
      mismatch: "SPOKEPOOL_CHANGED",
      differ: () => word(OTHER_ADDRESS),
      both: true,
    },
  ],
  [
    "the OP-stack operator fee",
    {
      method: "eth_call",
      match: (p) =>
        String((p[0] as { data?: string })?.data).slice(0, 10) === "0x275aedd2",
      failed: "OPERATOR_READ_FAILED:OP_STACK_OPERATOR_FEE",
      mismatch: "OP_STACK_OPERATOR_FEE_NONZERO",
      differ: () => "0x" + "0".repeat(63) + "1",
    },
  ],
];
describe("dry-review item 8: bridge review — the same distinction on both chains", () => {
  it("control: the honest fake is ready", async () => {
    expect((await bridgeLane().engine.review(BRIDGE_KEY)).problems).toEqual([]);
  });
  it.each(BRIDGE_REVIEW)("%s: one operator failing", async (_n, s) => {
    const L = bridgeLane();
    (s.chain === "destination" ? L.dst : L.src).tamper = failing(s);
    const r = await L.engine.review(BRIDGE_KEY);
    expect(r.ready).toBe(false);
    expectSite(r.problems, s.failed, s.mismatch);
  });
  it.each(BRIDGE_REVIEW)("%s: a different answer", async (_n, s) => {
    const L = bridgeLane();
    (s.chain === "destination" ? L.dst : L.src).tamper = differing(s);
    const r = await L.engine.review(BRIDGE_KEY);
    expect(r.ready).toBe(false);
    expectSite(r.problems, s.mismatch, "OPERATOR_READ_FAILED");
  });
});
async function bridgeRefusedAfterApprove() {
  const L = bridgeLane();
  await bridgeStep(L);
  settleSource(L);
  await L.engine.track();
  L.signer.answer = () => ({
    outcome: "REFUSED",
    hash: null,
    problems: ["EARLIER_TX_UNDECIDED"],
  });
  await bridgeStep(L);
  L.signer.answer = (_s, tx) => ({
    outcome: "SENT",
    hash: L.src.submit(tx),
    problems: [],
  });
  return L;
}
describe("dry-review item 8: bridge CLEANUP revoke — the same distinction, nothing spent", () => {
  it.each(REVOKE_SITES(SP.usdc.address))("%s", async (_n, s) => {
    for (const [mode, want, not] of [
      [failing(s), s.failed, s.mismatch],
      [differing(s), s.mismatch, "OPERATOR_READ_FAILED"],
    ] as const) {
      const L = await bridgeRefusedAfterApprove();
      L.src.tamper = mode;
      const e = await err(L.engine.revoke(BRIDGE_KEY));
      expect(e.code).toBe("REVOKE_NOT_READY");
      expectSite(e.detail, want, not);
      expect(L.signer.calls.some((c) => c.step === "REVOKE")).toBe(false);
    }
  });
});

// ---- a read block slightly ahead of the host clock -------------------------------------------------------------------
describe("a read block AHEAD of the host clock (the host runs a few seconds behind chain time)", () => {
  const ahead =
    (sec: number, now: () => number) =>
    (_o: 0 | 1, m: string, _p: Params, honest: unknown) =>
      m === "eth_getBlockByNumber" && honest
        ? {
            ...(honest as Record<string, unknown>),
            timestamp: hex(Math.floor(now() / 1000) + sec),
          }
        : undefined;
  it.each([[1], [4], [15]])(
    "%i s ahead: fresh (age 0, no crash, no negative age) — swap and bridge reviews are ready",
    async (sec) => {
      const S = lane();
      S.chain.tamper = ahead(sec, () => S.clock.t);
      const rs = await S.engine.review(SWAP_KEY);
      expect(rs.problems).toEqual([]);
      expect(rs.blockTime - S.clock.t).toBe(sec * 1000);
      const B = bridgeLane();
      B.src.tamper = ahead(sec, () => B.clock.t);
      const rb = await B.engine.review(BRIDGE_KEY);
      expect(rb.problems).toEqual([]);
    },
  );
  it.each([[16], [600]])(
    "%i s ahead: further than signer v5 accepts (blockAgeSec >= -15) -> REVIEW_BLOCK_IN_FUTURE, not ready",
    async (sec) => {
      const S = lane();
      S.chain.tamper = ahead(sec, () => S.clock.t);
      const rs = await S.engine.review(SWAP_KEY);
      expect(rs.ready).toBe(false);
      expect(rs.problems).toContain("REVIEW_BLOCK_IN_FUTURE");
      expect(rs.problems).not.toContain("REVIEW_BLOCK_TOO_OLD");
      const B = bridgeLane();
      B.src.tamper = ahead(sec, () => B.clock.t);
      const rb = await B.engine.review(BRIDGE_KEY);
      expect(rb.ready).toBe(false);
      expect(rb.problems).toContain("REVIEW_BLOCK_IN_FUTURE");
    },
  );
  it("the CLEANUP revoke applies the same rule (16 s ahead -> REVIEW_BLOCK_IN_FUTURE; 3 s ahead -> no age problem)", async () => {
    const L = await swapRefusedAfterApprove();
    L.chain.tamper = ahead(16, () => L.clock.t);
    expect((await err(L.engine.revoke(SWAP_KEY))).detail).toContain(
      "REVIEW_BLOCK_IN_FUTURE",
    );
    L.chain.tamper = ahead(3, () => L.clock.t);
    expect((await L.engine.revoke(SWAP_KEY)).outcome).toBe("SENT");
  });
});
