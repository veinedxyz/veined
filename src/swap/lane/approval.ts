// VEINED-FIN-LIVE-20261115-01: the swap lane's OWN protected facts and its OWN gate. Separate from the Bridge
// canary in every respect: its own record type and version, its own key digest domain, its own wiring switch, its
// own journal directory and its own single-use ledger. Nothing here reads src/security/canary-approval.ts.
// The record names exactly ONE route of the route table (./scope.ts SWAP_LANE_ROUTES); it must be ENABLED, and every
// bound of the record and every byte of a step is checked against THAT route.
//
// In this (disarmed) build all four facts are closed: OWNER_SWAP_LANE_APPROVAL = null, OWNER_SWAP_LANE_KEY_SHA256 =
// null, SWAP_LANE_LIVE_WIRING = false, OWNER_SWAP_LANE_SIGNER = null. scripts/verify-safety.mjs (rule 13) requires these exact literals; only a
// separately built LOCAL armed variant (outside the accepted tree) may set them, and its scanners then fail on
// purpose. No request, variable, cookie, header or build flag can supply a record.
import { pinsOf, routePinProblems } from "./pins";
import { lanePool } from "./reads";
import {
  SWAP_LANE_ROUTES,
  SWAP_LANE_SCOPE,
  routeById,
  type SwapLaneRoute,
} from "./scope";
import { approveProblem, swapProblem } from "./calldata";

export const SWAP_LANE_APPROVAL_VERSION = "veined.swap-lane.approval.v2";
export const SWAP_LANE_KEY_DOMAIN = "veined.swap-lane.owner-key.v1";
export interface OwnerSwapLaneApproval {
  version: string;
  approvalId: string;
  /** The route id (./scope.ts SWAP_LANE_ROUTES) — ENABLED routes only. */
  route: string;
  /** The route's scope id (= the route id). */
  scope: string;
  /** The route's pin set id. */
  pinSet: string;
  account: string;
  chainId: string;
  tokenIn: string;
  tokenOut: string;
  router: string;
  exactAmount: string;
  maxSlippageBps: number;
  nativeGasBudgetWei: string;
  /** The owner's nonce on the route's chain when the record was armed: the lane journal is anchored to it. */
  firstNonce: string;
  notBefore: number;
  notAfter: number;
  singleUse: true;
  allowanceCleanup: "ZERO_REVOKE_ONLY";
}
/** Global record bounds (every route). */
export const SWAP_LANE_RECORD_LIMITS = Object.freeze({
  maxSlippageBps: SWAP_LANE_SCOPE.maxSlippageBps,
  maxWindowMs: 24 * 3600_000,
});
/** The exact values and bounds a record of each route must hold (derived from the route table and the pin sets). */
export const SWAP_LANE_APPROVAL_BOUNDS = Object.freeze(
  Object.fromEntries(
    Object.values(SWAP_LANE_ROUTES).map((r) => [
      r.id,
      Object.freeze({
        route: r.id,
        status: r.status,
        scope: r.id,
        pinSet: pinsOf(r.id)?.set ?? null,
        chainId: r.chainId,
        tokenIn: r.pay.address,
        tokenOut: r.receive.address,
        router: r.router,
        minAmount: r.minAmount.toString(),
        maxAmount: r.maxAmount.toString(),
        maxSlippageBps: SWAP_LANE_RECORD_LIMITS.maxSlippageBps,
        maxGasBudgetWei: r.gasBudgetWei.toString(),
        maxWindowMs: SWAP_LANE_RECORD_LIMITS.maxWindowMs,
      }),
    ]),
  ),
);
// ---- the protected facts (disarmed) ----------------------------------------------------------------------------
export const OWNER_SWAP_LANE_APPROVAL =
  null as Readonly<OwnerSwapLaneApproval> | null;
export const OWNER_SWAP_LANE_KEY_SHA256 = null as string | null;
export const SWAP_LANE_LIVE_WIRING = false as const;
/** The LOCAL restricted signer of an armed variant (loopback URL + its per-run token file). Null: nothing can send. */
export const OWNER_SWAP_LANE_SIGNER = null as Readonly<{
  url: string;
  tokenFile: string;
}> | null;

