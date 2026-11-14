import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import {
  encodeEventTopics,
  encodeAbiParameters,
  toHex,
  encodeFunctionResult,
  decodeFunctionData,
} from "viem";
const network = vi.hoisted(() => ({ rpc: vi.fn(), history: vi.fn() }));
vi.mock("../../src/adapters/read-only", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/adapters/read-only")>();
  return {
    ...real,
    rpc: async (chain: string, method: string, params: unknown[] = []) => {
      real.validateRpc(method, params);
      return network.rpc(chain, method, params);
    },
    boundedRequest: network.history,
  };
});
import { POST } from "../../src/app/api/bridge/route";
import { CROSS, type TransferRecord } from "../../src/core/model";
import { READ_ONLY_DEPLOYMENT as deployment } from "../../src/adapters/deployment";
import {
  decodeNativeSource,
  decodeNativeDestination,
  type ReceiptRead,
} from "../../src/adapters/native-decoder";
import { nativePolicy } from "../../src/adapters/native-service";
import { nativeReadAbi } from "../../src/adapters/native-abi";
import { bridgeAbi } from "../../src/adapters/onebridge";
import { verifySettlement } from "../../src/core/flow";
import { G5_ROUTE_PINS } from "../../src/g5/route-pins";
import { keccak256 } from "viem";
import { validateObservation } from "../../src/features/bridge/observation";
import {
  withVerifiedIntent,
  mainnetNamespace,
} from "../../src/features/bridge/lifecycle";
const load = (name: string) =>
  JSON.parse(
    readFileSync(`evidence/otherbridge-v1/repair-r1/live/${name}.json`, "utf8"),
  );
const sample = load("public-settlement");
const raw = sample.sample;
const discovery = load("discovery");
const corrected = load("corrected-fresh");
const now = Date.parse(sample.at);
// V1.6: verifier/token runtimes and settlement-trust values pinned at the V1.6 evidence blocks.
const g5Runtimes = JSON.parse(
  readFileSync("tests/fixtures/g5/runtimes.json", "utf8"),
);
const roleId = (r: string) =>
  r === "DEFAULT_ADMIN_ROLE" ? `0x${"0".repeat(64)}` : keccak256(toHex(r));
