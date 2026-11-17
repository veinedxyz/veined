// VEINED-FIN-LIVE-20261115-01: the ONE composition of the swap lane (one engine, one durable journal, one process).
// Imported only by src/app/api/swap-lane/route.ts, and only reached when the lane is armed (all four protected facts
// set). The engine serves the ONE route the armed record names (an ENABLED route of ./scope.ts) and reads only that
// route's chain through its two operators. The journal is the reviewed canary store implementation (append-only,
// hash-chained, fsynced, one writer) in the lane's OWN directory — it never opens, reads or shares the canary's
// ".veined-canary-store" — and it is bound to ONE record AND its route.
import { join } from "node:path";
import { CanaryDurableStore } from "../../execution/server/canary/durable-store";
import {
  OWNER_SWAP_LANE_APPROVAL,
  OWNER_SWAP_LANE_KEY_SHA256,
  OWNER_SWAP_LANE_SIGNER,
  SWAP_LANE_LIVE_WIRING,
  swapLaneRecordProblems,
} from "./approval";
import { SwapLaneEngine } from "./engine";
import { laneReadBoth } from "./reads";
import { routeById } from "./scope";
import { laneSignerStatus, sendLaneTransaction } from "./signer-adapter";

export const SWAP_LANE_STORE_DIR = () =>
  join(process.cwd(), ".veined-swap-lane-store");
export function swapLaneArmed(): { armed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (OWNER_SWAP_LANE_APPROVAL === null)
    reasons.push("NO_OWNER_APPROVED_SWAP_LANE");
  else
    reasons.push(
      ...swapLaneRecordProblems(OWNER_SWAP_LANE_APPROVAL).map(
        (r) => `RECORD:${r}`,
      ),
    );
  if (OWNER_SWAP_LANE_KEY_SHA256 === null)
    reasons.push("NO_OWNER_SWAP_LANE_KEY");
  if (OWNER_SWAP_LANE_SIGNER === null) reasons.push("NO_LOCAL_SIGNER");
  if ((SWAP_LANE_LIVE_WIRING as boolean) !== true)
    reasons.push("SWAP_LANE_NOT_WIRED");
  return { armed: reasons.length === 0, reasons };
}
const globals = globalThis as typeof globalThis & {
  __veinedSwapLane?: SwapLaneEngine;
};
/**
 * Opens the lane journal and binds it to THIS record and its route with a lane-specific entry (the store writes its
 * own OPEN line; review MAJOR-1). A journal bound to another record or another route, or one that cannot be written,
 * is refused AND closed again, so a refusal never leaves the lock held.
 */
export function openLaneStore(
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
  if (typeof record.route !== "string" || routeById(record.route) === null)
    refuse("STORE_ROUTE_UNKNOWN");
  const binds = store.of("LANE_BIND");
  if (binds.length === 0) {
    // fl1 final review NIT-5: a journal that already holds lane entries but no binding belongs to no known record.
    const LANE_TYPES = [
      "REVIEW",
      "AUTH",
      "NONCE",
      "USE",
      "PREPARED",
      "DISPATCH",
      "RECEIPT",
      "SETTLED",
      "GATE_CLOSED",
      "SIGNER_PREFLIGHT",
      "REVOKE_REVIEW",
      "DISPATCH_DUPLICATE",
    ];
    if (store.entries().some((e) => LANE_TYPES.includes(e.type)))
      refuse("STORE_UNBOUND_ENTRIES");
    try {
      store.append("LANE_BIND", {
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
  else if ((binds[0].data as { route?: unknown }).route !== record.route)
    refuse("STORE_OTHER_ROUTE");
  return store;
}
export function swapLaneRuntime(): SwapLaneEngine {
  const a = swapLaneArmed();
  if (!a.armed)
    throw Object.assign(new Error("WRITE_DISABLED"), {
      code: "WRITE_DISABLED",
    });
  if (globals.__veinedSwapLane) return globals.__veinedSwapLane;
  const record = OWNER_SWAP_LANE_APPROVAL!;
  // The armed record's route (swapLaneRecordProblems above refused an unknown or BLOCKED route).
  const route = routeById(record.route);
  if (route === null || route.status !== "ENABLED")
    throw Object.assign(new Error("WRITE_DISABLED"), {
      code: "WRITE_DISABLED",
    });
  const store = openLaneStore(SWAP_LANE_STORE_DIR(), record);
  let engine: SwapLaneEngine;
  try {
    engine = new SwapLaneEngine({
      store,
      record,
      keyDigest: OWNER_SWAP_LANE_KEY_SHA256!,
      chain: {
        both: (method, params, pick) =>
          laneReadBoth(
            route,
            method,
            params,
            record.account,
            AbortSignal.timeout(20_000),
            pick,
          ),
      },
      signer: {
        send: (authority, tx, step) => sendLaneTransaction(authority, tx, step),
        status: () => laneSignerStatus("SWAP"),
      },
    });
  } catch (e) {
    // An engine that refuses its record (route / pin set) never leaves the journal lock held.
    store.close();
    throw e;
  }
  globals.__veinedSwapLane = engine;
  return engine;
}
