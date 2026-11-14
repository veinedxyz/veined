import { afterEach, expect, it, vi } from "vitest";
import { CROSS, NATIVE, type TransferRecord } from "../../src/core/model";
import { verifySettlement } from "../../src/core/flow";
import { assertNoUnresolved } from "../../src/features/bridge/lifecycle";
import {
  bindExternalWallet,
  requestOnce,
} from "../../src/features/wallet/provider";
import { validateQuote } from "../../src/adapters/onebridge";
import { localQuote } from "../fixtures/local";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const account = "0x3333333333333333333333333333333333333333";
const sourceContract = "0x1111111111111111111111111111111111111111";
const destinationContract = "0x2222222222222222222222222222222222222222";
const hash = (n: string) => `0x${n.repeat(64)}`;
const record: TransferRecord = {
  schema: 1,
  id: "r1",
  mode: "local-test",
  route: "one-native-to-bsc-cross",
  config: "1",
  sourceChain: 31337,
  destinationChain: 31338,
  account,
  recipient: account,
  sourceAsset: "native:ONE",
  token: CROSS,
  amount: "1000000000000000000",
  expected: "1000000000000000000",
  sourceHash: hash("a"),
  index: "7",
  state: "SETTLEMENT_PENDING",
  updatedAt: Date.now(),
};
const source = {
  chain: 31337,
  contract: sourceContract,
  hash: record.sourceHash!,
  blockHash: hash("c"),
  canonicalBlockHash: hash("c"),
  blockNumber: 100,
  successful: true,
  confirmations: 3,
  txFrom: account,
  txTo: sourceContract,
  index: "7",
  sender: account,
  token: NATIVE,
  eventLogIndex: 0,
  recipient: account,
  amount: record.amount,
  destinationChain: 31338,
};
const destination = {
  chain: 31338,
  contract: destinationContract,
  hash: hash("b"),
  blockHash: hash("d"),
  canonicalBlockHash: hash("d"),
  blockNumber: 200,
  successful: true,
  confirmations: 5,
  txFrom: sourceContract,
  txTo: destinationContract,
  sourceChain: 31337,
  index: "7",
  eventLogIndex: 1,
  recipient: account,
  amount: record.expected,
  token: CROSS,
  held: false,
  payout: {
    chain: 31338,
    transactionHash: hash("b"),
    blockHash: hash("d"),
    logIndex: 0,
    token: CROSS,
    from: destinationContract,
    recipient: account,
    amount: record.expected,
    transferIndex: "7",
  },
};
const policy = {
  sourceContract,
  destinationContract,
  sourceConfirmations: 3,
  destinationConfirmations: 5,
};
it("R1/F2 positive control uses exact canonical event and ERC20 payout identities", () => {
  expect(verifySettlement(record, source, destination, policy)).toBe(
    "COMPLETED",
  );
});
it("R1/F2 canonical reverted receipt does not need a nonexistent event", () => {
  const {
    index,
    sender,
    recipient,
    amount,
    token,
    destinationChain,
    eventLogIndex,
    ...receipt
  } = source;
  void [
    index,
    sender,
    recipient,
    amount,
    token,
    destinationChain,
    eventLogIndex,
  ];
  expect(
    verifySettlement(
      record,
      { ...receipt, successful: false },
      undefined,
      policy,
    ),
  ).toBe("SOURCE_REVERTED");
});
it.each([NaN, Infinity, -1, 0.5, undefined])(
  "R1/F2 rejects malformed confirmation count %s",
  (count) => {
    expect(
      verifySettlement(
        record,
        { ...source, confirmations: count as number },
        destination,
        policy,
      ),
    ).toBe("UNVERIFIED_COMPLETION");
  },
);
it("R1/F2 caller-provided payout boolean and reused payment cannot prove delivery", () => {
  expect(
    verifySettlement(record, source, { ...destination, payout: true }, policy),
  ).toBe("UNVERIFIED_COMPLETION");
  const owners = new Map([[`31338:${hash("b")}:0`, "unrelated-intent"]]);
  expect(verifySettlement(record, source, destination, policy, owners)).toBe(
    "UNVERIFIED_COMPLETION",
  );
});
it("R1/F2 rejects unrelated reverted receipt before a terminal classification", () => {
  expect(
    verifySettlement(
      record,
      {
        ...source,
        successful: false,
        hash: hash("f"),
        chain: 56,
        contract: account,
      },
      undefined,
      policy,
    ),
  ).toBe("UNVERIFIED_COMPLETION");
});
it("R1/F2 rejects unrelated held event before held classification", () => {
  expect(
    verifySettlement(
      record,
      source,
      {
        ...destination,
        index: "8",
        recipient: sourceContract,
        contract: account,
        held: true,
        payout: false,
      },
      policy,
    ),
  ).toBe("UNVERIFIED_COMPLETION");
});
it("R1/F2 rejects NaN confirmations", () => {
  expect(
    verifySettlement(
      record,
      { ...source, confirmations: NaN },
      destination,
      policy,
    ),
  ).toBe("UNVERIFIED_COMPLETION");
});
it("R1/F3 synthetic unresolved intent cannot lock the mainnet namespace", () => {
  expect(() =>
    assertNoUnresolved([record], account, {
      mode: "mainnet-readonly",
      route: record.route,
      config: "1",
      sourceChain: 612055,
      destinationChain: 56,
    }),
  ).not.toThrow();
});
it("R1/F4 binding times out when the account read succeeded but the chain read never resolves", async () => {
  vi.useFakeTimers();
  let outcome = "pending";
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) =>
      method === "eth_accounts" ? [account] : new Promise(() => {}),
    ),
  };
  void bindExternalWallet(provider, account).then(
    () => {
      outcome = "connected";
    },
    (e: { code: string }) => {
      outcome = e.code;
    },
  );
  await vi.advanceTimersByTimeAsync(21000);
  expect(outcome).toBe("WALLET_READ_TIMEOUT");
});
it("R1/F4 synchronous provider throw must release pending request lock", async () => {
  const provider = {
    request: vi.fn(() => {
      throw Error("sync throw");
    }),
  };
  await expect(requestOnce(provider, "eth_requestAccounts")).rejects.toThrow(
    "sync throw",
  );
  await expect(requestOnce(provider, "eth_requestAccounts")).rejects.toThrow(
    "sync throw",
  );
  expect(provider.request).toHaveBeenCalledTimes(2);
});
it("R1/F5 quote must match the current form amount", () => {
  const quote = localQuote(account, "1");
  expect(() =>
    validateQuote(quote, account, 31337, Date.now(), 2n * 10n ** 18n),
  ).toThrow("IDENTITY_CHANGED");
});
