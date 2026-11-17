// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the lane journal binding (src/swap/lane/runtime.ts openLaneStore) on the
// REAL durable store (src/execution/server/canary/durable-store.ts) in a temporary directory of this run (under
// D:/vnd/hk1/fl1/temp when tools/env.sh is sourced; never the lane's own .veined-swap-lane-store). The store writes its
// own OPEN line; the lane binds the journal to ONE record with a LANE_BIND entry; a journal of another record, or one
// that cannot be written, is refused AND closed (the writer lock is released).
// SYNTHETIC_TEST_ONLY: the records are synthetic. Nothing here reads a chain, signs or reaches a network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanaryDurableStore } from "../../src/execution/server/canary/durable-store";
import {
  SWAP_LANE_STORE_DIR,
  openLaneStore,
} from "../../src/swap/lane/runtime";
import { SwapLaneEngine } from "../../src/swap/lane/engine";
import {
  FakeChain,
  FakeSigner,
  KEY_DIGEST,
  NOW,
  OWNER_KEY,
  RECORD,
} from "./swap-lane-fake";

const TEMP = process.env.FL1 ? join(process.env.FL1, "temp") : tmpdir();
const OTHER_RECORD = { ...RECORD, approvalId: "0x" + "2b".repeat(32) };
let dir = "";
const open: CanaryDurableStore[] = [];
const track = (s: CanaryDurableStore) => (open.push(s), s);
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("EXPECTED_A_REFUSAL");
};
const lock = () => existsSync(CanaryDurableStore.lockPath(dir));
const types = (s: CanaryDurableStore) => s.entries().map((e) => e.type);

