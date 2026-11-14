// V1.11 G7 release gate: the BSC common-pin SECURITY INVARIANTS, pinned as tests so any future weakening of the
// policy constants or of selectCommonPin fails here (in addition to the behavioural suite g7-common-pin.test.ts).
//   - at least two independent operator groups; same-group sources never form a pair
//   - exact canonical finalized block hash agreement (state pair + logs witness)
//   - no latest/pending/safe substitution: only the `finalized` tag or explicit heights <= each source's finalized
//   - bounded step-down; stale limit; hash disagreement => fail closed at once; no pair => CONSENSUS_UNAVAILABLE
import { describe, expect, it } from "vitest";
import { G7RpcError, assertReadOnlyRequest } from "../../src/g7/rpc";
import {
  PinError,
  selectCommonPin,
  type PinCall,
  type PinPolicy,
  type PinSource,
} from "../../src/g7/common-pin";
import {
  BSC_LOGS_WITNESS,
  BSC_PIN_POLICY,
  BSC_STATE_SOURCES,
} from "../../src/g7/policy";

const NOW_S = 1_800_000_000;
const now = () => NOW_S * 1000;
interface Node {
  group: string;
  finalized: number;
  /** highest explicit height served (default: finalized + 2) */
  serves?: number;
  /** hash namespace (different => disagreement) */
  fork?: string;
  /** block age in seconds at the finalized head */
  ageSec?: number;
}
function world(nodes: Record<string, Node>) {
  const calls: { url: string; method: string; tag?: unknown }[] = [];
  const call: PinCall = async <T>(
    url: string,
    method: string,
    params: unknown[],
  ) => {
    calls.push({ url, method, tag: params[0] });
    const n = nodes[url];
    if (method === "eth_chainId") return "0x38" as T;
    if (method === "eth_blockNumber")
      return `0x${(n.finalized + 2).toString(16)}` as T;
    const tag = params[0] as string;
    const h = tag === "finalized" ? n.finalized : Number(BigInt(tag));
    if (tag !== "finalized" && h > (n.serves ?? n.finalized + 2))
      throw new G7RpcError("RPC_ERROR", `block not found: ${tag}`);
    return {
      number: `0x${h.toString(16)}`,
      hash: `0x${(n.fork ?? "a").repeat(8)}${h.toString(16).padStart(56, "0")}`,
      timestamp: `0x${(NOW_S - (n.ageSec ?? 2) - (n.finalized - h)).toString(16)}`,
    } as T;
  };
  const sources = (urls: string[]): PinSource[] =>
    urls.map((url) => ({ url, operatorGroup: nodes[url].group }));
  return { call, calls, sources };
}
const policy = (extra: Partial<PinPolicy> = {}): PinPolicy => ({
  ...BSC_PIN_POLICY,
  ...extra,
});
async function code(p: Promise<unknown>) {
  try {
    await p;
    return "PINNED";
  } catch (e) {
    return e instanceof PinError
      ? e.diagnostics.code
      : `UNEXPECTED ${String(e)}`;
  }
}

describe("G7 common-pin invariants: policy constants", () => {
  it("BSC chain id, stale limit <= 30 s, bounded step-down 1..16", () => {
    expect(BSC_PIN_POLICY.chainId).toBe(56);
    expect(BSC_PIN_POLICY.maxPinAgeSec).toBeGreaterThan(0);
    expect(BSC_PIN_POLICY.maxPinAgeSec).toBeLessThanOrEqual(30);
    expect(BSC_PIN_POLICY.maxStepDown).toBeGreaterThanOrEqual(1);
    expect(BSC_PIN_POLICY.maxStepDown).toBeLessThanOrEqual(16);
  });
  it("at least two independent operator groups; the logs witness is a separate group and never a state vote", () => {
    const groups = BSC_STATE_SOURCES.map((s) => s.operatorGroup);
    expect(new Set(groups).size).toBe(groups.length);
    expect(new Set(groups).size).toBeGreaterThanOrEqual(2);
    expect(groups).not.toContain(BSC_LOGS_WITNESS.operatorGroup);
    expect(BSC_STATE_SOURCES.map((s) => s.url)).not.toContain(
      BSC_LOGS_WITNESS.url,
    );
  });
  it("every pin source is a vetted https read-only endpoint (refused otherwise before any I/O)", () => {
    for (const s of [...BSC_STATE_SOURCES, BSC_LOGS_WITNESS]) {
      expect(s.url.startsWith("https://")).toBe(true);
      expect(() =>
        assertReadOnlyRequest(s.url, "eth_getBlockByNumber", [
          "finalized",
          false,
        ]),
      ).not.toThrow();
    }
    expect(() =>
      assertReadOnlyRequest(
        "https://rpc.example.invalid",
        "eth_getBlockByNumber",
        ["finalized", false],
      ),
    ).toThrow();
  });
});

