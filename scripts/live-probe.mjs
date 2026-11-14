import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeFunctionResult, erc20Abi } from "viem";
const root = "evidence/otherbridge-v1";
await mkdir(root, { recursive: true });
const calls = [];
const endpoints = {
  one: "https://mainnet.crosstoken.io:22001",
  bsc: "https://bsc-dataseed.bnbchain.org",
};
const source = "0xb81d6e000000000000000000000000000000c0de",
  destination = "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
  token = "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510";
const allowed = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_call",
  "eth_getStorageAt",
]);
async function rpc(chain, method, params = []) {
  if (!allowed.has(method)) throw Error("READ_ONLY_METHOD_REJECTED");
  const entry = { chain, method, params, at: new Date().toISOString() };
  calls.push(entry);
  try {
    const response = await fetch(endpoints[chain], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    entry.httpStatus = response.status;
    const result = await response.json();
    if (result.error) throw Error("RPC_ERROR");
    const value = result.result;
    if (method === "eth_getCode") {
      entry.result = {
        bytes: (value.length - 2) / 2,
        sha256: createHash("sha256").update(value).digest("hex"),
      };
    } else entry.result = value;
    return value;
  } catch (e) {
    entry.error = e.message;
    return undefined;
  }
}
const metadata = {};
for (const chain of ["one", "bsc"]) {
  await rpc(chain, "eth_chainId");
  await rpc(chain, "eth_getBlockByNumber", ["latest", false]);
  const contract = chain === "one" ? source : destination;
  await rpc(chain, "eth_getCode", [contract, "latest"]);
  await rpc(chain, "eth_getStorageAt", [
    contract,
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    "latest",
  ]);
}
await rpc("bsc", "eth_getCode", [token, "latest"]);
for (const [name, data] of [
  ["name", "0x06fdde03"],
  ["symbol", "0x95d89b41"],
  ["decimals", "0x313ce567"],
]) {
  const value = await rpc("bsc", "eth_call", [{ to: token, data }, "latest"]);
  if (value) {
    try {
      metadata[name] = decodeFunctionResult({
        abi: erc20Abi,
        functionName: name,
        data: value,
      });
    } catch {
      metadata[name] = "decode-failed";
    }
  }
}
const report = {
  observedAt: new Date().toISOString(),
  mode: "mainnet-readonly",
  candidateContracts: { source, destination },
  metadata,
  calls,
  G5: "BLOCKED",
  blockers: [
    "Native ONE deployment ABI/implementation match not proven",
    "Spendable reserves and pause/limits not fully verified",
    "Source-destination public example and finality policy not verified",
  ],
  broadcasts: 0,
  signatures: 0,
};
await writeFile(`${root}/live-readonly.json`, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    metadata,
    methods: calls.length,
    errors: calls.filter((c) => c.error).length,
    G5: report.G5,
  }),
);
// API publishes keyed RPC URLs; preserve useful metadata without replicating keys.
const infoPath = `${root}/live-chain-info.json`;
try {
  const info = JSON.parse(await readFile(infoPath, "utf8"));
  const body = JSON.parse(info.body);
  for (const chain of body.data ?? [])
    if (chain.rpc && new URL(chain.rpc).pathname !== "/")
      chain.rpc = `${new URL(chain.rpc).origin}/[PUBLIC_PROVIDER_PATH_REDACTED]`;
  info.body = body;
  await writeFile(infoPath, JSON.stringify(info, null, 2));
} catch {}
process.exitCode = 2; // This probe does not claim the full live acceptance gate passed.