function g5Read(chain: "one" | "bsc", method: string, params: unknown[]) {
  const side =
    chain === "one" ? G5_ROUTE_PINS.source : G5_ROUTE_PINS.destination;
  const p0 = params[0] as { to?: string; data?: string } | string;
  if (method === "eth_getCode" && typeof p0 === "string") {
    if (p0.toLowerCase() === side.verifier)
      return chain === "one" ? g5Runtimes.oneVerifier : g5Runtimes.bscVerifier;
    if (chain === "bsc" && p0.toLowerCase() === CROSS.toLowerCase())
      return g5Runtimes.crossToken;
  }
  if (method !== "eth_call" || typeof p0 !== "object" || !p0.data)
    return undefined;
  let decoded;
  try {
    decoded = decodeFunctionData({
      abi: nativeReadAbi,
      data: p0.data as `0x${string}`,
    });
  } catch {
    return undefined;
  }
  const enc = (functionName: string, result: unknown) =>
    encodeFunctionResult({ abi: nativeReadAbi, functionName, result } as never);
  switch (decoded.functionName) {
    case "threshold":
      return enc("threshold", side.settlement.threshold);
    case "getRoleMembers": {
      const role = String(decoded.args[0]).toLowerCase();
      const s = side.settlement;
      if (role === roleId("VALIDATOR_ROLE"))
        return enc("getRoleMembers", s.validators);
      if (
        role === roleId("ADMIN_ROLE") ||
        role === roleId("DEFAULT_ADMIN_ROLE")
      )
        return enc("getRoleMembers", s.admins);
      if (role === roleId("VERIFIER_ROLE"))
        return enc("getRoleMembers", s.verifierRole);
      return undefined;
    }
    case "bridgeVerifier":
      return chain === "bsc" ? enc("bridgeVerifier", side.verifier) : undefined;
    case "getNextInitiateIndex":
    case "getNextFinalizeIndex":
      // equal indices: no in-flight ONE->BSC transfer at the replayed pin
      return enc(decoded.functionName, 98729n);
    case "allPendingIndex":
      return enc("allPendingIndex", []);
  }
  return undefined;
}
const claim: TransferRecord = {
  schema: 1,
  id: "public-native-replay",
  mode: "mainnet-readonly",
  route: "one-native-to-bsc-cross",
  config: "1",
  sourceChain: 612055,
  destinationChain: 56,
  account: raw.sourceTransaction.from,
  recipient: raw.sourceTransaction.from,
  sourceAsset: "native:ONE",
  token: CROSS,
  amount: "12094599106825003813",
  expected: "12094599106825003813",
  sourceHash: raw.sourceTransaction.hash,
  state: "UNVERIFIED_COMPLETION",
  updatedAt: now,
};
function read(chain: "source" | "destination"): ReceiptRead {
  return {
    receipt: structuredClone(raw[`${chain}Receipt`]),
    transaction: structuredClone(raw[`${chain}Transaction`]),
    block: structuredClone(raw[`${chain}Block`]),
    finalized: structuredClone(raw[`${chain}Finalized`]),
    chainId: chain === "source" ? 612055 : 56,
  };
}
function request(body: unknown) {
  return new NextRequest("http://127.0.0.1:3100/api/bridge", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:3100", Host: "127.0.0.1:3100" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(Date, "now").mockReturnValue(now);
  network.history.mockReset().mockResolvedValue(sample.history);
  network.rpc
    .mockReset()
    .mockImplementation(
      async (chain: "one" | "bsc", method: string, params: unknown[]) => {
        const name = chain === "one" ? "source" : "destination";
        if (method === "eth_chainId")
          return toHex(chain === "one" ? 612055 : 56);
        const g5 = g5Read(chain, method, params);
        if (g5 !== undefined) return g5;
        if (method === "eth_getBlockByNumber") {
          if (params[0] === "latest" || params[0] === "finalized")
            return raw[`${name}Finalized`];
          // V1.6 pins reads PIN_LAG (3) blocks behind the reported head.
          const head = raw[`${name}Finalized`];
          if (BigInt(params[0] as string) === BigInt(head.number) - 3n)
            return { ...head, number: params[0] };
          return raw[`${name}Block`];
        }
        if (method === "eth_getStorageAt")
          return `0x${"0".repeat(24)}${discovery.snapshots[chain].implementation.slice(2)}`;
        if (method === "eth_getCode")
          return discovery.calls.find(
            (c: { chain: string; method: string; params: unknown[] }) =>
              c.chain === chain &&
              c.method === method &&
              c.params[0] === params[0],
          )?.result;
        if (method === "eth_getTransactionReceipt")
          return raw[`${name}Receipt`];
        if (method === "eth_getTransactionByHash")
          return raw[`${name}Transaction`];
        throw Error(`UNRECORDED_RPC_${method}`);
      },
    );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("R1/F3 real observer completion is revalidated under lock before eligibility, while storage failure/unknown stay blocked", async () => {
  let storage = JSON.stringify([{ ...claim, state: "COMPLETED" }]);
  let available = true;
  vi.stubGlobal("localStorage", { getItem: () => storage });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        key: string,
        options: unknown,
        callback: (lock: unknown) => Promise<unknown>,
      ) => {
        expect(key).toContain("mainnet-readonly");
        expect(options).toEqual({ ifAvailable: true });
        return callback(available ? { name: key } : null);
      },
    },
  });
  const observe = vi.fn(async (record: TransferRecord) => {
    const response = await POST(request({ action: "track", record }));
    expect(response.status).toBe(200);
    return response.json();
  });
  const eligible = vi.fn(async (records: TransferRecord[]) => records[0].state);
  expect(
    await withVerifiedIntent(
      claim.account,
      mainnetNamespace,
      observe,
      eligible,
    ),
  ).toBe("COMPLETED");
  expect(observe).toHaveBeenCalledOnce();
  expect(eligible).toHaveBeenCalledOnce();
  available = false;
  await expect(
    withVerifiedIntent(claim.account, mainnetNamespace, observe, eligible),
  ).rejects.toThrow("DUPLICATE_INTENT");
  expect(observe).toHaveBeenCalledOnce();
  available = true;
  storage = JSON.stringify([
    { ...claim, sourceHash: undefined, state: "SUBMISSION_UNKNOWN" },
  ]);
  await expect(
    withVerifiedIntent(claim.account, mainnetNamespace, observe, eligible),
  ).rejects.toThrow("DUPLICATE_INTENT");
  expect(observe).toHaveBeenCalledOnce();
  const oversized = " ".repeat(150001);
  storage = oversized;
  await expect(
    withVerifiedIntent(claim.account, mainnetNamespace, observe, eligible),
  ).rejects.toThrow("HISTORY_UNREADABLE");
  expect(storage).toBe(oversized);
  expect(eligible).toHaveBeenCalledOnce();
});
it("R1/F1 pinned public native source + destination payout replay through real API/observer", async () => {
  const response = await POST(request({ action: "track", record: claim }));
  expect(response.status).toBe(200);
  const observation = await response.json();
  expect(validateObservation(claim, observation, now).record.state).toBe(
    "COMPLETED",
  );
  expect(observation.record.index).toBe("98483");
  expect(observation.record.destinationHash).toBe(
    raw.destinationTransaction.hash,
  );
  expect(observation.evidence.destination.payout.logIndex).toBe(199);
  expect(network.history).toHaveBeenCalledOnce();
  expect(
    network.rpc.mock.calls.every(
      ([, method]) => !/send|sign|deploy|permit/i.test(method),
    ),
  ).toBe(true);
});
it("C3 reloaded rejected claim without a hash requires manual read-only recovery", async () => {
  const stored = {
    ...claim,
    sourceHash: undefined,
    state: "USER_REJECTED" as const,
  };
  const response = await POST(request({ action: "track", record: stored }));
  expect(response.status).toBe(200);
  const observation = await response.json();
  expect(validateObservation(stored, observation, now).record.state).toBe(
    "SUBMISSION_UNKNOWN",
  );
  expect(observation.record.error).toBe("MANUAL_ACTION_REQUIRED");
  expect(network.rpc).not.toHaveBeenCalled();
});
it("R1/F3 untrusted destination hash cannot prevent recovery from a public receipt proof", async () => {
  const wrongHash = `0x${"e".repeat(64)}`;
  const original = network.rpc.getMockImplementation()!;
  network.rpc.mockImplementation(async (...args) =>
    args[0] === "bsc" &&
    ["eth_getTransactionReceipt", "eth_getTransactionByHash"].includes(
      args[1],
    ) &&
    args[2][0] === wrongHash
      ? null
      : original(...args),
  );
  const response = await POST(
    request({
      action: "track",
      record: { ...claim, destinationHash: wrongHash },
    }),
  );
  const observation = await response.json();
  expect(response.status).toBe(200);
  expect(observation.record.state).toBe("COMPLETED");
  expect(observation.record.destinationHash).toBe(
    raw.destinationTransaction.hash,
  );
  expect(network.history).toHaveBeenCalledOnce();
});
it("R1/F1 public destination hints use bounded pagination for older transfers", async () => {
  network.history
    .mockReset()
    .mockResolvedValueOnce({
      code: 200,
      data: { histories: Array(20).fill({ source: "swap" }) },
    })
    .mockResolvedValueOnce(sample.history);
  const response = await POST(request({ action: "track", record: claim }));
  expect(response.status).toBe(200);
  expect((await response.json()).record.state).toBe("COMPLETED");
  expect(network.history.mock.calls.map(([, body]) => body.page)).toEqual([
    1, 2,
  ]);
});
it.each(["held", "reorg"])(
  "C2 stored %s candidate discovers later finalization through the actual API",
  async (scenario) => {
    const oldHash = `0x${"e".repeat(64)}`;
    const old = read("destination");
    const receipt = old.receipt as typeof raw.destinationReceipt;
    const tx = old.transaction as typeof raw.destinationTransaction;
    receipt.transactionHash = oldHash;
    tx.hash = oldHash;
    const event = structuredClone(receipt.logs[1]);
    event.transactionHash = oldHash;
    event.topics = encodeEventTopics({
      abi: nativeReadAbi,
      eventName: "BridgePending",
      args: { fromChainID: 612055n, index: 98483n, toToken: CROSS },
    });
    event.data = encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
      ],
      [
        claim.recipient as `0x${string}`,
        BigInt(claim.expected),
        1790885904n,
        1,
      ],
    );
    receipt.logs = [event];
    const original = network.rpc.getMockImplementation()!;
    let oldRead = false;
    network.rpc.mockImplementation(async (...args) => {
      const [chain, method, params] = args;
      if (chain === "bsc" && params[0] === oldHash) {
        oldRead = true;
        if (method === "eth_getTransactionReceipt") return receipt;
        if (method === "eth_getTransactionByHash") return tx;
      }
      if (
        scenario === "reorg" &&
        oldRead &&
        chain === "bsc" &&
        method === "eth_getBlockByNumber" &&
        params[0] === receipt.blockNumber
      ) {
        oldRead = false;
        return { ...raw.destinationBlock, hash: `0x${"f".repeat(64)}` };
      }
      return original(...args);
    });
    const stored = {
      ...claim,
      destinationHash: oldHash,
      state: "HELD_FOR_REVIEW" as const,
    };
    const response = await POST(request({ action: "track", record: stored }));
    expect(response.status).toBe(200);
    const observation = await response.json();
    expect(validateObservation(stored, observation, now).record.state).toBe(
      "COMPLETED",
    );
    expect(observation.record.destinationHash).toBe(
      raw.destinationTransaction.hash,
    );
    expect(network.history).toHaveBeenCalledOnce();
    expect(observation.evidence.destination.payout.logIndex).toBe(199);
  },
);
it("C2 exhausting bounded history is explicit and cannot manufacture completion", async () => {
  network.history.mockResolvedValue({
    code: 200,
    data: { histories: Array(20).fill({ source: "swap" }) },
  });
  const response = await POST(request({ action: "track", record: claim }));
  const observation = await response.json();
  expect(response.status).toBe(200);
  expect(observation.record.state).toBe("SETTLEMENT_PENDING");
  expect(observation.record.error).toBe("DESTINATION_DISCOVERY_BOUNDED");
  expect(network.history.mock.calls.map(([, body]) => body.page)).toEqual([
    1, 2, 3,
  ]);
});
it("R1/F2 reverted transaction must belong to the exact native calldata intent, without an event", () => {
  const reverted = read("source");
  const receipt = reverted.receipt as typeof raw.sourceReceipt;
  receipt.status = "0x0";
  receipt.logs = [];
  const source = decodeNativeSource(claim, reverted);
  expect(verifySettlement(claim, source, undefined, nativePolicy)).toBe(
    "SOURCE_REVERTED",
  );
  expect(() => decodeNativeSource({ ...claim, amount: "1" }, reverted)).toThrow(
    "UNRELATED_SOURCE_INTENT",
  );
});
it("R1/F2 source reorg and nonfinalized destination cannot yield completion", () => {
  const sourceRead = read("source"),
    destinationRead = read("destination");
  const source = decodeNativeSource(claim, sourceRead),
    record = { ...claim, index: source.index };
  (sourceRead.block as typeof raw.sourceBlock).hash = `0x${"f".repeat(64)}`;
  expect(
    verifySettlement(
      record,
      decodeNativeSource(claim, sourceRead),
      undefined,
      nativePolicy,
    ),
  ).toBe("UNVERIFIED_COMPLETION");
  (destinationRead.finalized as typeof raw.destinationBlock).number = toHex(
    BigInt(raw.destinationReceipt.blockNumber) - 1n,
  );
  expect(
    verifySettlement(
      record,
      source,
      decodeNativeDestination(record, source, destinationRead),
      nativePolicy,
    ),
  ).toBe("DESTINATION_CONFIRMING");
});
it.each([
  "missing",
  "wrong-recipient",
  "duplicate-payment",
  "wrong-emitter",
  "duplicate-event",
])("R1/F2 actual decoder rejects %s payout evidence", (mutation) => {
  const source = decodeNativeSource(claim, read("source")),
    record = { ...claim, index: source.index };
  const destinationRead = read("destination"),
    receipt = destinationRead.receipt as typeof raw.destinationReceipt;
  const payment = receipt.logs[0],
    event = receipt.logs[1];
  if (mutation === "missing") receipt.logs = [event];
  if (mutation === "wrong-emitter") payment.address = deployment.source;
  if (mutation === "wrong-recipient")
    payment.topics[2] = toHex(1n, { size: 32 });
  if (mutation === "duplicate-payment")
    receipt.logs.push({ ...payment, logIndex: "0xc6" });
  if (mutation === "duplicate-event")
    receipt.logs.push({ ...event, logIndex: "0xc9" });
  expect(() =>
    decodeNativeDestination(record, source, destinationRead),
  ).toThrow();
});
it("R1/F2 equal-value batch items receive separate ordered ERC20 proof ownership", () => {
  const source = decodeNativeSource(claim, read("source")),
    record = { ...claim, index: source.index };
  const destinationRead = read("destination"),
    receipt = destinationRead.receipt as typeof raw.destinationReceipt;
  const payment = receipt.logs[0],
    event = receipt.logs[1];
  const another = { ...event, logIndex: "0xc6", topics: [...event.topics] };
  another.topics[2] = toHex(98482n, { size: 32 });
  receipt.logs = [{ ...payment, logIndex: "0xc5" }, another, payment, event];
  const result = decodeNativeDestination(record, source, destinationRead);
  expect(result.payout).toMatchObject({
    logIndex: 199,
    transferIndex: "98483",
  });
  receipt.logs = [receipt.logs[0], another, event];
  expect(() =>
    decodeNativeDestination(record, source, destinationRead),
  ).toThrow("AMBIGUOUS_OR_MISSING_PAYOUT");
});
it("R1/F2 matching held event must have canonical finalized identity", () => {
  const source = decodeNativeSource(claim, read("source")),
    record = { ...claim, index: source.index };
  const destinationRead = read("destination"),
    receipt = destinationRead.receipt as typeof raw.destinationReceipt;
  const pending = {
    ...receipt.logs[1],
    topics: encodeEventTopics({
      abi: [
        {
          type: "event",
          name: "BridgePending",
          inputs: [
            { name: "fromChainID", type: "uint256", indexed: true },
            { name: "index", type: "uint256", indexed: true },
            { name: "toToken", type: "address", indexed: true },
            { name: "to", type: "address", indexed: false },
            { name: "value", type: "uint256", indexed: false },
            { name: "time", type: "uint256", indexed: false },
            { name: "status", type: "uint8", indexed: false },
          ],
        },
      ],
      eventName: "BridgePending",
      args: { fromChainID: 612055n, index: 98483n, toToken: CROSS },
    }),
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
      ],
      [
        claim.recipient as `0x${string}`,
        BigInt(claim.expected),
        1790885904n,
        1,
      ],
    ),
  };
  receipt.logs = [pending];
  expect(
    verifySettlement(
      record,
      source,
      decodeNativeDestination(record, source, destinationRead),
      nativePolicy,
    ),
  ).toBe("HELD_FOR_REVIEW");
  (destinationRead.block as typeof raw.destinationBlock).hash =
    `0x${"f".repeat(64)}`;
  expect(
    verifySettlement(
      record,
      source,
      decodeNativeDestination(record, source, destinationRead),
      nativePolicy,
    ),
  ).toBe("UNVERIFIED_COMPLETION");
});
it("R1/F1 changed proxy bytecode fails closed in the actual tracking API", async () => {
  const original = network.rpc.getMockImplementation()!;
  network.rpc.mockImplementation(async (...args) =>
    args[1] === "eth_getCode" && args[2][0] === deployment.destination
      ? "0x6000"
      : original(...args),
  );
  const response = await POST(request({ action: "track", record: claim }));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: "DEPLOYMENT_CHANGED" });
});
it("V1.6 CBU-09: a bridge or token contract can never be quoted as account/recipient (no RPC issued)", async () => {
  for (const account of [deployment.destination, deployment.source, CROSS]) {
    network.rpc.mockClear();
    const response = await POST(
      request({ action: "quote", account, amount: "12" }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "UNSUPPORTED_ACCOUNT" });
    expect(network.rpc).not.toHaveBeenCalled();
  }
});
it("R1/F1 actual quote uses recorded pair/fee ABI reads and a funded EOA simulation transport double", async () => {
  const original = network.rpc.getMockImplementation()!;
  network.rpc.mockImplementation(async (chain, method, params) => {
    const g5 = g5Read(chain, method, params);
    if (g5 !== undefined) return g5;
    if (method === "eth_gasPrice") return "0xb2d05e00";
    if (method === "eth_estimateGas") return "0x1e604";
    if (method === "eth_getBalance") return toHex(100n * 10n ** 18n);
    if (method === "eth_getCode" && params[0] === claim.account) return "0x";
    if (method === "eth_call" && params[0].from) {
      const call = decodeFunctionData({ abi: bridgeAbi, data: params[0].data });
      expect(call.args[3]).toBe(12n * 10n ** 18n);
      expect(BigInt(params[0].value)).toBe(
        call.args[3] + call.args[4] + call.args[5],
      );
      return encodeFunctionResult({
        abi: bridgeAbi,
        functionName: "bridgeToken",
        result: true,
      });
    }
    if (method === "eth_call") {
      const call = corrected.calls.find(
        (c: {
          chain: string;
          method: string;
          params: { to?: string; data?: string }[];
        }) =>
          c.chain === chain &&
          c.method === method &&
          c.params[0].to?.toLowerCase() === params[0].to.toLowerCase() &&
          c.params[0].data?.slice(0, 10) === params[0].data.slice(0, 10),
      );
      if (call) return call.result;
      const decoded = decodeFunctionData({
        abi: nativeReadAbi,
        data: params[0].data,
      });
      if (decoded.functionName === "paused")
        return encodeFunctionResult({
          abi: nativeReadAbi,
          functionName: "paused",
          result: false,
        });
      if (decoded.functionName === "bridgeVerifier")
        return encodeFunctionResult({
          abi: nativeReadAbi,
          functionName: "bridgeVerifier",
          result: deployment.sourceVerifier,
        });
    }
    return original(chain, method, params);
  });
  const response = await POST(
    request({ action: "quote", account: claim.account, amount: "12" }),
  );
  expect(response.status).toBe(200);
  const quote = await response.json();
  expect(quote).toMatchObject({
    mode: "mainnet-readonly",
    amount: "12000000000000000000",
    expected: "12000000000000000000",
    min: "5000000000000000000",
    networkFee: "180000000000000000",
    serviceFee: "0",
  });
  expect(BigInt(quote.gasBudget)).toBeGreaterThan(0n);
  expect(
    network.rpc.mock.calls.every(
      ([, method]) => !/send|sign|deploy|permit/i.test(method),
    ),
  ).toBe(true);
  const health = await POST(request({ action: "health" }));
  expect(await health.json()).toMatchObject({
    status: "blocked",
    // V1.6: pending set reconciled, no in-flight, pins and settlement trust unchanged.
    reasons: ["MAINNET_WRITE_DISABLED"],
    limits: { reserveVerified: true, paused: false },
  });
});
