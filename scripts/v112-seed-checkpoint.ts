// Bootstrap the performance cache from the OWNER-ACCEPTED V1.11 final dry evidence, not from live assumptions.
// Fresh external anchor validation is mandatory in livePreflight before any saved observation is reused.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FileG7Cache,
  cacheDigest,
  type G7Checkpoint,
} from "../src/data/store/g7-cache";
import { G5_ROUTE_PINS } from "../src/g5/route-pins";
import { reconcileLedgerDelta } from "../src/g7/ledger";
import { CROSS, EXTENDED_PINS } from "../src/g7/policy";
const accepted =
  "evidence/otherbridge-v1-11/g7gate-20261006T135310Z-f42f11/g7-dry";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const summary = read(join(accepted, "DRY_ACCEPTANCE_SUMMARY.json"));
if (
  !summary.allComplete ||
  summary.dryRunComplete !== 3 ||
  summary.writeMethodCalls !== 0 ||
  summary.walletRequests !== 0
)
  throw new Error("ACCEPTED_EVIDENCE_INVALID");
const last = summary.results.at(-1);
const root = last.evidence;
const baselinePath = join(root, "baseline.json");
const finalPath = join(root, "preflight", last.final.preflight.id + ".json");
const b = read(baselinePath),
  f = read(finalPath);
if (
  f.outcome.status !== "READY" ||
  f.outcome.review.intentDigest !==
    "4eecb9784961717f8464be8f9a650004974e328239f614211ad51bdf65aac869" ||
  !f.outcome.gates.every((g: { status: string }) => g.status === "PASS") ||
  !b.ledgerA.reconciled ||
  !f.observations.ledger.reconciled
)
  throw new Error("ACCEPTED_PREFLIGHT_INVALID");
const bs = f.observations.bscB.reads[0],
  os = f.observations.oneB.reads[0],
  ext = f.observations.logs;
const logs = {
  bscProxyLogs: [...b.logs.bscProxyLogs, ...ext.pB],
  crossIn: [...b.logs.crossIn, ...ext.inB],
  crossOut: [...b.logs.crossOut, ...ext.outB],
  bscVerifierLogs: [...b.logs.bscVerifierLogs, ...ext.vB],
  oneProxyLogs: [...b.logs.oneProxyLogs, ...ext.oB],
  oneVerifierLogs: [...b.logs.oneVerifierLogs, ...ext.ovB],
};
const cp: G7Checkpoint = {
  schema: "otherbridge.g7.checkpoint.v1",
  routeDigest: cacheDigest(G5_ROUTE_PINS),
  acceptedThroughBlock: bs.block,
  acceptedThroughBlockHash: bs.blockHash,
  oneThroughBlock: os.block,
  oneThroughBlockHash: os.blockHash,
  deposited: bs.pair.deposited,
  pendingAmount: bs.pair.pendingAmount,
  reserveBalance: bs.token.balanceOfBridge,
  openPending: bs.pending
    .filter(
      (p: { toToken: string }) =>
        p.toToken.toLowerCase() === CROSS.toLowerCase(),
    )
    .map((p: { index: string; value: string }) => ({
      index: p.index,
      value: p.value,
    })),
  nextIndexes: {
    finalize: bs.nextFinalizeIndex,
    initiate: bs.nextInitiateIndex,
  },
  eventDigest: cacheDigest(logs),
  sourceEvidence: {
    stateOperators: f.observations.bscB.pin.operatorGroups,
    witnessOperator: "nodereal-logs-only",
    observedAt: f.outcome.decisionAt,
  },
  logs,
};
// Replay the accepted cached events using the original accepted V1.6 ledger semantics before saving.
const v16 = G5_ROUTE_PINS.evidence;
const rec = read(join(v16, "manifests/reserve-reconciliation.json"));
const snap = read(join(v16, "manifests/G5_CURRENT_ROUTE_SNAPSHOT.json"));
const state = {
  block: cp.acceptedThroughBlock,
  balance: BigInt(cp.reserveBalance),
  deposited: BigInt(cp.deposited),
  pendingAmount: BigInt(cp.pendingAmount),
  nextFinalize: BigInt(cp.nextIndexes.finalize),
  nextInitiate: BigInt(cp.nextIndexes.initiate),
  pending: cp.openPending.map((p) => ({
    index: BigInt(p.index),
    value: BigInt(p.value),
  })),
};
const replay = reconcileLedgerDelta(
  {
    block: rec.pinnedBlock,
    balance: BigInt(rec.physicalCrossBaseUnits),
    deposited: BigInt(rec.deposited),
    pendingAmount: BigInt(rec.pendingAmount),
    nextFinalize: BigInt(snap.bsc.nextFinalizeIndex),
    nextInitiate: BigInt(snap.bsc.nextInitiateIndex),
    pending: rec.activePendingRecords.map(
      (p: { index: string; value: string }) => ({
        index: BigInt(p.index),
        value: BigInt(p.value),
      }),
    ),
  },
  state,
  logs.bscProxyLogs,
  [...logs.crossIn, ...logs.crossOut],
  {
    proxy: G5_ROUTE_PINS.destination.proxy,
    cross: CROSS,
    dev: EXTENDED_PINS.bsc.dev,
    sourceChainId: 612055n,
  },
);
if (!replay.reconciled) throw new Error("ACCEPTED_EVENT_REPLAY_FAILED");
const store = new FileG7Cache(".otherbridge/data-cache/g7-ledger.json");
if (!store.load()) store.save(cp);
const evidence = readFileSync(
  ".otherbridge/v112-evidence-path.txt",
  "utf8",
).trim();
writeFileSync(
  join(evidence, "g7-witness", "checkpoint-bootstrap.json"),
  JSON.stringify(
    {
      acceptedRoot: root,
      sourceHashes: Object.fromEntries(
        [baselinePath, finalPath].map((p) => [
          p,
          createHash("sha256").update(readFileSync(p)).digest("hex"),
        ]),
      ),
      acceptedThroughBlock: cp.acceptedThroughBlock,
      acceptedThroughBlockHash: cp.acceptedThroughBlockHash,
      eventDigest: cp.eventDigest,
      replayChecks: replay.checks,
      cacheNotIndependentWitness: true,
    },
    null,
    2,
  ),
);
console.log(
  `Accepted checkpoint ${cp.acceptedThroughBlock}; fresh external anchors required`,
);
