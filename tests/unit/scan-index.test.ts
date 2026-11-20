import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ScanIndex, projectAccount } from "../../src/scan/server";
import { CanaryDurableStore } from "../../src/execution/server/canary/durable-store";
import { lifecycle } from "../../src/scan/model";
import * as verification from "../../src/activity/verify";
import history from "../../src/scan/imported-history.json";
const owner = "0x" + "1".repeat(40),
  other = "0x" + "2".repeat(40),
  id = "a".repeat(64),
  hash = "0x" + "b".repeat(64);
const stores: { close(): void }[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  vi.restoreAllMocks();
});
function setup() {
  const dir = mkdtempSync(resolve("../evidence/scan-test-"));
  const index = new ScanIndex(join(dir, "scan"));
  const ledger = CanaryDurableStore.open(join(dir, "wallet", owner));
  stores.push(index.store, ledger);
  ledger.append("ACCOUNT_BIND", { account: owner, firstNonce: "0" });
  return { dir, index, ledger };
}
function submitted(ledger: CanaryDurableStore) {
  ledger.append("REQUESTED", {
    id,
    lane: "SWAP",
    step: "SWAP",
    requestedAt: 10,
  });
  ledger.append("RESULT", {
    id,
    lane: "SWAP",
    step: "SWAP",
    hash,
    outcome: "SENT",
    submittedAt: 20,
  });
}
it("ingests a wallet submission automatically, without any hash import, and deduplicates repeated ingestion", () => {
  const { index, ledger, dir } = setup();
  submitted(ledger);
  index.ingest(join(dir, "wallet"));
  index.ingest(join(dir, "wallet"));
  const rows = index.list(owner);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    hash,
    provenance: "VEINED_SUBMISSION",
    status: "SUBMITTED",
  });
  expect(
    index.store
      .of("SCAN_RECORD")
      .filter((e) => (e.data as { account: string }).account === owner),
  ).toHaveLength(1);
  expect(index.list(other)).toEqual([]);
});
it("restart recovers the durable index and the original transaction", () => {
  const { index, ledger, dir } = setup();
  submitted(ledger);
  index.ingest(join(dir, "wallet"));
  index.store.close();
  const restored = new ScanIndex(join(dir, "scan"));
  stores.push(restored.store);
  expect(restored.list(owner)).toHaveLength(1);
  expect(restored.list(owner)[0].hash).toBe(hash);
});
it("unfinished wallet handoff survives as UNKNOWN without invented hash", () => {
  const { index, ledger, dir } = setup();
  ledger.append("REQUESTED", { id, lane: "BRIDGE", step: "EXECUTE" });
  index.ingest(join(dir, "wallet"));
  expect(index.list(owner)[0]).toMatchObject({
    hash: null,
    status: "UNKNOWN",
    kind: "Bridge",
  });
});
it("mismatched account binding fails closed", () => {
  const { ledger } = setup();
  submitted(ledger);
  expect(() => projectAccount(other, [...ledger.entries()])).toThrow(
    "SCAN_ACCOUNT_BINDING",
  );
});
it("corrupted wallet journal surfaces an error instead of importing unverified rows", () => {
  const { index, ledger, dir } = setup();
  submitted(ledger);
  appendFileSync(join(dir, "wallet", owner, "journal.ndjson"), "cut");
  expect(index.ingest(join(dir, "wallet"))).toEqual([
    "SCAN_LEDGER_NEEDS_ATTENTION",
  ]);
  expect(index.list(owner)).toEqual([]);
});
it("first five verified transactions belong only to the historical public address", () => {
  const { index } = setup();
  const address = history.address.toLowerCase();
  expect(index.list(address)).toHaveLength(5);
  expect(
    index.list(address).every((r) => r.provenance === "HISTORICAL_IMPORT"),
  ).toBe(true);
  expect(index.list(owner)).toHaveLength(0);
  expect(index.list(address, "42161")).toHaveLength(1);
});
it.each([
  ["DESTINATION_PENDING", "FILL_PENDING"],
  ["SETTLED_VERIFIED", "SETTLED_VERIFIED"],
  ["REFUND_PENDING", "REFUND_PENDING"],
  ["DISCREPANCY", "UNKNOWN"],
])("bridge %s maps to %s without claiming delivery", (state, expected) => {
  expect(
    lifecycle("EXECUTE", {
      state,
      steps: { EXECUTE: { state: "FINAL_SUCCESS" } },
    }),
  ).toBe(expected);
});
it("provider failure retains the last observation and recovers on a later read", async () => {
  const { index, ledger, dir } = setup();
  submitted(ledger);
  index.ingest(join(dir, "wallet"));
  const row = index.list(owner)[0];
  await index.reconcile(row, async () => {
    throw Error("RPC");
  });
  expect(index.list(owner)[0].error).toBe("VERIFICATION_UNAVAILABLE");
  await index.reconcile(index.list(owner)[0], async () => ({
    state: "SWAP_PENDING",
    steps: { SWAP: { state: "PENDING" } },
  }));
  expect(index.list(owner)[0]).toMatchObject({
    status: "PENDING",
    error: undefined,
  });
});
it("historical source and fill are exactly correlated", () => {
  const { index } = setup();
  const address = history.address.toLowerCase();
  const bridge = index.list(address).find((r) => r.kind === "Bridge")!;
  const fill = index
    .list(address)
    .find((r) => r.kind === "Destination settlement")!;
  expect(bridge.transaction?.deposit).toEqual(fill.transaction?.deposit);
});
it("confirmed receipt is attached only after chain verification", async () => {
  const { index, ledger, dir } = setup();
  submitted(ledger);
  index.ingest(join(dir, "wallet"));
  vi.spyOn(verification, "verifyTransaction").mockResolvedValue({
    ...history.results[0].transaction,
    address: owner,
    hash,
  } as never);
  await index.reconcile(index.list(owner)[0], async () => ({
    state: "SETTLED_VERIFIED",
    steps: { SWAP: { state: "FINAL_SUCCESS" } },
  }));
  expect(index.list(owner)[0]).toMatchObject({
    status: "SETTLED_VERIFIED",
    transaction: { hash, address: owner },
  });
});

