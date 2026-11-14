// V1.6 G5: enumerate ONE->BSC in-flight obligations at a snapshot: indices in
// [BSC nextFinalize(612055), ONE nextInitiate(56)) are initiated on ONE but not yet finalized on BSC and will be
// paid before any new transfer. Each is located by eth_getLogs(BridgeInitiated, toChainID=56, index).
// Usage: node scripts/g5-v16-inflight.mjs <snapshotRel> <label>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pad, toHex, toEventSelector } from "viem";
import { EVIDENCE, rpc, retry, now, writeJson } from "./g5-v16-lib.mjs";
import { decodeLog } from "./g5-v16-proof-lib.mjs";

const [snapshotRel, label = "final"] = process.argv.slice(2);
const snap = JSON.parse(readFileSync(join(EVIDENCE, snapshotRel), "utf8"));
const one = snap.chains.one,
  bsc = snap.chains.bsc;
const ost = one.sources.find((s) => !s.error).state,
  bst = bsc.sources.find((s) => !s.error).state;
const nextInit = BigInt(ost.chains["56"].nextInitiateIndex),
  nextFin = BigInt(bst.chains["612055"].nextFinalizeIndex);
const SEL = toEventSelector(
  "BridgeInitiated(uint256,uint256,address,address,address,address,uint256,uint256,uint256,bytes,uint256)",
);
const ONE = "https://mainnet.crosstoken.io:22001",
  PROXY = "0xb81d6e000000000000000000000000000000c0de";
const items = [];
let enumerated = true;
for (let i = nextFin; i < nextInit; i++) {
  const logs = await retry(() =>
    rpc(
      ONE,
      "eth_getLogs",
      [
        {
          address: PROXY,
          fromBlock: toHex(BigInt(one.block) - 20000n),
          toBlock: toHex(BigInt(one.block)),
          topics: [SEL, pad(toHex(56n)), pad(toHex(i))],
        },
      ],
      { log: `reserve/in-flight-${label}-rpc.jsonl` },
    ),
  );
  if (logs.length !== 1) {
    enumerated = false;
    items.push({ index: i.toString(), found: logs.length });
    continue;
  }
  const d = decodeLog(logs[0]);
  items.push({
    index: i.toString(),
    tx: logs[0].transactionHash,
    block: Number(BigInt(logs[0].blockNumber)),
    toToken: d.args.toToken,
    to: d.args.to,
    value: d.args.value.toString(),
  });
}
const out = {
  at: now(),
  snapshot: snapshotRel,
  oneBlock: one.block,
  bscBlock: bsc.block,
  oneNextInitiate: nextInit.toString(),
  bscNextFinalize: nextFin.toString(),
  count: Number(nextInit > nextFin ? nextInit - nextFin : 0n),
  enumerated,
  values: items.filter((x) => x.value).map((x) => x.value),
  items,
};
const w = writeJson(`reserve/in-flight-${label}.json`, out);
console.log(JSON.stringify({ ...out, w }, null, 1));
