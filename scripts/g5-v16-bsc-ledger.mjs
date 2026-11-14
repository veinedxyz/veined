// V1.6 G5 §26-§29, §48, §50: event-sourced BSC CROSS reserve ledger from proxy creation to the pinned block.
// Reconstructs `deposited` and `pendingAmount` from every bridge-proxy log and requires exact equality with the
// live values at the same pinned block. The physical balance is reconciled with CROSS Transfer logs where they
// were scanned (contiguous prefix) and with archive-state surplus bisection (balance - deposited) afterwards;
// every balance movement that is not a ledger event is located and classified.
// Usage: node scripts/g5-v16-bsc-ledger.mjs <pinnedSnapshotRel> <surplusBisectRel>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  toEventSelector,
} from "viem";
import {
  EVIDENCE,
  REPO,
  now,
  writeJson,
  sha256,
  rpc,
  retry,
} from "./g5-v16-lib.mjs";
import { decodeLog } from "./g5-v16-proof-lib.mjs";

const PROXY = "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5";
const CROSS = "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510";
const DEV = "0x90583a8f272c7782646e58e6bfc49933678fffb0";
const DEAD = new Set([
  "0x000000000000000000000000000000000000dead",
  "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
  "0xdead000000000000000000000000000000000000",
]);
// initializeBSCBridge(..., crossInitialSupply = 20,000,000e18), decoded from the proxy creation tx.
const INITIAL_DEPOSITED = 20_000_000n * 10n ** 18n;
const RECEIPTS = "https://bsc-dataseed.bnbchain.org";
const ARCHIVE = "https://bsc-mainnet.public.blastapi.io";
const DIR = join(
  REPO,
  "..",
  "otherbridge-forensics",
  "v16",
  "bsc-ledger-chunks",
);
const [snapshotRel = "reserve/route-snapshot-initial.json", bisectRel] =
  process.argv.slice(2);
const snap = JSON.parse(readFileSync(join(EVIDENCE, snapshotRel), "utf8"));
const bsc = snap.chains.bsc;
const live = bsc.sources.find((s) => !s.error).state;
const livePair = live.chains["612055"].pairs.find(
  (p) => p.localToken.toLowerCase() === CROSS,
);
const PIN = bsc.block;
const manifestText = readFileSync(
  join(EVIDENCE, "reserve/bsc-ledger-scan-manifest.json"),
);
const manifest = JSON.parse(manifestText);
if (!manifest.contiguous || manifest.start !== 48753627 || manifest.end !== PIN)
  throw new Error(
    `SCAN_NOT_COMPLETE ${manifest.start}-${manifest.end} vs ${PIN}`,
  );
for (const c of manifest.chunks)
  if (sha256(readFileSync(join(DIR, c.file))) !== c.sha256)
    throw new Error(`CHUNK_HASH_MISMATCH ${c.file}`);
const bisect = JSON.parse(readFileSync(join(EVIDENCE, bisectRel), "utf8"));
const T_END = manifest.transferCoverage.to; // last block with full Transfer-log coverage (contiguous prefix)
if (!manifest.transferCoverage.contiguousPrefix)
  throw new Error("TRANSFER_COVERAGE_NOT_PREFIX");

const named = {};
for (const s of [
  "Initialized(uint64)",
  "RoleGranted(bytes32,address,address)",
  "RoleRevoked(bytes32,address,address)",
  "TokenPairRegistered(uint256,address,address,bool)",
  "BridgeVerifierSet(address)",
  "DevSet(address)",
  "Upgraded(address)",
  "TokenPauseSet(uint256,address,bool,bool)",
  "ChainPauseSet(uint256,bool)",
  "Paused(address)",
  "Unpaused(address)",
  "VerificationDelaySet(uint256)",
  "VerificationDelayExpirationSet(uint256,uint256,uint256)",
  "MaxExtraDataLengthSet(uint256)",
  "BridgeExecutorSet(address)",
  "PostCallGasReserveSet(uint256,uint256)",
  "ThresholdChanged(uint8)",
  "CrossMintableERC20CodeSet(address,address)",
  "ExtraCallExecuted(uint256,uint256,address,bytes4,bool,uint256,bytes)",
  "EIP712DomainChanged()",
  "RoleAdminChanged(bytes32,bytes32,bytes32)",
  // first implementation (v1.0.0 era) configuration events with older signatures
  "CrossMintableERC20CodeSet(address)",
  "TokenPauseSet(uint256,address,bool)",
  "TokenPairUnregistered(uint256,address)",
])
  named[toEventSelector(s)] = s;

const proxyLogs = [],
  transfers = [];
