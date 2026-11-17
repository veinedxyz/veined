// VEINED-FIN-LIVE-20261115-01: the swap lane's SEPARATE submission gate — the ONLY module of the app that can hand a
// transaction to a signer, and only for this lane. It is not the browser wallet adapter
// (src/features/wallet/adapter.ts) and shares nothing with it: no gate name, no dispatch authority, no registry.
//
// A dispatch authority is an opaque object minted ONLY by the lane engine (mintLaneDispatchAuthority is imported by
// engine.ts alone — verify-safety rule 13) after the single-use authorization was consumed and journaled. It is
// held in a module-private WeakMap, it is good for exactly ONE send of exactly ONE transaction, and it is deleted
// before anything leaves the process. sendLaneTransaction re-runs the lane gate on the authority's own facts and
// compares the transaction field by field; any difference refuses before the signer is contacted.
//
// The signer is the LOCAL policy-restricted burner signer of the armed variant (a separate process on 127.0.0.1).
// Its endpoint is a protected fact (OWNER_SWAP_LANE_SIGNER, null in this build): nothing can be sent from here.
// Body (the multi-chain signer contract): {method: "sign_send", declared: {lane: "SWAP", route, step: "APPROVE" |
// "EXECUTE"}, swapAmount, tx}; the route is the authority's own (gate-checked) route, never a caller's.
//
// VEINED-MC1 (bridge lane): the same hand-off for the bridge lane, with its OWN authority table (minted only by
// bridge-engine.ts), its OWN gate re-run (bridgeLaneGateState) and its OWN endpoint fact (OWNER_BRIDGE_LANE_SIGNER,
// null in this build). Body: {method: "sign_send", declared: {lane: "BRIDGE", route: <pair id>, step: "APPROVE" |
// "EXECUTE"}, tx} — signer v5 reads no swapAmount for the bridge lane, so none is sent.
// VEINED-MC1 review fixes: (MINOR-5) the lane's own zero-allowance REVOKE goes out as {method: "sign_send", declared:
// {lane: "CLEANUP", route, step: "REVOKE"}, tx}; (MAJOR-1) laneSignerStatus POSTs {method: "sync"} then {method:
// "status"} (signer v5 CONTRACT-v5.md) and signerPreflightProblems decides, BEFORE an engine spends a step, whether the
// signer would certainly refuse it. Every request leaves through ONE loopback-only POST (postSigner, the single fetch
// of this module), with the same endpoint and token rules.
import { readFileSync } from "node:fs";
import {
  OWNER_SWAP_LANE_SIGNER,
  swapLaneGateState,
  type SwapLaneStepFacts,
} from "./approval";
import {
  OWNER_BRIDGE_LANE_SIGNER,
  bridgeLaneGateState,
  type BridgeLaneStepFacts,
} from "./bridge-approval";

export const LANE_TX_FIELDS = Object.freeze([
  "chainId",
  "from",
  "to",
  "value",
  "data",
  "gas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
] as const);
export type LaneTx = SwapLaneStepFacts["tx"];
export type LaneDispatchAuthority = object;
interface Grant {
  facts: SwapLaneStepFacts;
  tx: LaneTx;
}
const GRANTS = new WeakMap<object, Grant>();
/** Engine only. Returns an opaque, single-use authority for exactly this transaction and these facts. */
export function mintLaneDispatchAuthority(
  facts: SwapLaneStepFacts,
): LaneDispatchAuthority {
  const a = Object.freeze(Object.create(null) as object);
  const tx = Object.freeze({ ...facts.tx });
  // Deep copy: the gate re-run reads THIS frozen tx, never the caller's object.
  GRANTS.set(a, Object.freeze({ facts: Object.freeze({ ...facts, tx }), tx }));
  return a;
}
interface BridgeGrant {
  facts: BridgeLaneStepFacts;
  tx: LaneTx;
}
const BRIDGE_GRANTS = new WeakMap<object, BridgeGrant>();
/** Bridge engine only. An opaque, single-use authority for exactly this bridge transaction and these facts. */
export function mintBridgeDispatchAuthority(
  facts: BridgeLaneStepFacts,
): LaneDispatchAuthority {
  const a = Object.freeze(Object.create(null) as object);
  const tx = Object.freeze({ ...facts.tx });
  BRIDGE_GRANTS.set(
    a,
    Object.freeze({ facts: Object.freeze({ ...facts, tx }), tx }),
  );
  return a;
}
export class LaneDispatchError extends Error {
  constructor(
    public code: string,
    public problems: readonly string[] = [],
  ) {
    super(code);
    this.name = "LaneDispatchError";
  }
}
export function sameLaneTx(a: LaneTx, b: LaneTx): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a).sort().join(","),
    kb = Object.keys(b).sort().join(",");
  if (ka !== kb || ka !== [...LANE_TX_FIELDS].sort().join(",")) return false;
  return LANE_TX_FIELDS.every(
    (k) =>
      typeof a[k] === "string" &&
      typeof b[k] === "string" &&
      a[k].toLowerCase() === b[k].toLowerCase(),
  );
}
export interface LaneSignerResult {
  outcome: "SENT" | "REFUSED" | "UNCERTAIN";
  hash: string | null;
  problems: string[];
}

