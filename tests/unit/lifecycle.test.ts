import { expect, it, vi } from "vitest";
import {
  recordSubmission,
  assertNoUnresolved,
} from "../../src/features/bridge/lifecycle";
import { CROSS, type TransferRecord } from "../../src/core/model";
it("S04 persists uncertainty before dispatch and never retries a missing hash", async () => {
  const events: string[] = [];
  const request = vi.fn(async () => {
    events.push("request");
    throw Error("disconnected");
  });
  const persistence = {
    unknown: async () => {
      events.push("persist-unknown");
    },
    hash: () => {
      events.push("hash");
    },
    rejected: () => {
      events.push("rejected");
    },
  };
  await expect(recordSubmission(request, persistence)).rejects.toThrow(
    "SUBMISSION_UNKNOWN",
  );
  expect(events).toEqual(["persist-unknown", "request"]);
  expect(request).toHaveBeenCalledTimes(1);
});
it("rejection and valid hash are distinct from unknown submission", async () => {
  const rejected = vi.fn();
  const hash = vi.fn();
  const p = { unknown: vi.fn(), hash, rejected };
  await expect(
    recordSubmission(async () => {
      throw { code: 4001 };
    }, p),
  ).rejects.toThrow("USER_REJECTED");
  expect(rejected).toHaveBeenCalledOnce();
  const value = `0x${"a".repeat(64)}`;
  expect(await recordSubmission(async () => value, p)).toBe(value);
  expect(hash).toHaveBeenCalledWith(value);
});
it("S03/P04 unresolved intents block the same account while another account remains separate", () => {
  const r: TransferRecord = {
    schema: 1,
    id: "one",
    mode: "mainnet-readonly",
    route: "one-native-to-bsc-cross",
    config: "1",
    sourceChain: 612055,
    destinationChain: 56,
    account: "0x3333333333333333333333333333333333333333",
    recipient: "0x3333333333333333333333333333333333333333",
    sourceAsset: "native:ONE",
    token: CROSS,
    amount: "1",
    expected: "1",
    state: "SUBMISSION_UNKNOWN",
    updatedAt: Date.now(),
  };
  expect(() => assertNoUnresolved([r], r.account)).toThrow("DUPLICATE_INTENT");
  expect(() =>
    assertNoUnresolved([r], "0x4444444444444444444444444444444444444444"),
  ).not.toThrow();
});