beforeEach(() => {
  mkdirSync(TEMP, { recursive: true });
  dir = join(mkdtempSync(join(TEMP, "swap-lane-store-")), "journal");
});
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  if (dir) rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("openLaneStore on the real durable store", () => {
  it("the test directory is never the lane's own store directory", () => {
    expect(dir).not.toBe(SWAP_LANE_STORE_DIR());
    expect(dir.startsWith(TEMP)).toBe(true);
  });
  it("the first open binds the journal to the record (the store's OPEN, then LANE_BIND)", () => {
    const s = track(openLaneStore(dir, RECORD));
    expect(s.writable).toBe(true);
    expect(types(s)).toEqual(["OPEN", "LANE_BIND"]);
    expect(s.of("LANE_BIND")[0].data).toEqual({
      record: RECORD.approvalId,
      route: RECORD.route,
      account: RECORD.account,
      scope: RECORD.scope,
      pinSet: RECORD.pinSet,
      firstNonce: RECORD.firstNonce,
    });
    expect(lock()).toBe(true);
    s.close();
    expect(lock()).toBe(false);
  });
  it("a reopen with the same record after close works and does not bind twice", () => {
    openLaneStore(dir, RECORD).close();
    const s = track(openLaneStore(dir, RECORD));
    expect(types(s)).toEqual(["OPEN", "LANE_BIND", "OPEN"]);
    expect(s.of("LANE_BIND")).toHaveLength(1);
    expect(s.writable).toBe(true);
  });
  it("another record -> STORE_OTHER_RECORD, the store is closed and its lock released", () => {
    openLaneStore(dir, RECORD).close();
    const e = refusal(() => track(openLaneStore(dir, OTHER_RECORD)));
    expect(e.code).toBe("STORE_OTHER_RECORD");
    expect(lock()).toBe(false);
    // the lock is really free: the same directory opens again at once (same process, same thread)
    const s = track(openLaneStore(dir, RECORD));
    expect(s.writable).toBe(true);
    expect(s.of("LANE_BIND")).toHaveLength(1);
    // the refused open left its own OPEN line and nothing else (no second LANE_BIND)
    expect(types(s)).toEqual(["OPEN", "LANE_BIND", "OPEN", "OPEN"]);
  });
  it("the same record id bound to another route -> STORE_OTHER_ROUTE, closed, lock released", () => {
    openLaneStore(dir, RECORD).close();
    const e = refusal(() =>
      track(
        openLaneStore(dir, { ...RECORD, route: "eth-usdc-weth-univ3-max1" }),
      ),
    );
    expect(e.code).toBe("STORE_OTHER_ROUTE");
    expect(lock()).toBe(false);
    expect(track(openLaneStore(dir, RECORD)).of("LANE_BIND")).toHaveLength(1);
  });
  it("a binding without a route (a single-route journal) is refused for every route", () => {
    const s = CanaryDurableStore.open(dir);
    s.append("LANE_BIND", {
      record: RECORD.approvalId,
      account: RECORD.account,
      scope: RECORD.scope,
      pinSet: RECORD.pinSet,
      firstNonce: RECORD.firstNonce,
    });
    s.close();
    expect(refusal(() => track(openLaneStore(dir, RECORD))).code).toBe(
      "STORE_OTHER_ROUTE",
    );
    expect(lock()).toBe(false);
  });
  it("a record naming no route of the table -> STORE_ROUTE_UNKNOWN before anything is bound", () => {
    for (const route of ["", "base-usdc-weth-univ3-max5", "__proto__"]) {
      expect(
        refusal(() => track(openLaneStore(dir, { ...RECORD, route }))).code,
      ).toBe("STORE_ROUTE_UNKNOWN");
      expect(lock()).toBe(false);
    }
    const s = track(openLaneStore(dir, RECORD));
    expect(s.of("LANE_BIND")).toHaveLength(1);
  });
  it("a journal with two LANE_BIND entries is refused as STORE_OTHER_RECORD", () => {
    const s = openLaneStore(dir, RECORD);
    s.append("LANE_BIND", { record: RECORD.approvalId });
    s.close();
    expect(refusal(() => track(openLaneStore(dir, RECORD))).code).toBe(
      "STORE_OTHER_RECORD",
    );
    expect(lock()).toBe(false);
  });
  it("a journal that cannot be written (damaged) -> STORE_NEEDS_ATTENTION, closed, lock released", () => {
    openLaneStore(dir, RECORD).close();
    appendFileSync(CanaryDurableStore.journalPath(dir), '{"seq":99,"bad":1}\n');
    expect(CanaryDurableStore.inspect(dir).status).not.toBe("READY");
    const e = refusal(() => track(openLaneStore(dir, RECORD)));
    expect(e.code).toBe("STORE_NEEDS_ATTENTION");
    expect(lock()).toBe(false);
    // the lock is free: a plain open succeeds (read-only, it is damaged)
    const s = track(CanaryDurableStore.open(dir));
    expect(s.writable).toBe(false);
  });
  it("a second writer while the first is open is refused by the store (STORE_LOCKED); the first keeps working", () => {
    const s = track(openLaneStore(dir, RECORD));
    expect(refusal(() => track(openLaneStore(dir, RECORD))).code).toBe(
      "STORE_LOCKED",
    );
    expect(lock()).toBe(true);
    s.append("PROBE", { ok: true });
    expect(s.of("PROBE")).toHaveLength(1);
  });
  it("the engine journals into the bound store and the lines survive a reopen", async () => {
    const s = track(openLaneStore(dir, RECORD));
    const chain = new FakeChain(() => NOW);
    const engine = new SwapLaneEngine({
      store: s,
      record: RECORD,
      keyDigest: KEY_DIGEST,
      chain,
      signer: new FakeSigner(chain),
      now: () => NOW,
    });
    // the real pins refuse the fake chain's code: the review is not ready, but it is journaled
    const r = await engine.review(OWNER_KEY);
    expect(r.ready).toBe(false);
    expect(s.of("REVIEW")).toHaveLength(1);
    s.close();
    const again = track(openLaneStore(dir, RECORD));
    expect(
      again.of("REVIEW").map((x) => (x.data as { reviewId: string }).reviewId),
    ).toEqual([r.reviewId]);
    expect(again.of("LANE_BIND")).toHaveLength(1);
  });
});
