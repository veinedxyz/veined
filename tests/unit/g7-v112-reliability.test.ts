import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadOnlyRpc, retryAfterMs, rpcHealth } from "../../src/g7/rpc";
import {
  BSC_STATE_SOURCES,
  BSC_LOGS_WITNESS,
  BSC_PIN_POLICY,
} from "../../src/g7/policy";
import {
  selectCommonPin,
  type PinCall,
  type PinSource,
} from "../../src/g7/common-pin";
import { validateLogs } from "../../src/g7/witness-logs";
import {
  FileG7Cache,
  cacheDigest,
  type G7Checkpoint,
} from "../../src/data/store/g7-cache";
import { fixtureTracker } from "../../scripts/g7-pilot/fixture";
import { fixturePreflight } from "../fixtures/g7-candidate";
import { PilotSession } from "../../scripts/g7-pilot/session";
const [A, B, C] = BSC_STATE_SOURCES;
const W = BSC_LOGS_WITNESS;
const F = 126000000;
const NOW = 1800000000000;
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "a");
const policy = { ...BSC_PIN_POLICY, witnessCandidates: [C, W] };
function fake(
  fail: Record<string, string> = {},
  lag: Record<string, number> = {},
  fork?: string,
): PinCall {
  return async <T>(
    url: string,
    method: string,
    params: unknown[],
  ): Promise<T> => {
    if (fail[url]) throw new Error(fail[url]);
    if (method === "eth_chainId")
      return (fork === "chain:" + url ? "0x1" : "0x38") as T;
    if (method === "eth_blockNumber") return `0x${(F + 4).toString(16)}` as T;
    const n =
      params[0] === "finalized"
        ? F - (lag[url] ?? 0)
        : Number(BigInt(String(params[0])));
    if (fork === "missing:" + url && n > F - 3 && params[0] !== "finalized")
      return null as T;
    return {
      number: `0x${n.toString(16)}`,
      hash: fork === url ? "0x" + "b".repeat(64) : hash(n),
      timestamp: `0x${(NOW / 1000 - 2 - (F - n)).toString(16)}`,
    } as T;
  };
}
describe("V1.12 independent witness rotation and chaos", () => {
  for (const [title, down] of [
    ["OnFinality 429", C],
    ["NodeReal 429", W],
    ["witness timeout", C],
  ] as const)
    it(title, async () => {
      const p = await selectCommonPin(
        [A, B],
        fake({
          [down.url]: title.includes("429")
            ? "429 rate limited"
            : "TimeoutError",
        }),
        policy,
        () => NOW,
      );
      expect(p.witnesses).toHaveLength(1);
      expect(p.witnesses[0].url).not.toBe(down.url);
      expect(
        new Set([...p.operatorGroups, p.witnesses[0].operatorGroup]).size,
      ).toBe(3);
    });
  for (const s of [A, B])
    it(`${s.operatorGroup} two blocks behind`, async () => {
      const p = await selectCommonPin(
        [A, B],
        fake({}, { [s.url]: 2 }),
        policy,
        () => NOW,
      );
      expect(p.number).toBe(F - 2);
    });
  it("state source timeout rotates the pair while retaining a third operator", async () => {
    const p = await selectCommonPin(
      [A, B, C],
      fake({ [A.url]: "TimeoutError" }),
      { ...policy, witnessCandidates: [W] },
      () => NOW,
    );
    expect(p.operatorGroups).toEqual([B.operatorGroup, C.operatorGroup]);
  });
  it("two witness providers unavailable blocks", async () => {
    await expect(
      selectCommonPin(
        [A, B],
        fake({ [C.url]: "429", [W.url]: "TimeoutError" }),
        policy,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE" });
  });
  it("wrong witness chain is excluded", async () => {
    const p = await selectCommonPin(
      [A, B],
      fake({}, {}, "chain:" + C.url),
      policy,
      () => NOW,
    );
    expect(p.witnesses[0].url).toBe(W.url);
  });
  it("exact hash mismatch fails closed without rotating to a convenient witness", async () => {
    await expect(
      selectCommonPin([A, B], fake({}, {}, C.url), policy, () => NOW),
    ).rejects.toMatchObject({ code: "RPC_FINALIZED_HASH_DISAGREEMENT" });
  });
  it("operator alias never supplies the third vote", async () => {
    const alias: PinSource = { ...C, operatorGroup: A.operatorGroup };
    await expect(
      selectCommonPin(
        [A, B],
        fake(),
        { ...policy, witnessCandidates: [alias] },
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE" });
  });
  it("common finalized step-down remains bounded and exact", async () => {
    const p = await selectCommonPin(
      [A, B],
      fake({}, {}, "missing:" + B.url),
      policy,
      () => NOW,
    );
    expect(p.number).toBe(F - 3);
    expect(p.hash).toBe(hash(F - 3));
  });
  it("a recovered witness can participate on the next fresh check", async () => {
    const before = await selectCommonPin(
      [A, B],
      fake({ [C.url]: "429" }),
      policy,
      () => NOW,
    );
    const after = await selectCommonPin([A, B], fake(), policy, () => NOW);
    expect(before.witnesses[0].url).toBe(W.url);
    expect(after.witnesses[0].url).toBe(C.url);
  });
});
describe("V1.12 cooldown and bounded read retries", () => {
  it("request budget refuses excess traffic before network I/O", async () => {
    let calls = 0;
    const rpc = new ReadOnlyRpc({
      requestBudget: 1,
      now: () => NOW + 1000000,
      fetchImpl: async () => {
        calls++;
        return new Response('{"result":"0x956d7"}');
      },
    });
    const url = "https://mainnet.onechain.nexus:22001";
    await rpc.call(url, "eth_chainId", []);
    await expect(rpc.call(url, "eth_chainId", [])).rejects.toMatchObject({
      code: "REQUEST_BUDGET_EXHAUSTED",
    });
    expect(calls).toBe(1);
  });
  it.each([
    ["2", 2000],
    ["1.5", 1500],
    [null, null],
    ["nonsense", null],
  ])("Retry-After %s", (v, expected) =>
    expect(retryAfterMs(v, NOW)).toBe(expected),
  );
  it("HTTP-date Retry-After is honored", () =>
    expect(retryAfterMs(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000));
  it("HTTP 429 causes no immediate retry and recovers after cooldown", async () => {
    let now = NOW,
      calls = 0;
    const rpc = new ReadOnlyRpc({
      now: () => now,
      random: () => 0,
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? new Response(
              '{"error":{"code":-32005,"message":"quota exceeded"}}',
              { status: 429, headers: { "retry-after": "5" } },
            )
          : new Response('{"result":"0x38"}');
      },
    });
    await expect(rpc.retry(C.url, "eth_chainId", [])).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(calls).toBe(1);
    await expect(rpc.call(C.url, "eth_chainId", [])).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(calls).toBe(1);
    now += 5001;
    expect(await rpc.call(C.url, "eth_chainId", [])).toBe("0x38");
    expect(calls).toBe(2);
    expect(rpcHealth(C.url).cooldownUntil).toBe(0);
  });
  it("JSON-RPC rate limits at the final financial check cannot pass", async () => {
    const rpc = new ReadOnlyRpc({
      now: () => NOW + 20000,
      random: () => 0,
      fetchImpl: async () =>
        new Response(
          '{"error":{"code":-32005,"message":"maximum API usage limit"}}',
        ),
    });
    await expect(
      rpc.call(W.url, "eth_getBlockByNumber", ["finalized", false]),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
  it("contract reverts never retry", async () => {
    let calls = 0;
    const rpc = new ReadOnlyRpc({
      fetchImpl: async () => {
        calls++;
        return new Response(
          '{"error":{"code":3,"message":"execution reverted"}}',
        );
      },
    });
    await expect(rpc.retry(A.url, "eth_chainId", [])).rejects.toMatchObject({
      code: "RPC_ERROR",
    });
    expect(calls).toBe(1);
  });
  it("non-200 HTTP result is never accepted", async () => {
    const rpc = new ReadOnlyRpc({
      fetchImpl: async () => new Response('{"result":"0x38"}', { status: 503 }),
    });
    await expect(rpc.call(A.url, "eth_chainId", [])).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });
});
const addr = "0x" + "a".repeat(40);
const log = {
  address: addr,
  topics: [hash(1)],
  data: "0x",
  blockNumber: "0x5",
  blockHash: hash(5),
  transactionHash: hash(2),
  logIndex: "0x0",
};
describe("V1.12 untrusted log validation", () => {
  it("well-formed exact contract/range is accepted", () =>
    expect(validateLogs([log], { address: addr }, 5, 5)).toEqual([log]));
  it.each([
    null,
    {},
    [null],
    [{ ...log, blockHash: "bad" }],
    [{ ...log, removed: true }],
    [{ ...log, blockNumber: "0x6" }],
    [{ ...log, address: "0x" + "b".repeat(40) }],
    [{ ...log, topics: ["bad"] }],
    [{ ...log, data: "0xa" }],
  ])("malformed response %j fails closed", (raw) =>
    expect(() => validateLogs(raw, { address: addr }, 5, 5)).toThrow(),
  );
  it("topic mismatch fails closed", () =>
    expect(() =>
      validateLogs([log], { address: addr, topics: [hash(99)] }, 5, 5),
    ).toThrow());
  it("duplicate log identity fails closed", () =>
    expect(() => validateLogs([log, log], { address: addr }, 5, 5)).toThrow());
});
describe("V1.12 checkpoint integrity and session single-flight", () => {
  const make = (): G7Checkpoint => {
    const logs = {
      bscProxyLogs: [],
      crossIn: [],
      crossOut: [],
      bscVerifierLogs: [],
      oneProxyLogs: [],
      oneVerifierLogs: [],
    };
    return {
      schema: "otherbridge.g7.checkpoint.v1",
      routeDigest: "x",
      acceptedThroughBlock: 5,
      acceptedThroughBlockHash: hash(5),
      oneThroughBlock: 7,
      oneThroughBlockHash: hash(7),
      deposited: "5",
      pendingAmount: "0",
      reserveBalance: "5",
      openPending: [],
      nextIndexes: { finalize: "2", initiate: "3" },
      eventDigest: cacheDigest(logs),
      sourceEvidence: {
        stateOperators: ["a", "b"],
        witnessOperator: "c",
        observedAt: NOW,
      },
      logs,
    };
  };
  it("atomic checkpoint roundtrip and monotonic advancement", () => {
    const p = join(mkdtempSync(join(tmpdir(), "g7-v112-cache-")), "cache.json");
    const store = new FileG7Cache(p),
      cp = make();
    store.save(cp);
    expect(store.load()).toEqual(cp);
    store.save({ ...cp, acceptedThroughBlock: 4 });
    expect(store.load()?.acceptedThroughBlock).toBe(5);
  });
  it("corrupted checkpoint is a cache miss, never trusted financial state", () => {
    const p = join(mkdtempSync(join(tmpdir(), "g7-v112-cache-")), "cache.json");
    const store = new FileG7Cache(p);
    store.save(make());
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace('"deposited":"5"', '"deposited":"6"'),
    );
    expect(store.load()).toBeNull();
  });
  it("cache evidence with a state/witness operator alias is refused", () => {
    const p = join(mkdtempSync(join(tmpdir(), "g7-v112-cache-")), "cache.json");
    const store = new FileG7Cache(p),
      cp = make();
    cp.sourceEvidence.witnessOperator = "a";
    store.save(cp);
    expect(store.load()).toBeNull();
  });
  it("same-session simultaneous retries await one fresh check", async () => {
    const fixture = fixturePreflight("ready");
    let calls = 0;
    let release = () => {};
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const session = new PilotSession({
      mode: "dry-run",
      fixture: true,
      preflight: {
        baseline: fixture.baseline,
        run: async (kind) => {
          calls++;
          if (kind === "refresh") await pending;
          return fixture.run(kind);
        },
      },
      tracker: fixtureTracker("ready"),
      lock: null,
      journal: () => {},
    });
    await session.start();
    const a = session.refresh(),
      b = session.refresh();
    expect(calls).toBe(2);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(calls).toBe(2);
    session.stop();
  });
});