for (const { file } of manifest.chunks) {
  const j = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  proxyLogs.push(...j.proxyLogs);
  if (j.crossIn === null) continue;
  const seen = new Set();
  for (const l of [...j.crossIn, ...j.crossOut]) {
    const k = `${l.transactionHash}:${l.logIndex}`;
    if (!seen.has(k)) {
      seen.add(k);
      transfers.push(l);
    }
  }
}
const key = (l) => [Number(BigInt(l.blockNumber)), Number(BigInt(l.logIndex))];
const order = (a, b) => {
  const [x, y] = [key(a), key(b)];
  return x[0] - y[0] || x[1] - y[1];
};
proxyLogs.sort(order);
transfers.sort(order);

const byTx = new Map();
for (const t of transfers) {
  const d = decodeLog(t);
  if (!d || d.event !== "Transfer") throw new Error("NON_TRANSFER_LOG");
  const rec = {
    tx: t.transactionHash,
    block: Number(BigInt(t.blockNumber)),
    logIndex: Number(BigInt(t.logIndex)),
    from: d.args.from.toLowerCase(),
    to: d.args.to.toLowerCase(),
    value: d.args.value,
    cls: null,
  };
  if (!byTx.has(rec.tx)) byTx.set(rec.tx, []);
  byTx.get(rec.tx).push(rec);
}
const proxyTx = new Set(proxyLogs.map((l) => l.transactionHash));
const counts = {},
  unknownTopics = {};
for (const l of proxyLogs) {
  const d = decodeLog(l);
  const name = d?.event ?? named[l.topics[0]];
  if (!name) unknownTopics[l.topics[0]] = (unknownTopics[l.topics[0]] ?? 0) + 1;
  counts[name ?? "UNKNOWN"] = (counts[name ?? "UNKNOWN"] ?? 0) + 1;
}

// Burn candidates outside the Transfer-scanned prefix are resolved from their own receipts.
const receiptCache = new Map();
async function receiptTransfers(tx) {
  if (!receiptCache.has(tx)) {
    const r = await retry(
      () =>
        rpc(RECEIPTS, "eth_getTransactionReceipt", [tx], {
          log: "reserve/ledger-receipts-rpc.jsonl",
        }),
      6,
      2000,
    );
    receiptCache.set(
      tx,
      r.logs
        .filter((l) => l.address.toLowerCase() === CROSS)
        .map((l) => decodeLog(l))
        .filter((d) => d?.event === "Transfer")
        .map((d) => ({
          from: d.args.from.toLowerCase(),
          to: d.args.to.toLowerCase(),
          value: d.args.value,
        })),
    );
  }
  return receiptCache.get(tx);
}

let deposited = INITIAL_DEPOSITED,
  pendingAmount = 0n;
const pendingByIndex = new Map(),
  finalizedIdx = new Set(),
  initiatedIdx = new Set();
// Index sequences are per remote chain and shared by every token pair (CROSS and USDT).
const chainFinalizeIdx = new Set(),
  chainInitiateIdx = new Set();
const sums = {
  deposits: 0n,
  depositCount: 0,
  payouts: 0n,
  payoutCount: 0,
  releasedPayouts: 0n,
  burns: 0n,
  burnCount: 0,
  feesForwarded: 0n,
  selfPayouts: 0n,
  selfPayoutCount: 0,
  pendingCreated: 0n,
  pendingRemoved: 0n,
  manualReleased: 0,
  executorCalls: 0,
};
const anomalies = [],
  burns = [],
  selfPayouts = [];
