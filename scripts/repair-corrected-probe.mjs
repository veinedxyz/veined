import { readFile, writeFile, access } from "node:fs/promises";
import {
  encodeFunctionData,
  decodeFunctionResult,
  decodeEventLog,
  toEventSelector,
  toHex,
  erc20Abi,
} from "viem";
import { nativeReadAbi as abi } from "../src/adapters/native-abi.ts";
const base = "evidence/otherbridge-v1/repair-r1/live";
const run = process.argv[2] ?? "corrected-discovery";
if (!/^[a-z0-9-]+$/.test(run)) throw Error("INVALID_RUN_NAME");
try {
  await access(`${base}/${run}.json`);
  throw Error("EVIDENCE_ALREADY_EXISTS");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const prior = JSON.parse(await readFile(`${base}/discovery.json`, "utf8"));
const chains = {
  one: "https://mainnet.crosstoken.io:22001",
  // BNB documentation says its public dataseed disables getLogs; use documented public provider capability, not rate-limit evasion.
  bsc: "https://bsc-rpc.publicnode.com",
};
const calls = [];
async function rpc(chain, method, params) {
  if (
    ![
      "eth_call",
      "eth_chainId",
      "eth_getLogs",
      "eth_getTransactionReceipt",
      "eth_getTransactionByHash",
      "eth_getBlockByNumber",
    ].includes(method)
  )
    throw Error("READ_ONLY");
  const call = { chain, method, params, at: new Date().toISOString() };
  calls.push(call);
  try {
    const response = await fetch(chains[chain], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    call.status = response.status;
    const text = await response.text();
    if (text.length > 1000000) throw Error("SIZE_LIMIT");
    const result = JSON.parse(text);
    if (result.error) {
      call.error = result.error;
      return;
    }
    call.result = result.result;
    return call.result;
  } catch (error) {
    call.error = error.message;
  }
}
const corrected = {};
const native = "0x0000000000000000000000000000000000000001",
  token = "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510";
for (const [chain, snapshot] of Object.entries(prior.snapshots)) {
  const id = await rpc(chain, "eth_chainId", []);
  if (!id || BigInt(id) !== BigInt(snapshot.chainId))
    throw Error("CHAIN_MISMATCH");
  snapshot.block = await rpc(chain, "eth_getBlockByNumber", ["latest", false]);
  snapshot.finalized = await rpc(chain, "eth_getBlockByNumber", [
    "finalized",
    false,
  ]);
  const remote = chain === "one" ? 56n : 612055n;
  const asset = chain === "one" ? native : token;
  corrected[chain] = {};
  for (const [name, to, args] of [
    ["getTokenPair", snapshot.proxy, [remote, asset]],
    ["isTokenFinalizePaused", snapshot.proxy, [remote, asset]],
    [
      "calculateFee",
      snapshot.views.bridgeVerifier,
      [remote, asset, 10n ** 18n],
    ],
    ["getTokenConfig", snapshot.views.bridgeVerifier, [remote, asset]],
    ["denominator", snapshot.views.bridgeVerifier, []],
  ]) {
    const data = encodeFunctionData({ abi, functionName: name, args });
    const result = await rpc(chain, "eth_call", [
      { to, data },
      snapshot.block.number,
    ]);
    if (result) {
      try {
        corrected[chain][name] = decodeFunctionResult({
          abi,
          functionName: name,
          data: result,
        });
      } catch (error) {
        corrected[chain][name] = { decodeError: error.message };
      }
    }
  }
  if (chain === "bsc") {
    const result = await rpc(chain, "eth_call", [
      {
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [snapshot.proxy],
        }),
      },
      snapshot.block.number,
    ]);
    if (result)
      corrected[chain].tokenBalance = decodeFunctionResult({
        abi: erc20Abi,
        functionName: "balanceOf",
        data: result,
      });
  }
}
const initiated = abi.find(
  (a) => a.type === "event" && a.name === "BridgeInitiated",
);
const samples = [];
const end = BigInt(prior.snapshots.one.block.number);
for (let page = 0; page < 12; page++) {
  const to = end - BigInt(page * 1000),
    from = to - 999n;
  const logs = await rpc("one", "eth_getLogs", [
    {
      address: prior.snapshots.one.proxy,
      fromBlock: toHex(from),
      toBlock: toHex(to),
      topics: [toEventSelector(initiated), toHex(56n, { size: 32 })],
    },
  ]);
  if (!Array.isArray(logs)) break;
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (
        decoded.args.fromToken?.toLowerCase() === native &&
        decoded.args.toToken?.toLowerCase() === token.toLowerCase()
      )
        samples.push({ log, decoded });
    } catch {
      /* Unknown event kept in raw calls, never classified as native. */
    }
  }
  if (samples.length) break;
}
const pairs = [];
for (const sample of samples.slice(-3)) {
  const sourceReceipt = await rpc("one", "eth_getTransactionReceipt", [
    sample.log.transactionHash,
  ]);
  const sourceTransaction = await rpc("one", "eth_getTransactionByHash", [
    sample.log.transactionHash,
  ]);
  const destinationEnd = BigInt(prior.snapshots.bsc.block.number);
  const finalized = abi.find(
    (a) => a.type === "event" && a.name === "BridgeFinalized",
  );
  let match;
  for (let page = 0; page < 12; page++) {
    const to = destinationEnd - BigInt(page * 1000),
      from = to - 999n;
    const logs = await rpc("bsc", "eth_getLogs", [
      {
        address: prior.snapshots.bsc.proxy,
        fromBlock: toHex(from),
        toBlock: toHex(to),
        topics: [
          toEventSelector(finalized),
          toHex(612055n, { size: 32 }),
          toHex(sample.decoded.args.index, { size: 32 }),
          toHex(BigInt(token), { size: 32 }),
        ],
      },
    ]);
    if (!Array.isArray(logs)) break;
    if (logs.length === 1) {
      match = logs[0];
      break;
    }
    if (logs.length > 1) break;
  }
  const destinationReceipt =
    match &&
    (await rpc("bsc", "eth_getTransactionReceipt", [match.transactionHash]));
  const destinationTransaction =
    match &&
    (await rpc("bsc", "eth_getTransactionByHash", [match.transactionHash]));
  const sourceBlock =
    sourceReceipt &&
    (await rpc("one", "eth_getBlockByNumber", [
      sourceReceipt.blockNumber,
      false,
    ]));
  const destinationBlock =
    destinationReceipt &&
    (await rpc("bsc", "eth_getBlockByNumber", [
      destinationReceipt.blockNumber,
      false,
    ]));
  pairs.push({
    sample,
    sourceReceipt,
    sourceTransaction,
    match,
    destinationReceipt,
    destinationTransaction,
    sourceBlock,
    destinationBlock,
  });
  if (destinationReceipt) break;
}
await writeFile(
  `${base}/${run}.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      note: "Correct seven-field pair layout and BridgeInitiated topic; verifier fee reads; raw discovery legacy decode superseded",
      corrected,
      endpointSources: [
        "https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/",
        "https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-56.json",
        "https://www.publicnode.com/?network=Mainnet",
      ],
      endpoints: chains,
      heads: Object.fromEntries(
        Object.entries(prior.snapshots).map(([chain, snapshot]) => [
          chain,
          { block: snapshot.block, finalized: snapshot.finalized },
        ]),
      ),
      pairs,
      calls,
      broadcasts: 0,
      signatures: 0,
    },
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      corrected,
      sourceSamples: samples.length,
      matchedDestination: pairs.filter((p) => p.destinationReceipt).length,
      calls: calls.length,
      errors: calls
        .filter((c) => c.error)
        .map((c) => ({ chain: c.chain, method: c.method, error: c.error })),
    },
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
  ),
);
