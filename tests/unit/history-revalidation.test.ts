import { expect, it, vi } from "vitest";
import { CROSS, NATIVE, type TransferRecord } from "../../src/core/model";
import { READ_ONLY_DEPLOYMENT as deployment } from "../../src/adapters/deployment";
import {
  RuntimeHistoryView,
  validateObservation,
} from "../../src/features/bridge/observation";
import {
  revalidateIntentHistory,
  mainnetNamespace,
  recordSubmission,
} from "../../src/features/bridge/lifecycle";
import { decodeHistory } from "../../src/storage/history";
const now = 1790890000000;
const hash = (v: string) => `0x${v.repeat(64)}`;
const account = "0x3333333333333333333333333333333333333333";
const record: TransferRecord = {
  schema: 1,
  id: "fresh-proof",
  mode: "mainnet-readonly",
  route: "one-native-to-bsc-cross",
  config: "1",
  sourceChain: 612055,
  destinationChain: 56,
  account,
  recipient: account,
  sourceAsset: "native:ONE",
  token: CROSS,
  amount: "100",
  expected: "100",
  sourceHash: hash("a"),
  index: "7",
  state: "COMPLETED",
  updatedAt: now,
};
const observation = {
  kind: "chain" as const,
  observedAt: now,
  record,
  evidence: {
    policy: {
      sourceContract: deployment.source,
      destinationContract: deployment.destination,
      sourceConfirmations: 1,
      destinationConfirmations: 1,
      finality: "node-finalized" as const,
    },
    source: {
      chain: 612055,
      contract: deployment.source,
      hash: hash("a"),
      blockHash: hash("c"),
      canonicalBlockHash: hash("c"),
      blockNumber: 100,
      successful: true,
      confirmations: 3,
      finalizedBlockNumber: 102,
      txFrom: account,
      txTo: deployment.source,
      sender: account,
      recipient: account,
      token: NATIVE,
      index: "7",
      eventLogIndex: 0,
      amount: "100",
      destinationChain: 56,
    },
    destination: {
      chain: 56,
      contract: deployment.destination,
      hash: hash("b"),
      blockHash: hash("d"),
      canonicalBlockHash: hash("d"),
      blockNumber: 200,
      successful: true,
      confirmations: 5,
      finalizedBlockNumber: 204,
      txFrom: account,
      txTo: deployment.destination,
      sourceChain: 612055,
      index: "7",
      recipient: account,
      amount: "100",
      token: CROSS,
      held: false,
      eventLogIndex: 1,
      payout: {
        chain: 56,
        transactionHash: hash("b"),
        blockHash: hash("d"),
        logIndex: 0,
        token: CROSS,
        from: deployment.destination,
        recipient: account,
        amount: "100",
        transferIndex: "7",
      },
    },
  },
};
it("C3 only the same-session exact intent with a fresh actual 4001 can be retried", async () => {
  const intent = {
    ...record,
    id: "rejected-in-runtime",
    sourceHash: undefined,
    index: undefined,
    state: "SUBMISSION_UNKNOWN" as const,
  };
  const persist = {
    unknown: async () => {},
    hash: async () => {},
    rejected: async () => {},
  };
  const observe = async () => {
    throw Error("HASHLESS_MUST_NOT_BE_OBSERVED");
  };
  await expect(
    recordSubmission(
      async () => {
        throw { code: 4001 };
      },
      persist,
      intent,
    ),
  ).rejects.toThrow("USER_REJECTED");
  const claims = decodeHistory(
    JSON.stringify([{ ...intent, state: "USER_REJECTED" }]),
  );
  await expect(
    revalidateIntentHistory(claims, account, mainnetNamespace, observe),
  ).resolves.toMatchObject([{ state: "USER_REJECTED" }]);
  for (const changed of [
    { ...claims[0], id: "imported-forged" },
    { ...claims[0], id: "REJECTED-IN-RUNTIME" },
    { ...claims[0], amount: "101" },
    { ...claims[0], sourceHash: hash("a") },
    { ...claims[0], error: "IMPORTED_UNVERIFIED" },
  ])
    await expect(
      revalidateIntentHistory([changed], account, mainnetNamespace, observe),
    ).rejects.toThrow("DUPLICATE_INTENT");
  await expect(
    revalidateIntentHistory(
      claims,
      account,
      mainnetNamespace,
      observe,
      () => Date.now() + 30001,
    ),
  ).rejects.toThrow("DUPLICATE_INTENT");
  vi.resetModules();
  const reloaded = await import("../../src/features/bridge/lifecycle");
  await expect(
    reloaded.revalidateIntentHistory(
      claims,
      account,
      mainnetNamespace,
      observe,
    ),
  ).rejects.toThrow("DUPLICATE_INTENT");
  await expect(
    recordSubmission(
      async () => {
        throw Error("timeout after retry");
      },
      persist,
      intent,
    ),
  ).rejects.toThrow("SUBMISSION_UNKNOWN");
  await expect(
    revalidateIntentHistory(claims, account, mainnetNamespace, observe),
  ).rejects.toThrow("DUPLICATE_INTENT");
});
it("C3 a persistence failure after a hash is not a wallet 4001 rejection", async () => {
  const intent = {
    ...record,
    id: "hash-write-failed",
    sourceHash: undefined,
    state: "SUBMISSION_UNKNOWN" as const,
  };
  const rejected = vi.fn();
  await expect(
    recordSubmission(
      async () => hash("b"),
      {
        unknown: async () => {},
        hash: async () => {
          throw { code: 4001 };
        },
        rejected,
      },
      intent,
    ),
  ).rejects.toThrow("SUBMISSION_UNKNOWN");
  expect(rejected).not.toHaveBeenCalled();
  await expect(
    revalidateIntentHistory(
      [{ ...intent, state: "USER_REJECTED" }],
      account,
      mainnetNamespace,
      async () => undefined,
    ),
  ).rejects.toThrow("DUPLICATE_INTENT");
});
it("C3 malformed hash and ambiguous timeout never become trusted rejection", async () => {
  const intent = {
    ...record,
    id: "timeout-in-runtime",
    sourceHash: undefined,
    state: "SUBMISSION_UNKNOWN" as const,
  };
  const persist = {
    unknown: async () => {},
    hash: async () => {},
    rejected: async () => {},
  };
  await expect(
    recordSubmission(
      async () => {
        throw Error("timeout");
      },
      persist,
      intent,
    ),
  ).rejects.toThrow("SUBMISSION_UNKNOWN");
  await expect(
    revalidateIntentHistory(
      [{ ...intent, state: "USER_REJECTED" }],
      account,
      mainnetNamespace,
      async () => undefined,
    ),
  ).rejects.toThrow("DUPLICATE_INTENT");
});
it("R1/F3 persist/reload claim needs fresh dual-chain proof before success display", () => {
  const claims = decodeHistory(JSON.stringify([record]));
  expect(claims[0].state).toBe("UNVERIFIED_COMPLETION");
  const view = new RuntimeHistoryView();
  expect(view.view(claims, now)[0].state).toBe("UNVERIFIED_COMPLETION");
  view.accept(claims[0], observation, now);
  expect(view.view(claims, now + 1000)[0].state).toBe("COMPLETED");
  expect(new RuntimeHistoryView().view(claims, now)[0].state).toBe(
    "UNVERIFIED_COMPLETION",
  );
  expect(view.view(claims, now + 30001)[0].state).toBe("UNVERIFIED_COMPLETION");
});
it("R1/F3 stored completion is revalidated before duplicate eligibility", async () => {
  const claims = decodeHistory(JSON.stringify([record]));
  let calls = 0;
  const fresh = await revalidateIntentHistory(
    claims,
    account,
    mainnetNamespace,
    async () => {
      calls++;
      return observation;
    },
    () => now,
  );
  expect(calls).toBe(1);
  expect(fresh[0].state).toBe("COMPLETED");
});
it("R1/F3 imported completion, unknown hash, failed and stale observations block", async () => {
  const claims = decodeHistory(JSON.stringify([record]), true);
  const reject = async () => {
    throw Error("RPC unavailable");
  };
  await expect(
    revalidateIntentHistory(
      claims,
      account,
      mainnetNamespace,
      reject,
      () => now,
    ),
  ).rejects.toThrow("DUPLICATE_INTENT");
  await expect(
    revalidateIntentHistory(
      claims,
      account,
      mainnetNamespace,
      async () => ({ ...observation, observedAt: now - 30001 }),
      () => now,
    ),
  ).rejects.toThrow("DUPLICATE_INTENT");
  let calls = 0;
  await expect(
    revalidateIntentHistory(
      [{ ...record, sourceHash: undefined, state: "SUBMISSION_UNKNOWN" }],
      account,
      mainnetNamespace,
      async () => {
        calls++;
        return observation;
      },
      () => now,
    ),
  ).rejects.toThrow("DUPLICATE_INTENT");
  expect(calls).toBe(0);
});
it("R1/F3 mutated storage, unrelated policy and synthetic mainnet success cannot enter runtime view", () => {
  expect(() =>
    validateObservation({ ...record, amount: "101" }, observation, now),
  ).toThrow();
  expect(() =>
    validateObservation(
      record,
      {
        ...observation,
        evidence: {
          ...observation.evidence,
          policy: { ...observation.evidence.policy, sourceContract: account },
        },
      },
      now,
    ),
  ).toThrow();
  expect(() =>
    validateObservation(
      record,
      { kind: "synthetic", record, observedAt: now },
      now,
    ),
  ).toThrow("MODE_MISMATCH");
});
