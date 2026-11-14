// V1.6 G5: discover RECENT completed ONE->BSC payouts (BSC BridgeFinalized, fromChainID=612055, toToken=CROSS),
// newest first, then locate the matching ONEchain BridgeInitiated(toChainID=56, index) by eth_getLogs.
// Read-only. Usage: node scripts/g5-find-recent-payouts.mjs [blocksBack=150000] [maxCandidates=6]
import { pad, toHex, toEventSelector } from "viem";
import { rpc, rpcRaw, retry, now, writeJson } from "./g5-v16-lib.mjs";
import { decodeLog } from "./g5-v16-proof-lib.mjs";

const BSC_LOGS =
  "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3"; // chainlist-published public endpoint
const BSC = "https://bsc-dataseed.bnbchain.org";
const ONE_RPCS = [
  "https://mainnet.crosstoken.io:22001",
  "https://mainnet.onechain.nexus:22001",
];
const BSC_PROXY = "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5";
const ONE_PROXY = "0xb81d6e000000000000000000000000000000c0de";
const CROSS = "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510";
const SEL_FIN = toEventSelector(
  "BridgeFinalized(uint256,uint256,address,address,uint256,uint256)",
);
const SEL_INIT = toEventSelector(
  "BridgeInitiated(uint256,uint256,address,address,address,address,uint256,uint256,uint256,bytes,uint256)",
);
const hx = (n) => "0x" + n.toString(16);
const back = Number(process.argv[2] ?? 150000),
  maxC = Number(process.argv[3] ?? 6);

async function bscLogs(a, b, topics) {
  for (let i = 0; i < 8; i++) {
    const r = await rpcRaw(
      BSC_LOGS,
      "eth_getLogs",
      [{ address: BSC_PROXY, fromBlock: hx(a), toBlock: hx(b), topics }],
      { log: "payouts/discovery-rpc.jsonl", timeoutMs: 60000 },
    );
    if (Array.isArray(r.json?.result)) return r.json.result;
    await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
  }
  throw new Error("BSC_LOGS_FAILED");
}

const head = Number(BigInt(await retry(() => rpc(BSC, "eth_blockNumber", []))));
const found = [];
for (let b = head; b > head - back && found.length < 40; b -= 50000) {
  const a = Math.max(b - 49999, head - back);
  const logs = await bscLogs(a, b, [
    SEL_FIN,
    pad(toHex(612055)),
    null,
    pad(CROSS),
  ]);
  for (const l of logs) found.push(l);
}
const candidates = found
  .map((l) => ({ l, d: decodeLog(l) }))
  .filter((x) => x.d?.event === "BridgeFinalized")
  .map(({ l, d }) => ({
    index: d.args.index.toString(),
    to: d.args.to,
    value: d.args.value.toString(),
    time: Number(d.args.time),
    destTx: l.transactionHash,
    destBlock: Number(BigInt(l.blockNumber)),
    destBlockHash: l.blockHash,
    destLogIndex: Number(BigInt(l.logIndex)),
  }))
  .sort((x, y) => Number(BigInt(y.index) - BigInt(x.index)));

// ONE block-by-time estimate from two reference points
const ONE = ONE_RPCS[0];
const oneHead = await retry(() =>
  rpc(ONE, "eth_getBlockByNumber", ["latest", false]),
);
const refN = 22464737,
  refT = Date.parse("2026-01-09T06:02:30Z") / 1000;
const hN = Number(BigInt(oneHead.number)),
  hT = Number(BigInt(oneHead.timestamp));
const bpsec = (hN - refN) / (hT - refT);
const estimate = (t) => Math.round(hN - (hT - t) * bpsec);

const out = [];
for (const c of candidates.slice(0, maxC)) {
  const est = estimate(c.time);
  let match = null,
    searched = [];
  for (const w of [3000, 20000, 100000]) {
    const a = Math.max(0, est - w),
      b = Math.min(hN, est + 600);
    searched.push([a, b]);
    const r = await rpcRaw(
      ONE,
      "eth_getLogs",
      [
        {
          address: ONE_PROXY,
          fromBlock: hx(a),
          toBlock: hx(b),
          topics: [SEL_INIT, pad(toHex(56)), pad(toHex(BigInt(c.index)))],
        },
      ],
      { log: "payouts/discovery-rpc.jsonl", timeoutMs: 60000 },
    );
    const logs = r.json?.result ?? [];
    if (logs.length) {
      match = logs;
      break;
    }
  }
  const src =
    match
      ?.map((l) => ({ l, d: decodeLog(l) }))
      .filter((x) => x.d?.event === "BridgeInitiated") ?? [];
  out.push({
    ...c,
    oneEstimatedBlock: est,
    oneSearched: searched,
    sourceMatches: src.map(({ l, d }) => ({
      sourceTx: l.transactionHash,
      sourceBlock: Number(BigInt(l.blockNumber)),
      sourceBlockHash: l.blockHash,
      sourceLogIndex: Number(BigInt(l.logIndex)),
      fromToken: d.args.fromToken,
      toToken: d.args.toToken,
      from: d.args.from,
      to: d.args.to,
      value: d.args.value.toString(),
      networkFee: d.args.networkFee.toString(),
      exFee: d.args.exFee.toString(),
      extraData: d.args.extraData,
      time: Number(d.args.time),
    })),
  });
}
const result = {
  at: now(),
  bscHead: head,
  blocksBack: back,
  finalizedFound: candidates.length,
  oneHead: hN,
  oneBlocksPerSecond: bpsec,
  candidates: out,
};
const w = writeJson("payouts/recent-payout-candidates.json", result);
console.log(
  JSON.stringify(
    {
      ...result,
      candidates: out.map((x) => ({
        index: x.index,
        value: x.value,
        to: x.to,
        destTx: x.destTx,
        destBlock: x.destBlock,
        src: x.sourceMatches.map((s) => [
          s.sourceTx,
          s.sourceBlock,
          s.to,
          s.value,
          s.toToken,
        ]),
      })),
    },
    null,
    1,
  ),
);
console.log(w);
