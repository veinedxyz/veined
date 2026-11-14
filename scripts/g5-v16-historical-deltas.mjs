// V1.6 G5 §31: archive-state accounting deltas around proven payouts. For each destination block B,
// read deposited/pendingAmount/balanceOf(bridge) at B-1 and B and compare with the sum of ALL bridge
// events for the CROSS pair inside block B (from the block receipts), under the exact live semantics.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { rpc, retry, now, writeJson, EVIDENCE } from "./g5-v16-lib.mjs";
import { decodeLog } from "./g5-v16-proof-lib.mjs";

const ARCHIVE = "https://bsc-mainnet.public.blastapi.io";
const RECEIPTS = "https://bsc-dataseed.bnbchain.org";
const PROXY = "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
  CROSS = "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510";
const abi = parseAbi([
  "function getTokenPair(uint256,address) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted))",
  "function balanceOf(address) view returns (uint256)",
]);
const hx = (n) => "0x" + BigInt(n).toString(16);
const call = async (to, fn, args, block) =>
  decodeFunctionResult({
    abi,
    functionName: fn,
    data: await retry(
      () =>
        rpc(
          ARCHIVE,
          "eth_call",
          [
            { to, data: encodeFunctionData({ abi, functionName: fn, args }) },
            hx(block),
          ],
          { log: "reserve/historical-rpc.jsonl" },
        ),
      5,
      4000,
    ),
  });
const state = async (b) => {
  const p = await call(PROXY, "getTokenPair", [612055n, CROSS], b);
  return {
    block: b,
    deposited: p.deposited,
    pendingAmount: p.pendingAmount,
    balance: await call(CROSS, "balanceOf", [PROXY], b),
  };
};

const out = { at: now(), archive: ARCHIVE, receipts: RECEIPTS, cases: [] };
for (const n of [1, 2, 3]) {
  const proof = JSON.parse(
    readFileSync(`${EVIDENCE}/payouts/payout-proof-${n}.json`, "utf8"),
  );
  const B = proof.destination.block;
  const [before, after] = [await state(B - 1), await state(B)];
  const rcs = await retry(() =>
    rpc(RECEIPTS, "eth_getBlockReceipts", [hx(B)], {
      log: "reserve/historical-rpc.jsonl",
    }),
  );
  let expDeposited = 0n,
    expBalance = 0n,
    expPending = 0n;
  const events = [];
  for (const r of rcs) {
    if (BigInt(r.status) !== 1n) continue;
    for (const l of r.logs) {
      const d = decodeLog(l);
      if (!d) continue;
      if (
        l.address.toLowerCase() === PROXY &&
        d.event === "BridgeFinalized" &&
        d.args.toToken.toLowerCase() === CROSS
      ) {
        expDeposited -= d.args.value;
        events.push([
          "BridgeFinalized",
          d.args.index.toString(),
          d.args.value.toString(),
        ]);
      }
      if (
        l.address.toLowerCase() === PROXY &&
        d.event === "BridgeInitiated" &&
        d.args.fromToken.toLowerCase() === CROSS
      ) {
        events.push([
          "BridgeInitiated",
          d.args.index.toString(),
          d.args.value.toString(),
          d.args.to,
        ]);
      }
      if (
        l.address.toLowerCase() === PROXY &&
        d.event === "BridgePending" &&
        d.args.toToken.toLowerCase() === CROSS
      ) {
        expPending += d.args.value;
        events.push([
          "BridgePending",
          d.args.index.toString(),
          d.args.value.toString(),
        ]);
      }
      if (l.address.toLowerCase() === CROSS && d.event === "Transfer") {
        if (d.args.to.toLowerCase() === PROXY) expBalance += d.args.value;
        if (d.args.from.toLowerCase() === PROXY) expBalance -= d.args.value;
      }
    }
  }
  // Deposits: BridgeInitiated (BSC->ONE, CROSS) increase deposited by `value` unless it is a dead-wallet burn
  // (burnCrossToDeadWallet: no transfer into the bridge, no deposited change). Identify burns by the absence of an inbound transfer in the same tx.
  for (const r of rcs) {
    if (BigInt(r.status) !== 1n) continue;
    const inits = r.logs
      .map((l) => ({ l, d: decodeLog(l) }))
      .filter(
        (x) =>
          x.l.address.toLowerCase() === PROXY &&
          x.d?.event === "BridgeInitiated" &&
          x.d.args.fromToken.toLowerCase() === CROSS,
      );
    const inbound = r.logs
      .map((l) => ({ l, d: decodeLog(l) }))
      .filter(
        (x) =>
          x.l.address.toLowerCase() === CROSS &&
          x.d?.event === "Transfer" &&
          x.d.args.to.toLowerCase() === PROXY,
      );
    if (inits.length && inbound.length)
      for (const x of inits) expDeposited += x.d.args.value;
  }
  const c = {
    proof: n,
    block: B,
    events,
    observed: {
      depositedDelta: after.deposited - before.deposited,
      balanceDelta: after.balance - before.balance,
      pendingDelta: after.pendingAmount - before.pendingAmount,
    },
    expectedFromBlockEvents: {
      depositedDelta: expDeposited,
      balanceDelta: expBalance,
      pendingDelta: expPending,
    },
    surplusBefore: before.balance - before.deposited,
    surplusAfter: after.balance - after.deposited,
  };
  c.MATCH =
    c.observed.depositedDelta === expDeposited &&
    c.observed.balanceDelta === expBalance &&
    c.observed.pendingDelta === expPending;
  out.cases.push(c);
}
out.allMatch = out.cases.every((c) => c.MATCH);
const w = writeJson("reserve/historical-deltas.json", out);
console.log(
  JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1),
);
console.log(w);
