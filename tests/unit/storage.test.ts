import { afterEach, expect, it, vi } from "vitest";
import { CROSS, type TransferRecord } from "../../src/core/model";
import {
  saveRecord,
  readHistory,
  decodeHistory,
  HISTORY_KEY,
  attachSourceHash,
} from "../../src/storage/history";
import { boundedBody } from "../../src/server/body";
afterEach(() => vi.unstubAllGlobals());
const record: TransferRecord = {
  schema: 1,
  id: "test",
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
  state: "COMPLETED",
  updatedAt: Date.now(),
};
it("C3 manual recovery preserves records and a hash candidate does not assert completion", async () => {
  let text = JSON.stringify([
    { ...record, state: "SUBMISSION_UNKNOWN" },
    { ...record, id: "other" },
  ]);
  vi.stubGlobal("localStorage", {
    getItem: () => text,
    setItem: (_key: string, value: string) => {
      text = value;
    },
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, callback: () => unknown) => callback(),
    },
  });
  const hash = `0x${"a".repeat(64)}`;
  await expect(attachSourceHash("test", "bad")).rejects.toThrow();
  expect(JSON.parse(text)[0].sourceHash).toBeUndefined();
  expect((await attachSourceHash("test", hash)).state).toBe("SOURCE_SUBMITTED");
  expect(JSON.parse(text).map((r: TransferRecord) => r.id)).toEqual([
    "test",
    "other",
  ]);
  await expect(attachSourceHash("test", `0x${"b".repeat(64)}`)).rejects.toThrow(
    "INVALID_REQUEST",
  );
  expect(JSON.parse(text)[0].sourceHash).toBe(hash);
});
it("P03 stored mainnet completion is revalidated before any success action", () =>
  expect(decodeHistory(JSON.stringify([record]))[0].state).toBe(
    "UNVERIFIED_COMPLETION",
  ));
it("P01/S03 parallel storage writes share a lock and preserve both records", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  let queue = Promise.resolve();
  const locks = {
    request: (_name: string, callback: () => void) => {
      queue = queue.then(callback);
      return queue;
    },
  };
  vi.stubGlobal("navigator", { locks });
  await Promise.all([
    saveRecord({ ...record, id: "one", state: "SOURCE_SUBMITTED" }),
    saveRecord({ ...record, id: "two", state: "SOURCE_SUBMITTED" }),
  ]);
  expect(
    readHistory()
      .records.map((r) => r.id)
      .sort(),
  ).toEqual(["one", "two"]);
  expect(storage.get(HISTORY_KEY)).not.toContain("signature");
});
it("X01/X02 oversized streaming body is cancelled before JSON parsing", async () => {
  await expect(
    boundedBody(
      new Request("http://localhost", {
        method: "POST",
        body: "x".repeat(16001),
      }),
    ),
  ).rejects.toThrow("REQUEST_TOO_LARGE");
});