const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const DIGITS = /^(0|[1-9]\d{0,40})$/;
/** The route a record names (null: no record, or no such route). Status is NOT checked here. */
export function recordRoute(r: unknown): Readonly<SwapLaneRoute> | null {
  return r && typeof r === "object"
    ? routeById((r as { route?: unknown }).route)
    : null;
}
/** Every way `r` is not a well-formed record inside the bounds of the route it names ([] = well formed). */
export function swapLaneRecordProblems(r: unknown): string[] {
  if (!r || typeof r !== "object") return ["NO_RECORD"];
  const x = r as Record<string, unknown>;
  const p: string[] = [];
  const keys = [
    "version",
    "approvalId",
    "route",
    "scope",
    "pinSet",
    "account",
    "chainId",
    "tokenIn",
    "tokenOut",
    "router",
    "exactAmount",
    "maxSlippageBps",
    "nativeGasBudgetWei",
    "firstNonce",
    "notBefore",
    "notAfter",
    "singleUse",
    "allowanceCleanup",
  ];
  for (const k of Object.keys(x))
    if (!keys.includes(k)) p.push(`UNKNOWN_FIELD:${k}`);
  if (x.version !== SWAP_LANE_APPROVAL_VERSION) p.push("VERSION");
  if (
    typeof x.approvalId !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(x.approvalId)
  )
    p.push("APPROVAL_ID");
  const route = recordRoute(x);
  const pins = route ? pinsOf(route.id) : null;
  if (!route) p.push("ROUTE");
  else {
    if (route.status !== "ENABLED") p.push("ROUTE_BLOCKED");
    if (routePinProblems(route.id).length) p.push("ROUTE_PINS");
  }
  if (!route || x.scope !== route.id) p.push("SCOPE");
  if (!pins || x.pinSet !== pins.set) p.push("PIN_SET");
  if (
    typeof x.account !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(x.account) ||
    /^0x0{40}$/i.test(x.account)
  )
    p.push("ACCOUNT");
  if (!route || x.chainId !== route.chainId) p.push("CHAIN");
  if (
    !route ||
    !same(x.tokenIn, route.pay.address) ||
    !same(x.tokenOut, route.receive.address)
  )
    p.push("TOKENS");
  if (!route || !same(x.router, route.router)) p.push("ROUTER");
  if (typeof x.exactAmount !== "string" || !DIGITS.test(x.exactAmount))
    p.push("AMOUNT");
  else if (
    !route ||
    BigInt(x.exactAmount) < route.minAmount ||
    BigInt(x.exactAmount) > route.maxAmount
  )
    p.push("AMOUNT_BOUNDS");
  if (
    !Number.isInteger(x.maxSlippageBps) ||
    (x.maxSlippageBps as number) < 1 ||
    (x.maxSlippageBps as number) > SWAP_LANE_RECORD_LIMITS.maxSlippageBps
  )
    p.push("SLIPPAGE_BOUNDS");
  if (typeof x.firstNonce !== "string" || !DIGITS.test(x.firstNonce))
    p.push("FIRST_NONCE");
  if (
    typeof x.nativeGasBudgetWei !== "string" ||
    !DIGITS.test(x.nativeGasBudgetWei)
  )
    p.push("GAS_BUDGET");
  else if (
    !route ||
    BigInt(x.nativeGasBudgetWei) <= 0n ||
    BigInt(x.nativeGasBudgetWei) > route.gasBudgetWei
  )
    p.push("GAS_BUDGET_BOUNDS");
  if (!Number.isSafeInteger(x.notBefore) || !Number.isSafeInteger(x.notAfter))
    p.push("WINDOW");
  else if (
    (x.notAfter as number) <= (x.notBefore as number) ||
    (x.notAfter as number) - (x.notBefore as number) >
      SWAP_LANE_RECORD_LIMITS.maxWindowMs
  )
    p.push("WINDOW_BOUNDS");
  if (x.singleUse !== true) p.push("SINGLE_USE");
  if (x.allowanceCleanup !== "ZERO_REVOKE_ONLY") p.push("CLEANUP_POLICY");
  return p;
}

export interface SwapLaneStepFacts {
  /** The route of the step (must be the record's route). */
  route: string;
  /** REVOKE (VEINED-MC1 review MINOR-5): the lane's own approve(router, 0), decided by the engine's revoke(). */
  step: "APPROVE" | "SWAP" | "REVOKE";
  /** The record's exact amount (raw pay-token units, decimal string). */
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
  /** For SWAP: the reviewed minimum (from the attested review). */
  amountOutMinimum?: bigint;
  /** Pins and balances read from two different configured operators at one block (engine proof). */
  operatorsAgree: boolean;
  /** The review attestation verified by this process for this record and plan. */
  reviewAttested: boolean;
  /** The Guardian verdict of this review was PASS-level (no BLOCK / HOLD) and attested. */
  guardianPassed: boolean;
  /** Native wei already spent by earlier lane steps + this step's worst case + L1 fee estimate. */
  gasWorstCaseTotalWei: bigint;
  now: number;
}
export type SwapLaneGateReason =
  | "NO_OWNER_APPROVED_SWAP_LANE"
  | "NO_OWNER_SWAP_LANE_KEY"
  | "SWAP_LANE_NOT_WIRED"
  | "SWAP_LANE_RPC_POOL_INCOMPLETE"
  | "SWAP_LANE_FACTS_MISSING"
  | `RECORD:${string}`
  | `STEP:${string}`;
