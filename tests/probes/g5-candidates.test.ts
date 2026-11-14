import { it, vi, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { decodeEventLog, toEventSelector, toHex, type Hex } from "viem";
const audit = vi.hoisted(() => ({
  calls: [] as {
    chain: string;
    method: string;
    params: unknown[];
    at: string;
    result?: unknown;
    error?: string;
  }[],
}));
vi.mock("../../src/adapters/read-only", async (original) => {
  const real = await original<typeof import("../../src/adapters/read-only")>();
  return {
    ...real,
    rpc: async (
      chain: "one" | "bsc",
      method: string,
      params: unknown[] = [],
    ) => {
      const item: {
        chain: string;
        method: string;
        params: unknown[];
        at: string;
        result?: unknown;
        error?: string;
      } = { chain, method, params, at: new Date().toISOString() };
      audit.calls.push(item);
      try {
        return (item.result = await real.rpc(chain, method, params));
      } catch (e) {
        item.error = String(e);
        throw e;
      }
    },
  };
});
import { rpc } from "../../src/adapters/read-only";
import { nativeReadAbi } from "../../src/adapters/native-abi";
import { READ_ONLY_DEPLOYMENT as deployment } from "../../src/adapters/deployment";
import { liveQuote, nativeTrack } from "../../src/adapters/native-service";
import { CROSS, NATIVE, type TransferRecord } from "../../src/core/model";
it("bounded public candidates, raw archive limitation and current simulation", async () => {
  const base = `${(await readFile(".otherbridge/v12-evidence-path.txt", "utf8")).trim()}/g5/candidates`;
  await mkdir(base, { recursive: true });
  const previous = JSON.parse(
    await readFile(
      `${(await readFile(".otherbridge/v12-evidence-path.txt", "utf8")).trim()}/g5/extra/independent-token-pair-history.json`,
      "utf8",
    ),
  );
  const oldCandidates = previous.history.data.histories
    .filter(
      (h: Record<string, unknown>) =>
        h.source === "bridge" &&
        h.fromChainID === 612055 &&
        h.toChainID === 56 &&
        h.index !== 98483,
    )
    .slice(0, 3);
  const historical = [];
  for (const h of oldCandidates) {
    const claim: TransferRecord = {
      schema: 1,
      id: `extra-${h.index}`,
      mode: "mainnet-readonly",
      route: "one-native-to-bsc-cross",
      config: "1",
      sourceChain: 612055,
      destinationChain: 56,
      account: h.from,
      recipient: h.to,
      sourceAsset: "native:ONE",
      token: CROSS,
      amount: h.value,
      expected: h.value,
      sourceHash: h.initiatedTxHash,
      destinationHash: h.finalizedTxHash,
      index: String(h.index),
      state: "UNVERIFIED_COMPLETION",
      updatedAt: Date.now(),
    };
    try {
      const sourceReceipt = await rpc("one", "eth_getTransactionReceipt", [
        h.initiatedTxHash,
      ]);
      const destinationReceipt = await rpc("bsc", "eth_getTransactionReceipt", [
        h.finalizedTxHash,
      ]);
      historical.push({
        claim,
        sourceReceipt,
        destinationReceipt,
        observation: await nativeTrack(claim),
      });
    } catch (e) {
      historical.push({ claim, error: String(e) });
    }
  }
  const publicAccounts = new Set<string>(),
    quotes: unknown[] = [];
  const event = nativeReadAbi.find(
    (entry) => entry.type === "event" && entry.name === "BridgeInitiated",
  )!;
  for (let page = 0; page < 2; page++) {
    const end = 45411356n - BigInt(page * 1000);
    const logs = await rpc("one", "eth_getLogs", [
      {
        address: deployment.source,
        fromBlock: toHex(end - 999n),
        toBlock: toHex(end),
        topics: [toEventSelector(event)],
      },
    ]);
    if (!Array.isArray(logs) || logs.length > 100)
      throw Error("LOG_PAGE_LIMIT");
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: nativeReadAbi,
          data: log.data as Hex,
          topics: log.topics,
          strict: true,
        });
        if (
          decoded.eventName === "BridgeInitiated" &&
          decoded.args.toChainID === 56n &&
          decoded.args.fromToken.toLowerCase() === NATIVE &&
          decoded.args.from === decoded.args.to
        )
          publicAccounts.add(decoded.args.from);
      } catch {
        /* Unknown events never become candidates. */
      }
    }
  }
  for (const account of [...publicAccounts].slice(0, 3)) {
    try {
      quotes.push({ account, quote: await liveQuote(account, "5") });
    } catch (e) {
      quotes.push({ account, error: String(e) });
    }
  }
  await writeFile(
    `${base}/public-candidates.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        historical,
        quotes,
        publicAccounts: [...publicAccounts],
        bounds: {
          historicalCandidates: 3,
          sourcePages: 2,
          blocksPerPage: 1000,
          quoteAccounts: 3,
        },
        calls: audit.calls,
        signatures: 0,
        approvals: 0,
        broadcasts: 0,
        deploys: 0,
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
    { flag: "wx" },
  );
  expect(
    audit.calls.every(
      (call) => !/send|sign|approve|broadcast/i.test(call.method),
    ),
  ).toBe(true);
});
