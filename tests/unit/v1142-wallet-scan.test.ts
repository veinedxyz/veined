import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  planWaves,
  slotPriority,
  PRIORITY_REASONS,
  WAVE_LIMITS,
  FIRST_PAGE_WAVES,
} from "../../src/data/portfolio/priority";
import {
  runScheduled,
  encodeBoundContinuation,
  decodeBoundContinuation,
  planDigest,
  CONTINUATION_TTL_MS,
} from "../../src/data/portfolio/scheduler";
import {
  sharedChainScan,
  recordChainDuration,
  slowChains,
  ReadSlots,
  clearWalletCachesForTests,
  walletCacheStats,
  WALLET_CHAIN_TTL_MS,
  SLOW_CHAIN_STRIKES,
  SLOW_CHAIN_WINDOW_MS,
  type ChainScanValue,
} from "../../src/data/portfolio/chain-cache";
import {
  applyWalletLine,
  emptyProgress,
  hasCheckedResult,
  hasMeaningfulAsset,
  heldIds,
  parseWalletLine,
  progressiveResult,
  type ChainLine,
  type PlanLine,
} from "../../src/portfolio/stream";
import type { ChainCoverage, Holding } from "../../src/portfolio/model";
import { perf } from "../../src/components/perf";
// V1.14.2 wallet-scan scheduler, priority, continuation, cache and stream units (deterministic, no network).
const ids = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => String(from + i));
const ZERO = "0x0000000000000000000000000000000000000000";
const holding = (chainId: string, over: Partial<Holding> = {}): Holding => ({
  chainId,
  address: ZERO,
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  balance: "1000",
  native: true,
  spam: false,
  suspicious: false,
  usd: null,
  priceAt: null,
  observedAt: 1,
  logo: "/networks/neutral.svg",
  lastActivity: null,
  ...over,
});
const coverage = (
  chainId: string,
  over: Partial<ChainCoverage> = {},
): ChainCoverage => ({
  chainId,
  state: "NATIVE_ONLY",
  tier: "NATIVE_ONLY",
  native: "CHECKED",
  tokens: "NOT_CHECKED",
  historicalComplete: false,
  indexedFromBlock: null,
  indexedThroughBlock: null,
  headBlock: "10",
  observedBlock: "10",
  reason: "NONE",
  observedAt: 1,
  ...over,
});
const planLine = (
  chains: string[],
  over: Partial<PlanLine> = {},
): PlanLine => ({
  type: "plan",
  v: 1,
  continued: false,
  chains: chains.map((chainId) => ({
    chainId,
    wave: 2,
    reasons: ["GENERAL_PRIORITY"],
  })),
  coverage: [],
  firstPage: { chains: chains.length, deadlineMs: 5000, chainBudgetMs: 2000 },
  defiChains: [],
  ...over,
});
const chainLine = (
  chainId: string,
  holdings: Holding[],
  over: Partial<ChainCoverage> = {},
): ChainLine => ({
  type: "chain",
  chainId,
  wave: 2,
  holdings,
  coverage: coverage(chainId, over),
});
describe("V1.14.2 wave priority (order only, explainable)", () => {
  const canonical = ids(60);
  const routable = new Set(ids(30));
  const evidence = {
    current: ["5"],
    context: ["9"],
    recent: ["40", "12"],
    indexed: new Set(["33"]),
    knownToken: new Set(["50"]),
    highConfidence: new Set(["1", "2", "3", "12"]),
    routable,
    slow: new Set(["2", "45"]),
  };
  it("is a permutation of the canonical plan: no network added or removed", () => {
    const plan = planWaves(canonical, evidence);
    expect(plan.map((c) => c.chainId).sort()).toEqual([...canonical].sort());
    expect(new Set(plan.map((c) => c.chainId)).size).toBe(canonical.length);
    // Evidence for networks outside the plan never adds them.
    const extra = planWaves(ids(5), {
      current: ["999"],
      recent: ["998"],
      indexed: new Set(["997"]),
    });
    expect(extra.map((c) => c.chainId).sort()).toEqual(ids(5).sort());
  });
  it("assigns waves deterministically and explains each with its leading reason", () => {
    const a = planWaves(canonical, evidence);
    const b = planWaves([...canonical], {
      ...evidence,
      indexed: new Set(evidence.indexed),
    });
    expect(a).toEqual(b);
    const byId = new Map(a.map((c) => [c.chainId, c]));
    expect(byId.get("5")).toMatchObject({
      wave: 0,
      reasons: ["CURRENT_CHAIN", "GENERAL_PRIORITY"],
    });
    expect(byId.get("9")!.wave).toBe(0);
    expect(byId.get("9")!.reasons[0]).toBe("RECENT_USER_CONTEXT");
    expect(byId.get("40")).toMatchObject({ wave: 1 });
    expect(byId.get("40")!.reasons[0]).toBe("RECENT_NONZERO");
    expect(byId.get("12")!.reasons.slice(0, 2)).toEqual([
      "RECENT_NONZERO",
      "HIGH_CONFIDENCE_PORTFOLIO_CHAIN",
    ]);
    expect(byId.get("33")!.reasons[0]).toBe("INDEXED_ACTIVITY");
    expect(byId.get("50")!.reasons[0]).toBe("KNOWN_TOKEN");
    expect(byId.get("1")).toMatchObject({ wave: 2 });
    expect(byId.get("1")!.reasons[0]).toBe("HIGH_CONFIDENCE_PORTFOLIO_CHAIN");
    // A quarantined slow network is deferred to the background wave — still planned.
    expect(byId.get("2")).toMatchObject({ wave: 4 });
    expect(byId.get("2")!.reasons[0]).toBe("DEFERRED_TO_BACKGROUND_SLOW_CHAIN");
    expect(byId.get("45")!.wave).toBe(4);
    expect(byId.get("59")!.reasons).toContain("LONG_TAIL");
    for (const c of a)
      for (const r of c.reasons) expect(PRIORITY_REASONS).toContain(r);
  });
  it("orders wave by wave, recent networks in client order and slow networks last", () => {
    const plan = planWaves(canonical, evidence);
    const waves = plan.map((c) => c.wave);
    expect(waves).toEqual([...waves].sort((x, y) => x - y));
    expect(plan.slice(0, 2).map((c) => c.chainId)).toEqual(["5", "9"]);
    expect(plan.slice(2, 4).map((c) => c.chainId)).toEqual(["40", "12"]);
    const tail = plan.slice(-2).map((c) => c.chainId);
    expect(tail).toEqual(["2", "45"]);
  });
  it("bounds wave 0, wave 1 and the general-priority head", () => {
    const plan = planWaves(ids(200), {
      current: ids(5, 1),
      context: ids(5, 6),
      recent: ids(40, 20),
      routable: new Set(ids(150)),
    });
    const count = (w: number) => plan.filter((c) => c.wave === w).length;
    expect(count(0)).toBe(WAVE_LIMITS.current);
    expect(count(1)).toBe(WAVE_LIMITS.evidence);
    expect(count(2)).toBe(WAVE_LIMITS.generalHead);
    expect(plan).toHaveLength(200);
    expect(FIRST_PAGE_WAVES).toEqual([0, 1, 2]);
    expect([0, 1, 2, 3, 4].map((w) => slotPriority(w as 0))).toEqual([
      0, 0, 1, 2, 2,
    ]);
  });
});
describe("V1.14.2 scheduler (bounded, adaptive, no silent omission)", () => {
  it("every admitted id ends done, failed or pending; overflow stays pending", async () => {
    const r = await runScheduled(
      ids(12),
      async (id, signal) => {
        if (id === "3")
          throw Object.assign(Error("x"), { code: "RATE_LIMITED" });
        if (id === "4")
          await new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(signal.reason)),
          );
        return Number(id);
      },
      { concurrency: 4, deadlineMs: 2000, perTaskMs: 50, maxTasks: 10 },
    );
    expect(r.failed.get("3")).toBe("RATE_LIMITED");
    expect(r.failed.get("4")).toBe("TIMEOUT");
    expect(r.pending).toEqual(["11", "12"]);
    expect(r.done.size + r.failed.size + r.pending.length).toBe(12);
  });
  it("raises parallelism only after healthy settles, never above the hard maximum, and backs off on stress", async () => {
    let active = 0,
      peak = 0;
    const r = await runScheduled(
      ids(60),
      async (id) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 2));
        active--;
        if (id === "40") throw Object.assign(Error("t"), { code: "TIMEOUT" });
        return id;
      },
      {
        concurrency: 2,
        maxConcurrency: 6,
        deadlineMs: 5000,
        perTaskMs: 1000,
        maxTasks: 100,
      },
    );
    expect(peak).toBeLessThanOrEqual(6);
    expect(r.maxInFlight).toBeLessThanOrEqual(6);
    expect(r.adaptive!.increases).toBeGreaterThan(0);
    expect(r.adaptive!.backoffs).toBeGreaterThanOrEqual(1);
    expect(r.done.size + r.failed.size).toBe(60);
  });
  it("keeps per-group parallelism bounded and records the deferral", async () => {
    const running = new Map<string, number>();
    let groupPeak = 0;
    const group = (id: string) => (Number(id) <= 10 ? "public" : `chain:${id}`);
    await runScheduled(
      ids(14),
      async (id) => {
        const g = group(id);
        running.set(g, (running.get(g) ?? 0) + 1);
        if (g === "public") groupPeak = Math.max(groupPeak, running.get(g)!);
        await new Promise((res) => setTimeout(res, 3));
        running.set(g, running.get(g)! - 1);
        return id;
      },
      {
        concurrency: 8,
        maxConcurrency: 8,
        groupOf: group,
        perGroup: 2,
        deadlineMs: 5000,
        perTaskMs: 1000,
        maxTasks: 100,
      },
    ).then((r) => expect(r.adaptive!.groupWaits).toBeGreaterThan(0));
    expect(groupPeak).toBeLessThanOrEqual(2);
  });
  it("a deadline leaves unserved slot waiters pending, never failed", async () => {
    const slots = new ReadSlots(1);
    const hold = await slots.acquire(0);
    const r = await runScheduled(ids(3), async () => "x", {
      concurrency: 3,
      deadlineMs: 30,
      perTaskMs: 1000,
      maxTasks: 10,
      slots,
    });
    hold();
    expect(r.failed.size).toBe(0);
    expect(r.pending.sort()).toEqual(ids(3));
  });
});
describe("V1.14.2 bound continuation (wallet, generation, plan, round, expiry)", () => {
  const scope = "abcdef0123456789";
  const plan = planDigest("gen-1", ["1", "10", "56"]);
  const binding = { scope, generation: "0123456789abcdef", plan, round: 1 };
  it("round-trips and only narrows the server plan", () => {
    const cursor = encodeBoundContinuation(binding, ["10", "56", "777"])!;
    const out = decodeBoundContinuation(cursor, scope, plan, ["1", "10", "56"]);
    expect(out).toEqual({
      pending: ["10", "56"],
      generation: "0123456789abcdef",
      round: 1,
    });
    expect(encodeBoundContinuation(binding, [])).toBeNull();
  });
  it("rejects another wallet, a tampered tag or body, a changed plan/catalog and expiry", () => {
    const now = 1_000_000;
    const cursor = encodeBoundContinuation(binding, ["10"], now)!;
    expect(() =>
      decodeBoundContinuation(cursor, "ffffffffffffffff", plan, ["10"], now),
    ).toThrow("CONTINUATION_SCOPE_MISMATCH");
    const [body, tag] = cursor.split(".");
    const flipped = tag.slice(0, -1) + (tag.endsWith("A") ? "B" : "A");
    expect(() =>
      decodeBoundContinuation(`${body}.${flipped}`, scope, plan, ["10"], now),
    ).toThrow("INVALID_CONTINUATION");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        s: "ffffffffffffffff",
      }),
    ).toString("base64url");
    expect(() =>
      decodeBoundContinuation(
        `${forged}.${tag}`,
        "ffffffffffffffff",
        plan,
        ["10"],
        now,
      ),
    ).toThrow("INVALID_CONTINUATION");
    expect(() =>
      decodeBoundContinuation(
        cursor,
        scope,
        planDigest("gen-2", ["1", "10", "56"]),
        ["10"],
        now,
      ),
    ).toThrow("INVALID_CONTINUATION");
    expect(() =>
      decodeBoundContinuation(
        cursor,
        scope,
        plan,
        ["10"],
        now + CONTINUATION_TTL_MS + 1,
      ),
    ).toThrow("INVALID_CONTINUATION");
    expect(() =>
      decodeBoundContinuation("!!", scope, plan, ["10"], now),
    ).toThrow("INVALID_CONTINUATION");
    expect(() =>
      decodeBoundContinuation("a".repeat(40001), scope, plan, ["10"], now),
    ).toThrow("INVALID_CONTINUATION");
  });
  it("binds the planned network set order-independently", () => {
    expect(planDigest("g", ["56", "1"])).toBe(
      planDigest("g", ["1", "56", "1"]),
    );
    expect(planDigest("g", ["56", "1"])).not.toBe(planDigest("g", ["56"]));
  });
});
describe("V1.14.2 wallet-chain cache (identity-safe single-flight, failures never cached)", () => {
  beforeEach(() => clearWalletCachesForTests());
  const ok = (chainId: string): ChainScanValue => ({
    holdings: [holding(chainId)],
    coverage: coverage(chainId),
  });
  it("joins identical concurrent reads and serves a fresh hit within the TTL only", async () => {
    const owner = {};
    let runs = 0;
    const run = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 5));
      return ok("1");
    };
    const [a, b] = await Promise.all([
      sharedChainScan(owner, "w1|1", run, { timeoutMs: 1000 }),
      sharedChainScan(owner, "w1|1", run, { timeoutMs: 1000 }),
    ]);
    expect(runs).toBe(1);
    expect([a.cache, b.cache].sort()).toEqual(["JOINED", "READ"]);
    let clock = Date.now();
    const hit = await sharedChainScan(owner, "w1|1", run, {
      timeoutMs: 1000,
      now: () => clock,
    });
    expect(hit.cache).toBe("HIT");
    clock += WALLET_CHAIN_TTL_MS + 1;
    const expired = await sharedChainScan(owner, "w1|1", run, {
      timeoutMs: 1000,
      now: () => clock,
    });
    expect(expired.cache).toBe("READ");
    expect(runs).toBe(2);
    // An explicit refresh skips the cache.
    expect(
      (
        await sharedChainScan(owner, "w1|1", run, {
          timeoutMs: 1000,
          fresh: true,
        })
      ).cache,
    ).toBe("READ");
  });
  it("isolates wallets, chains and data planes", async () => {
    const owner = {},
      other = {};
    let runs = 0;
    const run = (id: string) => async () => (runs++, ok(id));
    await sharedChainScan(owner, "w1|1", run("1"), { timeoutMs: 1000 });
    await sharedChainScan(owner, "w2|1", run("1"), { timeoutMs: 1000 });
    await sharedChainScan(owner, "w1|10", run("10"), { timeoutMs: 1000 });
    await sharedChainScan(other, "w1|1", run("1"), { timeoutMs: 1000 });
    expect(runs).toBe(4);
  });
  it("never caches a failure, a timeout, a partial token read or a FAILED/PENDING coverage", async () => {
    const owner = {};
    let runs = 0;
    const failing = async () => {
      runs++;
      throw Object.assign(Error("rate"), { code: "RATE_LIMITED" });
    };
    await expect(
      sharedChainScan(owner, "k", failing, { timeoutMs: 100 }),
    ).rejects.toThrow();
    await expect(
      sharedChainScan(owner, "k", failing, { timeoutMs: 100 }),
    ).rejects.toThrow();
    expect(runs).toBe(2);
    for (const bad of [
      { state: "FAILED" as const },
      { state: "PENDING" as const },
      { reason: "TOKEN_READ_INCOMPLETE" as const },
      { tokens: "FAILED" as const },
    ]) {
      let n = 0;
      const run = async () => (
        n++,
        { holdings: [], coverage: coverage("1", bad) }
      );
      await sharedChainScan(owner, `bad-${JSON.stringify(bad)}`, run, {
        timeoutMs: 100,
      });
      await sharedChainScan(owner, `bad-${JSON.stringify(bad)}`, run, {
        timeoutMs: 100,
      });
      expect(n).toBe(2);
    }
    const slow = () =>
      new Promise<ChainScanValue>((r) => setTimeout(() => r(ok("1")), 200));
    await expect(
      sharedChainScan(
        owner,
        "slow",
        (s) =>
          new Promise((_, rej) => {
            s.addEventListener("abort", () => rej(s.reason));
            void slow();
          }),
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow();
    expect(walletCacheStats().skipped).toBeGreaterThanOrEqual(4);
  });
  it("a caller that leaves (account switch) never aborts the shared read for another caller", async () => {
    const owner = {};
    const leave = new AbortController();
    let release: (v: ChainScanValue) => void = () => {};
    const run = () => new Promise<ChainScanValue>((r) => (release = r));
    const first = sharedChainScan(owner, "k2", run, {
      timeoutMs: 1000,
      signal: leave.signal,
    });
    const second = sharedChainScan(owner, "k2", run, { timeoutMs: 1000 });
    leave.abort(Error("ACCOUNT_SWITCH"));
    await expect(first).rejects.toThrow("ACCOUNT_SWITCH");
    release(ok("1"));
    expect((await second).holdings).toHaveLength(1);
  });
  it("delivers the native fast path to every waiting caller exactly once", async () => {
    const owner = {};
    const seen: string[] = [];
    let go: () => void = () => {};
    const run = async (
      _s: AbortSignal,
      hooks: { onNative?: (h: Holding) => void },
    ) => {
      hooks.onNative?.(holding("1"));
      await new Promise<void>((r) => (go = r));
      return ok("1");
    };
    const a = sharedChainScan(owner, "k3", run, {
      timeoutMs: 1000,
      hooks: { onNative: () => seen.push("a") },
    });
    const b = sharedChainScan(owner, "k3", run, {
      timeoutMs: 1000,
      hooks: { onNative: () => seen.push("b") },
    });
    await new Promise((r) => setTimeout(r, 1));
    go();
    await Promise.all([a, b]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });
  it("slow-chain memory: repeated budget overruns defer, a fast read or the window clears", () => {
    const t = 1_000_000;
    recordChainDuration("25", 5000, 2000, t);
    expect(slowChains(t).has("25")).toBe(SLOW_CHAIN_STRIKES <= 1);
    recordChainDuration("25", Number.POSITIVE_INFINITY, 2000, t + 1);
    expect(slowChains(t + 2).has("25")).toBe(true);
    expect(slowChains(t + SLOW_CHAIN_WINDOW_MS + 5).has("25")).toBe(false);
    recordChainDuration("25", 300, 2000, t + 3);
    expect(slowChains(t + 4).has("25")).toBe(false);
  });
  it("read slots: hard maximum across scans, first-result class served first, aborted waiters leave", async () => {
    const slots = new ReadSlots(2);
    const r1 = await slots.acquire(2);
    const r2 = await slots.acquire(2);
    const order: string[] = [];
    const bg = slots.acquire(2).then((r) => (order.push("background"), r));
    const gone = new AbortController();
    const dropped = slots.acquire(0, gone.signal);
    const first = slots.acquire(0).then((r) => (order.push("first"), r));
    gone.abort(Error("GONE"));
    await expect(dropped).rejects.toThrow("GONE");
    expect(slots.inUse).toBe(2);
    expect(slots.waiting).toBe(2);
    r1();
    (await first)();
    r2();
    (await bg)();
    expect(order).toEqual(["first", "background"]);
    expect(slots.peakInUse).toBe(2);
    expect(slots.inUse).toBe(0);
  });
});
describe("V1.14.2 wallet stream (strict lines, provisional reconciliation)", () => {
  it("validates every line strictly", () => {
    expect(() => parseWalletLine({ type: "nope" })).toThrow();
    expect(() => parseWalletLine({ ...planLine(["1"]), extra: 1 })).toThrow();
    expect(() =>
      parseWalletLine({ type: "native", chainId: "1", holding: holding("10") }),
    ).toThrow();
    expect(() =>
      parseWalletLine({ ...chainLine("1", [holding("10")]) }),
    ).toThrow();
    expect(() =>
      parseWalletLine({ type: "error", error: "x<script>" }),
    ).toThrow();
    expect(parseWalletLine(chainLine("1", [holding("1")])).type).toBe("chain");
    expect(() =>
      parseWalletLine({
        ...planLine(["1"]),
        chains: [{ chainId: "1", wave: 2, reasons: ["MADE_UP"] }],
      }),
    ).toThrow();
  });
  it("replaces repeated and provisional lines: a balance is never counted twice", () => {
    let p = emptyProgress(1);
    p = applyWalletLine(p, planLine(["1", "10"]));
    p = applyWalletLine(p, {
      type: "native",
      chainId: "1",
      holding: holding("1"),
    });
    expect(hasMeaningfulAsset(p)).toBe(true);
    expect(hasCheckedResult(p)).toBe(false);
    p = applyWalletLine(p, chainLine("1", [holding("1")]));
    p = applyWalletLine(p, chainLine("1", [holding("1")]));
    // A late native line never replaces a settled network's exact result.
    p = applyWalletLine(p, {
      type: "native",
      chainId: "1",
      holding: holding("1", { balance: "5" }),
    });
    // A network outside the plan is ignored.
    p = applyWalletLine(p, chainLine("777", [holding("777")]));
    const view = progressiveResult(p)!;
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0].balance).toBe("1000");
    expect(view.coverage.find((c) => c.chainId === "10")!.state).toBe(
      "PENDING",
    );
    expect(view.coverageSummary.pending).toBe(1);
    expect(view.state).toBe("PARTIAL");
    expect(view.coverage.some((c) => c.chainId === "777")).toBe(false);
  });
  it("pending is never empty and a failed network is never zero", () => {
    let p = applyWalletLine(emptyProgress(1), planLine(["1", "56"]));
    p = applyWalletLine(
      p,
      chainLine("56", [], {
        state: "FAILED",
        native: "FAILED",
        tokens: "FAILED",
        reason: "RPC_UNAVAILABLE",
        headBlock: null,
        observedBlock: null,
      }),
    );
    const view = progressiveResult(p)!;
    expect(view.coverageSummary.failed).toBe(1);
    expect(view.coverageSummary.checked).toBe(0);
    expect(view.coverage.find((c) => c.chainId === "1")!.native).toBe(
      "PENDING",
    );
    expect(view.state).toBe("PARTIAL");
  });
  it("first page / DeFi lines are recorded once; held ids exclude native, spam and zero", () => {
    let p = applyWalletLine(emptyProgress(1), planLine(["1"]));
    p = applyWalletLine(p, {
      type: "firstPage",
      reason: "WAVES_SETTLED",
      elapsedMs: 10,
      included: ["1"],
      outstanding: [],
    });
    p = applyWalletLine(p, {
      type: "firstPage",
      reason: "DEADLINE",
      elapsedMs: 99,
      included: [],
      outstanding: ["1"],
    });
    expect(p.firstPage!.reason).toBe("WAVES_SETTLED");
    const token = (address: string, over: Partial<Holding> = {}) =>
      holding("1", { address, native: false, symbol: "T", ...over });
    expect(
      heldIds(
        [
          holding("1"),
          token("0x00000000000000000000000000000000000000aa"),
          token("0x00000000000000000000000000000000000000bb", { spam: true }),
          token("0x00000000000000000000000000000000000000cc", { balance: "0" }),
          holding("10", {
            native: false,
            address: "0x00000000000000000000000000000000000000dd",
          }),
        ],
        new Set(["1"]),
      ),
    ).toEqual(["1:0x00000000000000000000000000000000000000aa"]);
  });
});
describe("V1.14.2 perf receipts", () => {
  it("records the four wallet timings once per scan and clears them on a new scan", () => {
    const marks = new Map<string, number>();
    const measures = new Map<string, number>();
    vi.stubGlobal("performance", {
      mark: (n: string) => marks.set(n, (marks.get(n) ?? 0) + 1),
      measure: (n: string) => measures.set(n, (measures.get(n) ?? 0) + 1),
      clearMarks: (n: string) => marks.delete(n),
      clearMeasures: (n: string) => measures.delete(n),
      getEntriesByName: (n: string, type: string) =>
        (type === "mark" ? marks : measures).has(n) ? [{}] : [],
    });
    perf.scanStart();
    for (const m of [
      "walletShellReadyMs",
      "firstMeaningfulAssetMs",
      "firstPageCompleteMs",
      "fullWalletCoverageMs",
    ] as const) {
      perf.once(m);
      perf.once(m);
    }
    perf.flush();
    perf.flush();
    expect(measures.get("otherbridge:firstPageCompleteMs")).toBe(1);
    expect(measures.size).toBe(4);
    expect(marks.get("otherbridge:walletFlush")).toBe(2);
    perf.scanStart();
    expect(measures.size).toBe(0);
    expect(marks.has("otherbridge:walletFlush")).toBe(false);
    vi.unstubAllGlobals();
  });
});
