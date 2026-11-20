// VEINED-MC1 (BRIDGE LANE): the bridge lane's OWN protected facts and its OWN gate. Separate from the Bridge canary and
// from the swap lane in every respect: its own record type and version, its own key digest domain, its own wiring
// switch, its own signer endpoint fact, its own journal directory and its own single-use ledger.
// The record names exactly ONE pair of ./bridge-scope.ts (an ENABLED one); every bound of the record and every byte of
// a step is checked against THAT pair.
//
// In this (disarmed) build all four facts are closed: OWNER_BRIDGE_LANE_APPROVAL = null, OWNER_BRIDGE_LANE_KEY_SHA256 =
// null, BRIDGE_LANE_LIVE_WIRING = false, OWNER_BRIDGE_LANE_SIGNER = null. scripts/verify-safety.mjs (rule 13, bridge
// part) requires these exact literals; only a separately built LOCAL armed variant may set them. No request, variable,
// cookie, header or build flag can supply a record.
import {
  BRIDGE_LIFI_DIAMOND,
  BRIDGE_LANE_PIN_SET,
  bridgePinProblems,
} from "./bridge-pins";
import {
  BRIDGE_LANE_PAIRS,
  BRIDGE_LANE_SCOPE,
  bridgeChainById,
  pairById,
  type BridgeLanePair,
  type BridgeLaneStep,
} from "./bridge-scope";
import { bridgeApproveProblem, bridgeCallProblems } from "./bridge-calldata";
import { lanePool } from "./reads";

export const BRIDGE_LANE_APPROVAL_VERSION = "veined.bridge-lane.approval.v1";
export const BRIDGE_LANE_KEY_DOMAIN = "veined.bridge-lane.owner-key.v1";
export interface OwnerBridgeLaneApproval {
  version: string;
  approvalId: string;
  /** The pair id (./bridge-scope.ts BRIDGE_LANE_PAIRS, = the signer v5 route id) — ENABLED pairs only. */
  route: string;
  /** = the pair id. */
  scope: string;
  /** The bridge lane pin set id. */
  pinSet: string;
  account: string;
  sourceChainId: string;
  destinationChainId: string;
  sourceToken: string;
  destinationToken: string;
  /** The only spender: the LI.FI Diamond. */
  spender: string;
  /** Exactly the pair's amount (5 USDC). */
  exactAmount: string;
  /** At least the pair's minimum (4.90 USDC), at most the amount. */
  minimumOut: string;
  /** 1 .. 300. */
  maxCostBps: number;
  nativeGasBudgetWei: string;
  /** The owner's nonce on the SOURCE chain when the record was armed: the lane journal is anchored to it. */
  firstNonce: string;
  notBefore: number;
  notAfter: number;
  singleUse: true;
  allowanceCleanup: "ZERO_REVOKE_ONLY";
}
export const BRIDGE_LANE_RECORD_LIMITS = Object.freeze({
  maxWindowMs: 24 * 3600_000,
});
/** The exact values and bounds a record of each pair must hold (derived from the pair table and the pin sets). */
export const BRIDGE_LANE_APPROVAL_BOUNDS = Object.freeze(
  Object.fromEntries(
    Object.values(BRIDGE_LANE_PAIRS).map((p) => [
      p.id,
      Object.freeze({
        route: p.id,
        status: p.status,
        pinSet: BRIDGE_LANE_PIN_SET,
        sourceChainId: p.source,
        destinationChainId: p.destination,
        sourceToken: bridgeChainById(p.source)!.usdc.address,
        destinationToken: bridgeChainById(p.destination)!.usdc.address,
        spender: BRIDGE_LIFI_DIAMOND,
        exactAmount: p.exactAmount.toString(),
        minimumOut: p.minimumOut.toString(),
        maxCostBps: p.maxCostBps,
        maxGasBudgetWei: p.gasBudgetWei.toString(),
        maxWindowMs: BRIDGE_LANE_RECORD_LIMITS.maxWindowMs,
      }),
    ]),
  ),
);
// ---- the protected facts (disarmed) ----------------------------------------------------------------------------
export const OWNER_BRIDGE_LANE_APPROVAL =
  null as Readonly<OwnerBridgeLaneApproval> | null;
