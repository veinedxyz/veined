// VEINED-MC1 (BRIDGE LANE): the bridge lane journal binding (src/swap/lane/bridge-runtime.ts openBridgeLaneStore) on the
// REAL durable store (src/execution/server/canary/durable-store.ts) in a temporary directory of this run (never the
// lane's own .veined-bridge-lane-store). The store writes its own OPEN line; the lane binds the journal to ONE record
// and pair with a LANE_BIND entry (lane BRIDGE); a journal of another record or pair, a swap-lane journal, a journal
// with lane entries but no binding, or one that cannot be written is refused AND closed (the writer lock is released).
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
  BRIDGE_LANE_ENTRY_TYPES,
  BRIDGE_LANE_STORE_DIR,
  bridgeLaneArmed,
  openBridgeLaneStore,
} from "../../src/swap/lane/bridge-runtime";
import {
  SWAP_LANE_STORE_DIR,
  openLaneStore,
} from "../../src/swap/lane/runtime";
import { RECORD as SWAP_RECORD } from "./swap-lane-fake";
import { recordFor } from "./bridge-lane-fake";

const TEMP = process.env.FL1 ? join(process.env.FL1, "temp") : tmpdir();
const RECORD = recordFor("bridge-8453-42161");
const OTHER_RECORD = { ...RECORD, approvalId: "0x" + "3d".repeat(32) };
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
  dir = join(mkdtempSync(join(TEMP, "bridge-lane-store-")), "journal");
});
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  if (dir) rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("openBridgeLaneStore on the real durable store", () => {
  it("its own directory, never the canary's or the swap lane's", () => {
    expect(BRIDGE_LANE_STORE_DIR().endsWith(".veined-bridge-lane-store")).toBe(
      true,
    );
    expect(BRIDGE_LANE_STORE_DIR()).not.toBe(SWAP_LANE_STORE_DIR());
    expect(dir).not.toBe(BRIDGE_LANE_STORE_DIR());
  });
  it("the first open binds the journal to the record and its pair (the store's OPEN, then LANE_BIND lane BRIDGE)", () => {
    const s = track(openBridgeLaneStore(dir, RECORD));
    expect(types(s)).toEqual(["OPEN", "LANE_BIND"]);
    expect(s.of("LANE_BIND")[0].data).toEqual({
      lane: "BRIDGE",
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
  it("a reopen with the same record works and does not bind twice", () => {
    openBridgeLaneStore(dir, RECORD).close();
    const s = track(openBridgeLaneStore(dir, RECORD));
    expect(types(s)).toEqual(["OPEN", "LANE_BIND", "OPEN"]);
    expect(s.of("LANE_BIND")).toHaveLength(1);
  });
  it("another record -> STORE_OTHER_RECORD, closed, lock released", () => {
    openBridgeLaneStore(dir, RECORD).close();
    expect(
      refusal(() => track(openBridgeLaneStore(dir, OTHER_RECORD))).code,
    ).toBe("STORE_OTHER_RECORD");
    expect(lock()).toBe(false);
  });
  it("the same record id bound to another pair -> STORE_OTHER_ROUTE, closed, lock released", () => {
    openBridgeLaneStore(dir, RECORD).close();
    expect(
      refusal(() =>
        track(openBridgeLaneStore(dir, { ...RECORD, route: "bridge-1-10" })),
      ).code,
    ).toBe("STORE_OTHER_ROUTE");
    expect(lock()).toBe(false);
  });
  it("a SWAP lane journal is never a bridge journal (its binding has no lane BRIDGE)", () => {
    openLaneStore(dir, SWAP_RECORD).close();
    expect(
      refusal(() =>
        track(
          openBridgeLaneStore(dir, {
            ...RECORD,
            approvalId: SWAP_RECORD.approvalId,
          }),
        ),
      ).code,
    ).toBe("STORE_OTHER_ROUTE");
    expect(lock()).toBe(false);
  });
  it.each(BRIDGE_LANE_ENTRY_TYPES)(
    "a journal holding %s but no binding -> STORE_UNBOUND_ENTRIES",
    (type) => {
      const s = CanaryDurableStore.open(dir);
      s.append(type, { probe: true });
      s.close();
      expect(refusal(() => track(openBridgeLaneStore(dir, RECORD))).code).toBe(
        "STORE_UNBOUND_ENTRIES",
      );
      expect(lock()).toBe(false);
    },
  );
  it("a record naming no pair (or a BLOCKED-unknown id) -> STORE_ROUTE_UNKNOWN before anything is bound", () => {
    for (const route of [
      "",
      "bridge-43114-1",
      "__proto__",
      "base-usdc-weth-univ3-max1",
    ]) {
      expect(
        refusal(() => track(openBridgeLaneStore(dir, { ...RECORD, route })))
          .code,
      ).toBe("STORE_ROUTE_UNKNOWN");
      expect(lock()).toBe(false);
    }
  });
  it("a damaged journal -> STORE_NEEDS_ATTENTION, closed, lock released", () => {
    openBridgeLaneStore(dir, RECORD).close();
    appendFileSync(CanaryDurableStore.journalPath(dir), '{"seq":99,"bad":1}\n');
    expect(refusal(() => track(openBridgeLaneStore(dir, RECORD))).code).toBe(
      "STORE_NEEDS_ATTENTION",
    );
    expect(lock()).toBe(false);
  });
  it("a second writer while the first is open is refused by the store (STORE_LOCKED)", () => {
    track(openBridgeLaneStore(dir, RECORD));
    expect(refusal(() => track(openBridgeLaneStore(dir, RECORD))).code).toBe(
      "STORE_LOCKED",
    );
  });
  it("disarmed: the runtime is not armed for four reasons", () => {
    expect(bridgeLaneArmed()).toEqual({
      armed: false,
      reasons: [
        "NO_OWNER_APPROVED_BRIDGE_LANE",
        "NO_OWNER_BRIDGE_LANE_KEY",
        "NO_LOCAL_SIGNER",
        "BRIDGE_LANE_NOT_WIRED",
      ],
    });
  });
});