// ---- the signer's status (CONTRACT-v5.md) -------------------------------------------------------------------------
/** The signer's status, parsed strictly (anything else is "no status"). */
export interface LaneSignerStatus {
  address: string;
  pinsSha256: string;
  /** Epoch ms. */
  sessionNotAfter: number;
  enabledRoutes: readonly string[];
  chains: Readonly<
    Record<
      string,
      {
        firstNonce: bigint;
        signedCount: number;
        inFlight: number;
        uncertain: number;
      }
    >
  >;
  /** "<route>:<step>" keys the signer ever signed (single use per key, ever). */
  signed: readonly string[];
  inFlight: number;
  uncertain: number;
}
const STATUS_KEYS = [
  "address",
  "pinsSha256",
  "sessionNotAfter",
  "enabledRoutes",
  "chains",
  "signed",
  "inFlight",
  "uncertain",
]
  .sort()
  .join(",");
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** The status body of signer v5, or null when it is not exactly that shape. */
export function parseSignerStatus(raw: unknown): LaneSignerStatus | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  // CONTRACT-v5.md 2.1: the body has EXACTLY these keys and no others.
  if (Object.keys(o).sort().join(",") !== STATUS_KEYS) return null;
  if (
    typeof o.address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(o.address) ||
    typeof o.pinsSha256 !== "string" ||
    typeof o.sessionNotAfter !== "string" ||
    !Number.isFinite(Date.parse(o.sessionNotAfter)) ||
    !Array.isArray(o.enabledRoutes) ||
    !o.enabledRoutes.every((r) => typeof r === "string") ||
    !o.chains ||
    typeof o.chains !== "object" ||
    Array.isArray(o.chains) ||
    !o.signed ||
    typeof o.signed !== "object" ||
    Array.isArray(o.signed) ||
    !count(o.inFlight) ||
    !count(o.uncertain)
  )
    return null;
  const chains: Record<string, LaneSignerStatus["chains"][string]> = {};
  for (const [c, v] of Object.entries(o.chains as Record<string, unknown>)) {
    const e = v as Record<string, unknown> | null;
    if (
      !/^[1-9]\d{0,9}$/.test(c) ||
      !e ||
      typeof e !== "object" ||
      Object.keys(e).sort().join(",") !==
        "firstNonce,inFlight,signedCount,uncertain" ||
      typeof e.firstNonce !== "string" ||
      !/^(0|[1-9]\d{0,19})$/.test(e.firstNonce) ||
      !count(e.signedCount) ||
      !count(e.inFlight) ||
      !count(e.uncertain)
    )
      return null;
    chains[c] = Object.freeze({
      firstNonce: BigInt(e.firstNonce),
      signedCount: e.signedCount as number,
      inFlight: e.inFlight as number,
      uncertain: e.uncertain as number,
    });
  }
  const signed = Object.entries(o.signed as Record<string, unknown>);
  if (!signed.every(([, v]) => v === true)) return null;
  return Object.freeze({
    address: o.address.toLowerCase(),
    pinsSha256: o.pinsSha256,
    sessionNotAfter: Date.parse(o.sessionNotAfter),
    enabledRoutes: Object.freeze([...(o.enabledRoutes as string[])]),
    chains: Object.freeze(chains),
    signed: Object.freeze(signed.map(([k]) => k)),
    inFlight: o.inFlight as number,
    uncertain: o.uncertain as number,
  });
}
/** The signer must keep its session at least this long beyond the check (review TTL + hand-off + margin). */
export const SIGNER_MIN_SESSION_MS = 120_000;
export interface SignerPreflightWant {
  account: string;
  route: string;
  /** The signer's own step name (APPROVE | EXECUTE | REVOKE), or null for a review with no step left. */
  signerStep: string | null;
  chainId: string;
  nowMs: number;
  /**
   * REVOKE only (CONTRACT-v5.md 6): other routes of the same spender on this chain; one that was approved and has
   * neither executed nor revoked still needs the allowance, so this revoke would clear it.
   */
  blockedBy?: readonly { approve: string; execute: string; revoke: string }[];
}
/**
 * Why signer v5 would certainly refuse this step right now ([] = it would not, on its own status): anything in flight
 * or uncertain on ANY chain, another burner, a route the instance does not enable, a step it already signed once, a
 * session about to end, a chain the instance does not anchor. Pure; the engines prefix SIGNER_NOT_READY:.
 */