export const OWNER_BRIDGE_LANE_KEY_SHA256 = null as string | null;
export const BRIDGE_LANE_LIVE_WIRING = false as const;
/** The LOCAL restricted signer of an armed variant (loopback URL + its per-run token file). Null: nothing can send. */
export const OWNER_BRIDGE_LANE_SIGNER = null as Readonly<{
  url: string;
  tokenFile: string;
}> | null;

const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const DIGITS = /^(0|[1-9]\d{0,40})$/;
/** The pair a record names (null: no record, or no such pair). Status is NOT checked here. */
export function recordPair(r: unknown): Readonly<BridgeLanePair> | null {
  return r && typeof r === "object"
    ? pairById((r as { route?: unknown }).route)
    : null;
}
const RECORD_KEYS = Object.freeze([
  "version",
  "approvalId",
  "route",
  "scope",
  "pinSet",
  "account",
  "sourceChainId",
  "destinationChainId",
  "sourceToken",
  "destinationToken",
  "spender",
  "exactAmount",
  "minimumOut",
  "maxCostBps",
  "nativeGasBudgetWei",
  "firstNonce",
  "notBefore",
  "notAfter",
  "singleUse",
  "allowanceCleanup",
]);
/** Every way `r` is not a well-formed record inside the bounds of the pair it names ([] = well formed). */
export function bridgeLaneRecordProblems(r: unknown): string[] {
  if (!r || typeof r !== "object") return ["NO_RECORD"];
  const x = r as Record<string, unknown>;
  const p: string[] = [];
  for (const k of Object.keys(x))
    if (!RECORD_KEYS.includes(k)) p.push(`UNKNOWN_FIELD:${k}`);
  if (x.version !== BRIDGE_LANE_APPROVAL_VERSION) p.push("VERSION");
  if (
    typeof x.approvalId !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(x.approvalId)
  )
    p.push("APPROVAL_ID");
  const pair = recordPair(x);
  const S = pair ? bridgeChainById(pair.source) : null,
    D = pair ? bridgeChainById(pair.destination) : null;
  if (!pair || !S || !D) p.push("ROUTE");
  else {
    if (pair.status !== "ENABLED") p.push("ROUTE_BLOCKED");
    if (
      bridgePinProblems(pair.source).length ||
      bridgePinProblems(pair.destination).length
    )
      p.push("ROUTE_PINS");
  }
  if (!pair || x.scope !== pair.id) p.push("SCOPE");
  if (x.pinSet !== BRIDGE_LANE_PIN_SET) p.push("PIN_SET");
  if (
    typeof x.account !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(x.account) ||
    /^0x0{40}$/i.test(x.account)
  )
    p.push("ACCOUNT");
  if (
    !pair ||
    x.sourceChainId !== pair.source ||
    x.destinationChainId !== pair.destination
  )
    p.push("CHAINS");
  if (
    !S ||
    !D ||
    !same(x.sourceToken, S.usdc.address) ||
    !same(x.destinationToken, D.usdc.address)
  )
    p.push("TOKENS");
  if (!same(x.spender, BRIDGE_LIFI_DIAMOND)) p.push("SPENDER");
  if (typeof x.exactAmount !== "string" || !DIGITS.test(x.exactAmount))
    p.push("AMOUNT");
  else if (!pair || BigInt(x.exactAmount) !== pair.exactAmount)
    p.push("AMOUNT_NOT_PAIR_AMOUNT");
  if (typeof x.minimumOut !== "string" || !DIGITS.test(x.minimumOut))
    p.push("MINIMUM");
  else if (
    !pair ||
    !S ||
    !D ||
    BigInt(x.minimumOut) < pair.minimumOut ||
    BigInt(x.minimumOut) * 10n ** BigInt(S.usdc.decimals) >
      pair.exactAmount * 10n ** BigInt(D.usdc.decimals)
  )
    p.push("MINIMUM_BOUNDS");
  if (
    !Number.isInteger(x.maxCostBps) ||
    (x.maxCostBps as number) < 1 ||
    (x.maxCostBps as number) > BRIDGE_LANE_SCOPE.maxCostBps ||
    (pair !== null && (x.maxCostBps as number) > pair.maxCostBps)
  )
    p.push("COST_BOUNDS");
  if (typeof x.firstNonce !== "string" || !DIGITS.test(x.firstNonce))
    p.push("FIRST_NONCE");
  if (
    typeof x.nativeGasBudgetWei !== "string" ||
    !DIGITS.test(x.nativeGasBudgetWei)
  )
    p.push("GAS_BUDGET");
  else if (
    !pair ||
    BigInt(x.nativeGasBudgetWei) <= 0n ||
    BigInt(x.nativeGasBudgetWei) > pair.gasBudgetWei
  )
    p.push("GAS_BUDGET_BOUNDS");
  if (!Number.isSafeInteger(x.notBefore) || !Number.isSafeInteger(x.notAfter))
    p.push("WINDOW");
  else if (
    (x.notAfter as number) <= (x.notBefore as number) ||
    (x.notAfter as number) - (x.notBefore as number) >
      BRIDGE_LANE_RECORD_LIMITS.maxWindowMs
  )
    p.push("WINDOW_BOUNDS");
  if (x.singleUse !== true) p.push("SINGLE_USE");
  if (x.allowanceCleanup !== "ZERO_REVOKE_ONLY") p.push("CLEANUP_POLICY");
  return p;
}

