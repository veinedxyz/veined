import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionInstruction,
} from "../../swap-providers/runtime";
import { rpc, jsonRead } from "../../src/swap/server/transport";
import {
  inspectSolana,
  assertSolanaReviewable,
  SOL_PROGRAMS,
} from "../../src/swap/server/solana";
import { simulate } from "../../src/swap/server/simulation";
import { buildEvm } from "../../src/swap/server/evm";
import { SwapService } from "../../src/swap/server/service";
import { digest } from "../../src/swap/server/digest";
import { verifyPools } from "../../src/swap/server/pools";
import { swapIntent, swapQuote, solIntent } from "../fixtures/swap";
import { SwapError, type SwapQuote } from "../../src/swap/model";
import routerCode from "../fixtures/uniswap-router-2.1.2-code.json";
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
function respond(method: string) {
  if (method === "eth_chainId") return "0x1";
  if (method === "eth_blockNumber") return "0x123";
  if (method === "eth_call") return "0x";
  if (method === "eth_estimateGas") return "0x10000";
  if (method === "getBlockHeight") return 10;
  if (method === "isBlockhashValid") return { value: true };
  return null;
}
function mockRpc(change: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    if (method === "eth_simulateV1") {
      const calls = params[0].blockStateCalls[0].calls,
        swap = calls[1];
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: [
          {
            number: "0x124",
            calls: [
              {
                status: "0x1",
                returnData: "0x" + "0".repeat(64),
                logs: [],
                gasUsed: "0x100",
              },
              {
                status: "0x1",
                returnData: "0x",
                gasUsed: "0x10000",
                logs: [
                  {
                    address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                    topics: [
                      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                      "0x" + swap.from.slice(2).padStart(64, "0"),
                      "0x" + swap.to.slice(2).padStart(64, "0"),
                    ],
                    data:
                      "0x" + BigInt(swap.value).toString(16).padStart(64, "0"),
                  },
                ],
              },
              {
                status: "0x1",
                returnData: "0x" + 30000000n.toString(16).padStart(64, "0"),
                logs: [],
                gasUsed: "0x100",
              },
            ],
          },
        ],
      });
    }
    const result =
      method in change
        ? change[method]
        : method === "eth_getCode"
          ? params[0].toLowerCase() ===
            "0x23617e59a5925b2a4bf75d73ff6711cd0b29de85"
            ? routerCode.code
            : "0x60006000"
          : method === "eth_getStorageAt"
            ? "0x" + "0".repeat(64)
            : method === "eth_call" && params[0].data.startsWith("0x1698ee82")
              ? "0x" + "0".repeat(24) + "33".repeat(20)
              : respond(method);
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
}
function solBuild(
  instructions: TransactionInstruction[],
  payer = solIntent().taker,
) {
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: "11111111111111111111111111111111",
      instructions,
    }).compileToV0Message(),
  );
  return {
    ecosystem: "SVM" as const,
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    lastValidBlockHeight: 20,
  };
}
describe("V115 read-only transport and simulation", () => {
  it.each([
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "personal_sign",
    "eth_signTypedData_v4",
    "sendTransaction",
    "sendRawTransaction",
  ])("no RPC escape through %s", async (method) => {
    await expect(
      rpc("1", method, [], new AbortController().signal),
    ).rejects.toThrow("EXECUTION_CLOSED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [429, "RATE_LIMITED"],
    [401, "CREDENTIAL_REQUIRED"],
    [403, "CREDENTIAL_REQUIRED"],
    [400, "HTTP_4XX"],
    [502, "HTTP_5XX"],
  ])("HTTP %i classified without raw response", async (status, code) => {
    fetchMock.mockResolvedValue(
      new Response("token=SECRET", { status: Number(status) }),
    );
    await expect(
      jsonRead(
        "https://ethereum-rpc.publicnode.com",
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(String(code));
  });
  it("oversized provider response rejected", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(1000001)));
    await expect(
      jsonRead(
        "https://ethereum-rpc.publicnode.com",
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("INVALID_SCHEMA");
  });
  it("simulation binds the unsigned EVM digest", async () => {
    mockRpc();
    const i = swapIntent(),
      build = buildEvm(swapQuote(i), i);
    const r = await simulate(build, i, new AbortController().signal);
    expect(r.transactionDigest).toBe(digest(build));
    expect(r.status).toBe("PASSED");
    expect(
      fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).method),
    ).toEqual([
      "eth_chainId",
      "eth_blockNumber",
      "eth_call",
      "eth_estimateGas",
    ]);
  });
  it("failed simulation cannot become reviewable", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { message: "bad" } }));
    const i = swapIntent();
    await expect(
      simulate(buildEvm(swapQuote(i), i), i, new AbortController().signal),
    ).rejects.toThrow();
  });
  it("RPC chain substitution fails closed", async () => {
    mockRpc({ eth_chainId: "0x38" });
    const i = swapIntent();
    await expect(
      simulate(buildEvm(swapQuote(i), i), i, new AbortController().signal),
    ).rejects.toThrow("REVIEW_REQUIRED");
  });
});
describe("V115 Solana structure never implies economic proof", () => {
  it("decodes compute budget from actual unsigned v0 bytes", async () => {
    mockRpc();
    const build = solBuild([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000n }),
    ]);
    const d = await inspectSolana(
      build,
      solIntent(),
      new AbortController().signal,
    );
    expect(d.computeLimit).toBe(300000);
    expect(d.priorityMicroLamports).toBe(1000n);
    expect(d.signers).toEqual([solIntent().taker]);
    expect(() => assertSolanaReviewable(d)).toThrow("BUILD_REVIEW_REQUIRED");
  });
  it("rejects payer substitution before RPC", async () => {
    const build = solBuild([], SOL_PROGRAMS.token);
    await expect(
      inspectSolana(build, solIntent(), new AbortController().signal),
    ).rejects.toThrow("REVIEW_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a second signer", async () => {
    const build = solBuild([
      new TransactionInstruction({
        programId: new PublicKey(SOL_PROGRAMS.jupiter),
        keys: [
          {
            pubkey: new PublicKey(SOL_PROGRAMS.token),
            isSigner: true,
            isWritable: true,
          },
        ],
        data: Buffer.alloc(8),
      }),
    ]);
    await expect(
      inspectSolana(build, solIntent(), new AbortController().signal),
    ).rejects.toThrow("REVIEW_REQUIRED");
  });
  it("rejects unknown program", async () => {
    mockRpc();
    const build = solBuild([
      new TransactionInstruction({
        programId: new PublicKey(solIntent().tokenOut.address),
        keys: [],
        data: Buffer.alloc(8),
      }),
    ]);
    await expect(
      inspectSolana(build, solIntent(), new AbortController().signal),
    ).rejects.toThrow("REVIEW_REQUIRED");
  });
  it("rejects hidden SystemProgram transfer", async () => {
    mockRpc();
    const build = solBuild([
      SystemProgram.transfer({
        fromPubkey: new PublicKey(solIntent().taker),
        toPubkey: new PublicKey(solIntent().tokenOut.address),
        lamports: 100,
      }),
    ]);
    await expect(
      inspectSolana(build, solIntent(), new AbortController().signal),
    ).rejects.toThrow("BUILD_REVIEW_REQUIRED");
  });
  it.each([{ getBlockHeight: 20 }, { isBlockhashValid: { value: false } }])(
    "stale blockhash invalidates build %j",
    async (change) => {
      mockRpc(change);
      await expect(
        inspectSolana(solBuild([]), solIntent(), new AbortController().signal),
      ).rejects.toThrow("QUOTE_STALE");
    },
  );
  it("rejects duplicate compute budget instructions", async () => {
    mockRpc();
    await expect(
      inspectSolana(
        solBuild([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 2 }),
        ]),
        solIntent(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("REVIEW_REQUIRED");
  });
  it("rejects signatures instead of handling signed provider transactions", async () => {
    const b = solBuild([]),
      tx = VersionedTransaction.deserialize(
        Buffer.from(b.transaction, "base64"),
      );
    tx.signatures[0][0] = 1;
    b.transaction = Buffer.from(tx.serialize()).toString("base64");
    await expect(
      inspectSolana(b, solIntent(), new AbortController().signal),
    ).rejects.toThrow("REVIEW_REQUIRED");
  });
});
describe("V115 canonical review", () => {
  it("independent factory lookup rejects substituted displayed pool", async () => {
    mockRpc();
    const i = swapIntent(),
      q = swapQuote(i);
    q.route[0].pool = "0x" + "44".repeat(20);
    await expect(
      verifyPools(q, i, new AbortController().signal),
    ).rejects.toThrow("REVIEW_REQUIRED");
  });
  it("router with no bytecode cannot be verified", async () => {
    mockRpc({ eth_getCode: "0x" });
    const i = swapIntent();
    await expect(
      verifyPools(swapQuote(i), i, new AbortController().signal),
    ).rejects.toThrow("REVIEW_REQUIRED");
  });
  it("review stays closed after independent simulation", async () => {
    mockRpc();
    const i = swapIntent();
    const service = new SwapService([
      {
        mode: "UNISWAP",
        provider: "Uniswap",
        chains: ["1"],
        exactOut: true,
        quote: async () => [swapQuote(i)],
        build: async (q, i) => buildEvm(q, i),
      },
    ]);
    let q: SwapQuote | undefined;
    await service.quote(i, new AbortController().signal, (e) => {
      if (e.type === "quote") q = e.quote;
    });
    const r = await service.review(q!.id, i, new AbortController().signal);
    expect(r.state).toBe("EXECUTION_CLOSED");
    expect(r.verifiedForReview).toBe(true);
    expect(r.digest).toHaveLength(64);
    expect(r.transactionDigest).toBe(r.simulation.transactionDigest);
  });
  it.each(["walletEpoch", "recipient", "portfolioRevision"])(
    "review refuses changed %s",
    async (field) => {
      const i = swapIntent(),
        q = swapQuote(i);
      const s = new SwapService([
        {
          mode: "UNISWAP",
          provider: "Uniswap",
          chains: ["1"],
          exactOut: true,
          quote: async () => [q],
          build: async () => {
            throw new SwapError("SIMULATION_FAILED");
          },
        },
      ]);
      await s.quote(i, new AbortController().signal, () => {});
      await expect(
        s.review(
          q.id,
          { ...i, [field]: field === "walletEpoch" ? 99 : "changed" },
          new AbortController().signal,
        ),
      ).rejects.toThrow("REVIEW_REQUIRED");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
