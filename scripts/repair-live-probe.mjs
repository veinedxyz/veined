import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  toEventSelector,
  toHex,
} from "viem";
const base = "evidence/otherbridge-v1/repair-r1";
await mkdir(`${base}/live`, { recursive: true });
const abi = JSON.parse(
  await readFile(
    `${base}/sources/skill-cross-crossd-skills_cross-crossd_scripts__bridge-router-abi.json`,
    "utf8",
  ),
);
const native = "0x0000000000000000000000000000000000000001";
const token = "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510";
const chains = {
  one: {
    id: 612055,
    url: "https://mainnet.crosstoken.io:22001",
    proxy: "0xb81d6e000000000000000000000000000000c0de",
    remote: 56,
    asset: native,
  },
  bsc: {
    id: 56,
    url: "https://bsc-dataseed.bnbchain.org",
    proxy: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
    remote: 612055,
    asset: token,
  },
};
const allowed = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_getLogs",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);
const calls = [];
async function rpc(chain, method, params) {
  if (!allowed.has(method)) throw Error("READ_ONLY_METHOD_REJECTED");
  const call = { chain, method, params, at: new Date().toISOString() };
  calls.push(call);
  try {
    const response = await fetch(chains[chain].url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    call.httpStatus = response.status;
    const raw = await response.text();
    if (raw.length > 1000000) throw Error("RESPONSE_SIZE_LIMIT");
    const result = JSON.parse(raw);
    if (result.error) {
      call.rpcError = result.error;
      return;
    }
    call.result = result.result;
    return call.result;
  } catch (error) {
    call.error = error.message;
  }
}
const snapshots = {};
for (const [chain, config] of Object.entries(chains)) {
  const id = await rpc(chain, "eth_chainId", []);
  if (!id || BigInt(id) !== BigInt(config.id)) throw Error("CHAIN_MISMATCH");
  const block = await rpc(chain, "eth_getBlockByNumber", ["latest", false]);
  const finalized = await rpc(chain, "eth_getBlockByNumber", [
    "finalized",
    false,
  ]);
  if (!block) continue;
  const slot = await rpc(chain, "eth_getStorageAt", [
    config.proxy,
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    block.number,
  ]);
  const implementation = slot ? `0x${slot.slice(-40)}` : undefined;
  const snapshot = {
    chainId: config.id,
    block,
    finalized,
    proxy: config.proxy,
    implementation,
    code: {},
    views: {},
  };
  snapshots[chain] = snapshot;
  for (const [name, address] of [
    ["proxy", config.proxy],
    ["implementation", implementation],
  ]) {
    if (!address) continue;
    const code = await rpc(chain, "eth_getCode", [address, block.number]);
    if (code)
      snapshot.code[name] = {
        address,
        bytes: (code.length - 2) / 2,
        keccak256: keccak256(code),
        sha256DecodedBytes: createHash("sha256")
          .update(Buffer.from(code.slice(2), "hex"))
          .digest("hex"),
        metadataTail: code.slice(-180),
      };
  }
  for (const [name, args] of [
    ["paused", []],
    ["bridgeVerifier", []],
    ["getTokenPair", [BigInt(config.remote), config.asset]],
    ["calculateFee", [BigInt(config.remote), config.asset, 10n ** 18n]],
    ["getNextInitiateIndex", [BigInt(config.remote)]],
    ["getNextFinalizeIndex", [BigInt(config.remote)]],
    ["initializedAt", []],
    ["eip712Domain", []],
  ]) {
    const data = encodeFunctionData({ abi, functionName: name, args });
    const result = await rpc(chain, "eth_call", [
      { to: config.proxy, data },
      block.number,
    ]);
    if (!result) continue;
    try {
      snapshot.views[name] = decodeFunctionResult({
        abi,
        functionName: name,
        data: result,
      });
    } catch (error) {
      snapshot.views[name] = { decodeError: error.message };
    }
  }
}
const initiated = abi.find(
  (a) => a.type === "event" && a.name === "BridgeInitiated",
);
const samples = [];
if (snapshots.one?.block) {
  const end = BigInt(snapshots.one.block.number);
  for (let page = 0; page < 6; page++) {
    const to = end - BigInt(page * 1000);
    const from = to - 999n;
    const logs = await rpc("one", "eth_getLogs", [
      {
        address: chains.one.proxy,
        fromBlock: toHex(from),
        toBlock: toHex(to),
        topics: [toEventSelector(initiated), toHex(56n, { size: 32 })],
      },
    ]);
    if (!Array.isArray(logs)) break;
    samples.push(...logs);
    if (samples.length) break;
  }
}
await writeFile(
  `${base}/live/discovery.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      abiSource:
        "Legacy frontend ABI snapshot; not independent deployment verification",
      hashEncoding:
        "keccak256 and sha256 over decoded runtime bytes, not hex text",
      snapshots,
      sourceInitiatedCandidates: samples,
      calls,
      signatures: 0,
      broadcasts: 0,
    },
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      snapshot: Object.fromEntries(
        Object.entries(snapshots).map(([k, v]) => [
          k,
          {
            implementation: v.implementation,
            code: v.code,
            views: v.views,
            finalizedBlock: v.finalized?.number,
            block: v.block?.number,
          },
        ]),
      ),
      samples: samples.length,
      errors: calls
        .filter((c) => c.error || c.rpcError)
        .map((c) => ({
          chain: c.chain,
          method: c.method,
          error: c.error,
          rpcError: c.rpcError,
        })),
    },
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
  ),
);
