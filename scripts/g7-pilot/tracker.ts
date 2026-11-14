// G7 pilot post-send observer (READ-ONLY). Same checks as the reviewed one-shot tracker (scripts/g7-track.ts):
// source receipt on both official ONE endpoints (status 1, canonical/finalized, exactly one BridgeInitiated from
// the pinned proxy with the exact recipient/amount), BSC BridgeFinalized/BridgePending(612055, index), the exact
// canonical CROSS Transfer(bridge -> recipient, amount) on a finalized BSC block and implementation consistency —
// plus byte-exact comparison of the mined transaction with the armed one. It never resends, never calls
// releasePending, never signs: every request goes through the allowlisted ReadOnlyRpc.
import { keccak256, pad, toHex, type Hex } from "viem";
import {
  decodeNativeDestination,
  decodeNativeSource,
  type ReceiptRead,
} from "../../src/adapters/native-decoder";
import { CROSS, ROUTE, type TransferRecord } from "../../src/core/model";
import type { DestinationEvidence, SourceEvidence } from "../../src/core/flow";
import { G5_ROUTE_PINS } from "../../src/g5/route-pins";
import { ENDPOINTS, SLOTS } from "../../src/g7/policy";
import { ReadOnlyRpc, type RpcAuditRecord } from "../../src/g7/rpc";
import {
  SETTLEMENT_POLICY,
  classifyTracking,
  type TrackInput,
  type TrackStatus,
} from "../../src/g7/track";
import type { WalletTx } from "./intent";
import { PILOT_SCOPE } from "./policy";

const hx = (n: number | bigint) => "0x" + n.toString(16);
const lc = (s: string) => s.toLowerCase();
const FINALIZED = keccak256(
  toHex("BridgeFinalized(uint256,uint256,address,address,uint256,uint256)"),
);
const PENDING = keccak256(
  toHex("BridgePending(uint256,uint256,address,address,uint256,uint256,uint8)"),
);
const UPGRADED = keccak256(toHex("Upgraded(address)"));
const INITIATED = keccak256(
  toHex(
    "BridgeInitiated(uint256,uint256,address,address,address,address,uint256,uint256,uint256,bytes,uint256)",
  ),
);

export interface TxCheck {
  found: boolean;
  exact: boolean;
  mismatches: string[];
  anomalies: string[];
}
export interface TrackSnapshot {
  at: string;
  txHash: string;
  status: TrackStatus;
  g7Pass: boolean;
  reasons: string[];
  nextStep: string;
  autoRetry: false;
  autoRelease: false;
  txCheck: TxCheck;
  source: {
    found: boolean;
    endpointsAgree: boolean;
    status: string | null;
    block: number | null;
    blockHash: string | null;
    confirmations: number | null;
    canonical: boolean;
    implementationConsistent: boolean | null;
    index: string | null;
    recipient: string | null;
    amount: string | null;
    decodeError: string | null;
  };
  destination: {
    searched: boolean;
    searchFrom: number | null;
    searchTo: number | null;
    event: "BridgeFinalized" | "BridgePending" | null;
    txHash: string | null;
    block: number | null;
    finalizedBlock: number | null;
    finalized: boolean | null;
    payout: {
      logIndex: number;
      token: string;
      from: string;
      recipient: string;
      amount: string;
    } | null;
    implementationConsistent: boolean | null;
    decodeError: string | null;
  };
}
export interface DetectResult {
  transfers: { txHash: string; index: string; block: number }[];
  nonces: string[];
}
export interface TrackerSource {
  track(input: { txHash: string; tx: WalletTx }): Promise<TrackSnapshot>;
  detect(input: { fromOneBlock: number }): Promise<DetectResult>;
}

// The armed transaction must be the mined one, byte for byte. Wallet-chosen gas fields are bounded, not exact.
export function compareMinedTransaction(
  mined: {
    from?: string;
    to?: string;
    value?: string;
    input?: string;
    gas?: string;
    maxFeePerGas?: string;
    gasPrice?: string;
    chainId?: string;
  } | null,
  armed: WalletTx,
): TxCheck {
  if (!mined)
    return {
      found: false,
      exact: false,
      mismatches: ["TRANSACTION_NOT_FOUND"],
      anomalies: [],
    };
  const mismatches: string[] = [];
  const anomalies: string[] = [];
  if (lc(mined.from ?? "") !== lc(armed.from)) mismatches.push("FROM");
  if (lc(mined.to ?? "") !== lc(armed.to)) mismatches.push("TO");
  if (BigInt(mined.value ?? "0x0") !== BigInt(armed.value))
    mismatches.push("VALUE");
  if (lc(mined.input ?? "") !== lc(armed.data)) mismatches.push("INPUT");
  if (
    mined.chainId !== undefined &&
    BigInt(mined.chainId) !== BigInt(armed.chainId)
  )
    mismatches.push("CHAIN_ID");
  if (mined.gas !== undefined && BigInt(mined.gas) > BigInt(armed.gas))
    anomalies.push("WALLET_RAISED_GAS_LIMIT");
  const cap = mined.maxFeePerGas ?? mined.gasPrice;
  if (cap !== undefined && BigInt(cap) > BigInt(armed.maxFeePerGas))
    anomalies.push("WALLET_RAISED_FEE_CAP");
  return { found: true, exact: mismatches.length === 0, mismatches, anomalies };
}

