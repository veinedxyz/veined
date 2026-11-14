// V1.7 G7 post-send observer (READ-ONLY, one shot, bounded). `pnpm g7:track --tx <sourceHash> [--historical]`
// Verifies the source receipt (status 1, canonical, exactly one BridgeInitiated from the proxy, recipient/amount
// exactly as in the approved unsigned package), finds BridgeFinalized/BridgePending(612055, index) on BSC, checks
// the canonical CROSS Transfer(bridge -> recipient, amount) on a finalized block and implementation consistency.
// It never resends, never releases, never signs, never starts a background job. `--historical` binds the claim to
// the transaction itself instead of the package (dry run of the observer on a past public transfer).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, keccak256, pad, toHex, type Hex } from "viem";
import { bridgeAbi } from "../src/adapters/onebridge";
import {
  decodeNativeDestination,
  decodeNativeSource,
  type ReceiptRead,
} from "../src/adapters/native-decoder";
import { CROSS, ROUTE, type TransferRecord } from "../src/core/model";
import type { SourceEvidence } from "../src/core/flow";
import { G5_ROUTE_PINS } from "../src/g5/route-pins";
import { ENDPOINTS, SLOTS } from "../src/g7/policy";
import { ReadOnlyRpc } from "../src/g7/rpc";
import {
  SETTLEMENT_POLICY,
  classifyTracking,
  type TrackInput,
} from "../src/g7/track";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const TX = arg("--tx");
if (!TX || !/^0x[0-9a-fA-F]{64}$/.test(TX))
  throw new Error(
    "usage: g7:track --tx <0x…64 hex> [--historical] [--label name]",
  );
const HISTORICAL = args.includes("--historical");
const LABEL = arg("--label") ?? (HISTORICAL ? "historical-dry-run" : "pilot");
const pointer = join(REPO, ".otherbridge", "g7-evidence-path.txt");
const root = existsSync(pointer)
  ? join(REPO, readFileSync(pointer, "utf8").trim(), "track")
  : join(REPO, "test-results", "g7-track");
mkdirSync(root, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.]/g, "");
const AUDIT = join(root, `${LABEL}-${TX.slice(0, 10)}-${stamp}-rpc.jsonl`);
const rpc = new ReadOnlyRpc({
  timeoutMs: 30000,
  audit: (r) => appendFileSync(AUDIT, JSON.stringify(r) + "\n"),
});
const hx = (n: number | bigint) => "0x" + n.toString(16);
const FINALIZED = keccak256(
  toHex("BridgeFinalized(uint256,uint256,address,address,uint256,uint256)"),
);
const PENDING = keccak256(
  toHex("BridgePending(uint256,uint256,address,address,uint256,uint256,uint8)"),
);
const UPGRADED = keccak256(toHex("Upgraded(address)"));

async function receiptRead(
  url: string,
  chainId: number,
  hash: string,
): Promise<ReceiptRead | null> {
  const receipt = await rpc.retry<{ blockNumber: string } | null>(
    url,
    "eth_getTransactionReceipt",
    [hash],
  );
  if (!receipt) return null;
  const [transaction, block, finalized] = await Promise.all([
    rpc.retry(url, "eth_getTransactionByHash", [hash]),
    rpc.retry(url, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    rpc.retry(url, "eth_getBlockByNumber", ["finalized", false]),
  ]);
  return { receipt, transaction, block, finalized, chainId };
}
async function logs(
  url: string,
  filter: Record<string, unknown>,
  from: number,
  to: number,
) {
  const out: {
    transactionHash: string;
    blockNumber: string;
    topics: string[];
  }[] = [];
  for (let a = from; a <= to; a += 50000)
    out.push(
      ...(await rpc.retry<typeof out>(url, "eth_getLogs", [
        { ...filter, fromBlock: hx(a), toBlock: hx(Math.min(a + 49999, to)) },
      ])),
    );
  return out;
}

const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  tx: TX,
  mode: HISTORICAL
    ? "HISTORICAL_DRY_RUN (claim from the transaction itself)"
    : "PILOT (claim from G7_UNSIGNED_TRANSACTION.json)",
  policy: SETTLEMENT_POLICY,
};
// ---- source on both official ONE endpoints
const reads = await Promise.all(
  ENDPOINTS.one.map((u) => receiptRead(u, 612055, TX)),
);
const found = reads.every((r) => r !== null);
type R = {
  receipt: { blockHash: string; status: string; logs: unknown[] };
  transaction: { from: string; input: string };
  block: { timestamp: string; number: string };
};
const r0 = reads[0] as unknown as R | null;
const agree =
  found &&
  new Set(
    reads.map((r) =>
      JSON.stringify([
        (r as unknown as R).receipt.blockHash,
        (r as unknown as R).receipt.status,
        (r as unknown as R).receipt.logs,
      ]),
    ),
  ).size === 1;
