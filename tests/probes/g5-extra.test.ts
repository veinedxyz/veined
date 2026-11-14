import { it, expect } from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import {
  encodeFunctionData,
  decodeFunctionResult,
  erc20Abi,
  keccak256,
  type Hex,
} from "viem";
import { nativeTrack } from "../../src/adapters/native-service";
import { nativeReadAbi } from "../../src/adapters/native-abi";
import { READ_ONLY_DEPLOYMENT as deployment } from "../../src/adapters/deployment";
import { CROSS, NATIVE, type TransferRecord } from "../../src/core/model";
it("bounded independent pair/token reads and a second public receipt proof", async () => {
  const base = `${(await readFile(".otherbridge/v12-evidence-path.txt", "utf8")).trim()}/g5/extra`;
  await mkdir(base, { recursive: true });
  const requests: unknown[] = [];
  const read = async (url: string, body?: unknown) => {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    const raw = await response.text();
    if (raw.length > 1048576) throw Error("SIZE_LIMIT");
    const data = JSON.parse(raw);
    requests.push({
      at: new Date().toISOString(),
      url,
      body,
      status: response.status,
      data,
    });
    return data;
  };
  const rpc = async (method: string, params: unknown[]) => {
    if (!["eth_getCode", "eth_getBlockByNumber", "eth_call"].includes(method))
      throw Error("READ_ONLY");
    const data = await read("https://bsc-dataseed.bnbchain.org", {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    if (data.error) throw Error(JSON.stringify(data.error));
    return data.result;
  };
  const pairs = await read("https://bridge-api.crosstoken.io/bridge/pairs");
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const token: Record<string, unknown> = { chain: 56, address: CROSS, block };
  token.runtime = await rpc("eth_getCode", [CROSS, block.number]);
  token.runtimeHash = keccak256(token.runtime as Hex);
  for (const functionName of [
    "name",
    "symbol",
    "decimals",
    "totalSupply",
  ] as const) {
    const raw = await rpc("eth_call", [
      { to: CROSS, data: encodeFunctionData({ abi: erc20Abi, functionName }) },
      block.number,
    ]);
    token[functionName] = decodeFunctionResult({
      abi: erc20Abi,
      functionName,
      data: raw,
    });
  }
  const rawPair = await rpc("eth_call", [
    {
      to: deployment.destination,
      data: encodeFunctionData({
        abi: nativeReadAbi,
        functionName: "getTokenPair",
        args: [612055n, CROSS],
      }),
    },
    block.number,
  ]);
  token.pair = decodeFunctionResult({
    abi: nativeReadAbi,
    functionName: "getTokenPair",
    data: rawPair,
  });
  const owner = "0x680ea0e0cb5c52b54f47f118067bd49e6e9be898";
  const history = await read(
    "https://bridge-api.crosstoken.io/bridge/history",
    { owner, page: 1, size: 20, sort: "desc" },
  );
  const candidates = (history.data?.histories ?? []).filter(
    (h: Record<string, unknown>) =>
      h.source === "bridge" &&
      h.fromChainID === 612055 &&
      h.toChainID === 56 &&
      String(h.fromToken).toLowerCase() === NATIVE &&
      String(h.toToken).toLowerCase() === CROSS.toLowerCase() &&
      h.finalizedTxHash &&
      h.initiatedTxHash !==
        "0xa6d46ef91f760e68d999d1128ef2eee67e42dc7e05faea2d5ecec242c3a82a05",
  );
  const samples: unknown[] = [];
  for (const h of candidates.slice(0, 2)) {
    const claim: TransferRecord = {
      schema: 1,
      id: `public-${h.index}`,
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
      samples.push({ claim, observation: await nativeTrack(claim) });
    } catch (e) {
      samples.push({ claim, error: String(e) });
    }
    if (samples.length) break;
  }
  await writeFile(
    `${base}/independent-token-pair-history.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        pairs,
        token,
        history,
        samples,
        requests,
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
  expect(token.symbol).toBe("CROSS");
  expect(token.decimals).toBe(18);
  console.log(
    JSON.stringify({
      base,
      secondSampleCandidates: candidates.length,
      samples: samples.length,
    }),
  );
});
