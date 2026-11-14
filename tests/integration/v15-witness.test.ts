import { describe, it, expect } from "vitest";
import { indexOnce } from "../../src/data/indexer/worker";
import { reverifyOnce } from "../../src/data/indexer/backfill";
import { RpcError } from "../../src/data/rpc/transport";
import { TRUSTED_CONSENSUS } from "../../src/data/indexer/witness";
import {
  CHAIN_ID,
  forkOf,
  makeChain,
  tokenA,
  wallet,
  witnessHarness,
} from "../fixtures/witness-harness";
// V1.5 independent log-set witness consensus against SYNTHETIC multi-operator RPC fixtures.
const three = [
  { host: "rpc-a.synthetic.test", operator: "op-a" },
  { host: "rpc-b.synthetic.test", operator: "op-b" },
  { host: "rpc-c.synthetic.test", operator: "op-c" },
];
const run = (
  h: Awaited<ReturnType<typeof witnessHarness>>,
  extra: Parameters<typeof indexOnce>[4] = {},
) =>
  indexOnce(h.store, h.pool, h.record, "witness-owner-1", {
    initialRange: 25,
    confirmations: 3,
    maxWindows: 20,
    ...extra,
  });
// First window is [78, 102]; block 84 carries two logs (wallet in/out).
const dropAt =
  (block: bigint, index = 0) =>
  (logs: Record<string, unknown>[]) =>
    logs.filter(
      (l) =>
        !(
          BigInt(String(l.blockNumber)) === block &&
          BigInt(String(l.logIndex)) === BigInt(index)
        ),
    );