export function signerPreflightProblems(
  s: LaneSignerStatus | null,
  w: SignerPreflightWant,
): string[] {
  if (!s) return ["STATUS_UNAVAILABLE"];
  const p: string[] = [];
  if (s.inFlight !== 0) p.push("IN_FLIGHT");
  if (s.uncertain !== 0) p.push("UNCERTAIN");
  if (s.address !== w.account.toLowerCase()) p.push("ADDRESS_MISMATCH");
  if (!s.enabledRoutes.includes(w.route)) p.push("ROUTE_NOT_ENABLED");
  if (w.signerStep !== null && s.signed.includes(`${w.route}:${w.signerStep}`))
    p.push("STEP_ALREADY_SIGNED");
  if (!(s.sessionNotAfter - w.nowMs >= SIGNER_MIN_SESSION_MS))
    p.push("SESSION_ENDING");
  if (!Object.prototype.hasOwnProperty.call(s.chains, w.chainId))
    p.push("CHAIN_NOT_IN_INSTANCE");
  for (const b of w.blockedBy ?? [])
    if (
      s.signed.includes(b.approve) &&
      !s.signed.includes(b.execute) &&
      !s.signed.includes(b.revoke)
    )
      p.push("REVOKE_WOULD_CLEAR_OTHER_ROUTE");
  return [...new Set(p)];
}
/** sync, then status, on the lane's own signer endpoint fact (null in this build: refused, nothing sent). */
export async function laneSignerStatus(
  lane: "SWAP" | "BRIDGE",
): Promise<LaneSignerStatus> {
  const s = lane === "SWAP" ? OWNER_SWAP_LANE_SIGNER : OWNER_BRIDGE_LANE_SIGNER;
  const synced = await postSigner(s, { method: "sync" });
  if (!synced || synced.status !== 200)
    throw new LaneDispatchError("SIGNER_STATUS_UNAVAILABLE", ["SYNC"]);
  const st = await postSigner(s, { method: "status" });
  const parsed = st && st.status === 200 ? parseSignerStatus(st.reply) : null;
  if (!parsed)
    throw new LaneDispatchError("SIGNER_STATUS_UNAVAILABLE", ["STATUS"]);
  return parsed;
}

const ENDPOINT = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/$/;
/**
 * Hands ONE transaction to the local restricted signer. Refuses (LaneDispatchError, nothing sent) unless the
 * authority is live, the transaction is exactly the authorized one and the lane gate is OPEN for its facts.
 */
export async function sendLaneTransaction(
  authority: unknown,
  tx: LaneTx,
  step: "APPROVE" | "SWAP" | "REVOKE",
): Promise<LaneSignerResult> {
  const g =
    authority && typeof authority === "object"
      ? GRANTS.get(authority)
      : undefined;
  if (!g) throw new LaneDispatchError("AUTHORITY_UNKNOWN_OR_USED");
  GRANTS.delete(authority as object);
  if (g.facts.step !== step)
    throw new LaneDispatchError("AUTHORITY_STEP_MISMATCH");
  if (!sameLaneTx(g.tx, tx))
    throw new LaneDispatchError("TX_NOT_AUTHORIZED_TX");
  const gate = swapLaneGateState({ ...g.facts, now: Date.now() });
  if (!gate.open)
    throw new LaneDispatchError("SWAP_LANE_GATE_CLOSED", gate.reasons);
  if (step === "REVOKE")
    return signResult(
      await postSigner(OWNER_SWAP_LANE_SIGNER, {
        method: "sign_send",
        declared: { lane: "CLEANUP", route: g.facts.route, step: "REVOKE" },
        tx,
      }),
    );
  return signResult(
    await postSigner(OWNER_SWAP_LANE_SIGNER, {
      method: "sign_send",
      declared: {
        lane: "SWAP",
        route: g.facts.route,
        step: step === "SWAP" ? "EXECUTE" : "APPROVE",
      },
      swapAmount: BigInt(g.facts.exactAmount).toString(),
      tx,
    }),
  );
}
/**
 * VEINED-MC1: hands ONE bridge-lane transaction to the local restricted signer. Refuses (nothing sent) unless the
 * bridge authority is live, the transaction is exactly the authorized one and the BRIDGE lane gate is OPEN for its
 * facts. The declared route and step are the authority's own.
 */