describe("G7 common-pin invariants: selection", () => {
  const base = {
    a: { group: "g1", finalized: 1000 },
    b: { group: "g2", finalized: 997 },
    w: { group: "gw", finalized: 999 },
  };
  it("pins the highest block BOTH sources and the witness have finalized, with one exact hash", async () => {
    const wd = world({
      "https://a": base.a,
      "https://b": base.b,
      "https://w": base.w,
    });
    const pin = await selectCommonPin(
      wd.sources(["https://a", "https://b"]),
      wd.call,
      policy({ witnesses: [{ url: "https://w", operatorGroup: "gw" }] }),
      now,
    );
    expect(pin.number).toBe(997);
    expect(pin.operatorGroups).toEqual(["g1", "g2"]);
    // no latest/pending/safe/earliest substitution: only `finalized` or explicit heights <= min(finalized)
    for (const c of wd.calls.filter(
      (x) => x.method === "eth_getBlockByNumber",
    )) {
      if (c.tag === "finalized") continue;
      expect(String(c.tag)).toMatch(/^0x[0-9a-f]+$/);
      expect(Number(BigInt(String(c.tag)))).toBeLessThanOrEqual(997);
    }
  });
  it("two sources of the SAME operator group never form a pair (no single-operator pass)", async () => {
    const wd = world({
      "https://a": { group: "g1", finalized: 1000 },
      "https://a2": { group: "g1", finalized: 1000 },
    });
    expect(
      await code(
        selectCommonPin(
          wd.sources(["https://a", "https://a2"]),
          wd.call,
          policy(),
          now,
        ),
      ),
    ).toBe("RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE");
  });
  it("a single source never passes", async () => {
    const wd = world({ "https://a": { group: "g1", finalized: 1000 } });
    expect(
      await code(
        selectCommonPin(wd.sources(["https://a"]), wd.call, policy(), now),
      ),
    ).toBe("RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE");
  });
  it("hash disagreement at a finalized height fails closed AT ONCE (no other pair is tried)", async () => {
    const wd = world({
      "https://a": { group: "g1", finalized: 1000 },
      "https://b": { group: "g2", finalized: 1000, fork: "b" },
      "https://c": { group: "g3", finalized: 1000 },
    });
    expect(
      await code(
        selectCommonPin(
          wd.sources(["https://a", "https://b", "https://c"]),
          wd.call,
          policy(),
          now,
        ),
      ),
    ).toBe("RPC_FINALIZED_HASH_DISAGREEMENT");
    expect(
      wd.calls.some(
        (c) =>
          c.url === "https://c" &&
          c.method === "eth_getBlockByNumber" &&
          c.tag !== "finalized",
      ),
    ).toBe(false);
  });
  it("step-down is bounded: an unserved candidate is retried at most maxStepDown + 1 heights per pair", async () => {
    const wd = world({
      "https://a": { group: "g1", finalized: 1000, serves: 500 },
      "https://b": { group: "g2", finalized: 1000, serves: 500 },
    });
    expect(
      await code(
        selectCommonPin(
          wd.sources(["https://a", "https://b"]),
          wd.call,
          policy(),
          now,
        ),
      ),
    ).toBe("RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE");
    const heights = new Set(
      wd.calls
        .filter(
          (c) =>
            c.url === "https://a" &&
            c.tag !== "finalized" &&
            c.method === "eth_getBlockByNumber",
        )
        .map((c) => c.tag),
    );
    expect(heights.size).toBeLessThanOrEqual(BSC_PIN_POLICY.maxStepDown + 1);
  });
  it("stale limit: a common block older than maxPinAgeSec is never pinned", async () => {
    const old = BSC_PIN_POLICY.maxPinAgeSec + 5;
    const wd = world({
      "https://a": { group: "g1", finalized: 1000, ageSec: old },
      "https://b": { group: "g2", finalized: 1000, ageSec: old },
    });
    expect(
      await code(
        selectCommonPin(
          wd.sources(["https://a", "https://b"]),
          wd.call,
          policy(),
          now,
        ),
      ),
    ).toBe("RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE");
  });
  it("never below the floor (ledger deltas only move forward)", async () => {
    const wd = world({
      "https://a": { group: "g1", finalized: 1000 },
      "https://b": { group: "g2", finalized: 990 },
    });
    expect(
      await code(
        selectCommonPin(
          wd.sources(["https://a", "https://b"]),
          wd.call,
          policy({ floor: 995 }),
          now,
        ),
      ),
    ).toBe("RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE");
  });
  it("no independent pair => RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE (fail closed, never a pass)", async () => {
    const wd = world({ "https://a": { group: "g1", finalized: 1000 } });
    const sources = [
      ...wd.sources(["https://a"]),
      { url: "https://down", operatorGroup: "g2" },
    ];
    const call: PinCall = (url, method, params, t) =>
      url === "https://down"
        ? Promise.reject(new G7RpcError("TRANSPORT", "ECONNREFUSED"))
        : wd.call(url, method, params, t);
    expect(await code(selectCommonPin(sources, call, policy(), now))).toBe(
      "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE",
    );
  });
});
