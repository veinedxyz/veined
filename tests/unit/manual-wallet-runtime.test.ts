// Separate end-to-end server composition over keyless, two-operator fake chains. No wallet/RPC write or private key.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { AccountRuntime } from "../../src/manual-wallet/server/runtime";
import * as reads from "../../src/swap/lane/reads";
import { lane, OWNER, FIRST_NONCE, type Lane } from "./swap-lane-fake";
import {
  bridgeLane,
  FIRST_NONCE as BRIDGE_NONCE,
  fillAndBury,
  type BridgeLane,
} from "./bridge-lane-fake";
import type { ManualLane } from "../../src/manual-wallet/protocol";
import { ScanIndex } from "../../src/scan/server";
import { join } from "node:path";
vi.mock("../../src/manual-wallet/release", () => ({
  MANUAL_WALLET_RELEASED: true,
}));
vi.mock("../../src/swap/lane/pins", async (original) => {
  const real = await original<typeof import("../../src/swap/lane/pins")>();
  return (await import("./swap-lane-pin-mock")).fakeCodePinModule(real);
});
vi.mock("../../src/swap/lane/bridge-pins", async (original) => {
  const real =
    await original<typeof import("../../src/swap/lane/bridge-pins")>();
  return (await import("./bridge-lane-pin-mock")).fakeBridgePinModule(real);
});
const opened: AccountRuntime[] = [];
for (const kind of ["SWAP", "BRIDGE"] as const) {
  it(`${kind}: accepted engine → wallet broker result → durable automatic Scan ingestion → restart`, async () => {
    const { a, L, directory } = setup(kind);
    const sent = await send(a, L, kind);
    const index = new ScanIndex(join(directory, "scan-index"));
    try {
      index.ingest(directory);
      expect(index.list(OWNER)).toHaveLength(1);
      expect(index.list(OWNER)[0]).toMatchObject({
        hash: sent.result.hash,
        kind: "Approval",
        status: "SUBMITTED",
        provenance: "VEINED_SUBMISSION",
      });
      index.ingest(directory);
      expect(index.list(OWNER)).toHaveLength(1);
    } finally {
      index.store.close();
    }
    const restored = new ScanIndex(join(directory, "scan-index"));
    try {
      expect(restored.list(OWNER)[0].hash).toBe(sent.result.hash);
    } finally {
      restored.store.close();
    }
  });
}
function close(a: AccountRuntime) {
  for (const f of a.history.values()) f.store.close();
  a.root.close();
}
afterEach(() => {
  opened.splice(0).forEach((a) => {
    try {
      close(a);
    } catch {}
  });
  vi.restoreAllMocks();
});
function setup(kind: ManualLane) {
  const L = kind === "SWAP" ? lane() : bridgeLane();
  vi.spyOn(Date, "now").mockImplementation(() => L.clock.t);
  if (kind === "SWAP")
    vi.spyOn(reads, "laneReadBoth").mockImplementation(
      (_r, m, p, _a, _s, pick) => (L as Lane).chain.both(m, p, pick),
    );
  else {
    vi.spyOn(reads, "bridgeReadBoth").mockImplementation(
      (chain, m, p, _a, _s, pick) =>
        (chain === "8453" ? (L as BridgeLane).src : (L as BridgeLane).dst).both(
          m,
          p,
          pick,
        ),
    );
    vi.spyOn(reads, "bridgeLifiQuote").mockImplementation(async () => {
      const { honestParts, quoteOf } = await import("./bridge-lane-fake");
      const b = L as BridgeLane;
      return quoteOf(
        b.pairId,
        honestParts(b.pairId, Math.floor(b.clock.t / 1000)),
      );
    });
  }
  const directory = mkdtempSync(resolve("../evidence/manual-runtime-"));
  const a = new AccountRuntime(
    OWNER,
    (kind === "SWAP" ? FIRST_NONCE : BRIDGE_NONCE).toString(),
    directory,
  );
  opened.push(a);
  return { a, L, directory };
}
async function send(a: AccountRuntime, L: Lane | BridgeLane, kind: ManualLane) {
  const review = await a.review(kind);
  expect(review.problems).toEqual([]);
  expect(review.ready).toBe(true);
  const p = a.prepare(kind, review.reviewId);
  const claimed = await a.claim(kind, p.id);
  const fake = L.signer;
  const result = await fake.send({}, claimed.transaction, p.step as "APPROVE");
  await a.result(kind, claimed.authority, result.outcome, result.hash);
  return { p, claimed, result };
}
it("composes live review, exact approval, manual hash return, receipt and Base swap settlement", async () => {
  const { a, L: raw } = setup("SWAP"),
    L = raw as Lane;
  await send(a, L, "SWAP");
  expect(a.status().inFlight).toBe(1);
  expect((await a.track("SWAP")).state).not.toBe("SETTLED");
  L.chain.mine();
  L.chain.advance(L.chain.route.confirmations - 1);
  await a.track("SWAP");
  expect(a.status().inFlight).toBe(0);
  await send(a, L, "SWAP");
  L.chain.mine();
  L.chain.advance(L.chain.route.confirmations - 1);
  expect((await a.track("SWAP")).state).toBe("SETTLED_VERIFIED");
  expect(L.chain.allowance).toBe(0n);
  expect(L.signer.calls).toHaveLength(2);
});
it("requires a final successful approval before execution", async () => {
  const { a, L: raw } = setup("SWAP"),
    L = raw as Lane;
  await send(a, L, "SWAP");
  const review = await a.review("SWAP");
  expect(review.ready).toBe(false);
  expect(review.problems).toContain("APPROVAL_NOT_FINAL");
  expect(() => a.prepare("SWAP", review.reviewId)).toThrow();
});
for (const kind of ["SWAP", "BRIDGE"] as const) {
  it(`${kind}: two independently single-use sessions, exact pending hashes, durable restart and history`, async () => {
    const { a, L, directory } = setup(kind);
    const source = kind === "SWAP" ? (L as Lane).chain : (L as BridgeLane).src;
    const depth =
      kind === "SWAP"
        ? (L as Lane).chain.route.confirmations
        : (L as BridgeLane).src.chain.confirmations;
    const mine = () => {
      source.mine();
      source.advance(depth - 1);
    };
    const firstRecord = a.flow(kind).record.approvalId;
    await send(a, L, kind);
    mine();
    await a.track(kind);
    await send(a, L, kind);
    mine();
    if (kind === "BRIDGE") {
      await a.track(kind);
      await expect(a.review(kind)).rejects.toThrow("MANUAL_SESSION_UNSETTLED");
      fillAndBury(L as BridgeLane, (L as BridgeLane).src.deposits.at(-1)!);
    }
    expect((await a.track(kind)).state).toBe("SETTLED_VERIFIED");
    expect((await a.review(kind)).ready).toBe(true);
    const secondRecord = a.flow(kind).record.approvalId;
    expect(secondRecord).not.toBe(firstRecord);
    expect(a.history.size).toBe(2);
    await send(a, L, kind);
    // The first session's approval receipt must not clear the new pending approval.
    expect(a.status().inFlight).toBe(1);
    mine();
    await a.track(kind);
    await send(a, L, kind);
    mine();
    if (kind === "BRIDGE")
      fillAndBury(L as BridgeLane, (L as BridgeLane).src.deposits.at(-1)!);
    expect((await a.track(kind)).state).toBe("SETTLED_VERIFIED");
    const count = a.root.of("MANUAL_RECORD").length;
    close(a);
    opened.splice(opened.indexOf(a), 1);
    const restored = new AccountRuntime(OWNER, "0", directory);
    opened.push(restored);
    expect(restored.root.of("MANUAL_RECORD")).toHaveLength(count);
    expect(restored.flow(kind).record.approvalId).toBe(secondRecord);
    expect(restored.status().inFlight).toBe(0);
    expect(restored.status().chains["8453"].signedCount).toBe(4);
    expect((await restored.track(kind, firstRecord)).state).toBe(
      "SETTLED_VERIFIED",
    );
    const index = new ScanIndex(join(directory, "second-session-index"));
    try {
      index.ingest(directory);
      index.ingest(directory);
      expect(
        index.list(OWNER).filter((r) => r.provenance === "VEINED_SUBMISSION"),
      ).toHaveLength(4);
    } finally {
      index.store.close();
    }
  });
}
it("persists UNKNOWN across a new runtime and blocks every new dispatch", async () => {
  const { a, L, directory } = setup("SWAP");
  const r = await a.review("SWAP");
  const p = a.prepare("SWAP", r.reviewId);
  const c = await a.claim("SWAP", p.id);
  await a.result("SWAP", c.authority, "UNCERTAIN", null);
  expect(a.status().uncertain).toBe(1);
  close(a);
  opened.splice(opened.indexOf(a), 1);
  const restored = new AccountRuntime(OWNER, FIRST_NONCE.toString(), directory);
  opened.push(restored);
  expect(restored.status().uncertain).toBe(1);
  expect((await restored.review("SWAP")).ready).toBe(false);
  expect(L.signer.calls).toHaveLength(0);
});
it("Bridge remains PENDING until a verified Across fill and zero allowance", async () => {
  const { a, L: raw } = setup("BRIDGE"),
    L = raw as BridgeLane;
  await send(a, L, "BRIDGE");
  L.src.mine();
  L.src.advance(L.src.chain.confirmations - 1);
  await a.track("BRIDGE");
  await send(a, L, "BRIDGE");
  L.src.mine();
  L.src.advance(L.src.chain.confirmations - 1);
  expect((await a.track("BRIDGE")).state).toBe("DESTINATION_PENDING");
  fillAndBury(L, L.src.deposits.at(-1)!);
  expect((await a.track("BRIDGE")).state).toBe("SETTLED_VERIFIED");
  expect(L.src.allowance).toBe(0n);
});
it("duplicate claims and another route cannot dispatch during a wallet prompt", async () => {
  const { a } = setup("SWAP");
  const r = await a.review("SWAP");
  const p = a.prepare("SWAP", r.reviewId);
  const c = await a.claim("SWAP", p.id);
  await expect(a.claim("SWAP", p.id)).rejects.toThrow();
  expect(a.status().uncertain).toBe(1);
  expect(() => a.prepare("SWAP", r.reviewId)).toThrow();
  await a.result("SWAP", c.authority, "REFUSED", null);
});
it("a crash/refusal after REQUESTED cannot disappear during a later review", async () => {
  const { a } = setup("SWAP");
  const r = await a.review("SWAP");
  const p = a.prepare("SWAP", r.reviewId);
  const f = a.flows.get("SWAP")!;
  const spy = vi.spyOn(f.engine, "authorize").mockImplementation(() => {
    throw Error("SIMULATED_CRASH");
  });
  await expect(a.claim("SWAP", p.id)).rejects.toThrow("SIMULATED_CRASH");
  spy.mockRestore();
  expect(a.status().uncertain).toBe(1);
  const again = await a.review("SWAP");
  expect(again.ready).toBe(false);
  expect(again.problems).toContain("SIGNER_NOT_READY:UNCERTAIN");
});
it("failed approval stays closed and never prepares execution", async () => {
  const { a, L: raw } = setup("BRIDGE"),
    L = raw as BridgeLane;
  await send(a, L, "BRIDGE");
  L.src.failNext = true;
  L.src.mine();
  L.src.advance(L.src.chain.confirmations - 1);
  expect((await a.track("BRIDGE")).state).toBe("APPROVAL_FAILED");
  const r = await a.review("BRIDGE");
  expect(r.ready).toBe(false);
  expect(r.problems).toContain("APPROVAL_FAILED");
  expect(() => a.prepare("BRIDGE", r.reviewId)).toThrow();
});
