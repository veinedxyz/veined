// VEINED-MC1 (BRIDGE LANE): the ONE composition of the bridge lane (one engine, one append-only journal, one process).
// Imported only by src/app/api/bridge-lane/route.ts, and only reached when the lane is armed (all four protected
// bridge facts set). The engine serves the ONE pair the armed record names (an ENABLED pair of ./bridge-scope.ts) and
// reads only that pair's two chains through their two operators each, plus the ONE LI.FI quote of the pair. The
// journal is the reviewed canary store implementation (append-only, hash-chained, fsynced, one writer) in the bridge
// lane's OWN directory — it never opens, reads or shares ".veined-canary-store" or ".veined-swap-lane-store" — and it
// is bound to ONE record AND its pair (LANE_BIND).
import { join } from "node:path";
import { CanaryDurableStore } from "../../execution/server/canary/durable-store";
import {
  BRIDGE_LANE_LIVE_WIRING,
  OWNER_BRIDGE_LANE_APPROVAL,
  OWNER_BRIDGE_LANE_KEY_SHA256,
  OWNER_BRIDGE_LANE_SIGNER,
  bridgeLaneRecordProblems,
} from "./bridge-approval";
import { BridgeLaneEngine } from "./bridge-engine";
import { pairById } from "./bridge-scope";
import { bridgeLifiQuote, bridgeReadBoth } from "./reads";
import { laneSignerStatus, sendBridgeLaneTransaction } from "./signer-adapter";

export const BRIDGE_LANE_STORE_DIR = () =>
  join(process.cwd(), ".veined-bridge-lane-store");
export function bridgeLaneArmed(): { armed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (OWNER_BRIDGE_LANE_APPROVAL === null)
    reasons.push("NO_OWNER_APPROVED_BRIDGE_LANE");
  else
    reasons.push(
      ...bridgeLaneRecordProblems(OWNER_BRIDGE_LANE_APPROVAL).map(
        (r) => `RECORD:${r}`,
      ),
    );
  if (OWNER_BRIDGE_LANE_KEY_SHA256 === null)
    reasons.push("NO_OWNER_BRIDGE_LANE_KEY");
  if (OWNER_BRIDGE_LANE_SIGNER === null) reasons.push("NO_LOCAL_SIGNER");
  if ((BRIDGE_LANE_LIVE_WIRING as boolean) !== true)
    reasons.push("BRIDGE_LANE_NOT_WIRED");
  return { armed: reasons.length === 0, reasons };
}
const globals = globalThis as typeof globalThis & {
  __veinedBridgeLane?: BridgeLaneEngine;
};
/** Every entry type the bridge engine writes: a journal holding any of them but no binding belongs to no record. */
export const BRIDGE_LANE_ENTRY_TYPES = Object.freeze([
  "REVIEW",
  "AUTH",
  "NONCE",
  "USE",
  "PREPARED",
  "DISPATCH",
  "RECEIPT",
  "DEPOSIT",
  "FILL_SCAN",
  "SETTLED",
  "GATE_CLOSED",
  "SIGNER_PREFLIGHT",
  "REVOKE_REVIEW",
  "DISPATCH_DUPLICATE",
]);
/**
 * Opens the bridge lane journal and binds it to THIS record and its pair with a lane-specific entry (the store writes
 * its own OPEN line). A journal bound to another record or another pair, one holding lane entries without a binding,
 * or one that cannot be written, is refused AND closed again, so a refusal never leaves the lock held.
 */
export function openBridgeLaneStore(
  dir: string,
  record: {
    approvalId: string;
    route: string;
    account: string;
    scope: string;
    pinSet: string;
    firstNonce: string;
  },
): CanaryDurableStore {
  const store = CanaryDurableStore.open(dir);
  const refuse = (code: string): never => {
    store.close();
    throw Object.assign(new Error(code), { code });
  };
  if (!store.writable) refuse("STORE_NEEDS_ATTENTION");
  if (typeof record.route !== "string" || pairById(record.route) === null)
    refuse("STORE_ROUTE_UNKNOWN");
  const binds = store.of("LANE_BIND");
  if (binds.length === 0) {
    if (store.entries().some((e) => BRIDGE_LANE_ENTRY_TYPES.includes(e.type)))
      refuse("STORE_UNBOUND_ENTRIES");
    try {
      store.append("LANE_BIND", {
        lane: "BRIDGE",
        record: record.approvalId,
        route: record.route,
        account: record.account,
        scope: record.scope,
        pinSet: record.pinSet,
        firstNonce: record.firstNonce,
      });
    } catch {
      refuse("STORE_NEEDS_ATTENTION");
    }
  } else if (
    binds.length !== 1 ||
    (binds[0].data as { record?: unknown }).record !== record.approvalId
  )
    refuse("STORE_OTHER_RECORD");
  else if (
    (binds[0].data as { route?: unknown }).route !== record.route ||
    (binds[0].data as { lane?: unknown }).lane !== "BRIDGE"
  )
    refuse("STORE_OTHER_ROUTE");
  return store;
}
export function bridgeLaneRuntime(): BridgeLaneEngine {
  const a = bridgeLaneArmed();
  if (!a.armed)
    throw Object.assign(new Error("WRITE_DISABLED"), {
      code: "WRITE_DISABLED",
    });
  if (globals.__veinedBridgeLane) return globals.__veinedBridgeLane;
  const record = OWNER_BRIDGE_LANE_APPROVAL!;
  // The armed record's pair (bridgeLaneRecordProblems above refused an unknown or BLOCKED pair).
  const pair = pairById(record.route);
  if (pair === null || pair.status !== "ENABLED")
    throw Object.assign(new Error("WRITE_DISABLED"), {
      code: "WRITE_DISABLED",
    });
  const store = openBridgeLaneStore(BRIDGE_LANE_STORE_DIR(), record);
  let engine: BridgeLaneEngine;
  try {
    engine = new BridgeLaneEngine({
      store,
      record,
      keyDigest: OWNER_BRIDGE_LANE_KEY_SHA256!,
      chains: {
        source: {
          both: (method, params, pick) =>
            bridgeReadBoth(
              pair.source,
              method,
              params,
              record.account,
              AbortSignal.timeout(20_000),
              pick,
            ),
        },
        destination: {
          both: (method, params, pick) =>
            bridgeReadBoth(
              pair.destination,
              method,
              params,
              record.account,
              AbortSignal.timeout(20_000),
              pick,
            ),
        },
        quote: () =>
          bridgeLifiQuote(pair, record.account, AbortSignal.timeout(15_000)),
      },
      signer: {
        send: (authority, tx, step) =>
          sendBridgeLaneTransaction(authority, tx, step),
        status: () => laneSignerStatus("BRIDGE"),
      },
    });
  } catch (e) {
    // An engine that refuses its record (pair / pin sets) never leaves the journal lock held.
    store.close();
    throw e;
  }
  globals.__veinedBridgeLane = engine;
  return engine;
}