export interface BridgeLaneStepFacts {
  /** The pair of the step (must be the record's pair). */
  route: string;
  /** REVOKE (VEINED-MC1 review MINOR-5): the lane's own approve(Diamond, 0), decided by the engine's revoke(). */
  step: BridgeLaneStep | "REVOKE";
  /** The record's exact amount (raw source USDC units, decimal string). */
  exactAmount: string;
  /** The exact transaction the engine prepared (8 canonical fields). */
  tx: {
    chainId: string;
    from: string;
    to: string;
    value: string;
    data: string;
    gas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  };
  /** Pins, balances and simulation read from two different configured operators at one block (engine proof). */
  operatorsAgree: boolean;
  /** The review attestation verified by this process for this record and plan. */
  reviewAttested: boolean;
  /** The Guardian verdict of this review was not BLOCK / HOLD, and attested. */
  guardianPassed: boolean;
  /** Native wei already spent by earlier lane steps + this step's worst case + L1 fee estimate. */
  gasWorstCaseTotalWei: bigint;
  now: number;
}
export type BridgeLaneGateReason =
  | "NO_OWNER_APPROVED_BRIDGE_LANE"
  | "NO_OWNER_BRIDGE_LANE_KEY"
  | "BRIDGE_LANE_NOT_WIRED"
  | "BRIDGE_LANE_RPC_POOL_INCOMPLETE"
  | "BRIDGE_LANE_FACTS_MISSING"
  | `RECORD:${string}`
  | `STEP:${string}`;
export interface BridgeLaneGateState {
  state: "OPEN" | "CLOSED";
  open: boolean;
  reasons: BridgeLaneGateReason[];
  /** The record's pair id, or null when no record names a known pair. */
  scope: string | null;
  pinSet: string | null;
}
const twoOperators = (
  pool: readonly { operator: string; url: string }[] | null | undefined,
) =>
  !!pool &&
  pool.length === 2 &&
  !!pool[0].operator &&
  !!pool[1].operator &&
  pool[0].operator.toLowerCase() !== pool[1].operator.toLowerCase() &&
  pool[0].url !== pool[1].url;
const bigOr = (v: unknown, fallback: bigint) => {
  try {
    return typeof v === "string" && v !== "" ? BigInt(v) : fallback;
  } catch {
    return fallback;
  }
};
/**
 * The bridge lane gate for ONE step. It never opens the general execution gate, the canary gate or the swap lane gate,
 * and it decides from the transaction's own bytes (re-decoded and re-bound here), not from a caller's verdict.
 */
