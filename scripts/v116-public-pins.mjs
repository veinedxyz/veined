import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { keccak256 } from "viem";
const out = process.argv[2];
if (!out) throw Error("NEW_OUTPUT_REQUIRED");
mkdirSync(out, { recursive: true });
const urls = {
  1: "https://ethereum-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  solana: "https://api.mainnet-beta.solana.com",
};
let requests = 0;
const results = [],
  sha = (b) => createHash("sha256").update(b).digest("hex");
async function rpc(chain, method, params) {
  requests++;
  const r = await fetch(urls[chain], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requests, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw Error("HTTP_" + r.status);
  const j = await r.json();
  if (j.error) throw Error("RPC_ERROR");
  return j.result;
}
const slots = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
];
const pins = JSON.parse(
  readFileSync("src/swap/server/deployment-pins.generated.json"),
);
for (const chain of ["1", "56", "8453"]) {
  let block;
  try {
    const id = await rpc(chain, "eth_chainId", []);
    if (BigInt(id) !== BigInt(chain)) throw Error("CHAIN_MISMATCH");
    block = await rpc(chain, "eth_getBlockByNumber", ["latest", false]);
  } catch (e) {
    results.push({ chain, status: "UNAVAILABLE", error: e.message });
    continue;
  }
  for (const p of pins.filter((p) => p.chain === chain))
    try {
      const code = await rpc(chain, "eth_getCode", [p.address, block.number]),
        observedSlots = [];
      for (const slot of slots)
        observedSlots.push(
          await rpc(chain, "eth_getStorageAt", [p.address, slot, block.number]),
        );
      const codehash = keccak256(code),
        matches =
          codehash === p.codehash &&
          JSON.stringify(observedSlots) === JSON.stringify(p.proxySlots);
      results.push({
        chain,
        role: p.role,
        address: p.address,
        block: block.number,
        blockHash: block.hash,
        codehash,
        proxySlots: observedSlots,
        status: matches ? "PIN_MATCH" : "REVIEW_REQUIRED",
        autoActivated: false,
      });
    } catch (e) {
      results.push({
        chain,
        role: p.role,
        address: p.address,
        status: "UNAVAILABLE",
        error: e.message,
      });
    }
  console.log(chain, "done");
}
for (const p of JSON.parse(
  readFileSync("src/swap/server/solana-program-pins.generated.json"),
))
  try {
    const r = await rpc("solana", "getAccountInfo", [
      p.address,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const a = r.value;
    const observedCodeSha256 = a ? sha(Buffer.from(a.data[0], "base64")) : null;
    let matches =
        !!a && a.owner === p.loader && observedCodeSha256 === p.codeSha256,
      observedMetadata = null;
    if (p.programData) {
      const data = await rpc("solana", "getAccountInfo", [
        p.programData,
        {
          encoding: "base64",
          commitment: "confirmed",
          dataSlice: { offset: 0, length: 45 },
        },
      ]);
      observedMetadata = data.value?.data?.[0];
      matches =
        matches &&
        observedMetadata === p.metadata &&
        data.value.owner === p.loader;
    }
    results.push({
      chain: "solana",
      address: p.address,
      slot: r.context.slot,
      observedCodeSha256,
      expectedCodeSha256: p.codeSha256,
      observedMetadata,
      expectedMetadata: p.metadata,
      status: matches ? "PIN_MATCH" : "REVIEW_REQUIRED",
      autoActivated: false,
    });
  } catch (e) {
    results.push({
      chain: "solana",
      address: p.address,
      status: "UNAVAILABLE",
      error: e.message,
    });
  }
writeFileSync(
  out + "/current-pins.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      results,
      requests,
      writes: 0,
      execution: "CLOSED",
      expected: pins.length + 7,
      unchangedPinFileSha256: {
        evm: sha(
          readFileSync("src/swap/server/deployment-pins.generated.json"),
        ),
        solana: sha(
          readFileSync("src/swap/server/solana-program-pins.generated.json"),
        ),
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    results: results.length,
    match: results.filter((r) => r.status === "PIN_MATCH").length,
    review: results.filter((r) => r.status === "REVIEW_REQUIRED").length,
    unavailable: results.filter((r) => r.status === "UNAVAILABLE").length,
  }),
);