export interface SwapLaneGateState {
  state: "OPEN" | "CLOSED";
  open: boolean;
  reasons: SwapLaneGateReason[];
  /** The record's route (= its scope id), or null when no record names a known route. */
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
 * The lane gate for ONE step. It never opens the general execution gate (G5, routing, Swap service, firewall stay
 * closed) and it decides from the transaction's own bytes, not from a caller's verdict.
 */
export function swapLaneGateState(
  facts?: SwapLaneStepFacts,
  record: Readonly<OwnerSwapLaneApproval> | null = OWNER_SWAP_LANE_APPROVAL,
  keyDigest: string | null = OWNER_SWAP_LANE_KEY_SHA256,
  wiring: boolean = SWAP_LANE_LIVE_WIRING,
): SwapLaneGateState {
  const reasons: SwapLaneGateReason[] = [];
  if (record === null) reasons.push("NO_OWNER_APPROVED_SWAP_LANE");
  else
    for (const r of swapLaneRecordProblems(record)) reasons.push(`RECORD:${r}`);
  const route = record === null ? null : recordRoute(record);
  if (keyDigest === null || !/^[0-9a-f]{64}$/.test(keyDigest))
    reasons.push("NO_OWNER_SWAP_LANE_KEY");
  if (route !== null && !twoOperators(lanePool(route.chainId)))
    reasons.push("SWAP_LANE_RPC_POOL_INCOMPLETE");
  if ((wiring as boolean) !== true) reasons.push("SWAP_LANE_NOT_WIRED");
  if (
    record !== null &&
    route !== null &&
    !reasons.some((r) => r.startsWith("RECORD:"))
  ) {
    if (!facts || typeof facts !== "object" || !facts.tx)
      reasons.push("SWAP_LANE_FACTS_MISSING");
    else {
      const t = facts.tx;
      const step = (c: string) => reasons.push(`STEP:${c}`);
      if (facts.route !== record.route) step("ROUTE");
      // A zero-allowance REVOKE stays possible after the record window (it only ever lowers an allowance to 0).
      const revoke = facts.step === "REVOKE";
      if (!revoke && facts.now < record.notBefore) step("NOT_YET_VALID");
      if (!revoke && facts.now >= record.notAfter) step("APPROVAL_EXPIRED");
      if (t.chainId !== route.chainHex) step("CHAIN");
      if (!same(t.from, record.account)) step("FROM_NOT_OWNER");
      if (t.value !== "0x0") step("NATIVE_VALUE");
      const exactAmount = BigInt(record.exactAmount);
      if (facts.exactAmount !== record.exactAmount)
        step("AMOUNT_NOT_RECORD_AMOUNT");
      if (facts.step === "REVOKE") {
        if (!same(t.to, route.pay.address)) step("REVOKE_TARGET_NOT_USDC");
        const pr = approveProblem(route, t.data, 0n);
        if (pr)
          step(pr === "APPROVE_NOT_EXACT_AMOUNT" ? "REVOKE_NOT_ZERO" : pr);
      } else if (facts.step === "APPROVE") {
        if (!same(t.to, route.pay.address)) step("APPROVE_TARGET_NOT_USDC");
        const pr = approveProblem(route, t.data, exactAmount);
        if (pr) step(pr);
      } else if (facts.step === "SWAP") {
        if (!same(t.to, route.router)) step("SWAP_TARGET_NOT_ROUTER");
        if (facts.amountOutMinimum === undefined) step("NO_REVIEWED_MINIMUM");
        else {
          const pr = swapProblem(
            route,
            t.data,
            {
              owner: record.account,
              amountIn: exactAmount,
              amountOutMinimum: facts.amountOutMinimum,
            },
            Math.floor(facts.now / 1000),
          );
          if (pr) step(pr);
        }
      } else step("UNKNOWN_STEP");
      const gas = bigOr(t.gas, -1n);
      const cap =
        facts.step === "SWAP" ? route.maxGas.SWAP : route.maxGas.APPROVE;
      if (gas <= 0n || gas > cap) step("GAS_LIMIT");
      if (gas < SWAP_LANE_SCOPE.minGas) step("GAS_LIMIT_BELOW_FLOOR");
      const fee = bigOr(t.maxFeePerGas, -1n);
      if (fee <= 0n || fee > route.maxFeePerGasWei)
        step("FEE_CAP_ABOVE_SIGNER_POLICY");
      const tip = bigOr(t.maxPriorityFeePerGas, -1n);
      if (
        tip < route.minTipWei ||
        tip > route.maxTipWei ||
        (fee > 0n && tip > fee)
      )
        step("TIP_OUTSIDE_ROUTE_POLICY");
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
    scope: route?.id ?? null,
    pinSet: route ? (pinsOf(route.id)?.set ?? null) : null,
  };
}