async function consistent(h: Awaited<ReturnType<typeof witnessHarness>>) {
  const v = await h.store.verifyIndex(CHAIN_ID);
  expect(v).toMatchObject({
    missingRanges: [],
    duplicateLogKeys: 0,
    orphanRecords: 0,
    checkpointMismatch: false,
    blockHashInconsistencies: 0,
    disputedCommittedWindows: 0,
  });
  return v;
}
describe("V15 log witness consensus (indexer)", () => {
  it("1 identical log sets → MATCH, every committed window trusted", async () => {
    const h = await witnessHarness({ hosts: three });
    const r = await run(h);
    expect(r.status).toBe("CURRENT");
    expect(r.witness.trusted).toBe(r.windows);
    expect(r.witness.development).toBe(0);
    const v = await consistent(h);
    expect(v.witness?.trustedWindows).toBe(v.windows);
    const recs = await h.store.listWitnessRecords(CHAIN_ID, 100);
    expect(recs.every((x) => x.consensus === "MATCH" && x.committed)).toBe(
      true,
    );
    expect(recs[0].primaryOperator).not.toBe(recs[0].witnessOperator);
    expect(recs[0].primaryDigest).toBe(recs[0].witnessDigest);
  });
  it("2 same count but one different log → tiebreak matches primary; witness quarantined", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-b.synthetic.test", {
      logs: (logs) =>
        logs.map((l) =>
          BigInt(String(l.blockNumber)) === 80n
            ? { ...l, data: `0x${"0".repeat(63)}9` }
            : l,
        ),
    });
    const r = await run(h, { maxWindows: 1 });
    expect(r.witness.tiebreaks).toBe(1);
    const [rec] = await h.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec).toMatchObject({
      consensus: "TIEBREAK_MATCH_PRIMARY",
      failure: "LOG_SET_MISMATCH",
      committed: true,
      primaryLogCount: rec.witnessLogCount,
    });
    expect(rec.primaryDigest).not.toBe(rec.witnessDigest);
    expect(rec.tiebreakDigest).toBe(rec.primaryDigest);
    expect(h.pool.ranked().map((e) => e.id)).not.toContain(
      `${CHAIN_ID}:rpc-b.synthetic.test`,
    );
    await consistent(h);
  });
  it("3 primary omits one event → tiebreak matches witness; the omitted event is committed", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-a.synthetic.test", { logs: dropAt(84n, 0) });
    const r = await run(h, { maxWindows: 1 });
    expect(r.windows).toBe(1);
    const [rec] = await h.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec.consensus).toBe("TIEBREAK_MATCH_WITNESS");
    expect(rec.primaryLogCount).toBe(rec.witnessLogCount! - 1);
    const rows = await h.store.windowRows(CHAIN_ID, 84n, 84n);
    expect(rows.map((x) => x.logIndex)).toEqual([0, 1]);
    expect(
      (await h.store.discoveredTokens(CHAIN_ID, wallet)).map((d) => d.token),
    ).toContain(tokenA);
    expect(h.pool.ranked().map((e) => e.id)).not.toContain(
      `${CHAIN_ID}:rpc-a.synthetic.test`,
    );
    await consistent(h);
  });
  it("4 witness omits one event → tiebreak matches primary", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-b.synthetic.test", { logs: dropAt(84n, 1) });
    await run(h, { maxWindows: 1 });
    const [rec] = await h.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec.consensus).toBe("TIEBREAK_MATCH_PRIMARY");
    expect((await h.store.windowRows(CHAIN_ID, 84n, 84n)).length).toBe(2);
  });
  it("5 different order only → MATCH", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-b.synthetic.test", {
      logs: (logs) => [...logs].reverse(),
    });
    const r = await run(h);
    expect(r.witness.trusted).toBe(r.windows);
    expect(
      (await h.store.listWitnessRecords(CHAIN_ID, 100)).every(
        (x) => x.consensus === "MATCH",
      ),
    ).toBe(true);
  });
  it("6 duplicate log: primary duplicate aborts without commit; witness duplicate falls to next operator", async () => {
    const h = await witnessHarness({ hosts: three });
    const dup = (logs: Record<string, unknown>[]) => [...logs, logs[0]];
    h.hooks.set("rpc-a.synthetic.test", { logs: dup });
    const r = await run(h, { maxWindows: 1 });
    expect(r.status).toBe("ERROR");
    expect(r.error).toMatch(/DUPLICATE_LOG/);
    expect((await h.store.verifyIndex(CHAIN_ID)).transfers).toBe(0);
    const g = await witnessHarness({ hosts: three });
    g.hooks.set("rpc-b.synthetic.test", { logs: dup });
    const r2 = await run(g, { maxWindows: 1 });
    expect(r2.windows).toBe(1);
    const [rec] = await g.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec).toMatchObject({
      consensus: "MATCH",
      witnessEndpointId: `${CHAIN_ID}:rpc-c.synthetic.test`,
    });
  });
  it("7 witness on a different block hash (fork) → BLOCK_HASH_MISMATCH, nothing committed", async () => {
    const main = makeChain();
    const h = await witnessHarness({ hosts: three, chain: main });
    h.hooks.set("rpc-b.synthetic.test", { chain: forkOf(main, 90n) });
    const r = await run(h, { maxWindows: 1 });
    expect(r.status).toBe("ERROR");
    expect(r.error).toMatch(/LOG_WITNESS_BLOCK_HASH_MISMATCH/);
    expect(r.windows).toBe(0);
    const [rec] = await h.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec).toMatchObject({
      consensus: "MISMATCH",
      failure: "BLOCK_HASH_MISMATCH",
      committed: false,
    });
    expect((await h.store.verifyIndex(CHAIN_ID)).windows).toBe(0);
  });
  it("8 witness timeout: next independent operator witnesses; all witnesses down → never zero logs", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-b.synthetic.test", { timeout: true });
    await run(h, { maxWindows: 1 });
    const [rec] = await h.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec).toMatchObject({
      consensus: "MATCH",
      witnessEndpointId: `${CHAIN_ID}:rpc-c.synthetic.test`,
    });
    const g = await witnessHarness({ hosts: three });
    g.hooks.set("rpc-b.synthetic.test", { timeout: true });
    g.hooks.set("rpc-c.synthetic.test", { timeout: true });
    const strict = await run(g, { witness: "required", maxWindows: 1 });
    expect(strict.status).toBe("WITNESS_UNAVAILABLE");
    expect(strict.windows).toBe(0);
    const [w] = await g.store.listWitnessRecords(CHAIN_ID, 1);
    expect(w).toMatchObject({
      consensus: "NO_INDEPENDENT_WITNESS",
      failure: "WITNESS_FAILED",
      committed: false,
    });
    const dev = await run(g, { maxWindows: 1 });
    expect(dev.windows).toBe(1);
    expect(dev.witness.development).toBe(1);
    const v = await g.store.verifyIndex(CHAIN_ID);
    expect(v.witness).toMatchObject({
      trustedWindows: 0,
      developmentWindows: 1,
    });
  });
  it("9 empty witness answer is a disagreement, not zero logs", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-b.synthetic.test", { logs: () => [] });
    await run(h, { maxWindows: 1 });
    const [rec] = await h.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec.witnessLogCount).toBe(0);
    expect(rec.consensus).toBe("TIEBREAK_MATCH_PRIMARY");
  });
  it("10 three-way disagreement → UNRESOLVED: no commit, chain halted until operator resume", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-b.synthetic.test", { logs: dropAt(84n, 0) });
    h.hooks.set("rpc-c.synthetic.test", { logs: dropAt(84n, 1) });
    const r = await run(h);
    expect(r.status).toBe("HALTED");
    expect(r.windows).toBe(0);
    expect(r.disputes[0].diff?.totals.onlyInFirst).toBe(1);
    const cp = (await h.store.getCheckpoint(CHAIN_ID))!;
    expect(cp.haltedReason).toMatch(/^LOG_CONSENSUS_UNRESOLVED:78-102$/);
    expect((await h.store.verifyIndex(CHAIN_ID)).transfers).toBe(0);
    h.hooks.clear();
    expect((await run(h)).status).toBe("HALTED");
    expect(await h.store.resumeChain(CHAIN_ID)).toBe(true);
    const resumed = await run(h);
    expect(resumed.status).toBe("CURRENT");
    expect(resumed.witness.trusted).toBe(resumed.windows);
    await consistent(h);
  });
  it("10b two operators that disagree with no independent tiebreak → UNRESOLVED", async () => {
    const h = await witnessHarness({ hosts: three.slice(0, 2) });
    h.hooks.set("rpc-b.synthetic.test", { logs: dropAt(84n, 0) });
    const r = await run(h);
    expect(r.status).toBe("HALTED");
    expect((await h.store.listWitnessRecords(CHAIN_ID, 1))[0].consensus).toBe(
      "UNRESOLVED",
    );
  });
  it("11 single endpoint: development commit only; required policy commits nothing", async () => {
    const h = await witnessHarness({ hosts: three.slice(0, 1) });
    const strict = await run(h, { witness: "required" });
    expect(strict.status).toBe("WITNESS_UNAVAILABLE");
    expect(strict.windows).toBe(0);
    const dev = await run(h);
    expect(dev.status).toBe("CURRENT");
    expect(dev.witness.development).toBe(dev.windows);
    const v = await consistent(h);
    expect(v.witness?.trustedWindows).toBe(0);
  });
  it("11b same-operator aliases and unknown operators are never independent", async () => {
    const alias = await witnessHarness({
      hosts: [
        { host: "rpc-a.synthetic.test", operator: "op-a" },
        { host: "rpc-a2.synthetic.test", operator: "op-a" },
        { host: "rpc-x.synthetic.test", operator: null },
      ],
    });
    const r = await run(alias, { witness: "required" });
    expect(r.status).toBe("WITNESS_UNAVAILABLE");
    expect(r.windows).toBe(0);
  });
  // Self-review D1: a routing provider (operator not attributable) is never the compared side.
  it("11c a routing-provider primary cannot form consensus; eligible operators are preferred as primary", async () => {
    const router = {
      host: "rpc-r.synthetic.test",
      operator: "router",
      eligible: false,
    };
    const two = await witnessHarness({ hosts: [router, three[1]!] });
    const strict = await run(two, { witness: "required" });
    expect(strict.status).toBe("WITNESS_UNAVAILABLE");
    expect(strict.windows).toBe(0);
    const h = await witnessHarness({ hosts: [router, three[1]!, three[2]!] });
    const r = await run(h, { witness: "required" });
    expect(r.status).toBe("CURRENT");
    expect(r.witness.trusted).toBe(r.windows);
    const recs = await h.store.listWitnessRecords(CHAIN_ID, 100);
    expect(recs.length).toBeGreaterThan(0);
    for (const x of recs) {
      expect(x.primaryOperator).not.toBe("router");
      expect(x.witnessOperator).not.toBe("router");
    }
    await consistent(h);
  });
  // Self-review D2 + residual: development-only windows are re-verified once independent operators
  // exist; a witness-won tiebreak stores the witness digest, so verify reports no disputed window.
  it("11d REVERIFY upgrades development windows; a witness-won tiebreak keeps verify clean", async () => {
    const dev = await witnessHarness({ hosts: three.slice(0, 1) });
    const first = await run(dev, { maxWindows: 3 });
    expect(first.witness.development).toBe(first.windows);
    const h = await witnessHarness({
      hosts: three,
      store: dev.store,
      chain: dev.main,
    });
    h.hooks.set("rpc-a.synthetic.test", { logs: dropAt(84n, 0) });
    const r = await reverifyOnce(h.store, h.pool, h.record, { maxWindows: 10 });
    expect(r.status).toBe("DONE");
    expect(r.verified).toBe(first.windows);
    const recs = (await h.store.listWitnessRecords(CHAIN_ID, 100)).filter(
      (x) => x.mode === "REVERIFY",
    );
    const won = recs.find((x) => x.consensus === "TIEBREAK_MATCH_WITNESS");
    expect(won).toBeDefined();
    const windows = await h.store.listWindows(CHAIN_ID, 100);
    const w = windows.find((x) => x.fromBlock === won!.fromBlock)!;
    expect(w.logDigest).toBe(won!.witnessDigest);
    expect(w.logDigest).not.toBe(won!.primaryDigest);
    const v = await consistent(h);
    expect(v.witness?.trustedWindows).toBe(v.windows);
  });
  it("12 reorg after prior MATCH: rewind, re-witness, no disputed window", async () => {
    const main = makeChain();
    const h = await witnessHarness({ hosts: three, chain: main });
    await run(h);
    main.reorg(190n, "fork2", () => [
      { token: tokenA, from: wallet, to: wallet, value: 7n },
    ]);
    const r = await run(h);
    expect(r.reorgs).toBe(1);
    const v = await consistent(h);
    expect(v.witness?.trustedWindows).toBe(v.windows);
    const cp = (await h.store.getCheckpoint(CHAIN_ID))!;
    expect(cp.throughBlockHash).toBe(
      main.blocks[Number(cp.indexedThroughBlock)].hash,
    );
  });
  it("13 witness on the wrong chain is quarantined; next operator witnesses", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-b.synthetic.test", { wrongChainId: true });
    await run(h, { maxWindows: 1 });
    const [rec] = await h.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec.witnessEndpointId).toBe(`${CHAIN_ID}:rpc-c.synthetic.test`);
    expect(rec.consensus).toBe("MATCH");
  });
  it("14 oversized witness responses bisect to the same set; unsplittable size fails over", async () => {
    const h = await witnessHarness({ hosts: three });
    h.hooks.set("rpc-b.synthetic.test", {
      getLogsError: (a, b) =>
        b - a > 4n ? new RpcError("RESPONSE_TOO_LARGE") : null,
    });
    await run(h, { maxWindows: 1 });
    const [rec] = await h.store.listWitnessRecords(CHAIN_ID, 1);
    expect(rec).toMatchObject({
      consensus: "MATCH",
      witnessEndpointId: `${CHAIN_ID}:rpc-b.synthetic.test`,
    });
    const g = await witnessHarness({ hosts: three });
    g.hooks.set("rpc-b.synthetic.test", {
      getLogsError: () => new RpcError("RESPONSE_TOO_LARGE"),
    });
    await run(g, { maxWindows: 1 });
    expect(
      (await g.store.listWitnessRecords(CHAIN_ID, 1))[0].witnessEndpointId,
    ).toBe(`${CHAIN_ID}:rpc-c.synthetic.test`);
  });
  it("15 witness with a smaller log range chunks and still reaches the identical set", async () => {
    const h = await witnessHarness({
      hosts: [
        { host: "rpc-a.synthetic.test", operator: "op-a", maxLogRange: 1000 },
        { host: "rpc-b.synthetic.test", operator: "op-b", maxLogRange: 3 },
      ],
    });
    h.hooks.set("rpc-b.synthetic.test", {
      getLogsError: (a, b) =>
        b - a + 1n > 3n ? new RpcError("RANGE_TOO_LARGE") : null,
    });
    const r = await run(h, { maxWindows: 2 });
    expect(r.witness.trusted).toBe(r.windows);
    expect(r.windows).toBe(2);
    expect(h.calls.get("rpc-b.synthetic.test")!).toBeGreaterThan(16);
  });
  it("trusted consensus values are exactly the three agreeing outcomes", () => {
    expect([...TRUSTED_CONSENSUS].sort()).toEqual([
      "MATCH",
      "TIEBREAK_MATCH_PRIMARY",
      "TIEBREAK_MATCH_WITNESS",
    ]);
  });
});
