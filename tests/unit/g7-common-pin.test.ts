// V1.11 P0: BSC canonical common finalized pin (src/g7/common-pin.ts). Deterministic fake read-only RPC; no network.
// Covers the 2026-10-06 failure (endpoint B several blocks behind endpoint A -> "block not found"), every RPC
// failure class the owner listed, and the invariants that must never weaken (independence, finality, agreement).
import { describe, expect, it } from "vitest";
import { G7RpcError } from "../../src/g7/rpc";
import {
  PinError,
  classifyPinFailure,
  selectCommonPin,
  type PinCall,
  type PinSource,
} from "../../src/g7/common-pin";
import {
  BSC_LOGS_WITNESS,
  BSC_PIN_POLICY,
  BSC_STATE_SOURCES,
  ENDPOINTS,
} from "../../src/g7/policy";
import { assertReadOnlyRequest } from "../../src/g7/rpc";
import { provenanceForUrl } from "../../src/data/registry/rpc-provenance";

const NOW_S = 1_790_000_000;
const now = () => NOW_S * 1000;
const hashOf = (n: number, fork = "") =>
  "0x" + (fork + n.toString(16)).padStart(64, fork ? "f" : "a");
interface FakeNode {
  chainId?: number;
  finalized: number;
  head?: number;
  /** Highest block this node can serve (a lagging load-balanced backend serves less than it reports). */
  servesUpTo?: number;
  /** Blocks >= forkFrom have a different hash on this node. */
  forkFrom?: number;
  /** Failure for every call. */
  fail?: "timeout" | "429" | "transport" | "html";
  /** Answer `null` instead of "block not found" for unserved blocks. */
  nullForMissing?: boolean;
  /** Fails for the first N calls, then recovers. */
  failFirst?: number;
  /** Seconds between blocks (timestamp of block n = NOW_S - (finalized - n) * spacing - age). */
  ageSec?: number;
}
function fake(nodes: Record<string, FakeNode>) {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const counts = new Map<string, number>();
  const call: PinCall = async <T>(
    url: string,
    method: string,
    params: unknown[],
  ): Promise<T> => {
    assertReadOnlyRequest(url, method, params); // the real allowlist: refused before any I/O
    calls.push({ url, method, params });
    const node = nodes[url];
    const c = (counts.get(url) ?? 0) + 1;
    counts.set(url, c);
    if (!node) throw new G7RpcError("TRANSPORT", `ENOTFOUND ${method}`);
    if (node.failFirst && c <= node.failFirst)
      throw new G7RpcError("TRANSPORT", `AbortError ${method}`);
    if (node.fail === "timeout")
      throw new G7RpcError("TRANSPORT", `AbortError ${method}`);
    if (node.fail === "transport")
      throw new G7RpcError("TRANSPORT", `ECONNRESET ${method}`);
    if (node.fail === "429")
      throw new G7RpcError("NON_JSON", "429 <html>Too Many Requests</html>");
    if (node.fail === "html")
      throw new G7RpcError("NON_JSON", "520 <!DOCTYPE html>");
    if (method === "eth_chainId")
      return `0x${(node.chainId ?? 56).toString(16)}` as T;
    if (method === "eth_blockNumber")
      return `0x${(node.head ?? node.finalized + 3).toString(16)}` as T;
    if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      const n = tag === "finalized" ? node.finalized : Number(BigInt(tag));
      if (
        tag !== "finalized" &&
        n > (node.servesUpTo ?? node.head ?? node.finalized + 3)
      ) {
        if (node.nullForMissing) return null as T;
        throw new G7RpcError(
          "RPC_ERROR",
          `eth_getBlockByNumber: {"code":-32001,"message":"block not found: ${tag}"}`,
        );
      }
      const forked = node.forkFrom !== undefined && n >= node.forkFrom;
      return {
        number: `0x${n.toString(16)}`,
        hash: hashOf(n, forked ? "b" : ""),
        timestamp: `0x${(NOW_S - (node.ageSec ?? 0) - Math.max(0, 126036977 - n)).toString(16)}`,
      } as T;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, calls };
}
const [A, B, C] = BSC_STATE_SOURCES.map((s) => s.url);
const W = BSC_LOGS_WITNESS.url;
const policy = { ...BSC_PIN_POLICY, witnesses: [BSC_LOGS_WITNESS] };
const F = 126036977;

