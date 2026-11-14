import { z } from "zod";
import { createHash } from "node:crypto";
import { RoutingError } from "../routing/model";
import { registry } from "../data/observability/metrics";
import {
  CANARY_APPROVAL_BOUNDS,
  OWNER_CANARY_APPROVAL,
  approvalRecordProblems,
  evaluateCanaryApproval,
  exactApproveCalldata,
  readCanarySendCalldata,
  type CanaryAction,
  type CanaryApprovalFacts,
} from "./canary-approval";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((s) => !/^0x0{40}$/i.test(s));
const units = z.string().regex(/^(0|[1-9]\d{0,77})$/);
// The zero address is the canonical native-token sentinel, never a spender/recipient.
const tokenAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const intentSchema = z
  .object({
    chainId: z.string().regex(/^\d{1,18}$/),
    from: address,
    toContract: address,
    value: units,
    calldataSelector: z.string().regex(/^0x[0-9a-f]{8}$/i),
    inputToken: tokenAddress,
    inputAmount: units,
    outputToken: tokenAddress,
    minimumOutput: units,
    recipient: address,
    approvalSpender: address.nullable(),
    approvalAmount: units,
    platformFeeBps: z.literal(0),
    quoteId: z.string().min(1).max(200),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ExpectedIntent = z.infer<typeof intentSchema>;
export const transactionSchema = z
  .object({
    chainId: z.string(),
    from: address,
    to: address,
    value: units,
    data: z.string().regex(/^0x([0-9a-fA-F]{2}){4,65536}$/),
  })
  .strict();
export type PreparedTransaction = z.infer<typeof transactionSchema>;
export interface ContractEntry {
  chainId: string;
  protocol: string;
  provider: string;
  contract: string;
  spender: string | null;
  token: string;
  selector: string;
  runtimeHash: string;
  implementationHash: string | null;
  verifiedAt: number;
  verifiedBlock: string;
  provenance: string;
  status: "ACTIVE" | "REVIEW_REQUIRED" | "DENIED";
}
export const contractRegistry: readonly ContractEntry[] = Object.freeze([]);
export interface KillPolicy {
  global: boolean;
  chains: readonly string[];
  providers: readonly string[];
  protocols: readonly string[];
  tokens: readonly string[];
  spenders: readonly string[];
}
export const killPolicy: Readonly<KillPolicy> = Object.freeze({
  global: true,
  chains: [],
  providers: [],
  protocols: [],
  tokens: [],
  spenders: [],
});
// G14 protected proposal B2 — the ONE scoped contract entry of the owner-signed canary, kept OUTSIDE the general
// registry on purpose: `contractRegistry` stays empty and `killPolicy.global` stays true, so the general firewall
// (compareIntent / SimulationGate / routeHealth), G5, Swap and general routing remain closed exactly as before
// (scripts/verify-safety.mjs and scripts/g7-safety-scan.ts assert both literals). This entry is data, not a permit:
// its ACTIVE label alone allows nothing. The only consumer is canaryFirewallDecision below.
// Values: pin set g14-canary-pins.2026-11-12.2 — src/execution/canary/pins.ts and the dated live evidence
// live-pin-check-2.json (Base block 56427247, 2026-11-12T09:30:20Z, problems: []). A pin is a dated claim that is
// re-read on every decision; it is never assumed to still hold.
export const CANARY_PIN_SET_ID = "g14-canary-pins.2026-11-12.2";
export const canaryContractEntry: Readonly<ContractEntry> = Object.freeze({
  chainId: "8453",
  protocol: "across-v4",
  provider: "lifi",
  // LI.FI Diamond (Base): the call target and the only spender.
  contract: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
  spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
  // Circle native USDC (Base).
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4 — the only selector; 0xa1f1ce43 ("start") is not in scope.
  selector: "0x1794958f",
  // keccak256 of the Diamond's runtime code, and of the facet the Diamond loupe returns for the selector.
  runtimeHash:
    "0x5efa2ebe1ed041ce83c069f1cedc04945f1438680dacf5f88068ef6c7d94110a",
  implementationHash:
    "0x0d049cb64bfcb713b3fe8fa4727ae763cc1efe1e741ea5c43d41d07add0fb1f8",
  verifiedAt: 1794475820753,
  verifiedBlock: "56427247",
  provenance:
    "g14-canary-pins.2026-11-12.2: canary-probe-1 + fee-collector-pin-1 + live-pin-check-2 (facet 0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd)",
  status: "ACTIVE",
});
/** The pin evidence a canary decision needs: re-read NOW by the server from two configured operators at one block. */
export interface CanaryPinEvidence {
  set: string;
  /** keccak256 of the Diamond runtime code and of the facet behind the selector, as read. */
  runtimeHash: string | null;
  implementationHash: string | null;
  /** Decimal block the reads were made at, and when the server made them (ms). */
  block: string | null;
  observedAt: number | null;
  /** True only when two independent configured operators returned the same values at the same block. */
  twoOperatorsAgree: boolean | null;
}
export interface CanaryFirewallInput {
  now: number;
  action: CanaryAction;
  transaction: PreparedTransaction;
  pins: CanaryPinEvidence | null;
  /** Live wallet identity (decimal chain id), the reviewed output, the gas facts and the durable use state. */
  wallet: { account: string | null; chainId: string | null };
  expectedOut: string | null;
  gas: CanaryApprovalFacts["gas"];
  use: CanaryApprovalFacts["use"];
}
export interface CanaryFirewallDecision {
  decision: "DENIED" | "CANARY_EXCEPTION";
  reasons: string[];
  registryDigest: string;
}
/** Pin evidence older than this (ms) decides nothing (the scope's review-block bound). */
const CANARY_PIN_EVIDENCE_MAX_AGE_MS = 60_000;
/**
 * The narrow canary control. It is the only path on which the canary entry is consulted, and it never widens the
 * general firewall: there is no allow list, bypass flag or policy parameter here. CANARY_EXCEPTION is returned only
 * when ALL of these hold for THIS transaction: the protected owner record (canary-approval.ts, the module constant —
 * no caller can supply one) covers it exactly (scope, pin set, account, chain, token, spender, target, selector,
 * exact amount, owner minimum, gas budget, validity window, single use from a durable store); the transaction is one
 * of exactly two shapes (approve(Diamond, exactAmount) on the token, or the pinned selector on the Diamond with
 * sender = recipient = refund address, read from the calldata itself); the pin evidence is current, complete and
 * agreed by two operators; and no non-global kill list names the entry. Anything missing or UNKNOWN is DENIED.
 * Stated plainly: this decision does not consult killPolicy.global — the global kill keeps every OTHER path closed
 * and is not lifted for them; the canary's own off-switches are the disarmed owner record and the wiring constant
 * of the canary gate (src/execution/server/gate.ts), which calls this function for every wallet step.
 */
export function canaryFirewallDecision(
  i: CanaryFirewallInput,
): CanaryFirewallDecision {
  const entry = canaryContractEntry;
  const reasons: string[] = [];
  const lower = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : "");
  let tx: PreparedTransaction | null = null;
  try {
    tx = transactionSchema.parse(i?.transaction);
  } catch {
    reasons.push("TRANSACTION_MALFORMED");
  }
  if (entry.status !== "ACTIVE") reasons.push("ENTRY_NOT_ACTIVE");
  // A targeted kill (chain, provider, protocol, token, spender) always wins.
  const named = (values: readonly string[], key: string | null) =>
    !!key && values.some((v) => v.toLowerCase() === key.toLowerCase());
  if (
    named(killPolicy.chains, entry.chainId) ||
    named(killPolicy.providers, entry.provider) ||
    named(killPolicy.protocols, entry.protocol) ||
    named(killPolicy.tokens, entry.token) ||
    named(killPolicy.spenders, entry.spender)
  )
    reasons.push("EXECUTION_PAUSED");
  const p = i?.pins ?? null;
  if (!p) reasons.push("PIN_EVIDENCE_MISSING");
  else {
    if (p.set !== CANARY_PIN_SET_ID) reasons.push("PIN_SET_MISMATCH");
    if (
      lower(p.runtimeHash) !== entry.runtimeHash ||
      lower(p.implementationHash) !== entry.implementationHash
    )
      reasons.push("PIN_MISMATCH");
    if (p.twoOperatorsAgree !== true) reasons.push("PIN_SOURCES_NOT_AGREED");
    if (
      typeof p.block !== "string" ||
      !/^\d{1,20}$/.test(p.block) ||
      BigInt(p.block) < BigInt(entry.verifiedBlock)
    )
      reasons.push("PIN_BLOCK_INVALID");
    if (
      typeof p.observedAt !== "number" ||
      !Number.isFinite(p.observedAt) ||
      !Number.isFinite(i.now) ||
      i.now < p.observedAt ||
      i.now - p.observedAt > CANARY_PIN_EVIDENCE_MAX_AGE_MS
    )
      reasons.push("PIN_EVIDENCE_STALE");
  }
  // Token, spender, target, selector and amount are read from the transaction itself, never from a claim about it.
  let token: string | null = null,
    spender: string | null = null,
    amount: string | null = null,
    expectedOut: string | null = i?.expectedOut ?? null;
  const selector = tx ? tx.data.slice(0, 10).toLowerCase() : null;
  if (tx) {
    if (tx.chainId !== entry.chainId) reasons.push("WRONG_CHAIN");
    if (tx.value !== "0") reasons.push("NATIVE_VALUE_NOT_ZERO");
    if (i.action === "APPROVE") {
      // Exactly approve(spender, amount) with two argument words — not "any USDC method".
      const data = tx.data.toLowerCase();
      const word = data.length === 138 ? data.slice(74) : "";
      const value = /^[0-9a-f]{64}$/.test(word) ? BigInt("0x" + word) : null;
      if (
        value === null ||
        data !== exactApproveCalldata(entry.spender!, value) ||
        lower(tx.to) !== lower(entry.token)
      )
        reasons.push("NOT_AN_EXACT_APPROVAL");
      else {
        token = tx.to;
        spender = entry.spender;
        amount = value.toString();
      }
    } else if (i.action === "SEND") {
      if (lower(tx.to) !== lower(entry.contract) || selector !== entry.selector)
        reasons.push("REGISTRY_MISMATCH");
      // The call's own arguments are read from the calldata by the protected reader (canary-approval.ts) the way
      // the contract's decoder reads them — never taken from a caller's or a provider's "decoded" object.
      const d = readCanarySendCalldata(tx.data);
      if (!d) reasons.push("CALLDATA_NOT_READABLE");
      else {
        if (
          d.receiver !== lower(tx.from) ||
          d.acrossReceiver !== lower(tx.from) ||
          d.refund !== lower(tx.from)
        )
          reasons.push("RECIPIENT_NOT_SENDER");
        if (
          d.stepSendingAsset !== d.sendingAsset ||
          d.stepReceivingAsset !== d.sendingAsset ||
          d.acrossInputToken !== d.sendingAsset
        )
          reasons.push("TOKEN_INCONSISTENT");
        if (
          d.destinationChainId !== CANARY_APPROVAL_BOUNDS.destinationChainId ||
          d.acrossOutputToken !==
            CANARY_APPROVAL_BOUNDS.destinationToken.toLowerCase()
        )
          reasons.push("DESTINATION_MISMATCH");
        if (d.hasDestinationCall || d.messageLength !== "0")
          reasons.push("DESTINATION_CALL");
        token = d.sendingAsset;
        spender = entry.spender;
        amount = d.inputAmount;
        // The output read from the calldata must be the reviewed one; the owner minimum is checked against it below.
        if (expectedOut !== d.effectiveOutput)
          reasons.push("OUTPUT_NOT_REVIEWED");
        expectedOut = d.effectiveOutput;
        // review 2 G1: the only source step is the pinned fee collection; USDC -> USDC is never above 1:1; and what
        // is bridged is at least the owner's minimum, so a step cannot keep more than the accepted cost.
        if (
          d.stepCallTo !== CANARY_APPROVAL_BOUNDS.feeCollector ||
          d.stepApproveTo !== CANARY_APPROVAL_BOUNDS.feeCollector ||
          d.stepSelector !== CANARY_APPROVAL_BOUNDS.feeCollectorSelector
        )
          reasons.push("SOURCE_STEP_NOT_PINNED_FEE");
        if (BigInt(d.multiplier) <= 0n || BigInt(d.multiplier) > 10n ** 18n)
          reasons.push("MULTIPLIER_OUT_OF_BOUNDS");
        const record = OWNER_CANARY_APPROVAL;
        if (
          record !== null &&
          approvalRecordProblems(record).length === 0 &&
          BigInt(d.bridgedAmount) < BigInt(record.minimumOut)
        )
          reasons.push("BRIDGED_BELOW_OWNER_MINIMUM");
      }
    } else reasons.push("ACTION_UNKNOWN");
  }
  const pinsVerified =
    !!p &&
    p.twoOperatorsAgree === true &&
    !reasons.some((r) => r.startsWith("PIN_"));
  const approval = evaluateCanaryApproval(OWNER_CANARY_APPROVAL, {
    now: i?.now,
    action: i?.action,
    account: tx && lower(i.wallet?.account) === lower(tx.from) ? tx.from : null,
    chainId: i?.wallet?.chainId ?? null,
    pinSet: p?.set ?? null,
    pinsVerified,
    token,
    spender,
    target: tx ? tx.to : null,
    selector,
    amount,
    expectedOut,
    gas: i?.gas ?? null,
    use: i?.use ?? null,
  });
  if (approval.status !== "VALID")
    reasons.push(...approval.reasons.map((r) => `OWNER_APPROVAL:${r}`));
  const unique = [...new Set(reasons)];
  if (unique.length)
    registry().inc(
      "security_firewall_rejections_total",
      { reason: "CANARY_DENIED" },
      1,
      "Transaction firewall rejections by safe reason code.",
    );
  return {
    decision: unique.length ? "DENIED" : "CANARY_EXCEPTION",
    reasons: unique,
    registryDigest: entryDigest(entry),
  };
}
/** The frozen bounds of the canary record, re-exported for the gate (single source: canary-approval.ts). */
export const CANARY_FIREWALL_BOUNDS = CANARY_APPROVAL_BOUNDS;
export function assertNotKilled(entry: ContractEntry, policy: KillPolicy) {
  const has = (values: readonly string[], key: string | null) =>
    !!key && values.some((v) => v.toLowerCase() === key.toLowerCase());
  if (
    policy.global ||
    has(policy.chains, entry.chainId) ||
    has(policy.providers, entry.provider) ||
    has(policy.protocols, entry.protocol) ||
    has(policy.tokens, entry.token) ||
    has(policy.spenders, entry.spender)
  )
    throw new RoutingError("EXECUTION_PAUSED");
}
export function routeHealth(
  entry: ContractEntry,
  policy: KillPolicy,
  runtimeHash: string,
  implementationHash: string | null,
) {
  assertNotKilled(entry, policy);
  if (
    entry.status !== "ACTIVE" ||
    entry.runtimeHash !== runtimeHash ||
    entry.implementationHash !== implementationHash
  )
    throw new RoutingError("REVIEW_REQUIRED");
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function transactionDigest(raw: PreparedTransaction) {
  return digest(transactionSchema.parse(raw));
}
export type TrustedDecoder = (
  data: string,
) => Pick<
  ExpectedIntent,
  | "inputToken"
  | "inputAmount"
  | "outputToken"
  | "minimumOutput"
  | "recipient"
  | "approvalSpender"
  | "approvalAmount"
  | "platformFeeBps"
>;
// A future adapter must supply a independently reviewed decoder. Upstream "decoded" objects are never accepted.
const decodedSchema = intentSchema.pick({
  inputToken: true,
  inputAmount: true,
  outputToken: true,
  minimumOutput: true,
  recipient: true,
  approvalSpender: true,
  approvalAmount: true,
  platformFeeBps: true,
});
// V1.5: rejections are counted by safe reason code (monitoring), then rethrown unchanged.
function countRejection(error: unknown): never {
  const reason =
    error instanceof RoutingError && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code)
      ? error.code
      : error instanceof z.ZodError
        ? "SCHEMA_REJECTED"
        : "OTHER";
  registry().inc(
    "security_firewall_rejections_total",
    { reason },
    1,
    "Transaction firewall rejections by safe reason code.",
  );
  throw error;
}
export function compareIntent(
  expected: ExpectedIntent,
  raw: PreparedTransaction,
  entry: ContractEntry,
  decoder: TrustedDecoder,
  now = Date.now(),
) {
  try {
    return compareIntentUnchecked(expected, raw, entry, decoder, now);
  } catch (error) {
    countRejection(error);
  }
}
function compareIntentUnchecked(
  expected: ExpectedIntent,
  raw: PreparedTransaction,
  entry: ContractEntry,
  decoder: TrustedDecoder,
  now: number,
) {
  const intent = intentSchema.parse(expected),
    tx = transactionSchema.parse(raw);
  if (now >= intent.expiresAt) throw new RoutingError("QUOTE_EXPIRED");
  if (
    entry.chainId !== intent.chainId ||
    entry.contract.toLowerCase() !== intent.toContract.toLowerCase() ||
    entry.token.toLowerCase() !== intent.inputToken.toLowerCase() ||
    entry.selector.toLowerCase() !== intent.calldataSelector.toLowerCase() ||
    entry.spender?.toLowerCase() !== intent.approvalSpender?.toLowerCase()
  )
    throw new RoutingError("REGISTRY_MISMATCH");
  const normalized = intentSchema.parse({
    ...intent,
    ...decodedSchema.parse(decoder(tx.data)),
    chainId: tx.chainId,
    from: tx.from,
    toContract: tx.to,
    value: tx.value,
    calldataSelector: tx.data.slice(0, 10),
  });
  for (const key of Object.keys(intent) as (keyof ExpectedIntent)[]) {
    const x = intent[key],
      y = normalized[key];
    if (
      typeof x === "string" && /^0x/.test(x)
        ? x.toLowerCase() !== String(y).toLowerCase()
        : x !== y
    )
      throw new RoutingError("INTENT_MISMATCH");
  }
  if (BigInt(intent.approvalAmount) > BigInt(intent.inputAmount))
    throw new RoutingError("UNLIMITED_APPROVAL_REJECTED");
  return {
    intentDigest: digest(intent),
    transactionDigest: transactionDigest(tx),
  };
}
export interface SimulationProof {
  success: boolean;
  transactionDigest: string;
  intentDigest: string;
  chainId: string;
  block: string;
  observedAt: number;
  // V1.5: the simulation is bound to the exact reviewed registry entry (contract, spender, token,
  // selector, runtime/implementation hashes, verified block, status). Any drift invalidates it.
  registryDigest: string;
}
// Fixed-order digest of a registry entry (field order is part of the spec, not object insertion).
export function entryDigest(entry: ContractEntry) {
  return digest([
    "otherbridge.registry-entry.v1",
    entry.chainId,
    entry.protocol,
    entry.provider,
    entry.contract.toLowerCase(),
    entry.spender?.toLowerCase() ?? null,
    entry.token.toLowerCase(),
    entry.selector.toLowerCase(),
    entry.runtimeHash,
    entry.implementationHash,
    entry.verifiedBlock,
    entry.status,
  ]);
}
// The gate enforces the kill policy itself (default: frozen global kill ON), so no future
// integration can reach a reviewed transaction while execution is paused.
export class SimulationGate {
  private used = new Set<string>();
  constructor(private readonly policy: Readonly<KillPolicy> = killPolicy) {}
  review(
    expected: ExpectedIntent,
    tx: PreparedTransaction,
    entry: ContractEntry,
    decoder: TrustedDecoder,
    proof: SimulationProof,
    now = Date.now(),
  ) {
    try {
      return this.reviewUnchecked(expected, tx, entry, decoder, proof, now);
    } catch (error) {
      countRejection(error);
    }
  }
  private reviewUnchecked(
    expected: ExpectedIntent,
    tx: PreparedTransaction,
    entry: ContractEntry,
    decoder: TrustedDecoder,
    proof: SimulationProof,
    now: number,
  ) {
    assertNotKilled(entry, this.policy);
    z.object({
      success: z.boolean(),
      transactionDigest: z.string(),
      intentDigest: z.string(),
      chainId: z.string(),
      block: z.string().regex(/^\d{1,20}$/),
      observedAt: z.number().finite().nonnegative(),
      registryDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
      .strict()
      .parse(proof);
    // Only an ACTIVE reviewed entry may be used, and the simulation must have run on state at or
    // after the block at which that entry was verified.
    if (entry.status !== "ACTIVE") throw new RoutingError("REVIEW_REQUIRED");
    if (proof.registryDigest !== entryDigest(entry))
      throw new RoutingError("REGISTRY_DRIFT");
    if (
      !/^\d{1,20}$/.test(entry.verifiedBlock) ||
      BigInt(proof.block) < BigInt(entry.verifiedBlock)
    )
      throw new RoutingError("SIMULATION_BLOCK_MISMATCH");
    const result = compareIntentUnchecked(expected, tx, entry, decoder, now);
    if (
      !proof.success ||
      proof.transactionDigest !== result.transactionDigest ||
      proof.intentDigest !== result.intentDigest ||
      proof.chainId !== expected.chainId ||
      !/^\d+$/.test(proof.block) ||
      now - proof.observedAt > 15000 ||
      now < proof.observedAt
    )
      throw new RoutingError("SIMULATION_REQUIRED");
    if (this.used.has(expected.quoteId))
      throw new RoutingError("REPLAY_REJECTED");
    if (this.used.size >= 1000)
      throw new RoutingError("REPLAY_CAPACITY_REACHED");
    this.used.add(expected.quoteId);
    return result;
  }
}
export function reviewApproval(
  amount: string,
  inputAmount: string,
  existingAllowance: string,
  deadline: number,
  now = Date.now(),
) {
  units.parse(amount);
  units.parse(inputAmount);
  units.parse(existingAllowance);
  if (
    BigInt(amount) > BigInt(inputAmount) ||
    !Number.isFinite(deadline) ||
    deadline <= now ||
    deadline - now > 300000
  )
    throw new RoutingError("UNLIMITED_APPROVAL_REJECTED");
  return {
    amount,
    spenderMustBeReviewed: true,
    approvalRequired: BigInt(existingAllowance) < BigInt(amount),
    signatureEnabled: false,
  };
}
export const incidentStates = [
  "WARN",
  "DEGRADED",
  "EXECUTION_PAUSED",
  "INCIDENT",
] as const;
export function futureExecution(): never {
  throw new RoutingError("WRITE_DISABLED");
}
