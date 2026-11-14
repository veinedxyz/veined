// V1.6 G5 §59/§78 gate J: runtime-drift recheck between the evidence pins and the final pinned blocks.
// Scans both proxies for Upgraded/AdminChanged/BeaconUpgraded/Initialized/role/threshold/verifier/pause
// events in (fromBlock, finalBlock] and compares the final runtime hashes with the exact-build pins.
// Usage: node scripts/g5-v16-drift-recheck.mjs <oneFrom> <oneTo> <bscFrom> <bscTo>
import { keccak256, toEventSelector } from "viem";
import { rpc, rpcRaw, retry, now, writeJson } from "./g5-v16-lib.mjs";

// "head" resolves to the current head minus 3 blocks at run time (public nodes keep only recent state).
const head = async (url) =>
  Number(BigInt(await retry(() => rpc(url, "eth_blockNumber", [])))) - 3;
const args = process.argv.slice(2);
const oneFrom = Number(args[0]),
  bscFrom = Number(args[2]);
const oneTo =
  args[1] === "head"
    ? await head("https://mainnet.crosstoken.io:22001")
    : Number(args[1]);
const bscTo =
  args[3] === "head"
    ? await head("https://bsc-dataseed.bnbchain.org")
    : Number(args[3]);
const WATCH = [
  "Upgraded(address)",
  "AdminChanged(address,address)",
  "BeaconUpgraded(address)",
  "Initialized(uint64)",
  "RoleGranted(bytes32,address,address)",
  "RoleRevoked(bytes32,address,address)",
  "ThresholdChanged(uint8)",
  "BridgeVerifierSet(address)",
  "DevSet(address)",
  "BridgeExecutorSet(address)",
  "Paused(address)",
  "Unpaused(address)",
  "TokenPauseSet(uint256,address,bool,bool)",
  "ChainPauseSet(uint256,bool)",
  "TokenPairRegistered(uint256,address,address,bool)",
  "PendingRemoved(uint256,uint256)",
  "ManualReleased(uint256,uint256)",
];
const topics = Object.fromEntries(WATCH.map((s) => [toEventSelector(s), s]));
const SIDES = [
  {
    chain: "one",
    url: "https://mainnet.crosstoken.io:22001",
    span: 300000,
    proxy: "0xb81d6e000000000000000000000000000000c0de",
    impl: "0x2827865ad5330faf855af8b743c701ae9c818034",
    implHash:
      "0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc",
    proxyHash:
      "0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b",
    from: oneFrom,
    to: oneTo,
  },
  {
    chain: "bsc",
    url: "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
    stateUrl: "https://bsc-dataseed.bnbchain.org",
    span: 50000,
    proxy: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
    impl: "0xac7b8ffed19d670930b8caa0693189b33454e8d8",
    implHash:
      "0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22",
    proxyHash:
      "0x25b30cfa97d56a7b846443ce92558cf31d86e95966c5afa22dacb0213c52ff9b",
    from: bscFrom,
    to: bscTo,
  },
];
const SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const hx = (n) => "0x" + n.toString(16);
const out = { at: now(), chains: {} };
for (const s of SIDES) {
  const events = [];
  for (let a = s.from + 1; a <= s.to; a += s.span) {
    const b = Math.min(a + s.span - 1, s.to);
    let logs = null;
    for (let i = 0; i < 8 && !logs; i++) {
      const r = await rpcRaw(
        s.url,
        "eth_getLogs",
        [
          {
            address: s.proxy,
            fromBlock: hx(a),
            toBlock: hx(b),
            topics: [Object.keys(topics)],
          },
        ],
        { log: "chain-pins/drift-recheck-rpc.jsonl", timeoutMs: 60000 },
      );
      if (Array.isArray(r.json?.result)) logs = r.json.result;
      else await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
    }
    if (!logs) throw new Error(`LOGS_UNAVAILABLE ${s.chain} ${a}-${b}`);
    events.push(
      ...logs.map((l) => ({
        event: topics[l.topics[0]],
        block: Number(BigInt(l.blockNumber)),
        tx: l.transactionHash,
        topics: l.topics,
        data: l.data,
      })),
    );
  }
  const stateUrl = s.stateUrl ?? s.url;
  const slot = await retry(() =>
    rpc(stateUrl, "eth_getStorageAt", [s.proxy, SLOT, hx(s.to)], {
      log: "chain-pins/drift-recheck-rpc.jsonl",
    }),
  );
  const implCode = await retry(() =>
    rpc(stateUrl, "eth_getCode", ["0x" + slot.slice(-40), hx(s.to)], {
      log: "chain-pins/drift-recheck-rpc.jsonl",
    }),
  );
  const proxyCode = await retry(() =>
    rpc(stateUrl, "eth_getCode", [s.proxy, hx(s.to)], {
      log: "chain-pins/drift-recheck-rpc.jsonl",
    }),
  );
  const c = {
    from: s.from,
    to: s.to,
    events,
    implementationAtFinal: "0x" + slot.slice(-40),
    implementationCodeHash: keccak256(implCode),
    proxyCodeHash: keccak256(proxyCode),
  };
  c.NO_DRIFT =
    events.length === 0 &&
    c.implementationAtFinal === s.impl &&
    c.implementationCodeHash === s.implHash &&
    c.proxyCodeHash === s.proxyHash;
  out.chains[s.chain] = c;
}
out.RUNTIME_DRIFT_RECHECK = Object.values(out.chains).every((c) => c.NO_DRIFT)
  ? "PASS"
  : "DRIFT_DETECTED";
const w = writeJson("chain-pins/drift-recheck.json", out);
console.log(JSON.stringify({ ...out, w }, null, 1));
