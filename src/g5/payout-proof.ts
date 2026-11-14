// V1.6 G5 payout-proof correlation: binds a ONEchain BridgeInitiated to a BSC BridgeFinalized by
// (route, index) and requires identical recipient, principal and token, successful canonical receipts,
// a canonical CROSS Transfer bridge->recipient BEFORE the BridgeFinalized log, exactly one finalization
// for the index, and the exact-build implementation active at the destination block.
// Historical correlation is evidence of past settlement only, never a guarantee for future transfers.
import { CROSS, NATIVE } from "../core/model";
import { G5_ROUTE_PINS } from "./route-pins";

export interface SourceSide {
  chainId: number;
  emitter: string;
  receiptStatus: number;
  blockHash: string;
  canonicalBlockHash: string;
  event: {
    toChainID: bigint;
    index: bigint;
    fromToken: string;
    toToken: string;
    to: string;
    value: bigint;
  };
}
export interface DestinationSide {
  chainId: number;
  emitter: string;
  receiptStatus: number;
  blockHash: string;
  canonicalBlockHash: string;
  implementationAtBlock: string;
  finalizationsForIndex: number;
  finalizedLogIndex: number;
  event: {
    fromChainID: bigint;
    index: bigint;
    toToken: string;
    to: string;
    value: bigint;
  };
  transfer: {
    token: string;
    from: string;
    to: string;
    value: bigint;
    logIndex: number;
  } | null;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function verifyPayoutCorrelation(
  s: SourceSide,
  d: DestinationSide,
): { ok: boolean; failures: string[] } {
  const f: string[] = [];
  const src = G5_ROUTE_PINS.source,
    dst = G5_ROUTE_PINS.destination;
  if (s.chainId !== src.chainId || !same(s.emitter, src.proxy))
    f.push("SOURCE_EMITTER");
  if (d.chainId !== dst.chainId || !same(d.emitter, dst.proxy))
    f.push("DESTINATION_EMITTER");
  if (s.receiptStatus !== 1) f.push("SOURCE_RECEIPT_FAILED");
  if (d.receiptStatus !== 1) f.push("DESTINATION_RECEIPT_FAILED");
  if (!same(s.blockHash, s.canonicalBlockHash)) f.push("SOURCE_NONCANONICAL");
  if (!same(d.blockHash, d.canonicalBlockHash))
    f.push("DESTINATION_NONCANONICAL");
  if (
    s.event.toChainID !== BigInt(dst.chainId) ||
    d.event.fromChainID !== BigInt(src.chainId)
  )
    f.push("ROUTE_MISMATCH");
  if (s.event.index !== d.event.index) f.push("INDEX_MISMATCH");
  if (!same(s.event.to, d.event.to)) f.push("RECIPIENT_MISMATCH");
  if (s.event.value !== d.event.value || s.event.value <= 0n)
    f.push("AMOUNT_MISMATCH");
  if (
    !same(s.event.fromToken, NATIVE) ||
    !same(s.event.toToken, CROSS) ||
    !same(d.event.toToken, CROSS)
  )
    f.push("TOKEN_MISMATCH");
  if (d.finalizationsForIndex !== 1)
    f.push("DUPLICATE_OR_MISSING_FINALIZATION");
  if (!same(d.implementationAtBlock, dst.implementation))
    f.push("DESTINATION_IMPLEMENTATION_MISMATCH");
  const t = d.transfer;
  if (
    !t ||
    !same(t.token, CROSS) ||
    !same(t.from, dst.proxy) ||
    !same(t.to, d.event.to) ||
    t.value !== d.event.value
  )
    f.push("TRANSFER_MISSING");
  else if (t.logIndex >= d.finalizedLogIndex) f.push("EVENT_ORDER_MISMATCH");
  return { ok: f.length === 0, failures: f };
}