export async function sendBridgeLaneTransaction(
  authority: unknown,
  tx: LaneTx,
  step: "APPROVE" | "EXECUTE" | "REVOKE",
): Promise<LaneSignerResult> {
  const bg =
    authority && typeof authority === "object"
      ? BRIDGE_GRANTS.get(authority)
      : undefined;
  if (!bg) throw new LaneDispatchError("AUTHORITY_UNKNOWN_OR_USED");
  BRIDGE_GRANTS.delete(authority as object);
  if (bg.facts.step !== step)
    throw new LaneDispatchError("AUTHORITY_STEP_MISMATCH");
  if (!sameLaneTx(bg.tx, tx))
    throw new LaneDispatchError("TX_NOT_AUTHORIZED_TX");
  const bridgeGate = bridgeLaneGateState({ ...bg.facts, now: Date.now() });
  if (!bridgeGate.open)
    throw new LaneDispatchError("BRIDGE_LANE_GATE_CLOSED", bridgeGate.reasons);
  if (bg.facts.step === "REVOKE")
    return signResult(
      await postSigner(OWNER_BRIDGE_LANE_SIGNER, {
        method: "sign_send",
        declared: { lane: "CLEANUP", route: bg.facts.route, step: "REVOKE" },
        tx,
      }),
    );
  return signResult(
    await postSigner(OWNER_BRIDGE_LANE_SIGNER, {
      method: "sign_send",
      declared: { lane: "BRIDGE", route: bg.facts.route, step: bg.facts.step },
      tx,
    }),
  );
}
/** A sign_send answer as a lane outcome: never resent; anything but a hash or an explicit refusal is UNCERTAIN. */
function signResult(
  r: { status: number; reply: unknown } | null,
): LaneSignerResult {
  if (!r)
    // The request may or may not have reached the signer: never resend; the journal and the chain decide.
    return {
      outcome: "UNCERTAIN",
      hash: null,
      problems: ["SIGNER_UNREACHABLE_AFTER_SEND"],
    };
  const reply = (r.reply && typeof r.reply === "object" ? r.reply : {}) as {
    hash?: unknown;
    problems?: unknown;
    refused?: unknown;
  };
  const problems = Array.isArray(reply.problems)
    ? reply.problems.map(String).slice(0, 32)
    : [];
  const hash =
    typeof reply.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(reply.hash)
      ? reply.hash.toLowerCase()
      : null;
  if (r.status === 200 && hash) return { outcome: "SENT", hash, problems: [] };
  if (r.status === 403 && reply.refused === true)
    return { outcome: "REFUSED", hash: null, problems };
  return {
    outcome: "UNCERTAIN",
    hash,
    problems: problems.length ? problems : [`SIGNER_HTTP_${r.status}`],
  };
}
/**
 * Lanes review R2 NEW-2: sync and status answer within 15 s or count as unavailable (the preflight runs inside the
 * process-wide dispatch lock, and the engines re-check the review's freshness after it); every other request keeps the
 * contract's 120 s.
 */
export const SIGNER_STATUS_TIMEOUT_MS = 15_000;
export const SIGNER_SEND_TIMEOUT_MS = 120_000;
/**
 * The ONE loopback POST to a lane's signer endpoint fact (null in this build: refused, nothing is ever sent). Returns
 * the HTTP status and the parsed JSON reply, or null when the request failed in flight.
 */
async function postSigner(
  s: Readonly<{ url: string; tokenFile: string }> | null,
  body: unknown,
): Promise<{ status: number; reply: unknown } | null> {
  if (
    s === null ||
    typeof s.url !== "string" ||
    !ENDPOINT.test(s.url) ||
    typeof s.tokenFile !== "string"
  )
    throw new LaneDispatchError("NO_LOCAL_SIGNER");
  const token = readFileSync(s.tokenFile, "utf8").trim();
  const method = (body as { method?: unknown } | null)?.method;
  const timeoutMs =
    method === "sync" || method === "status"
      ? SIGNER_STATUS_TIMEOUT_MS
      : SIGNER_SEND_TIMEOUT_MS;
  let r: Response;
  try {
    r = await fetch(s.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fl1-signer-token": token,
      },
      body: JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  let reply: unknown = null;
  try {
    reply = (await r.json()) as unknown;
  } catch {
    /* decided by the caller */
  }
  return { status: r.status, reply };
}