let expected = { account: "", recipient: "", amount: "" };
if (HISTORICAL && r0) {
  const call = decodeFunctionData({
    abi: bridgeAbi,
    data: r0.transaction.input as Hex,
  });
  expected = {
    account: r0.transaction.from,
    recipient: String(call.args[2]),
    amount: String(call.args[3]),
  };
} else if (!HISTORICAL) {
  const pkg = JSON.parse(
    readFileSync(join(REPO, "G7_UNSIGNED_TRANSACTION.json"), "utf8"),
  );
  expected = {
    account: pkg.from,
    recipient: pkg.decodedIntent.to,
    amount: pkg.decodedIntent.value,
  };
}
const claim = {
  schema: 1,
  id: "g7-track",
  mode: "mainnet-readonly",
  route: ROUTE.id,
  config: "1",
  sourceChain: 612055,
  destinationChain: 56,
  account: expected.account,
  recipient: expected.recipient,
  sourceAsset: "native:ONE",
  token: CROSS,
  amount: expected.amount,
  expected: expected.amount,
  sourceHash: TX,
  state: "SOURCE_SUBMITTED",
  updatedAt: Date.now(),
} as unknown as TransferRecord;
let sourceEvidence: SourceEvidence | null = null;
let sourceDecodeError: string | undefined;
if (found && agree)
  try {
    sourceEvidence = decodeNativeSource(claim, reads[0]!);
  } catch (e) {
    sourceDecodeError = (e as { code?: string }).code ?? String(e);
  }
const elapsedSeconds = r0
  ? Math.floor(Date.now() / 1000) - Number(BigInt(r0.block.timestamp))
  : 0;
// Source implementation consistency: no Upgraded event on the ONE proxy since the source block + current pin.
let sourceImplConsistent: boolean | null = null;
if (sourceEvidence) {
  // toBlock "latest": the load-balanced ONE backends may lag each other by a few blocks (V1.6 PIN_LAG).
  const up = await rpc.retry<unknown[]>(ENDPOINTS.one[0], "eth_getLogs", [
    {
      address: G5_ROUTE_PINS.source.proxy,
      topics: [UPGRADED],
      fromBlock: hx(sourceEvidence.blockNumber),
      toBlock: "latest",
    },
  ]);
  const slot = await rpc.retry<string>(ENDPOINTS.one[0], "eth_getStorageAt", [
    G5_ROUTE_PINS.source.proxy,
    SLOTS.implementation,
    "latest",
  ]);
  sourceImplConsistent =
    up.length === 0 &&
    ("0x" + slot.slice(-40)).toLowerCase() ===
      G5_ROUTE_PINS.source.implementation;
}
const canonical =
  !!sourceEvidence &&
  sourceEvidence.finalizedBlockNumber !== undefined &&
  sourceEvidence.blockNumber <= sourceEvidence.finalizedBlockNumber &&
  (sourceEvidence.confirmations ?? 0) >=
    SETTLEMENT_POLICY.sourceConfirmations &&
  sourceEvidence.canonicalBlockHash === sourceEvidence.blockHash &&
  sourceImplConsistent === true;
