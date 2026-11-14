import { z } from "zod";
import {
  BridgeError,
  recordSchema,
  hashSchema,
  type TransferRecord,
} from "../core/model";
const listSchema = z.array(recordSchema).max(100);
export const HISTORY_KEY = "otherbridge.history.v1";
export function decodeHistory(
  text: string,
  imported = false,
): TransferRecord[] {
  if (text.length > 150000) throw new BridgeError("IMPORT_TOO_LARGE");
  const items = listSchema.parse(JSON.parse(text));
  if (new Set(items.map((r) => r.id)).size !== items.length)
    throw new BridgeError("DUPLICATE_RECORD");
  return items.map((r) =>
    imported ||
    (r.mode === "mainnet-readonly" &&
      [
        "COMPLETED",
        "SOURCE_REVERTED",
        "SOURCE_CANCELLED",
        "USER_REJECTED",
      ].includes(r.state))
      ? {
          ...r,
          state: "UNVERIFIED_COMPLETION",
          error: imported ? "IMPORTED_UNVERIFIED" : "STORED_STATE_UNVERIFIED",
        }
      : r,
  );
}
export function readHistory(): { records: TransferRecord[]; error?: string } {
  try {
    return {
      records: decodeHistory(localStorage.getItem(HISTORY_KEY) ?? "[]"),
    };
  } catch {
    return { records: [], error: "HISTORY_UNREADABLE" };
  }
}
export async function saveRecord(record: TransferRecord): Promise<void> {
  const write = () => {
    const current = readHistory();
    if (current.error) throw new BridgeError(current.error);
    const records = current.records.filter((r) => r.id !== record.id);
    records.unshift(recordSchema.parse(record));
    const encoded = JSON.stringify(listSchema.parse(records));
    if (encoded.length > 150000) throw new BridgeError("HISTORY_TOO_LARGE");
    localStorage.setItem(HISTORY_KEY, encoded);
    window.dispatchEvent(new Event("otherbridge:history"));
  };
  if (navigator.locks)
    await navigator.locks.request("otherbridge-history", write);
  else throw new BridgeError("LOCK_UNAVAILABLE");
}
export async function importHistory(text: string) {
  const imported = decodeHistory(text, true);
  if (!navigator.locks) throw new BridgeError("LOCK_UNAVAILABLE");
  await navigator.locks.request("otherbridge-history", () => {
    const current = readHistory();
    if (current.error) throw new BridgeError(current.error);
    const existing = new Set(current.records.map((r) => r.id));
    const records = [
      ...current.records,
      ...imported.filter((r) => !existing.has(r.id)),
    ];
    const encoded = JSON.stringify(listSchema.parse(records));
    if (encoded.length > 150000) throw new BridgeError("HISTORY_TOO_LARGE");
    localStorage.setItem(HISTORY_KEY, encoded);
    window.dispatchEvent(new Event("otherbridge:history"));
  });
}
export async function attachSourceHash(id: string, candidate: string) {
  const sourceHash = hashSchema.parse(candidate);
  if (!navigator.locks) throw new BridgeError("LOCK_UNAVAILABLE");
  return navigator.locks.request("otherbridge-history", () => {
    const current = readHistory();
    if (current.error) throw new BridgeError(current.error);
    const claim = current.records.find((record) => record.id === id);
    if (!claim || claim.mode !== "mainnet-readonly" || claim.sourceHash)
      throw new BridgeError("INVALID_REQUEST");
    // This is a user-supplied candidate, never proof of rejection or delivery.
    const updated = recordSchema.parse({
      ...claim,
      sourceHash,
      state: "SOURCE_SUBMITTED",
      error: undefined,
      updatedAt: Date.now(),
    });
    const encoded = JSON.stringify(
      listSchema.parse(
        current.records.map((record) => (record.id === id ? updated : record)),
      ),
    );
    if (encoded.length > 150000) throw new BridgeError("HISTORY_TOO_LARGE");
    localStorage.setItem(HISTORY_KEY, encoded);
    window.dispatchEvent(new Event("otherbridge:history"));
    return updated;
  });
}
export function diagnostic(record: TransferRecord, includePublic = false) {
  return {
    schema: record.schema,
    mode: record.mode,
    route: record.route,
    config: record.config,
    state: record.state,
    updatedAt: record.updatedAt,
    error: record.error,
    ...(includePublic
      ? {
          account: record.account,
          recipient: record.recipient,
          amount: record.amount,
          sourceHash: record.sourceHash,
          destinationHash: record.destinationHash,
          index: record.index,
        }
      : { identity: "REDACTED" }),
  };
}
export function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
