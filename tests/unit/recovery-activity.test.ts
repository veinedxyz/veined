import { expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { verifyTransaction } from "../../src/activity/verify";
import type { RpcTransport } from "../../src/data/rpc/transport";
import recorded from "../fixtures/recovery-recorded-bridge.json";
import { matchingBridge } from "../../src/activity/model";
const wallet = "0x1111111111111111111111111111111111111111",
  other = "0x2222222222222222222222222222222222222222";
const hash = "0x" + "a".repeat(64),
  blockHash = "0x" + "b".repeat(64);
const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  router = "0x2626664c2603336e57b271c5c0b26f421741e481";
const abi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
type Mutate = (method: string, value: unknown, url: string) => unknown;
const input = {
  address: wallet,
  chainId: "8453" as const,
  hash,
  consent: true as const,
};
const recordedTransport: RpcTransport = async (endpoint, body) => {
  const { method } = body as { method: string };
  const row = recorded.rows.find((r) => r.url === endpoint.url)!;
  const reads = row.reads as Record<string, unknown>;
  const result =
    method === "eth_blockNumber"
      ? "0x" +
        (
          BigInt((reads.eth_getBlockByNumber as { number: string }).number) +
          100n
        ).toString(16)
      : reads[method];
  return { jsonrpc: "2.0", id: 1, result: structuredClone(result) };
};
it("recorded Across receipts correlate: an empty source message has the protocol's ZERO32 hash", async () => {
  const address = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c";
  const source = await verifyTransaction(
    { address, chainId: "8453", hash: recorded.rows[0].hash, consent: true },
    recordedTransport,
  );
  const target = recorded.rows.find((r) => r.chainId === "42161")!;
  const fill = await verifyTransaction(
    { address, chainId: "42161", hash: target.hash, consent: true },
    recordedTransport,
  );
  expect(source.deposit?.messageHash).toBe("0x" + "0".repeat(64));
  expect(matchingBridge(source, fill)).toBe(true);
  expect(
    matchingBridge(source, {
      ...fill,
      deposit: { ...fill.deposit!, outputAmount: "1" },
    }),
  ).toBe(false);
});
it("the recorded fill must pay the address and preserve the deposited message before settlement classification", async () => {
  const address = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c",
    target = recorded.rows.find((r) => r.chainId === "42161")!;
  const omitPayment: RpcTransport = async (endpoint, body, opts) => {
    const r = (await recordedTransport(endpoint, body, opts)) as {
      jsonrpc: string;
      id: number;
      result: { logs?: { address: string }[] };
    };
    if ((body as { method: string }).method === "eth_getTransactionReceipt")
      r.result.logs = r.result.logs!.filter(
        (l) =>
          l.address.toLowerCase() !==
          "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      );
    return r;
  };
  await expect(
    verifyTransaction(
      { address, chainId: "42161", hash: target.hash, consent: true },
      omitPayment,
    ),
  ).rejects.toMatchObject({ code: "ADDRESS_NOT_INVOLVED" });
});
function fake(mutate: Mutate = (_m, v) => v) {
  const calls: { method: string; url: string }[] = [];
  const transport: RpcTransport = async (endpoint, body) => {
    const { method, params } = body as { method: string; params: unknown[] };
    calls.push({ method, url: endpoint.url });
    const log = {
      address: usdc,
      topics: encodeEventTopics({
        abi,
        eventName: "Transfer",
        args: { from: wallet, to: other },
      }),
      data: encodeAbiParameters([{ type: "uint256" }], [1000000n]),
      transactionHash: hash,
      blockHash,
      blockNumber: "0x64",
      logIndex: "0x0",
      removed: false,
    };
    const result =
      method === "eth_chainId"
        ? "0x2105"
        : method === "eth_blockNumber"
          ? "0x100"
          : method === "eth_getTransactionByHash"
            ? {
                hash,
                blockHash,
                blockNumber: "0x64",
                from: wallet,
                to: router,
                input: "0x5ae401dc",
                value: "0x0",
                nonce: "0x1",
              }
            : method === "eth_getTransactionReceipt"
              ? {
                  transactionHash: hash,
                  blockHash,
                  blockNumber: "0x64",
                  status: "0x1",
                  from: wallet,
                  to: router,
                  logs: [log],
                }
              : method === "eth_getBlockByNumber" && params[0] === "0x64"
                ? { hash: blockHash, number: "0x64", timestamp: "0x6b000000" }
                : null;
    return {
      jsonrpc: "2.0",
      id: 1,
      result: mutate(method, result, endpoint.url),
    };
  };
  return { transport, calls };
}
it("imports a canonical, address-bound receipt from two independent operators with exact amounts", async () => {
  const f = fake();
  const r = await verifyTransaction(input, f.transport);
  expect(r.kind).toBe("Swap");
  expect(r.amounts).toEqual([
    { symbol: "USDC", amount: "1", direction: "out" },
  ]);
  expect(r.status).toBe("CONFIRMED");
  expect(r.operators).toHaveLength(2);
  expect(r.coverage).toContain("no indexed history");
  expect(new Set(f.calls.map((c) => c.url)).size).toBe(2);
  expect(f.calls.every((c) => !/(sign|send)/i.test(c.method))).toBe(true);
});
it("a genuine transaction for another address cannot be imported", async () => {
  await expect(
    verifyTransaction(
      { ...input, address: "0x3333333333333333333333333333333333333333" },
      fake().transport,
    ),
  ).rejects.toMatchObject({ code: "ADDRESS_NOT_INVOLVED" });
});
it.each(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"])(
  "wrong or missing %s stops verification",
  async (method) => {
    const f = fake((m, v) =>
      m !== method
        ? v
        : m === "eth_chainId"
          ? "0x1"
          : m === "eth_getBlockByNumber"
            ? { ...(v as object), hash: "0x" + "c".repeat(64) }
            : null,
    );
    await expect(verifyTransaction(input, f.transport)).rejects.toMatchObject({
      code: "VERIFICATION_UNAVAILABLE",
    });
  },
);
it("operators that disagree never produce a verified row", async () => {
  const f = fake((m, v, url) =>
    m === "eth_getTransactionByHash" && url.includes("mainnet.base")
      ? { ...(v as object), nonce: "0x2" }
      : v,
  );
  await expect(verifyTransaction(input, f.transport)).rejects.toMatchObject({
    code: "OPERATORS_DISAGREE",
  });
});
it("logs of another hash or block cannot establish address involvement", async () => {
  const f = fake((m, v) =>
    m === "eth_getTransactionReceipt"
      ? {
          ...(v as object),
          logs: [
            {
              ...(v as { logs: object[] }).logs[0],
              transactionHash: "0x" + "f".repeat(64),
            },
          ],
        }
      : v,
  );
  await expect(verifyTransaction(input, f.transport)).rejects.toMatchObject({
    code: "VERIFICATION_UNAVAILABLE",
  });
});
it("a provider error identifies its operator and a later retry recovers", async () => {
  const f = fake();
  const transport: RpcTransport = (endpoint, body, opts) =>
    endpoint.url.includes("mainnet.base")
      ? Promise.reject(Error("synthetic outage"))
      : f.transport(endpoint, body, opts);
  await expect(verifyTransaction(input, transport)).rejects.toMatchObject({
    code: "VERIFICATION_UNAVAILABLE",
    sources: [{ operator: "base-coinbase", code: "PROVIDER_UNAVAILABLE" }],
  });
  expect((await verifyTransaction(input, f.transport)).status).toBe(
    "CONFIRMED",
  );
});
it("insufficient confirmations remain unverified", async () => {
  const f = fake((m, v) => (m === "eth_blockNumber" ? "0x65" : v));
  await expect(verifyTransaction(input, f.transport)).rejects.toMatchObject({
    code: "VERIFICATION_UNAVAILABLE",
    sources: expect.arrayContaining([
      expect.objectContaining({ code: "PENDING_CONFIRMATIONS" }),
    ]),
  });
});
it("a failed receipt is shown as failed", async () => {
  const f = fake((m, v) =>
    m === "eth_getTransactionReceipt"
      ? { ...(v as object), status: "0x0", logs: [] }
      : v,
  );
  expect((await verifyTransaction(input, f.transport)).status).toBe("FAILED");
});
it.each([
  { url: "https://evil.invalid" },
  { method: "eth_sendTransaction" },
  { consent: false },
  { chainId: "1" },
  { hash: "0x1234" },
])("rejects caller-selected capability %j before egress", async (over) => {
  const f = fake();
  await expect(
    verifyTransaction({ ...input, ...over } as typeof input, f.transport),
  ).rejects.toBeDefined();
  expect(f.calls).toHaveLength(0);
});