describe("V1.11 BSC common finalized pin", () => {
  it("vetted sources: three independent operator groups from the provenance inventory, V1.6 pair first", () => {
    expect(BSC_STATE_SOURCES.map((s) => s.url).slice(0, 2)).toEqual([
      ...ENDPOINTS.bsc,
    ]);
    expect(new Set(BSC_STATE_SOURCES.map((s) => s.operatorGroup)).size).toBe(3);
    for (const s of BSC_STATE_SOURCES) {
      const p = provenanceForUrl(s.url);
      expect(p.operatorGroup, s.url).toBe(s.operatorGroup);
      expect(p.witnessEligible, s.url).toBe(true);
      expect(p.reviewStatus).not.toBe("PROHIBITED");
      // every source is in the G7 read-only allowlist; NodeReal stays logs-only (not a state source)
      expect(() =>
        assertReadOnlyRequest(s.url, "eth_chainId", []),
      ).not.toThrow();
    }
    expect(BSC_STATE_SOURCES.map((s) => s.url as string)).not.toContain(W);
    expect(BSC_PIN_POLICY.maxPinAgeSec).toBeLessThanOrEqual(30);
  });

  it("endpoint A ahead, endpoint B a few blocks behind: pins B's finalized block on the primary pair (the 2026-10-06 failure)", async () => {
    const { call } = fake({
      [A]: { finalized: F + 8 },
      [B]: { finalized: F, servesUpTo: F + 2 },
      [C]: { finalized: F + 7 },
      [W]: { finalized: F + 7 },
    });
    const pin = await selectCommonPin(BSC_STATE_SOURCES, call, policy, now);
    expect(pin.number).toBe(F);
    expect(pin.block).toBe(`0x${F.toString(16)}`);
    expect(pin.operatorGroups).toEqual([
      "bnb-chain-bsc-dataseed",
      "allnodes-publicnode",
    ]);
    expect(pin.hash).toBe(hashOf(F));
    expect(pin.health.find((h) => h.url === B)?.lagBlocks).toBe(8);
    expect(pin.attempts).toEqual([
      expect.objectContaining({ outcome: "PINNED", candidate: F, tried: [F] }),
    ]);
  });

  it("block not found at the common head (load-balanced backend lag): steps down a bounded number of blocks", async () => {
    const { call } = fake({
      [A]: { finalized: F + 3 },
      [B]: { finalized: F, servesUpTo: F - 2 },
      [C]: { finalized: F },
      [W]: { finalized: F + 3 },
    });
    const pin = await selectCommonPin(BSC_STATE_SOURCES, call, policy, now);
    expect(pin.number).toBe(F - 2);
    expect(pin.attempts[0].tried).toEqual([F, F - 1, F - 2]);
    // `null` for an unknown block is handled the same way
    const { call: call2 } = fake({
      [A]: { finalized: F + 3 },
      [B]: { finalized: F, servesUpTo: F - 1, nullForMissing: true },
      [C]: { finalized: F },
      [W]: { finalized: F + 3 },
    });
    expect(
      (await selectCommonPin(BSC_STATE_SOURCES, call2, policy, now)).number,
    ).toBe(F - 1);
  });

  it("uses an older common finalized pin only when it is still recent; a stale pair falls back to the next independent pair", async () => {
    const { call } = fake({
      [A]: { finalized: F },
      [B]: { finalized: F - 200, ageSec: 0 }, // ~90 s behind
      [C]: { finalized: F - 1 },
      [W]: { finalized: F },
    });
    const pin = await selectCommonPin(BSC_STATE_SOURCES, call, policy, now);
    expect(pin.operatorGroups).toEqual([
      "bnb-chain-bsc-dataseed",
      "onfinality",
    ]);
    expect(pin.number).toBe(F - 1);
    expect(pin.attempts.map((a) => a.outcome)).toEqual([
      "PIN_TOO_OLD",
      "PINNED",
    ]);
  });

  it("hash disagreement at a finalized height fails closed at once, without trying another pair", async () => {
    const { call, calls } = fake({
      [A]: { finalized: F },
      [B]: { finalized: F, forkFrom: F - 5 },
      [C]: { finalized: F },
      [W]: { finalized: F },
    });
    const err = await selectCommonPin(
      BSC_STATE_SOURCES,
      call,
      policy,
      now,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinError);
    expect(err.code).toBe("RPC_FINALIZED_HASH_DISAGREEMENT");
    expect(err.diagnostics.attempts).toHaveLength(1);
    expect(err.diagnostics.attempts[0].outcome).toBe("HASH_DISAGREEMENT");
    // C was measured but never paired after the disagreement
    expect(
      calls.filter(
        (c) =>
          c.url === C &&
          c.params[0] !== "finalized" &&
          c.method === "eth_getBlockByNumber",
      ),
    ).toHaveLength(0);
  });

  it("logs witness disagreeing with the pair also fails closed", async () => {
    const { call } = fake({
      [A]: { finalized: F },
      [B]: { finalized: F },
      [C]: { finalized: F },
      [W]: { finalized: F, forkFrom: F - 1 },
    });
    await expect(
      selectCommonPin(BSC_STATE_SOURCES, call, policy, now),
    ).rejects.toMatchObject({
      code: "RPC_FINALIZED_HASH_DISAGREEMENT",
    });
  });

  it("wrong chainId: the source is excluded (never a vote) and the next independent pair pins", async () => {
    const { call } = fake({
      [A]: { finalized: F, chainId: 97 },
      [B]: { finalized: F },
      [C]: { finalized: F + 1 },
      [W]: { finalized: F + 1 },
    });
    const pin = await selectCommonPin(BSC_STATE_SOURCES, call, policy, now);
    expect(pin.operatorGroups).toEqual(["allnodes-publicnode", "onfinality"]);
    expect(pin.health.find((h) => h.url === A)).toMatchObject({
      ok: false,
      failure: "WRONG_CHAIN_ID",
      chainId: 97,
    });
  });

  it.each([
    ["timeout", "TIMEOUT"],
    ["429", "RATE_LIMITED"],
    ["transport", "UNAVAILABLE"],
    ["html", "UNAVAILABLE"],
  ] as const)(
    "%s on one primary source: classified and replaced by the independent fallback",
    async (fail, cls) => {
      const { call } = fake({
        [A]: { finalized: F },
        [B]: { finalized: F, fail },
        [C]: { finalized: F },
        [W]: { finalized: F },
      });
      const pin = await selectCommonPin(BSC_STATE_SOURCES, call, policy, now);
      expect(pin.operatorGroups).toEqual([
        "bnb-chain-bsc-dataseed",
        "onfinality",
      ]);
      expect(pin.health.find((h) => h.url === B)?.failure).toBe(cls);
    },
  );

  it("recovered endpoint: a source that failed the first selection is used again by the next fresh selection", async () => {
    const nodes = {
      [A]: { finalized: F },
      [B]: { finalized: F, failFirst: 3 },
      [C]: { finalized: F },
      [W]: { finalized: F },
    };
    const { call } = fake(nodes);
    const first = await selectCommonPin(BSC_STATE_SOURCES, call, policy, now);
    expect(first.operatorGroups[1]).toBe("onfinality");
    const second = await selectCommonPin(BSC_STATE_SOURCES, call, policy, now);
    expect(second.operatorGroups).toEqual([
      "bnb-chain-bsc-dataseed",
      "allnodes-publicnode",
    ]);
  });

  it("no independent pair: RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE (never a single-source pass)", async () => {
    const { call } = fake({
      [A]: { finalized: F },
      [B]: { finalized: F, fail: "timeout" },
      [C]: { finalized: F, fail: "429" },
      [W]: { finalized: F },
    });
    const err = await selectCommonPin(
      BSC_STATE_SOURCES,
      call,
      policy,
      now,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinError);
    expect(err.code).toBe("RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE");
    expect(err.diagnostics.attempts).toHaveLength(0);
    expect(err.message).toMatch(
      /RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE \(bsc\)/,
    );
  });

  it("two sources of the same operator group are never independent", async () => {
    const same: PinSource[] = [
      { url: A, operatorGroup: "bnb-chain-bsc-dataseed" },
      { url: B, operatorGroup: "bnb-chain-bsc-dataseed" },
    ];
    const { call } = fake({
      [A]: { finalized: F },
      [B]: { finalized: F },
      [W]: { finalized: F },
    });
    await expect(
      selectCommonPin(same, call, policy, now),
    ).rejects.toMatchObject({
      code: "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE",
    });
  });

  it("never pins below the floor (the phase-A pin) and never beyond a source's own finalized head", async () => {
    const { call, calls } = fake({
      [A]: { finalized: F },
      [B]: { finalized: F - 3 },
      [C]: { finalized: F - 2 },
      [W]: { finalized: F },
    });
    await expect(
      selectCommonPin(
        BSC_STATE_SOURCES,
        call,
        { ...policy, floor: F - 1 },
        now,
      ),
    ).rejects.toMatchObject({ code: "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE" });
    const pin = await selectCommonPin(
      BSC_STATE_SOURCES,
      call,
      { ...policy, floor: F - 3 },
      now,
    );
    expect(pin.number).toBe(F - 3);
    const headerReads = calls
      .filter(
        (c) =>
          c.method === "eth_getBlockByNumber" && c.params[0] !== "finalized",
      )
      .map((c) => Number(BigInt(c.params[0] as string)));
    expect(Math.max(...headerReads)).toBeLessThanOrEqual(F - 2);
  });

  it("witness down blocks every pair (the logs source is required), reported as WITNESS_UNAVAILABLE", async () => {
    const { call } = fake({
      [A]: { finalized: F },
      [B]: { finalized: F },
      [C]: { finalized: F },
      [W]: { finalized: F, fail: "timeout" },
    });
    const err = await selectCommonPin(
      BSC_STATE_SOURCES,
      call,
      policy,
      now,
    ).catch((e) => e);
    expect(err.code).toBe("RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE");
    expect(
      err.diagnostics.attempts.every(
        (a: { outcome: string }) => a.outcome === "WITNESS_UNAVAILABLE",
      ),
    ).toBe(true);
  });

  it("only read-only allowlisted methods, finalized tag or explicit block numbers (never latest/pending)", async () => {
    const { call, calls } = fake({
      [A]: { finalized: F + 4 },
      [B]: { finalized: F },
      [C]: { finalized: F },
      [W]: { finalized: F + 4 },
    });
    await selectCommonPin(BSC_STATE_SOURCES, call, policy, now);
    expect(new Set(calls.map((c) => c.method))).toEqual(
      new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber"]),
    );
    for (const c of calls.filter((c) => c.method === "eth_getBlockByNumber"))
      expect(c.params[0]).toMatch(/^(finalized|0x[0-9a-f]+)$/);
    expect(JSON.stringify(calls)).not.toMatch(/latest|pending|safe/);
  });

  it("classifies failure text conservatively", () => {
    expect(
      classifyPinFailure(new G7RpcError("TRANSPORT", "AbortError eth_call")),
    ).toBe("TIMEOUT");
    expect(
      classifyPinFailure(
        new G7RpcError("RPC_ERROR", '{"message":"rate limit exceeded"}'),
      ),
    ).toBe("RATE_LIMITED");
    expect(
      classifyPinFailure(new G7RpcError("RPC_ERROR", "block not found: 0x1")),
    ).toBe("BLOCK_NOT_SERVED");
    expect(classifyPinFailure(new Error("socket hang up"))).toBe("UNAVAILABLE");
    // 2026-10-06 dry acceptance: the public logs key's quota answer (HTTP 429, JSON-RPC -32005)
    expect(
      classifyPinFailure(
        new G7RpcError(
          "RPC_ERROR",
          'eth_chainId: {"code":-32005,"message":"You have reached the maximum API usage limit of public."}',
        ),
      ),
    ).toBe("RATE_LIMITED");
  });
});
