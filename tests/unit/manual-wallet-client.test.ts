import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManualPreparation } from "../../src/manual-wallet/protocol";
const A = "0x" + "3".repeat(40),
  B = "0x" + "4".repeat(40),
  HASH = "0x" + "a".repeat(64);
let methods: string[],
  bodies: Record<string, unknown>[],
  account: string,
  chain: string,
  sendError: unknown,
  answer: unknown;
let mutate: (x: Record<string, unknown>) => void;
const preparation = (): ManualPreparation => ({
  id: "a".repeat(64),
  lane: "SWAP",
  reviewId: "r1",
  step: "APPROVE",
  transaction: {
    chainId: "0x2105",
    from: A,
    to: B,
    value: "0x0",
    data: "0x12345678",
    gas: "0x186a0",
    maxFeePerGas: "0x64",
    maxPriorityFeePerGas: "0x0",
  },
  expiresAt: Date.now() + 20_000,
  serverTime: Date.now(),
  released: true,
});
beforeEach(() => {
  vi.resetModules();
  methods = [];
  bodies = [];
  account = A;
  chain = "0x2105";
  sendError = undefined;
  answer = HASH;
  mutate = () => {};
  vi.stubGlobal("window", {
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ csrf: "csrf" });
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.action === "claim") {
        const reply = { ...preparation(), authority: "b".repeat(64) };
        mutate(reply);
        return Response.json({ preparation: reply });
      }
      return Response.json({
        result: { outcome: body.outcome, hash: body.hash },
      });
    }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function setup() {
  const { WalletProviderAdapter } =
    await import("../../src/features/wallet/adapter");
  const client = await import("../../src/manual-wallet/client");
  const raw = {
    request: vi.fn(async ({ method }: { method: string }) => {
      methods.push(method);
      if (method === "eth_accounts") return [account];
      if (method === "eth_chainId") return chain;
      if (method === "eth_sendTransaction") {
        if (sendError) throw sendError;
        return answer;
      }
      throw Error("FORBIDDEN");
    }),
  };
  const adapter = new WalletProviderAdapter(raw, {
    address: A,
    chainId: 8453,
    epoch: 1,
  });
  return { raw, adapter, client };
}
it("refuses a disconnected/forged authority before asking the wallet", async () => {
  const { adapter } = await setup();
  await expect(adapter.sendManualTransaction({})).rejects.toThrow(
    "MANUAL_AUTHORITY_UNKNOWN_OR_USED",
  );
  expect(methods).toEqual([]);
});
it("hands exact immutable server bytes to the connected wallet once and returns its hash", async () => {
  const { adapter, client, raw } = await setup();
  const p = preparation();
  const authority = await client.manualAuthority(
    adapter,
    "SWAP",
    p,
    () => true,
  );
  expect(await adapter.sendManualTransaction(authority)).toBe(HASH);
  const request = raw.request.mock.calls.find(
    (c) => c[0].method === "eth_sendTransaction",
  )![0] as { params?: unknown };
  expect(request.params).toEqual([p.transaction]);
  expect(Object.isFrozen((request.params as object[])[0])).toBe(true);
  await expect(adapter.sendManualTransaction(authority)).rejects.toThrow(
    "MANUAL_AUTHORITY_UNKNOWN_OR_USED",
  );
  expect(methods.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
  expect(bodies.at(-1)).toMatchObject({
    action: "result",
    outcome: "SENT",
    hash: HASH,
  });
});
it("refuses a different network before claiming", async () => {
  const { adapter, client } = await setup();
  chain = "0x1";
  await expect(
    client.manualAuthority(adapter, "SWAP", preparation(), () => true),
  ).rejects.toThrow("WALLET_IDENTITY_CHANGED");
  expect(bodies).toHaveLength(0);
});
it("refuses an account changed after preparation", async () => {
  const { adapter, client } = await setup();
  const authority = await client.manualAuthority(
    adapter,
    "SWAP",
    preparation(),
    () => true,
  );
  account = B;
  await expect(adapter.sendManualTransaction(authority)).rejects.toThrow();
  expect(methods).not.toContain("eth_sendTransaction");
  expect(bodies.at(-1)).toMatchObject({ outcome: "REFUSED" });
});
it("refuses a revoked adapter after claiming", async () => {
  const { adapter, client } = await setup();
  const authority = await client.manualAuthority(
    adapter,
    "SWAP",
    preparation(),
    () => true,
  );
  adapter.revoke();
  await expect(adapter.sendManualTransaction(authority)).rejects.toThrow();
  expect(methods).not.toContain("eth_sendTransaction");
});
it("checks the current review after the last identity await", async () => {
  const { adapter, client } = await setup();
  let current = true;
  const authority = await client.manualAuthority(
    adapter,
    "SWAP",
    preparation(),
    () => current,
  );
  current = false;
  await expect(adapter.sendManualTransaction(authority)).rejects.toThrow(
    "MANUAL_AUTHORITY_STALE",
  );
  expect(methods).not.toContain("eth_sendTransaction");
});
it("records rejection without automatic retry", async () => {
  const { adapter, client } = await setup();
  sendError = { code: 4001 };
  const authority = await client.manualAuthority(
    adapter,
    "SWAP",
    preparation(),
    () => true,
  );
  await expect(adapter.sendManualTransaction(authority)).rejects.toEqual(
    sendError,
  );
  expect(bodies.at(-1)).toMatchObject({ outcome: "REFUSED" });
  expect(methods.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
});
it.each(["provider-error", "malformed-hash"])(
  "retains UNKNOWN and refuses another financial call: %s",
  async (scenario) => {
    const { adapter, client } = await setup();
    if (scenario === "provider-error") sendError = { code: 4900 };
    else answer = "0xnotahash";
    const authority = await client.manualAuthority(
      adapter,
      "SWAP",
      preparation(),
      () => true,
    );
    await expect(
      adapter.sendManualTransaction(authority),
    ).rejects.toBeDefined();
    expect(bodies.at(-1)).toMatchObject({ outcome: "UNCERTAIN" });
    sendError = undefined;
    const second = await client.manualAuthority(
      adapter,
      "SWAP",
      preparation(),
      () => true,
    );
    await expect(adapter.sendManualTransaction(second)).rejects.toThrow();
    expect(methods.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
  },
);
it.each(["calldata", "step", "route", "stale"])(
  "refuses changed server claim: %s",
  async (scenario) => {
    const { adapter, client } = await setup();
    mutate = (x) => {
      if (scenario === "calldata")
        x.transaction = { ...preparation().transaction, data: "0xdeadbeef" };
      if (scenario === "step") x.step = "EXECUTE";
      if (scenario === "route") x.lane = "BRIDGE";
      if (scenario === "stale") x.expiresAt = Date.now() - 1;
    };
    await expect(
      client.manualAuthority(adapter, "SWAP", preparation(), () => true),
    ).rejects.toThrow("MANUAL_AUTHORITY_INVALID");
    expect(methods).not.toContain("eth_sendTransaction");
  },
);
it("a network changed after claim is refused before the wallet request", async () => {
  const { adapter, client } = await setup();
  const authority = await client.manualAuthority(
    adapter,
    "SWAP",
    preparation(),
    () => true,
  );
  chain = "0x1";
  await expect(adapter.sendManualTransaction(authority)).rejects.toThrow(
    "IDENTITY_CHANGED",
  );
  expect(methods).not.toContain("eth_sendTransaction");
  expect(bodies.at(-1)).toMatchObject({ outcome: "REFUSED" });
});
it("rechecks expiration after the final asynchronous wallet identity read", async () => {
  let clock = 100;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const { adapter, client, raw } = await setup();
  const authority = await client.manualAuthority(
    adapter,
    "SWAP",
    preparation(),
    () => true,
  );
  const original = raw.request.getMockImplementation()!;
  raw.request.mockImplementation(async (args) => {
    if (args.method === "eth_accounts") clock += 11_000;
    return original(args);
  });
  await expect(adapter.sendManualTransaction(authority)).rejects.toThrow(
    "MANUAL_AUTHORITY_STALE",
  );
  expect(methods).not.toContain("eth_sendTransaction");
  expect(bodies.at(-1)).toMatchObject({ outcome: "REFUSED" });
});
