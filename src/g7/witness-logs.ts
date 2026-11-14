import { G7RpcError } from "./rpc";
import type { RawLog } from "./ledger";
const hash = /^0x[0-9a-f]{64}$/i;
const address = /^0x[0-9a-f]{40}$/i;
const qty = /^0x[0-9a-f]{1,16}$/i;
// Provider metadata is untrusted. Invalid/removed/out-of-filter logs never enter the accounting cache.
export function validateLogs(
  raw: unknown,
  filter: Record<string, unknown>,
  from: number,
  to: number,
): RawLog[] {
  if (!Array.isArray(raw)) throw new G7RpcError("MALFORMED_LOG_RESPONSE");
  const seen = new Set<string>();
  for (const value of raw) {
    const l = value as RawLog;
    if (
      !l ||
      !address.test(l.address) ||
      !qty.test(l.blockNumber) ||
      !qty.test(l.logIndex) ||
      !hash.test(l.transactionHash) ||
      !hash.test(l.blockHash ?? "") ||
      l.removed === true ||
      !/^0x([0-9a-f]{2})*$/i.test(l.data) ||
      !Array.isArray(l.topics) ||
      !l.topics.every((t) => hash.test(t)) ||
      Number(BigInt(l.blockNumber)) < from ||
      Number(BigInt(l.blockNumber)) > to ||
      l.address.toLowerCase() !== String(filter.address).toLowerCase()
    )
      throw new G7RpcError("MALFORMED_LOG_RESPONSE");
    const topics = filter.topics as (string | string[] | null)[] | undefined;
    if (
      topics?.some(
        (t, i) =>
          t !== null &&
          !(Array.isArray(t) ? t : [t]).some(
            (v) => v.toLowerCase() === l.topics[i]?.toLowerCase(),
          ),
      )
    )
      throw new G7RpcError("LOG_FILTER_MISMATCH");
    const key = `${l.transactionHash.toLowerCase()}:${l.logIndex.toLowerCase()}`;
    if (seen.has(key)) throw new G7RpcError("DUPLICATE_LOG_RESPONSE");
    seen.add(key);
  }
  return raw as RawLog[];
}
