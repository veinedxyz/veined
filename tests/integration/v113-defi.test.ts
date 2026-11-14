import { describe, it, expect, beforeEach } from "vitest";
import { adapterFixture, families, defiWallet, loan } from "../fixtures/defi";
import { scanDefi, clearScanStateForTests } from "../../src/defi/scanner";
import { DataPlane } from "../../src/data/plane";
import { deployments } from "../../src/defi/registry";
import { DefiReader } from "../../src/defi/reader";
import { RpcPool } from "../../src/data/rpc/pool";
import { encodeFunctionResult } from "viem";
import { abiFor } from "../../src/defi/abi";
import { POST } from "../../src/app/api/portfolio/defi/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { verifyIndexedHashes } from "../../src/defi/indexer";
const plane = new DataPlane(null),
  ids = families.map(
    (f) => deployments.find((d) => d.adapter === f && d.chainId === "1")!.id,
  );
const pin = adapterFixture("lido").ctx.pin;
const factory = (
  d: (typeof deployments)[number],
  wallet: string,
  _pin: unknown,
  signal: AbortSignal,
) => {
  void _pin;
  const c = adapterFixture(d.adapter).ctx;
  c.wallet = wallet;
  c.signal = signal;
  return c;
};
const store = {
  async refs(id: string) {
    const d = deployments.find((d) => d.id === id)!;
    return { refs: adapterFixture(d.adapter).refs, complete: true };
  },
  async record() {},
};
beforeEach(() => {
  clearScanStateForTests();
  setAppLimiterForTests(new MemoryRateLimiter());
});
describe("progressive position orchestration", () => {
  it.each([{ chains: [] }, { deploymentIds: [] }])(
    "empty explicit scope cannot reuse the unfiltered scan cache: %s",
    (options) => {
      expect(() => scanDefi(defiWallet, plane, options)).toThrow("EMPTY_SCOPE");
    },
  );
  it("production scan supplies only exact same-chain curated nested-vault targets", async () => {
    const child = deployments.find(
      (d) => d.adapter === "erc4626" && d.chainId === "1",
    )!.contracts.vault;
    const scan = await scanDefi(defiWallet, plane, {
      deploymentIds: [ids[3]],
      pinFactory: async () => pin,
      store,
      readerFactory: (...args) => {
        const ctx = factory(...args),
          read = ctx.read.bind(ctx);
        ctx.curatedVaults = undefined;
        ctx.read = async (target, name, values) =>
          name === "asset"
            ? target === child
              ? loan
              : child
            : name === "convertToAssets" && target === child
              ? 2000000n
              : read(target, name, values);
        return ctx;
      },
    });
    expect(scan.positions[0].underlying[0]).toMatchObject({
      contract: loan,
      rawAmount: "2000000",
    });
  });
  it("an uncooperative adapter times out without blocking independent protocols", async () => {
    const started = Date.now();
    const scan = await scanDefi(defiWallet, plane, {
      deploymentIds: [ids[1], ids[4]],
      perAdapterMs: 50,
      deadlineMs: 1000,
      pinFactory: async () => pin,
      readerFactory: (...args) => {
        const ctx = factory(...args);
        if (ctx.deployment.adapter === "compound-iii")
          ctx.read = () => new Promise(() => {});
        return ctx;
      },
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(
      scan.coverage.find((c) => c.protocolId === "compound-iii"),
    ).toMatchObject({
      state: "FAILED",
      result: "UNKNOWN",
      reason: "SCAN_TIMEOUT",
    });
    expect(scan.positions.some((p) => p.protocolId === "lido")).toBe(true);
  });
  it("all eight families produce deterministic nonzero independent evidence", async () => {
    const scan = await scanDefi(defiWallet, plane, {
      deploymentIds: ids,
      maxDeployments: 8,
      readerFactory: factory,
      pinFactory: async () => pin,
      store,
    });
    expect(scan.positions.length).toBe(9);
    expect(scan.coverage.every((c) => c.result === "NONZERO")).toBe(true);
    expect(scan.peakConcurrency).toBeLessThanOrEqual(3);
  });
  it("bounded page returns explicit continuation", async () => {
    const scan = await scanDefi(defiWallet, plane, {
      deploymentIds: ids,
      maxDeployments: 2,
      readerFactory: factory,
      pinFactory: async () => pin,
      store,
    });
    expect(scan.coverage.length).toBe(2);
    expect(scan.continuation.length).toBe(6);
  });
  it("failed protocol never blocks other results or becomes ZERO", async () => {
    const scan = await scanDefi(defiWallet, plane, {
      deploymentIds: ids,
      maxDeployments: 8,
      pinFactory: async () => pin,
      store,
      readerFactory: (...a) => {
        const c = factory(...a);
        if (c.deployment.adapter === "compound-iii")
          c.read = async () => {
            throw Error("RPC_UNAVAILABLE");
          };
        return c;
      },
    });
    expect(
      scan.coverage.find((c) => c.protocolId === "compound-iii"),
    ).toMatchObject({ state: "FAILED", result: "UNKNOWN" });
    expect(scan.positions.some((p) => p.protocolId === "lido")).toBe(true);
  });
  it("no local discovery index is NOT_CHECKED instead of zero", async () => {
    const scan = await scanDefi(defiWallet, plane, {
      deploymentIds: [ids[2]],
      readerFactory: factory,
      pinFactory: async () => pin,
    });
    expect(scan.coverage[0]).toMatchObject({
      state: "NOT_CHECKED",
      result: "UNKNOWN",
      reason: "LOCAL_DISCOVERY_INDEX_REQUIRED",
    });
  });
  it("exact successful empty is ZERO", async () => {
    const scan = await scanDefi(defiWallet, plane, {
      deploymentIds: [ids[0]],
      pinFactory: async () => pin,
      readerFactory: (d) => adapterFixture(d.adapter, true).ctx,
    });
    expect(scan.coverage[0]).toMatchObject({
      state: "FULL_POSITION",
      result: "ZERO",
    });
  });
  it("same client/address/page shares one in-flight scan", async () => {
    let calls = 0;
    const o = {
      deploymentIds: [ids[0]],
      readerFactory: (...a: Parameters<typeof factory>) => {
        calls++;
        return factory(...a);
      },
      pinFactory: async () => pin,
    };
    const [a, b] = await Promise.all([
      scanDefi(defiWallet, plane, o),
      scanDefi(defiWallet, plane, o),
    ]);
    expect(a.scanId).toBe(b.scanId);
    expect(calls).toBe(1);
  });
  it("different clients never share private scan results", async () => {
    const base = {
      deploymentIds: [ids[0]],
      readerFactory: factory,
      pinFactory: async () => pin,
    };
    const [a, b] = await Promise.all([
      scanDefi(defiWallet, plane, { ...base, clientScope: "A" }),
      scanDefi(defiWallet, plane, { ...base, clientScope: "B" }),
    ]);
    expect(a.scanId).not.toBe(b.scanId);
  });
  it("wrong chain rejected before protocol reads", async () =>
    await expect(
      scanDefi(defiWallet, plane, { chains: ["999999999999"] }),
    ).rejects.toThrow("UNSUPPORTED_CHAIN"));
  it("wrong deployment rejected", async () =>
    await expect(
      scanDefi(defiWallet, plane, { deploymentIds: ["fake"] }),
    ).rejects.toThrow("UNSUPPORTED_DEPLOYMENT"));
  it("malformed wallet rejected before network work", () =>
    expect(() => scanDefi("0x0", plane)).toThrow());
});
describe("real read transport boundary", () => {
  it("canonical log verification rejects a hash from another fork", async () => {
    const log = {
      address: loan,
      topics: ["0x" + "aa".repeat(32)],
      data: "0x",
      blockNumber: "0x1",
      blockHash: "0x" + "ab".repeat(32),
      transactionHash: "0x" + "cd".repeat(32),
      logIndex: "0x0",
    };
    await expect(
      verifyIndexedHashes([log], async () => "0x" + "ef".repeat(32)),
    ).rejects.toThrow("NONCANONICAL_LOG");
  });
  it("canonical log verification checks each unique block once", async () => {
    const hash = "0x" + "ab".repeat(32),
      log = {
        address: loan,
        topics: [hash],
        data: "0x",
        blockNumber: "0x1",
        blockHash: hash,
        transactionHash: hash,
        logIndex: "0x0",
      };
    let reads = 0;
    await verifyIndexedHashes([log, { ...log, logIndex: "0x1" }], async () => {
      reads++;
      return hash;
    });
    expect(reads).toBe(1);
  });
  const d = deployments.find((d) => d.adapter === "erc4626")!;
  const endpoint = {
    id: "synthetic",
    chainId: "1",
    url: "https://synthetic.test",
    priority: 1,
    supportsLogs: false,
    maxLogRange: 0,
    supportsBatch: false,
    supportsFinalized: false,
    supportsSafe: false,
    archive: true,
  };
  it("read generates only exact eth_call capability at pinned block", async () => {
    const calls: unknown[] = [];
    const pool = new RpcPool(
      "1",
      { ecosystem: "EVM" },
      [endpoint],
      async (_e, body) => {
        calls.push(body);
        return {
          jsonrpc: "2.0",
          id: (body as { id: unknown }).id,
          result: encodeFunctionResult({
            abi: abiFor("convertToAssets"),
            functionName: "convertToAssets",
            result: 110n,
          }),
        };
      },
    );
    const reader = new DefiReader(
      d,
      defiWallet,
      { ...pin, endpointId: "synthetic" },
      new AbortController().signal,
      pool,
    );
    expect(
      await reader.read(d.contracts.vault, "convertToAssets", [100n]),
    ).toBe(110n);
    expect((calls[0] as { method: string; params: unknown[] }).params[1]).toBe(
      "0x3039",
    );
    expect((calls[0] as { method: string }).method).toBe("eth_call");
  });
  it("unregistered target cannot receive even a view read", async () => {
    const pool = new RpcPool(
      "1",
      { ecosystem: "EVM" },
      [endpoint],
      async () => {
        throw Error("MUST_NOT_CALL");
      },
    );
    const r = new DefiReader(
      d,
      defiWallet,
      pin,
      new AbortController().signal,
      pool,
    );
    await expect(r.read(loan, "asset")).rejects.toThrow(
      "TARGET_NOT_AUTHORIZED",
    );
  });
  it("RPC budget bounds a pathological adapter", async () => {
    const pool = new RpcPool(
      "1",
      { ecosystem: "EVM" },
      [endpoint],
      async (_e, body) => ({
        jsonrpc: "2.0",
        id: (body as { id: unknown }).id,
        result: encodeFunctionResult({
          abi: abiFor("asset"),
          functionName: "asset",
          result: loan,
        }),
      }),
    );
    const r = new DefiReader(
      d,
      defiWallet,
      { ...pin, endpointId: "synthetic" },
      new AbortController().signal,
      pool,
      new Map(),
      1,
    );
    await r.read(d.contracts.vault, "asset");
    await expect(r.read(d.contracts.vault, "asset")).rejects.toThrow(
      "RPC_BUDGET_EXHAUSTED",
    );
  });
  it("app API refuses hostile origin", async () => {
    const r = await POST(
      new Request("http://127.0.0.1:3100/api/portfolio/defi", {
        method: "POST",
        headers: {
          Origin: "https://evil.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ wallet: defiWallet, consent: true }),
      }),
    );
    expect(r.status).toBe(403);
  });
  it("app API has no arbitrary URL/ABI input", async () => {
    const r = await POST(
      new Request("http://127.0.0.1:3100/api/portfolio/defi", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3100",
          Host: "127.0.0.1:3100",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          wallet: defiWallet,
          consent: true,
          url: "https://evil.test",
          abi: [],
        }),
      }),
    );
    expect(r.status).toBe(422);
  });
});
