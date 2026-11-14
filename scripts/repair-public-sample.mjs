import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeEventLog, erc20Abi } from "viem";
import { nativeReadAbi } from "../src/adapters/native-abi.ts";
const base = "evidence/otherbridge-v1/repair-r1";
const name = process.argv[2] ?? "public-history";
if (!/^[a-z0-9-]+$/.test(name)) throw Error("INVALID_RUN_NAME");
const file = `${base}/live/${name}.json`;
try {
  await access(file);
  throw Error("EVIDENCE_ALREADY_EXISTS");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const discovery = JSON.parse(
  await readFile(`${base}/live/corrected-fresh.json`, "utf8"),
);
const pair = discovery.pairs[0];
const requests = [];
async function read(url, body) {
  const allowed = [
    "https://bridge-api.crosstoken.io/bridge/history",
    "https://bsc-dataseed.bnbchain.org",
    "https://mainnet.crosstoken.io:22001",
  ];
  if (!allowed.includes(url)) throw Error("HOST_NOT_ALLOWED");
  if (url.endsWith("org") || url.endsWith("22001")) {
    if (
      ![
        "eth_chainId",
        "eth_getTransactionReceipt",
        "eth_getTransactionByHash",
        "eth_getBlockByNumber",
      ].includes(body.method)
    )
      throw Error("READ_ONLY");
  }
  const request = { url, body, at: new Date().toISOString() };
  requests.push(request);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    request.status = response.status;
    const text = await response.text();
    if (text.length > 1048576) throw Error("SIZE_LIMIT");
    request.response = JSON.parse(text);
    return request.response;
  } catch (e) {
    request.error = e.message;
  }
}
const history =
  name === "public-settlement"
    ? JSON.parse(await readFile(`${base}/live/public-history.json`, "utf8"))
        .history
    : await read("https://bridge-api.crosstoken.io/bridge/history", {
        owner: pair.sourceTransaction.from,
        page: 1,
        size: 20,
        sort: "desc",
      });
const correlated = history?.data?.histories?.filter(
  (h) =>
    h.source === "bridge" &&
    h.fromChainID === 612055 &&
    h.toChainID === 56 &&
    h.initiatedTxHash === pair.sourceReceipt.transactionHash,
);
const sample = {
  sourceReceipt: pair.sourceReceipt,
  sourceTransaction: pair.sourceTransaction,
  sourceBlock: pair.sourceBlock,
};
if (
  name === "public-settlement" &&
  correlated?.length === 1 &&
  /^0x[0-9a-f]{64}$/i.test(correlated[0].finalizedTxHash)
) {
  for (const [chain, endpoint, hash] of [
    [
      "source",
      "https://mainnet.crosstoken.io:22001",
      pair.sourceReceipt.transactionHash,
    ],
    [
      "destination",
      "https://bsc-dataseed.bnbchain.org",
      correlated[0].finalizedTxHash,
    ],
  ]) {
    const rpc = async (method, params) =>
      (await read(endpoint, { jsonrpc: "2.0", id: 1, method, params }))?.result;
    sample[`${chain}ChainId`] = await rpc("eth_chainId", []);
    sample[`${chain}Receipt`] = await rpc("eth_getTransactionReceipt", [hash]);
    sample[`${chain}Transaction`] = await rpc("eth_getTransactionByHash", [
      hash,
    ]);
    if (sample[`${chain}Receipt`])
      sample[`${chain}Block`] = await rpc("eth_getBlockByNumber", [
        sample[`${chain}Receipt`].blockNumber,
        false,
      ]);
    sample[`${chain}Finalized`] = await rpc("eth_getBlockByNumber", [
      "finalized",
      false,
    ]);
    sample[`${chain}DecodedLogs`] = (sample[`${chain}Receipt`]?.logs ?? []).map(
      (log) => {
        for (const abi of [nativeReadAbi, erc20Abi]) {
          try {
            return {
              log,
              decoded: decodeEventLog({
                abi,
                data: log.data,
                topics: log.topics,
                strict: true,
              }),
            };
          } catch {
            /* Retain raw unknown log without using it as proof. */
          }
        }
        return { log };
      },
    );
  }
}
await writeFile(
  file,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      sourceHash: pair.sourceReceipt.transactionHash,
      sourceIndex: pair.sample.decoded.args.index,
      owner: pair.sourceTransaction.from,
      apiProvenance: {
        url: "https://raw.githubusercontent.com/to-nexus/skill-cross-crossd/8ef4f05a88c053e42b8e17d37feff4207884f618/skills/cross-crossd/scripts/_api.mjs",
        sha256: createHash("sha256")
          .update(await readFile(`${base}/sources/skill-public-api.mjs`))
          .digest("hex"),
      },
      history,
      correlated,
      sample,
      requests,
      signatures: 0,
      broadcasts: 0,
    },
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    evidence: file,
    status: requests[0]?.status,
    keys: history && Object.keys(history),
    error: requests.filter((r) => r.error || r.response?.error),
    destinationDecoded: sample.destinationDecodedLogs?.map(
      (l) => l.decoded?.eventName,
    ),
  }),
);
