import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualBroker } from "../../src/manual-wallet/server/broker";
import {
  manualLane,
  manualTx,
  type ManualPreparation,
} from "../../src/manual-wallet/protocol";
const tx = manualTx({
  chainId: "0x2105",
  from: "0x" + "3".repeat(40),
  to: "0x" + "4".repeat(40),
  data: "0x12345678",
  value: "0x0",
  gas: "0x186a0",
  maxFeePerGas: "0x64",
  maxPriorityFeePerGas: "0x0",
});
const prep = (): ManualPreparation => ({
  id: "a".repeat(64),
  lane: "SWAP",
  reviewId: "review-1",
  step: "APPROVE",
  transaction: tx,
  serverTime: 1000,
  expiresAt: 20_000,
  released: true,
});
afterEach(() => vi.useRealTimers());
describe("manual wallet durable handoff", () => {
  it("keeps financial activation closed without spending a request", () => {
    const append = vi.fn();
    const b = new ManualBroker(prep(), append, () => 1000);
    expect(() => b.claim(false)).toThrow("OWNER_RELEASE_REQUIRED");
    expect(append).not.toHaveBeenCalled();
  });
  it("requires a claim before handoff", () => {
    const b = new ManualBroker(prep(), vi.fn(), () => 1000);
    expect(() => b.handoff(tx)).toThrow("MANUAL_HANDOFF_INVALID");
  });
  it("commits REQUESTED before exposing exact bytes and reports one result", async () => {
    const entries: { type: string; data: unknown }[] = [];
    const b = new ManualBroker(
      prep(),
      (type, data) => entries.push({ type, data }),
      () => 1000,
    );
    b.claim(true);
    const result = b.handoff(tx);
    expect(entries[0].type).toBe("REQUESTED");
    expect(await b.captured).toEqual(tx);
    expect(() => b.claim(true)).toThrow("MANUAL_AUTHORITY_USED");
    b.finish("SENT", "0x" + "a".repeat(64));
    expect(await result).toMatchObject({ outcome: "SENT" });
    expect(entries.map((x) => x.type)).toEqual(["REQUESTED", "RESULT"]);
    expect(() => b.finish("SENT", "0x" + "b".repeat(64))).toThrow(
      "MANUAL_RESULT_ALREADY_USED",
    );
  });
  it("refuses changed calldata after a durable claim", () => {
    const b = new ManualBroker(prep(), vi.fn(), () => 1000);
    b.claim(true);
    expect(() => b.handoff({ ...tx, data: "0xdeadbeef" })).toThrow(
      "MANUAL_PREPARATION_CHANGED",
    );
  });
  it("refuses stale preparation before claim", () => {
    const b = new ManualBroker(prep(), vi.fn(), () => 20_000);
    expect(() => b.claim(true)).toThrow("REVIEW_EXPIRED");
  });
  it("rechecks freshness after claim", () => {
    let now = 1000;
    const b = new ManualBroker(prep(), vi.fn(), () => now);
    b.claim(true);
    now = 20_000;
    expect(() => b.handoff(tx)).toThrow("MANUAL_PREPARATION_CHANGED");
  });
  it("treats malformed wallet hashes as UNKNOWN and never retries", async () => {
    const b = new ManualBroker(prep(), vi.fn(), () => 1000);
    b.claim(true);
    const result = b.handoff(tx);
    b.finish("SENT", "invalid");
    expect(await result).toMatchObject({ outcome: "UNCERTAIN", hash: null });
    expect(() => b.claim(true)).toThrow("MANUAL_AUTHORITY_USED");
  });
  it("keeps definitive rejection distinct from UNKNOWN", async () => {
    const b = new ManualBroker(prep(), vi.fn(), () => 1000);
    b.claim(true);
    const result = b.handoff(tx);
    b.finish("REFUSED", null);
    expect(await result).toMatchObject({ outcome: "REFUSED", hash: null });
  });
  it("records unanswered wallet prompts as UNKNOWN", async () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const b = new ManualBroker(prep(), append, () => 1000);
    b.claim(true);
    const result = b.handoff(tx);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await result).toMatchObject({ outcome: "UNCERTAIN" });
    expect(append.mock.calls[1][1]).toMatchObject({ outcome: "UNCERTAIN" });
  });
  it("a failed REQUESTED fsync never allows a handoff", () => {
    const b = new ManualBroker(
      prep(),
      () => {
        throw Error("DISK_FAILED");
      },
      () => 1000,
    );
    expect(() => b.claim(true)).toThrow("DISK_FAILED");
    expect(() => b.claim(true)).toThrow("MANUAL_AUTHORITY_USED");
    expect(() => b.handoff(tx)).toThrow();
  });
  it.each(["ETH", "bridge-1-8453", {}, null])(
    "refuses a general route %j",
    (value) => {
      expect(() => manualLane(value)).toThrow("MANUAL_ROUTE_UNSUPPORTED");
    },
  );
  it.each([
    { nonce: "0x1" },
    { chainId: "0x1" },
    { value: "0x1" },
    { gas: "0x01" },
    { from: "bad" },
  ])("refuses unsupported transaction fields %j", (change) => {
    expect(() => manualTx({ ...tx, ...change })).toThrow();
  });
});