export function liveTracker(audit: (r: RpcAuditRecord) => void): TrackerSource {
  const rpc = new ReadOnlyRpc({ timeoutMs: 30000, audit });
  let bscSearchFrom: number | null = null;

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
      data: string;
    }[] = [];
    for (let a = from; a <= to; a += 50000)
      out.push(
        ...(await rpc.retry<typeof out>(url, "eth_getLogs", [
          { ...filter, fromBlock: hx(a), toBlock: hx(Math.min(a + 49999, to)) },
        ])),
      );
    return out;
  }

  async function track({
    txHash,
    tx,
  }: {
    txHash: string;
    tx: WalletTx;
  }): Promise<TrackSnapshot> {
    type R = {
      receipt: {
        blockHash: string;
        status: string;
        logs: unknown[];
        blockNumber: string;
      };
      transaction: Parameters<typeof compareMinedTransaction>[0];
      block: { timestamp: string; number: string };
    };
    const reads = await Promise.all(
      ENDPOINTS.one.map((u) => receiptRead(u, 612055, txHash)),
    );
    const found = reads.every((r) => r !== null);
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
    const pending = r0
      ? null
      : await rpc.retry<R["transaction"] | null>(
          ENDPOINTS.one[0],
          "eth_getTransactionByHash",
          [txHash],
        );
    const txCheck = compareMinedTransaction(
      r0?.transaction ?? pending ?? null,
      tx,
    );
    const expected = {
      account: PILOT_SCOPE.account,
      recipient: PILOT_SCOPE.recipient,
      amount: PILOT_SCOPE.principal.toString(),
    };
    const claim = {
      schema: 1,
      id: "g7-pilot",
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
      sourceHash: txHash,
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
    let sourceImplConsistent: boolean | null = null;
    if (sourceEvidence) {
      const up = await rpc.retry<unknown[]>(ENDPOINTS.one[0], "eth_getLogs", [
        {
          address: G5_ROUTE_PINS.source.proxy,
          topics: [UPGRADED],
          fromBlock: hx(sourceEvidence.blockNumber),
          toBlock: "latest",
        },
      ]);
      const slot = await rpc.retry<string>(
        ENDPOINTS.one[0],
        "eth_getStorageAt",
        [G5_ROUTE_PINS.source.proxy, SLOTS.implementation, "latest"],
      );
      sourceImplConsistent =
        up.length === 0 &&
        lc("0x" + slot.slice(-40)) === G5_ROUTE_PINS.source.implementation;
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
    const destination: TrackSnapshot["destination"] = {
      searched: false,
      searchFrom: null,
      searchTo: null,
      event: null,
      txHash: null,
      block: null,
      finalizedBlock: null,
      finalized: null,
      payout: null,
      implementationConsistent: null,
      decodeError: null,
    };
    if (sourceEvidence?.index && canonical) {
      const head = Number(
        BigInt(
          await rpc.retry<string>(ENDPOINTS.bscLogs[0], "eth_blockNumber", []),
        ),
      );
      const sourceTime = Number(BigInt(r0!.block.timestamp));
      if (bscSearchFrom === null) {
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
        bscSearchFrom = start;
      }
      const found2 =
        head - bscSearchFrom > 1_000_000
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
              bscSearchFrom,
              head,
            );
      destination.searched = found2 !== null;
      destination.searchFrom = bscSearchFrom;
      destination.searchTo = head;
      const finals = (found2 ?? []).filter((l) => l.topics[0] === FINALIZED);
      const pendings = (found2 ?? []).filter((l) => l.topics[0] === PENDING);
      const event = finals.length
        ? "BridgeFinalized"
        : pendings.length
          ? "BridgePending"
          : null;
      destination.event = event;
      input.destination = { searched: found2 !== null, event };
      const destLog = finals[0] ?? pendings[0];
      if (destLog) {
        destination.txHash = destLog.transactionHash;
        const dReads = await Promise.all(
          [ENDPOINTS.bsc[0], ENDPOINTS.bscLogs[0]].map((u) =>
            receiptRead(u, 56, destLog.transactionHash),
          ),
        );
        try {
          const ev: DestinationEvidence = decodeNativeDestination(
            claim,
            sourceEvidence,
            dReads[0]!,
          );
          const up = await logs(
            ENDPOINTS.bscLogs[0],
            { address: G5_ROUTE_PINS.destination.proxy, topics: [UPGRADED] },
            ev.blockNumber,
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
          const implementationConsistent =
            up.length === 0 &&
            lc("0x" + slot.slice(-40)) ===
              G5_ROUTE_PINS.destination.implementation;
          const finalized =
            ev.finalizedBlockNumber !== undefined &&
            ev.blockNumber <= ev.finalizedBlockNumber;
          input.destination = {
            searched: true,
            event,
            receiptSuccess: ev.successful && sameAcross,
            finalized,
            payoutExact: ev.payout !== false && !ev.held,
            implementationConsistent,
          };
          destination.block = ev.blockNumber;
          destination.finalizedBlock = ev.finalizedBlockNumber ?? null;
          destination.finalized = finalized;
          destination.implementationConsistent = implementationConsistent;
          destination.payout =
            typeof ev.payout === "object"
              ? {
                  logIndex: ev.payout.logIndex,
                  token: ev.payout.token,
                  from: ev.payout.from,
                  recipient: ev.payout.recipient,
                  amount: ev.payout.amount,
                }
              : null;
        } catch (e) {
          const code = (e as { code?: string }).code ?? String(e);
          input.destination = { searched: true, event, decodeError: code };
          destination.decodeError = code;
        }
      }
    }
    const c = classifyTracking(input);
    // G7 PASS only with every condition of the owner instruction AND the mined transaction equal to the armed one.
    let status = c.status;
    const reasons = [...c.reasons];
    if (txCheck.found && !txCheck.exact) {
      status = "MANUAL_REVIEW_REQUIRED";
      reasons.push(
        ...txCheck.mismatches.map(
          (m) => `MINED_TRANSACTION_${m}_DIFFERS_FROM_ARMED`,
        ),
      );
    }
    const g7Pass =
      status === "COMPLETED" &&
      txCheck.exact &&
      !!sourceEvidence?.index &&
      destination.event === "BridgeFinalized" &&
      destination.finalized === true &&
      destination.payout !== null &&
      lc(destination.payout.token) === lc(CROSS) &&
      lc(destination.payout.recipient) === lc(PILOT_SCOPE.recipient) &&
      destination.payout.amount === PILOT_SCOPE.principal.toString();
    return {
      at: new Date().toISOString(),
      txHash,
      status,
      g7Pass,
      reasons,
      nextStep: c.nextStep,
      autoRetry: false,
      autoRelease: false,
      txCheck,
      source: {
        found,
        endpointsAgree: !!agree,
        status: r0?.receipt.status ?? null,
        block:
          sourceEvidence?.blockNumber ??
          (r0 ? Number(BigInt(r0.receipt.blockNumber)) : null),
        blockHash: r0?.receipt.blockHash ?? null,
        confirmations: sourceEvidence?.confirmations ?? null,
        canonical,
        implementationConsistent: sourceImplConsistent,
        index: sourceEvidence?.index ?? null,
        recipient: sourceEvidence?.recipient ?? null,
        amount: sourceEvidence?.amount ?? null,
        decodeError: sourceDecodeError ?? null,
      },
      destination,
    };
  }

  // Read-only safety net when the wallet returned no hash (page closed, provider error, ambiguous result): any
  // BridgeInitiated(toChainID=56, from=owner EOA) since the armed ONE block, and the account nonce on both endpoints.
  async function detect({
    fromOneBlock,
  }: {
    fromOneBlock: number;
  }): Promise<DetectResult> {
    const found = await rpc.retry<
      { transactionHash: string; topics: string[]; blockNumber: string }[]
    >(ENDPOINTS.one[0], "eth_getLogs", [
      {
        address: G5_ROUTE_PINS.source.proxy,
        topics: [
          INITIATED,
          pad(toHex(56n)),
          null,
          pad(PILOT_SCOPE.account as Hex),
        ],
        fromBlock: hx(fromOneBlock),
        toBlock: "latest",
      },
    ]);
    const nonces = await Promise.all(
      ENDPOINTS.one.map((u) =>
        rpc.retry<string>(u, "eth_getTransactionCount", [
          PILOT_SCOPE.account,
          "latest",
        ]),
      ),
    );
    return {
      transfers: found.map((l) => ({
        txHash: l.transactionHash,
        index: BigInt(l.topics[2]).toString(),
        block: Number(BigInt(l.blockNumber)),
      })),
      nonces: nonces.map((n) => BigInt(n).toString()),
    };
  }
  return { track, detect };
}
