// V1.6 G5 §29/§50 independent second method: archive-state bisection of the BSC bridge CROSS surplus
// s(b) = balanceOf(bridge) - deposited(612055, CROSS) from proxy creation to the pinned block.
// Ledger-consistent events (deposit, payout, fee forward) never change s; every change point is located
// to the exact block and classified from that block's receipts. Read-only (eth_call / eth_getBlockReceipts).
// Usage: node scripts/g5-v16-surplus-bisect.mjs <startBlock> <endBlock> [gridPoints=48]
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { rpc, retry, now, writeJson } from "./g5-v16-lib.mjs";
import { decodeLog } from "./g5-v16-proof-lib.mjs";

const ARCHIVE = "https://bsc-mainnet.public.blastapi.io";
const RECEIPTS = "https://bsc-dataseed.bnbchain.org";
const PROXY = "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5";
const CROSS = "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510";
const abi = parseAbi([
  "function getTokenPair(uint256,address) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted))",
  "function balanceOf(address) view returns (uint256)",
]);
const [start, end] = [Number(process.argv[2]), Number(process.argv[3])];
const grid = Number(process.argv[4] ?? 48);
const hx = (n) => "0x" + BigInt(n).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
const cache = new Map();
async function call(to, fn, args, b) {
  await sleep(250);
  calls++;
  const data = encodeFunctionData({ abi, functionName: fn, args });
  const raw = await retry(
    () =>
      rpc(ARCHIVE, "eth_call", [{ to, data }, hx(b)], {
        log: "reserve/surplus-bisect-rpc.jsonl",
      }),
    8,
    3000,
  );
  return decodeFunctionResult({ abi, functionName: fn, data: raw });
}
async function state(b) {
  if (cache.has(b)) return cache.get(b);
  // Before the proxy exists getTokenPair returns empty data; treat as deposited 0.
  let deposited = 0n,
    pending = 0n;
  try {
    const p = await call(PROXY, "getTokenPair", [612055n, CROSS], b);
    deposited = p.deposited;
    pending = p.pendingAmount;
  } catch {
    /* pre-creation */
  }
  const balance = await call(CROSS, "balanceOf", [PROXY], b);
  const s = {
    block: b,
    balance,
    deposited,
    pending,
    surplus: balance - deposited,
  };
  cache.set(b, s);
  return s;
}
const changes = [];
async function scan(a, sa, b, sb) {
  if (sa.surplus === sb.surplus) return;
  if (b - a === 1) {
    changes.push({ from: sa, to: sb });
    return;
  }
  const m = Math.floor((a + b) / 2),
    sm = await state(m);
  await scan(a, sa, m, sm);
  await scan(m, sm, b, sb);
}
const pts = [];
for (let i = 0; i <= grid; i++)
  pts.push(Math.floor(start + ((end - start) * i) / grid));
const vals = [];
for (const p of pts) vals.push(await state(p));
const monotonic = vals.every(
  (v, i) => i === 0 || v.surplus >= vals[i - 1].surplus,
);
for (let i = 0; i < grid; i++)
  await scan(pts[i], vals[i], pts[i + 1], vals[i + 1]);
const classified = [];
for (const c of changes) {
  const b = c.to.block;
  const rcs = await retry(
    () =>
      rpc(RECEIPTS, "eth_getBlockReceipts", [hx(b)], {
        log: "reserve/surplus-bisect-rpc.jsonl",
      }),
    6,
    3000,
  );
  const touching = [];
  for (const r of rcs) {
    if (BigInt(r.status) !== 1n) continue;
    const evs = r.logs
      .map((l) => ({ l, d: decodeLog(l) }))
      .filter(
        (x) =>
          x.d &&
          ((x.l.address.toLowerCase() === CROSS &&
            x.d.event === "Transfer" &&
            [x.d.args.from.toLowerCase(), x.d.args.to.toLowerCase()].includes(
              PROXY,
            )) ||
            x.l.address.toLowerCase() === PROXY),
      );
    if (evs.length)
      touching.push({
        tx: r.transactionHash,
        from: r.from,
        to: r.to,
        events: evs.map((x) => ({
          logIndex: Number(BigInt(x.l.logIndex)),
          emitter: x.l.address,
          event: x.d.event,
          args: JSON.parse(
            JSON.stringify(x.d.args, (_, v) =>
              typeof v === "bigint" ? v.toString() : v,
            ),
          ),
        })),
      });
  }
  classified.push({
    block: b,
    surplusBefore: c.from.surplus,
    surplusAfter: c.to.surplus,
    delta: c.to.surplus - c.from.surplus,
    balanceDelta: c.to.balance - c.from.balance,
    depositedDelta: c.to.deposited - c.from.deposited,
    txs: touching,
  });
}
const out = {
  at: now(),
  archive: ARCHIVE,
  receipts: RECEIPTS,
  start,
  end,
  gridPoints: pts.length,
  archiveCalls: calls,
  monotonicOnGrid: monotonic,
  startState: vals[0],
  endState: vals[vals.length - 1],
  changePoints: classified,
  totalSurplusChange: vals[vals.length - 1].surplus - vals[0].surplus,
  sumOfChangeDeltas: classified.reduce((s, c) => s + c.delta, 0n),
};
out.CHANGES_SUM_TO_TOTAL = out.totalSurplusChange === out.sumOfChangeDeltas;
const w = writeJson(`reserve/surplus-bisect-${start}-${end}.json`, out);
console.log(
  JSON.stringify(
    {
      ...out,
      changePoints: classified.map((c) => ({
        block: c.block,
        delta: c.delta,
        balanceDelta: c.balanceDelta,
        depositedDelta: c.depositedDelta,
        txs: c.txs.map((t) => [
          t.tx,
          t.events
            .map(
              (e) =>
                `${e.event}${e.args.value ? ":" + e.args.value : ""}${e.args.to ? "->" + e.args.to : ""}`,
            )
            .join(" | "),
        ]),
      })),
    },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    1,
  ),
);
console.log(w);