for (const l of proxyLogs) {
  const d = decodeLog(l);
  if (!d) {
    if (named[l.topics[0]]?.startsWith("ExtraCallExecuted"))
      sums.executorCalls++;
    continue; // configuration/role events: counted above, no accounting effect
  }
  const a = d.args,
    tx = l.transactionHash,
    block = Number(BigInt(l.blockNumber));
  if (
    (d.event === "BridgeFinalized" || d.event === "BridgePending") &&
    a.fromChainID === 612055n
  )
    chainFinalizeIdx.add(a.index);
  if (d.event === "BridgeInitiated" && a.toChainID === 612055n) {
    if (chainInitiateIdx.has(a.index))
      anomalies.push({
        kind: "DUPLICATE_INITIATE_INDEX_ANY_TOKEN",
        index: a.index.toString(),
        tx,
      });
    chainInitiateIdx.add(a.index);
  }
  const scanned = block <= T_END;
  const tfs = byTx.get(tx) ?? [];
  if (d.event === "BridgeInitiated" && a.fromToken.toLowerCase() === CROSS) {
    if (a.toChainID !== 612055n) {
      anomalies.push({ kind: "INITIATE_OTHER_CHAIN", tx });
      continue;
    }
    if (initiatedIdx.has(a.index))
      anomalies.push({
        kind: "DUPLICATE_INITIATE_INDEX",
        index: a.index.toString(),
        tx,
      });
    initiatedIdx.add(a.index);
    const fee = a.networkFee + a.exFee;
    let isDeposit;
    if (scanned) {
      const inbound = tfs.find(
        (t) =>
          !t.cls &&
          t.to === PROXY &&
          t.from !== PROXY &&
          t.value === a.value + fee,
      );
      isDeposit = Boolean(inbound);
      if (inbound) {
        inbound.cls = "DEPOSIT";
        if (fee > 0n) {
          const out = tfs.find(
            (t) =>
              !t.cls && t.from === PROXY && t.to === DEV && t.value === fee,
          );
          if (out) out.cls = "FEE_FORWARD";
          else
            anomalies.push({
              kind: "FEE_NOT_FORWARDED",
              tx,
              fee: fee.toString(),
            });
        }
      }
    } else if (DEAD.has(a.to.toLowerCase())) {
      const rt = await receiptTransfers(tx);
      isDeposit = rt.some((t) => t.to === PROXY && t.value === a.value + fee);
    } else isDeposit = true; // validated globally by DEPOSITED_EXACT
    if (isDeposit) {
      deposited += a.value;
      sums.deposits += a.value;
      sums.depositCount++;
      if (fee > 0n) sums.feesForwarded += fee;
    } else if (DEAD.has(a.to.toLowerCase()) && fee === 0n) {
      sums.burns += a.value;
      sums.burnCount++;
      burns.push({
        index: a.index.toString(),
        tx,
        block,
        from: a.from,
        deadWallet: a.to,
        value: a.value.toString(),
        resolvedBy: scanned ? "transfer-logs" : "receipt",
      });
      const deadT = tfs.find(
        (t) => !t.cls && t.to === a.to.toLowerCase() && t.value === a.value,
      );
      if (deadT) deadT.cls = "BURN_TO_DEAD_NOT_TOUCHING_BRIDGE";
    } else
      anomalies.push({
        kind: "INITIATE_WITHOUT_DEPOSIT",
        tx,
        index: a.index.toString(),
        value: a.value.toString(),
      });
  }
  if (
    d.event === "BridgePending" &&
    a.toToken.toLowerCase() === CROSS &&
    a.fromChainID === 612055n
  ) {
    if (pendingByIndex.has(a.index) || finalizedIdx.has(a.index))
      anomalies.push({ kind: "DUPLICATE_PENDING", index: a.index.toString() });
    pendingByIndex.set(a.index, a.value);
    pendingAmount += a.value;
    sums.pendingCreated += a.value;
    finalizedIdx.add(a.index);
  }
  if (
    d.event === "BridgeFinalized" &&
    a.toToken.toLowerCase() === CROSS &&
    a.fromChainID === 612055n
  ) {
    const wasPending = pendingByIndex.has(a.index);
    if (!wasPending && finalizedIdx.has(a.index))
      anomalies.push({
        kind: "DUPLICATE_FINALIZE",
        index: a.index.toString(),
        tx,
      });
    finalizedIdx.add(a.index);
    if (wasPending) {
      pendingAmount -= pendingByIndex.get(a.index);
      pendingByIndex.delete(a.index);
      sums.releasedPayouts += a.value;
    }
    deposited -= a.value;
    sums.payouts += a.value;
    sums.payoutCount++;
    if (a.to.toLowerCase() === PROXY) {
      sums.selfPayouts += a.value;
      sums.selfPayoutCount++;
      selfPayouts.push({
        index: a.index.toString(),
        tx,
        block,
        value: a.value.toString(),
      });
      const self = tfs.find(
        (t) =>
          !t.cls && t.from === PROXY && t.to === PROXY && t.value === a.value,
      );
      if (self) self.cls = "SELF_PAYOUT_CBU09";
    } else if (scanned && a.value > 0n) {
      const out = tfs.find(
        (t) =>
          !t.cls &&
          t.from === PROXY &&
          t.to === a.to.toLowerCase() &&
          t.value === a.value,
      );
      if (out) out.cls = "PAYOUT";
      else
        anomalies.push({
          kind: "PAYOUT_WITHOUT_TRANSFER",
          tx,
          index: a.index.toString(),
        });
    }
  }
  if (d.event === "PendingRemoved") {
    const v = pendingByIndex.get(a.index);
    if (v === undefined)
      anomalies.push({
        kind: "REMOVE_UNKNOWN_PENDING",
        index: a.index.toString(),
      });
    else {
      pendingAmount -= v;
      pendingByIndex.delete(a.index);
      sums.pendingRemoved += v;
    }
  }
  if (d.event === "ManualReleased") sums.manualReleased++;
}