const input: TrackInput = {
  elapsedSeconds,
  expected,
  source: {
    found,
    endpointsAgree: !!agree,
    status: r0 ? (r0.receipt.status as "0x1" | "0x0") : null,
    canonical,
    decodeError: sourceDecodeError,
    decoded: sourceEvidence?.index
      ? {
          index: sourceEvidence.index,
          recipient: sourceEvidence.recipient!,
          amount: sourceEvidence.amount!,
          destinationChain: sourceEvidence.destinationChain!,
        }
      : undefined,
  },
};
// ---- destination (BSC): BridgeFinalized / BridgePending for (612055, index)
if (sourceEvidence?.index && canonical) {
  const head = Number(
    BigInt(
      await rpc.retry<string>(ENDPOINTS.bscLogs[0], "eth_blockNumber", []),
    ),
  );
  const sourceTime = Number(BigInt(r0!.block.timestamp));
  let start = Math.max(
    0,
    head - Math.ceil((Date.now() / 1000 - sourceTime) / 0.4) - 2000,
  );
  for (let k = 0; k < 20; k++) {
    const b = await rpc.retry<{ timestamp: string }>(
      ENDPOINTS.bscLogs[0],
      "eth_getBlockByNumber",
      [hx(start), false],
    );
    if (Number(BigInt(b.timestamp)) < sourceTime - 60) break;
    start = Math.max(0, start - 50000);
  }
  const found2 =
    head - start > 1_000_000
      ? null
      : await logs(
          ENDPOINTS.bscLogs[0],
          {
            address: G5_ROUTE_PINS.destination.proxy,
            topics: [
              [FINALIZED, PENDING],
              pad(toHex(612055n)),
              pad(toHex(BigInt(sourceEvidence.index))),
            ],
          },
          start,
          head,
        );
  report.destinationSearch = { from: start, to: head, logs: found2 };
  const finals = (found2 ?? []).filter((l) => l.topics[0] === FINALIZED);
  const pendings = (found2 ?? []).filter((l) => l.topics[0] === PENDING);
  const event = finals.length
    ? "BridgeFinalized"
    : pendings.length
      ? "BridgePending"
      : null;
  input.destination = { searched: found2 !== null, event };
  const destLog = finals[0] ?? pendings[0];
  if (destLog) {
    const dReads = await Promise.all(
      [ENDPOINTS.bsc[0], ENDPOINTS.bscLogs[0]].map((u) =>
        receiptRead(u, 56, destLog.transactionHash),
      ),
    );
    try {
      const ev = decodeNativeDestination(claim, sourceEvidence, dReads[0]!);
      const destBlock = ev.blockNumber;
      const up = await logs(
        ENDPOINTS.bscLogs[0],
        { address: G5_ROUTE_PINS.destination.proxy, topics: [UPGRADED] },
        destBlock,
        head,
      );
      const slot = await rpc.retry<string>(
        ENDPOINTS.bsc[0],
        "eth_getStorageAt",
        [G5_ROUTE_PINS.destination.proxy, SLOTS.implementation, "latest"],
      );
      const sameAcross = dReads.every(
        (r) =>
          r &&
          JSON.stringify((r.receipt as R["receipt"]).logs) ===
            JSON.stringify((dReads[0]!.receipt as R["receipt"]).logs),
      );
      input.destination = {
        searched: true,
        event,
        receiptSuccess: ev.successful && sameAcross,
        finalized:
          ev.finalizedBlockNumber !== undefined &&
          ev.blockNumber <= ev.finalizedBlockNumber,
        payoutExact: ev.payout !== false && !ev.held,
        implementationConsistent:
          up.length === 0 &&
          ("0x" + slot.slice(-40)).toLowerCase() ===
            G5_ROUTE_PINS.destination.implementation,
      };
      report.destinationEvidence = ev;
    } catch (e) {
      input.destination = {
        searched: true,
        event,
        decodeError: (e as { code?: string }).code ?? String(e),
      };
    }
  }
}
const classification = classifyTracking(input);
report.sourceEvidence = sourceEvidence;
report.sourceImplementationConsistent = sourceImplConsistent;
report.input = input;
report.classification = classification;
if (classification.status === "COMPLETED" && sourceEvidence?.index)
  report.payoutProofNext = `Build the canonical payout proof (header/receipt-trie/validator signatures) for index ${sourceEvidence.index} with scripts/g5-v16-payout-proof.mjs into a NEW evidence root (never into the V1.6 root): <label> ${sourceEvidence.index} ${sourceEvidence.blockNumber} ${TX} ${(report.destinationEvidence as { hash: string }).hash}`;
report.rpcCalls = Object.fromEntries(rpc.counts);
const out = join(root, `${LABEL}-${TX.slice(0, 10)}-${stamp}.json`);
writeFileSync(
  out,
  JSON.stringify(
    report,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    1,
  ),
);
console.log(
  JSON.stringify(
    {
      status: classification.status,
      reasons: classification.reasons,
      nextStep: classification.nextStep,
      autoRetry: false,
      report: out,
    },
    null,
    1,
  ),
);