export function bridgeLaneGateState(
  facts?: BridgeLaneStepFacts,
  record: Readonly<OwnerBridgeLaneApproval> | null = OWNER_BRIDGE_LANE_APPROVAL,
  keyDigest: string | null = OWNER_BRIDGE_LANE_KEY_SHA256,
  wiring: boolean = BRIDGE_LANE_LIVE_WIRING,
): BridgeLaneGateState {
  const reasons: BridgeLaneGateReason[] = [];
  if (record === null) reasons.push("NO_OWNER_APPROVED_BRIDGE_LANE");
  else
    for (const r of bridgeLaneRecordProblems(record))
      reasons.push(`RECORD:${r}`);
  const pair = record === null ? null : recordPair(record);
  if (keyDigest === null || !/^[0-9a-f]{64}$/.test(keyDigest))
    reasons.push("NO_OWNER_BRIDGE_LANE_KEY");
  if (
    pair !== null &&
    (!twoOperators(lanePool(pair.source)) ||
      !twoOperators(lanePool(pair.destination)))
  )
    reasons.push("BRIDGE_LANE_RPC_POOL_INCOMPLETE");
  if ((wiring as boolean) !== true) reasons.push("BRIDGE_LANE_NOT_WIRED");
  if (
    record !== null &&
    pair !== null &&
    !reasons.some((r) => r.startsWith("RECORD:"))
  ) {
    const S = bridgeChainById(pair.source)!;
    if (!facts || typeof facts !== "object" || !facts.tx)
      reasons.push("BRIDGE_LANE_FACTS_MISSING");
    else {
      const t = facts.tx;
      const step = (c: string) => reasons.push(`STEP:${c}`);
      if (facts.route !== record.route) step("ROUTE");
      // A zero-allowance REVOKE stays possible after the record window (it only ever lowers an allowance to 0).
      const revoke = facts.step === "REVOKE";
      if (!revoke && facts.now < record.notBefore) step("NOT_YET_VALID");
      if (!revoke && facts.now >= record.notAfter) step("APPROVAL_EXPIRED");
      if (t.chainId !== S.chainHex) step("CHAIN");
      if (!same(t.from, record.account)) step("FROM_NOT_OWNER");
      if (t.value !== "0x0") step("NATIVE_VALUE");
      const exactAmount = BigInt(record.exactAmount);
      if (facts.exactAmount !== record.exactAmount)
        step("AMOUNT_NOT_RECORD_AMOUNT");
      if (facts.step === "REVOKE") {
        if (!same(t.to, S.usdc.address)) step("REVOKE_TARGET_NOT_USDC");
        const pr = bridgeApproveProblem(t.data, 0n);
        if (pr)
          step(pr === "APPROVE_NOT_EXACT_AMOUNT" ? "REVOKE_NOT_ZERO" : pr);
      } else if (facts.step === "APPROVE") {
        if (!same(t.to, S.usdc.address)) step("APPROVE_TARGET_NOT_USDC");
        const pr = bridgeApproveProblem(t.data, exactAmount);
        if (pr) step(pr);
      } else if (facts.step === "EXECUTE") {
        if (!same(t.to, BRIDGE_LIFI_DIAMOND))
          step("EXECUTE_TARGET_NOT_DIAMOND");
        for (const pr of bridgeCallProblems(pair, t.data, {
          owner: record.account,
          exactAmount,
          minimumOut: BigInt(record.minimumOut),
          maxCostBps: record.maxCostBps,
          nowSec: Math.floor(facts.now / 1000),
        }).problems)
          step(pr);
      } else step("UNKNOWN_STEP");
      const gas = bigOr(t.gas, -1n);
      const cap =
        facts.step === "EXECUTE" ? S.maxGas.EXECUTE : S.maxGas.APPROVE;
      if (gas <= 0n || gas > cap) step("GAS_LIMIT");
      if (gas < BRIDGE_LANE_SCOPE.minGas) step("GAS_LIMIT_BELOW_FLOOR");
      const fee = bigOr(t.maxFeePerGas, -1n);
      if (fee <= 0n || fee > S.maxFeePerGasWei)
        step("FEE_CAP_ABOVE_SIGNER_POLICY");
      const tip = bigOr(t.maxPriorityFeePerGas, -1n);
      if (tip < S.minTipWei || tip > S.maxTipWei || (fee > 0n && tip > fee))
        step("TIP_OUTSIDE_CHAIN_POLICY");
      if (facts.gasWorstCaseTotalWei > BigInt(record.nativeGasBudgetWei))
        step("GAS_BUDGET");
      if (facts.operatorsAgree !== true) step("OPERATORS_NOT_PROVEN");
      if (facts.reviewAttested !== true) step("REVIEW_NOT_ATTESTED");
      // A REVOKE has no counterparty and moves nothing: no Guardian subject.
      if (!revoke && facts.guardianPassed !== true) step("GUARDIAN_NOT_PASSED");
    }
  }
  const open = reasons.length === 0;
  return {
    state: open ? "OPEN" : "CLOSED",
    open,
    reasons,
    scope: pair?.id ?? null,
    pinSet: pair ? BRIDGE_LANE_PIN_SET : null,
  };
}