// Physical balance over the Transfer-scanned prefix, and classification of its non-ledger movements.
let prefixBalance = 0n;
const direct = [],
  unclassified = [];
for (const list of byTx.values())
  for (const t of list) {
    if (t.to === PROXY) prefixBalance += t.value;
    if (t.from === PROXY) prefixBalance -= t.value;
    if (!t.cls) {
      if (t.to === PROXY && !proxyTx.has(t.tx)) {
        t.cls = "DIRECT_INBOUND_NO_BRIDGE_EVENT";
        direct.push(t);
      } else unclassified.push(t);
    }
  }
const classCounts = {};
for (const list of byTx.values())
  for (const t of list)
    classCounts[t.cls ?? "UNCLASSIFIED"] =
      (classCounts[t.cls ?? "UNCLASSIFIED"] ?? 0) + 1;
const archiveAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
const archiveBalanceAtTEnd = decodeFunctionResult({
  abi: archiveAbi,
  functionName: "balanceOf",
  data: await retry(
    () =>
      rpc(
        ARCHIVE,
        "eth_call",
        [
          {
            to: CROSS,
            data: encodeFunctionData({
              abi: archiveAbi,
              functionName: "balanceOf",
              args: [PROXY],
            }),
          },
          "0x" + T_END.toString(16),
        ],
        { log: "reserve/ledger-receipts-rpc.jsonl" },
      ),
    6,
    3000,
  ),
});

// Non-ledger movements after the prefix: surplus bisection change points (each classified from receipts).
const lateChanges = bisect.changePoints.filter((c) => c.block > T_END);
const lateDirect = lateChanges.filter(
  (c) =>
    c.depositedDelta === "0" &&
    c.txs.length > 0 &&
    c.txs.every((t) =>
      t.events.every(
        (e) =>
          e.emitter.toLowerCase() === CROSS &&
          e.event === "Transfer" &&
          e.args.to.toLowerCase() === PROXY,
      ),
    ),
);
const lateUnexplained = lateChanges.filter((c) => !lateDirect.includes(c));
const directSum =
  direct.reduce((s, t) => s + t.value, 0n) +
  lateDirect.reduce((s, c) => s + BigInt(c.delta), 0n);

const liveBalance = BigInt(live.cross.balanceOfBridge),
  liveDeposited = BigInt(livePair.deposited),
  livePending = BigInt(livePair.pendingAmount);