it("restart never overwrites a more recent historical verification with the seed snapshot", () => {
  const { index, dir } = setup();
  const r = index.list(history.address.toLowerCase())[0];
  index.put({
    ...r,
    transaction: {
      ...r.transaction!,
      verifiedAt: r.transaction!.verifiedAt + 1000,
    },
    updatedAt: r.updatedAt + 1000,
  });
  index.store.close();
  const restored = new ScanIndex(join(dir, "scan"));
  stores.push(restored.store);
  expect(restored.records.get(r.id)?.transaction?.verifiedAt).toBe(
    r.transaction!.verifiedAt + 1000,
  );
});
it("a verified new bridge fill is ingested and linked to its source automatically", async () => {
  const { index, ledger, dir } = setup();
  ledger.append("REQUESTED", {
    id,
    lane: "BRIDGE",
    step: "EXECUTE",
    requestedAt: 10,
  });
  ledger.append("RESULT", {
    id,
    lane: "BRIDGE",
    step: "EXECUTE",
    outcome: "SENT",
    hash,
    submittedAt: 20,
  });
  index.ingest(join(dir, "wallet"));
  const source = history.results.find(
    (r) => r.transaction.kind === "Bridge",
  )!.transaction;
  const fill = history.results.find(
    (r) => r.transaction.kind === "Destination settlement",
  )!.transaction;
  const fillHash = "0x" + "c".repeat(64);
  vi.spyOn(verification, "verifyTransaction").mockImplementation(
    async (input) =>
      ({
        ...(input.chainId === "8453" ? source : fill),
        address: owner,
        from: input.chainId === "8453" ? owner : fill.from,
        hash: input.hash,
        deposit: { ...source.deposit!, recipient: owner },
      }) as never,
  );
  await index.reconcile(index.list(owner)[0], async () => ({
    state: "SETTLED_VERIFIED",
    steps: { EXECUTE: { state: "FINAL_SUCCESS" } },
    settlement: { fillHash },
  }));
  expect(index.list(owner)).toHaveLength(2);
  expect(index.list(owner).find((r) => r.chainId === "42161")).toMatchObject({
    sourceHash: hash,
    hash: fillHash,
    status: "SETTLED_VERIFIED",
    provenance: "VEINED_SUBMISSION",
  });
  expect(
    index.list(owner).find((r) => r.chainId === "8453")?.destinationHash,
  ).toBe(fillHash);
});
