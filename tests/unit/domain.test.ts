import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { parseAmount, formatAmount, maximum } from "../../src/core/amounts";
import { CROSS, NATIVE, type TransferRecord } from "../../src/core/model";
import {
  preflight,
  prepare,
  validateQuote,
  validateUnsigned,
  bridgeAbi,
} from "../../src/adapters/onebridge";
import {
  classifyReplacement,
  transition,
  verifySettlement,
  type SourceEvidence,
  type DestinationEvidence,
} from "../../src/core/flow";
import { decodeHistory, diagnostic } from "../../src/storage/history";
import { publicIp, validateRpc } from "../../src/adapters/read-only";
import { localQuote } from "../fixtures/local";
const account = "0x3333333333333333333333333333333333333333";
const d = {
  mode: "local-test" as const,
  source: "0x1111111111111111111111111111111111111111",
  destination: "0x2222222222222222222222222222222222222222",
  verified: true,
  nativeSentinel: NATIVE,
  sourceChain: 31337,
  destinationChain: 31338,
  config: "1",
};
const q = () => localQuote(account, "1");
const record: TransferRecord = {
  schema: 1,
  id: "test-1",
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
  sourceHash: `0x${"a".repeat(64)}`,
  index: "7",
  state: "SETTLEMENT_PENDING",
  updatedAt: Date.now(),
};
const source: SourceEvidence = {
  chain: 31337,
  contract: d.source,
  hash: record.sourceHash!,
  blockHash: `0x${"c".repeat(64)}`,
  canonicalBlockHash: `0x${"c".repeat(64)}`,
  blockNumber: 100,
  txFrom: account,
  txTo: d.source,
  sender: account,
  token: NATIVE,
  eventLogIndex: 0,
  successful: true,
  confirmations: 3,
  index: "7",
  recipient: account,
  amount: record.amount,
  destinationChain: 31338,
};
const dest: DestinationEvidence = {
  chain: 31338,
  contract: d.destination,
  hash: `0x${"b".repeat(64)}`,
  blockHash: `0x${"d".repeat(64)}`,
  canonicalBlockHash: `0x${"d".repeat(64)}`,
  blockNumber: 200,
  txFrom: d.source,
  txTo: d.destination,
  eventLogIndex: 1,
  successful: true,
  confirmations: 5,
  index: "7",
  recipient: account,
  amount: record.expected,
  sourceChain: 31337,
  token: CROSS,
  payout: {
    chain: 31338,
    transactionHash: `0x${"b".repeat(64)}`,
    blockHash: `0x${"d".repeat(64)}`,
    logIndex: 0,
    token: CROSS,
    from: d.destination,
    recipient: account,
    amount: record.expected,
    transferIndex: "7",
  },
  held: false,
};
const policy = {
  sourceContract: d.source,
  destinationContract: d.destination,
  sourceConfirmations: 3,
  destinationConfirmations: 5,
};
describe("amount correctness", () => {
  it("M01 retains all 18 digits and floors display", () => {
    expect(parseAmount("1.123456789123456789")).toBe(1123456789123456789n);
    expect(formatAmount(1999999999999999999n, 4)).toBe("1.9999");
  });
  it.each([
    "0",
    "-1",
    "NaN",
    "1e18",
    " 1",
    "1 ",
    "01",
    "1.0000000000000000001",
    "9".repeat(81),
    "1,000",
    "1,25",
  ])("M02/M03 rejects %s", (v) => expect(() => parseAmount(v)).toThrow());
  it("M04/M05 MAX preserves gas with amount dependent fee", () => {
    const balance = 100n * 10n ** 18n,
      gas = 10n ** 15n,
      fee = (v: bigint) => v / 1000n + 10n ** 16n;
    const max = maximum(balance, gas, fee);
    expect(max + fee(max) + gas).toBeLessThanOrEqual(balance);
    expect(max).toBeGreaterThan(99n * 10n ** 18n);
    expect(maximum(1n, 2n, () => 0n)).toBe(0n);
    expect(maximum(balance, gas, fee, 99n * 10n ** 18n)).toBe(99n * 10n ** 18n);
  });
});
describe("route, quote and payload", () => {
  it("A01/M06 only encodes native bridge, exact value and empty extraData", () => {
    const quote = q(),
      tx = prepare(quote, d),
      decoded = decodeFunctionData({ abi: bridgeAbi, data: tx.data });
    expect(decoded.args[1]).toBe(NATIVE);
    expect(decoded.args[6]).toBe("0x");
    expect(tx.value).toBe(quote.amount + quote.networkFee + quote.serviceFee);
    expect(decoded.functionName).toBe("bridgeToken");
    expect(() =>
      validateUnsigned({ ...tx, value: tx.value + 1n }, quote, d),
    ).toThrow("PAYLOAD_MISMATCH");
  });
  it.each([
    "token",
    "sourceChain",
    "destinationChain",
    "recipient",
    "route",
    "config",
  ] as const)("A02-A05/Q03/S05 rejects changed %s", (key) => {
    const quote = q();
    const bad = { ...quote, [key]: key.includes("Chain") ? 1 : d.source };
    expect(() => validateQuote(bad, account, 31337)).toThrow();
  });
  it("A06/Q04 refuses sentinel/router drift and unverified ABI", () => {
    expect(() =>
      prepare(q(), {
        ...d,
        nativeSentinel: "0xfeed00000000000000000000000000000000c0de",
      }),
    ).toThrow();
    expect(() => prepare(q(), { ...d, verified: false })).toThrow(
      "DEPLOYMENT_UNVERIFIED",
    );
    const quote = q();
    expect(() =>
      validateUnsigned({ ...prepare(quote, d), to: account }, quote, d),
    ).toThrow();
  });
  it("Q02 expiry refuses old quote", () =>
    expect(() =>
      validateQuote({ ...q(), expiresAt: Date.now() - 1 }, account, 31337),
    ).toThrow("QUOTE_EXPIRED"));
  it("Q03 arbitrary extraData and modified fees are rejected", () => {
    const quote = q();
    const tx = prepare(quote, d);
    const data = encodeFunctionData({
      abi: bridgeAbi,
      functionName: "bridgeToken",
      args: [
        31338n,
        NATIVE,
        account,
        quote.amount,
        quote.networkFee,
        quote.serviceFee,
        "0xab",
      ],
    });
    expect(() => validateUnsigned({ ...tx, data }, quote, d)).toThrow();
    expect(() =>
      validateUnsigned(tx, { ...quote, networkFee: quote.networkFee + 1n }, d),
    ).toThrow();
  });
  const context = {
    account,
    chain: 31337,
    balance: 100n * 10n ** 18n,
    sourceCode: "0x",
    destinationCode: "0x",
    healthFresh: true,
    reserveKnown: true,
    paused: false,
    simulation: true,
  };
  it("positive preflight returns an unsigned native call", () =>
    expect(preflight(q(), d, context).to).toBe(d.source));
  it.each([
    { sourceCode: "0xef0100abc" },
    { destinationCode: "0x1234" },
    { reserveKnown: false },
    { healthFresh: false },
    { paused: true },
    { simulation: false },
    { balance: 0n },
  ])("W06/Q05/Q06/G01 blocks unsafe preflight case $#", (override) =>
    expect(() => preflight(q(), d, { ...context, ...override })).toThrow(),
  );
});
describe("settlement correlation and recovery", () => {
  it("T01 source alone is pending; verified dual evidence completes", () => {
    expect(verifySettlement(record, source, undefined, policy)).toBe(
      "SETTLEMENT_PENDING",
    );
    expect(verifySettlement(record, source, dest, policy)).toBe("COMPLETED");
  });
  it("T02 source revert never starts settlement", () =>
    expect(
      verifySettlement(record, { ...source, successful: false }, dest, policy),
    ).toBe("SOURCE_REVERTED"));
  it.each([
    { index: "8" },
    { recipient: d.source },
    { token: d.source },
    { amount: "1" },
    { chain: 56 },
    { sourceChain: 1 },
    { contract: account },
    { payout: false },
    { successful: false },
  ])("T03/T04/T05 rejects unrelated payout %j", (override) =>
    expect(
      verifySettlement(record, source, { ...dest, ...override }, policy),
    ).toBe("UNVERIFIED_COMPLETION"),
  );
  it("T06 held is not completed until correlated release payout", () => {
    expect(
      verifySettlement(
        record,
        source,
        { ...dest, held: true, payout: false },
        policy,
      ),
    ).toBe("HELD_FOR_REVIEW");
    expect(
      verifySettlement(
        record,
        source,
        { ...dest, held: true, payout: dest.payout },
        policy,
      ),
    ).toBe("COMPLETED");
  });
  it("T08 reorg and confirmation shortfalls re-evaluate completion", () => {
    expect(
      verifySettlement(
        record,
        { ...source, canonicalBlockHash: "reorg" },
        dest,
        policy,
      ),
    ).toBe("UNVERIFIED_COMPLETION");
    expect(
      verifySettlement(
        record,
        source,
        { ...dest, canonicalBlockHash: "reorg" },
        policy,
      ),
    ).toBe("UNVERIFIED_COMPLETION");
    expect(
      verifySettlement(record, source, { ...dest, confirmations: 4 }, policy),
    ).toBe("DESTINATION_CONFIRMING");
  });
  it("T09 no source evidence is tracking unavailable, never refunded", () =>
    expect(verifySettlement(record, undefined, undefined, policy)).toBe(
      "TRACKING_UNAVAILABLE",
    ));
  it("T07 replacement classifies speedup, cancellation and changed intent", () => {
    const tx = {
      from: account,
      chainId: 31337,
      to: d.source,
      data: "0xab",
      value: "10",
      nonce: 1,
    };
    expect(classifyReplacement(tx, tx, account)).toBe("SOURCE_REPLACED");
    expect(
      classifyReplacement(
        tx,
        { ...tx, to: account, data: "0x", value: "0", nonce: 1 },
        account,
      ),
    ).toBe("SOURCE_CANCELLED");
    expect(classifyReplacement(tx, { ...tx, value: "11" }, account)).toBe(
      "MANUAL_ACTION_REQUIRED",
    );
  });
  it("state machine cannot jump from submitted to completed or retry uncertain submission", () => {
    expect(() => transition("SOURCE_SUBMITTED", "COMPLETED")).toThrow();
    expect(() => transition("SUBMISSION_UNKNOWN", "AWAITING_WALLET")).toThrow();
    expect(transition("HELD_FOR_REVIEW", "DESTINATION_CONFIRMING")).toBe(
      "DESTINATION_CONFIRMING",
    );
  });
});
describe("history and RPC boundary", () => {
  it("P02/P03 imported success is untrusted and strict schema rejects poisoning", () => {
    expect(
      decodeHistory(
        JSON.stringify([{ ...record, state: "COMPLETED" }]),
        true,
      )[0].state,
    ).toBe("UNVERIFIED_COMPLETION");
    expect(() =>
      decodeHistory(JSON.stringify([{ ...record, secret: "x" }])),
    ).toThrow();
    expect(() => decodeHistory("x".repeat(150001))).toThrow("IMPORT_TOO_LARGE");
    expect(() => decodeHistory('[{"id":"<script>"}]')).toThrow();
    expect(() =>
      decodeHistory(JSON.stringify([{ ...record, recipient: d.source }])),
    ).toThrow();
  });
  it("X04 diagnostics omit account, amount and hashes by default", () => {
    const text = JSON.stringify(diagnostic(record));
    expect(text).not.toContain(account);
    expect(text).not.toContain(record.sourceHash);
    expect(diagnostic(record, true)).toMatchObject({ account });
  });
  it.each([
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_sign",
    "personal_sign",
    "eth_signTypedData_v4",
    "eth_getLogs",
  ])("S02/X02 RPC rejects %s", (m) =>
    expect(() => validateRpc(m, [])).toThrow("RPC_NOT_ALLOWED"),
  );
  it("read method params are constrained to allowed contracts and known metadata selectors", () => {
    expect(() =>
      validateRpc("eth_call", [{ to: account, data: "0x313ce567" }, "latest"]),
    ).toThrow();
    expect(() =>
      validateRpc("eth_call", [{ to: CROSS, data: "0x313ce567" }, "latest"]),
    ).not.toThrow();
    expect(() =>
      validateRpc("eth_getBlockByNumber", ["0x10", false]),
    ).not.toThrow();
  });
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])("X01 rejects private/reserved %s", (ip) =>
    expect(publicIp(ip)).toBe(false),
  );
});