const surplus = liveBalance - liveDeposited;
const surplusExplained = directSum - INITIAL_DEPOSITED + sums.selfPayouts;
const oneState = snap.chains.one.sources.find((s) => !s.error).state;
const oneMinted = BigInt(
  oneState.chains["56"].pairs.find(
    (p) =>
      p.localToken.toLowerCase() ===
      "0x0000000000000000000000000000000000000001",
  ).minted,
);
const ic = {
  crossFinalizeIndices: finalizedIdx.size,
  crossInitiateIndices: initiatedIdx.size,
  finalizedMax: Math.max(...[...chainFinalizeIdx].map(Number)),
  finalizedCount: chainFinalizeIdx.size,
  nextFinalize: Number(live.chains["612055"].nextFinalizeIndex),
  initiatedMax: Math.max(...[...chainInitiateIdx].map(Number)),
  initiatedCount: chainInitiateIdx.size,
  nextInitiate: Number(live.chains["612055"].nextInitiateIndex),
};
const checks = {
  DEPOSITED_EXACT: deposited === liveDeposited,
  PENDING_EXACT: pendingAmount === livePending,
  OPEN_PENDING_SET_EXACT:
    JSON.stringify([...pendingByIndex.keys()].map(String).sort()) ===
    JSON.stringify(
      live.chains["612055"].pending.map((p) => String(p.index)).sort(),
    ),
  PREFIX_BALANCE_EQUALS_ARCHIVE: prefixBalance === archiveBalanceAtTEnd,
  BISECTION_COMPLETE:
    bisect.CHANGES_SUM_TO_TOTAL === true &&
    bisect.monotonicOnGrid === true &&
    bisect.end === PIN &&
    bisect.start <= T_END,
  NO_UNEXPLAINED_LATE_BALANCE_CHANGE: lateUnexplained.length === 0,
  NO_UNCLASSIFIED_PREFIX_TRANSFERS: unclassified.length === 0,
  NO_ANOMALIES: anomalies.length === 0,
  NO_UNKNOWN_EVENT_TOPICS: Object.keys(unknownTopics).length === 0,
  NO_EXECUTOR_SETTLEMENTS: sums.executorCalls === 0,
  SURPLUS_EXPLAINED: surplus === surplusExplained,
  BALANCE_EXACT: liveDeposited + surplusExplained === liveBalance,
  FINALIZE_INDEX_CONTIGUOUS:
    ic.finalizedCount === ic.nextFinalize - 1 &&
    ic.finalizedMax === ic.nextFinalize - 1,
  INITIATE_INDEX_CONTIGUOUS:
    ic.initiatedCount === ic.nextInitiate - 1 &&
    ic.initiatedMax === ic.nextInitiate - 1,
  CROSS_CHAIN_MINTED_MINUS_DEPOSITED_EQUALS_BURNS:
    oneMinted - liveDeposited === sums.burns,
};
const result = {
  at: now(),
  pinnedBlock: PIN,
  pinnedBlockHash: bsc.blockHash,
  scan: {
    start: manifest.start,
    end: manifest.end,
    chunks: manifest.chunkCount,
    proxyLogs: proxyLogs.length,
    transferLogs: transfers.length,
    transferCoverage: manifest.transferCoverage,
    manifestSha256: sha256(manifestText),
  },
  eventCounts: counts,
  unknownTopics,
  transferClassCounts: classCounts,
  ledger: {
    initialDeposited: INITIAL_DEPOSITED,
    ...sums,
    computedDeposited: deposited,
    computedPendingAmount: pendingAmount,
    openPending: [...pendingByIndex].map(([i, v]) => ({
      index: i.toString(),
      value: v.toString(),
    })),
  },
  live: {
    deposited: liveDeposited,
    pendingAmount: livePending,
    balance: liveBalance,
    pendingIndices: live.chains["612055"].pending.map((p) => p.index),
  },
  physical: {
    transferPrefixEnd: T_END,
    prefixBalanceFromLogs: prefixBalance,
    archiveBalanceAtPrefixEnd: archiveBalanceAtTEnd,
    lateSurplusChangePoints: lateChanges.map((c) => ({
      block: c.block,
      delta: c.delta,
      txs: c.txs.map((t) => t.tx),
    })),
    bisectArtifact: bisectRel,
  },
  surplus: {
    value: surplus,
    directInbound: [
      ...direct.map((t) => ({
        tx: t.tx,
        block: t.block,
        from: t.from,
        value: t.value,
        via: "transfer-logs",
      })),
      ...lateDirect.map((c) => ({
        tx: c.txs[0].tx,
        block: c.block,
        value: c.delta,
        via: "archive-bisection+receipt",
      })),
    ],
    directInboundSum: directSum,
    initialUnfundedDeposited: INITIAL_DEPOSITED,
    cbu09SelfPayouts: selfPayouts,
    explained: surplusExplained,
  },
  crossChain: {
    oneMinted,
    oneBlock: snap.chains.one.block,
    bscDeposited: liveDeposited,
    difference: oneMinted - liveDeposited,
    burnsToDeadWallets: sums.burns,
    burnCount: sums.burnCount,
    burns,
    inFlightAtPins: {
      oneNextInitiate: Number(oneState.chains["56"].nextInitiateIndex),
      bscNextFinalize: ic.nextFinalize,
      bscNextInitiate: ic.nextInitiate,
      oneNextFinalize: Number(oneState.chains["56"].nextFinalizeIndex),
    },
  },
  indexContiguity: ic,
  checks,
  anomalies,
  unclassified: unclassified
    .slice(0, 50)
    .map((t) => ({ ...t, value: t.value.toString() })),
  unclassifiedCount: unclassified.length,
};
result.RECONCILED = Object.values(checks).every((v) => v === true);
const w = writeJson("reserve/bsc-ledger-reconciliation.json", result);
console.log(
  JSON.stringify(
    {
      RECONCILED: result.RECONCILED,
      checks,
      ledger: result.ledger,
      live: result.live,
      physical: result.physical,
      surplus: {
        value: surplus,
        directInboundSum: directSum,
        explained: surplusExplained,
      },
      crossChain: {
        ...result.crossChain,
        burns: result.crossChain.burns.length,
      },
      anomalies: anomalies.slice(0, 10),
      unclassifiedCount: unclassified.length,
      classCounts,
      counts,
      w,
    },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    1,
  ),
);
