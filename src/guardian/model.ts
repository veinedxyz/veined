// VEINED Guardian: the intelligence and defense layer that reads an action before anything is signed.
// Browser-safe types and the frozen policy. Guardian is deterministic: the same facts always produce the same verdict
// and the same digest. Narration (templates or NEAR AI Cloud) may only explain a verdict, never change it.
//
// Severity ladder (per finding):
//   PASS      a check that ran and found the expected evidence (shown so the user sees what was verified)
//   INFO      context the user should know (no action needed)
//   CAUTION   proceed only if this is what you meant
//   WARNING   stop and verify before continuing (verdict HOLD)
//   CRITICAL  a pattern used by scams or one that loses funds (verdict BLOCK)
import type { AssetLevel, RiskFlag } from "./support";

export const GUARDIAN_POLICY = Object.freeze({
  id: "veined-guardian",
  // g1.2026-11.1 (G13): a bridge loss explained by the route's own fees is named as such (ROUTE_COST_SHARE /
  // LARGER_AMOUNT) instead of advising a smaller amount; every severity is unchanged.
  version: "g1.2026-11.1",
  // Price impact (basis points) at which Guardian raises CAUTION / WARNING / CRITICAL.
  impactBps: [100, 300, 1000] as const,
  // Value lost between what you pay and what you receive, both priced by the same source (basis points).
  valueLossBps: [200, 500, 1500] as const,
  // Slippage tolerance at which Guardian asks for care (basis points).
  slippageBps: [100, 250] as const,
  // A quote this much better than the median of the others is an outlier worth a second look (basis points).
  outlierBps: 1000,
  // Bridge duration (seconds) worth mentioning.
  slowBridgeSeconds: 1800,
  // Attached NEAR deposit (yoctoNEAR) at which a function call is worth a caution: 0.1 NEAR.
  nearDepositCaution: 10n ** 23n,
  // A route with more hops or splits than this is described as complex.
  complexHops: 4,
});

export const SEVERITIES = [
  "PASS",
  "INFO",
  "CAUTION",
  "WARNING",
  "CRITICAL",
] as const;
export type Severity = (typeof SEVERITIES)[number];
export const LEVELS = ["CLEAR", "CAUTION", "HOLD", "BLOCK"] as const;
export type Level = (typeof LEVELS)[number];
export type Category =
  | "ASSET"
  | "ROUTE"
  | "RECIPIENT"
  | "APPROVAL"
  | "ACCOUNT"
  | "KEY"
  | "PORTFOLIO"
  | "EXECUTION";

export const FINDINGS = [
  // Assets
  "ASSET_EVIDENCE",
  "ASSET_BLOCKED",
  "ASSET_IMPERSONATION",
  "ASSET_TEXT_LURE",
  "ASSET_NO_CODE",
  "ASSET_UNVERIFIED",
  "ASSET_THIN_MARKET",
  "ASSET_CHAIN_MISMATCH",
  "FEE_POLICY_VIOLATION",
  // Route
  "ROUTE_IMPACT",
  "ROUTE_IMPACT_UNKNOWN",
  "ROUTE_VALUE_LOSS",
  "ROUTE_COST_SHARE",
  "ROUTE_SLIPPAGE",
  "ROUTE_COMPLEX",
  "ROUTE_STALE",
  "ROUTE_CROSS_CHECKED",
  "ROUTE_SINGLE_SOURCE",
  "ROUTE_OUTLIER",
  "BRIDGE_DESTINATION_SIGNATURE",
  "BRIDGE_UNBOUND_TOOL",
  "BRIDGE_SLOW",
  "BRIDGE_PROVIDER_NOTE",
  // Recipient
  "RECIPIENT_SELF",
  "RECIPIENT_EXTERNAL",
  "RECIPIENT_POISONED",
  "RECIPIENT_BURN",
  "RECIPIENT_TOKEN_CONTRACT",
  "RECIPIENT_INVALID",
  // Approval
  "APPROVAL_UNLIMITED",
  "APPROVAL_PERMIT2",
  "APPROVAL_EXACT",
  // Portfolio
  "HOLDINGS_SUSPICIOUS",
  "HOLDINGS_SAME_SYMBOL",
  "HOLDINGS_UNVERIFIED",
  "HOLDINGS_SPAM_HIDDEN",
  "HOLDINGS_CLEAN",
  // NEAR accounts
  "NEAR_ACCOUNT_INVALID",
  "NEAR_ACCOUNT_KNOWN",
  "NEAR_ACCOUNT_LOOKALIKE",
  "NEAR_ACCOUNT_LURE",
  "NEAR_ACCOUNT_IMPLICIT",
  "NEAR_ACCOUNT_ETH_IMPLICIT",
  "NEAR_ACCOUNT_SUBACCOUNT",
  "NEAR_TOKEN_BRIDGED_VARIANT",
  "NEAR_ACCOUNT_ONCHAIN",
  "NEAR_ACCOUNT_MISSING",
  "NEAR_ACCOUNT_UNFUNDED",
  "NEAR_ACCOUNT_UNVERIFIED",
  // NEAR actions and keys
  "NEAR_KEY_FULL_ACCESS",
  "NEAR_KEY_FUNCTION_CALL",
  "NEAR_KEY_UNLIMITED",
  "NEAR_DELETE_ACCOUNT",
  "NEAR_DEPLOY_CONTRACT",
  "NEAR_DELETE_KEY",
  "NEAR_DEPOSIT",
  "NEAR_TOKEN_TRANSFER",
  "NEAR_STAKE",
  "NEAR_DELEGATE",
  "NEAR_RECEIVER_UNKNOWN",
  // NEP-413 signed messages
  "NEAR_SIGNED_INTENT",
  "NEAR_INTENT_ADD_KEY",
  "NEAR_SIGNED_LOGIN",
  // Agent policy (Agent Gate)
  "POLICY_RECEIVER_NOT_ALLOWED",
  "POLICY_ACTION_NOT_ALLOWED",
  "POLICY_TOKEN_NOT_ALLOWED",
  "POLICY_TOKEN_LIMIT",
  "POLICY_TOKEN_DAILY_LIMIT",
  "POLICY_AMOUNT_INVALID",
  "POLICY_METHOD_NOT_ALLOWED",
  "POLICY_PER_ACTION_LIMIT",
  "POLICY_DAILY_LIMIT",
  "POLICY_WITHIN_LIMITS",
  // NEAR Intents
  "INTENTS_REFUND_EXTERNAL",
  "INTENTS_SIGNATURE_VALID",
  "INTENTS_SIGNATURE_INVALID",
  "INTENTS_QUOTE_MISMATCH",
  "INTENTS_DRY_QUOTE",
  // Execution
  "EXECUTION_CLOSED",
  // Chat drafts (Guardian chat-draft policy: amounts prepared in conversation)
  "DRAFT_LARGE_AMOUNT",
  "DRAFT_EXCEEDS_BALANCE",
] as const;
export type FindingCode = (typeof FINDINGS)[number];

export const SAFE_STEPS = [
  "STOP",
  "PICK_CURATED",
  "DO_NOT_INTERACT",
  "REQUOTE",
  "REDUCE_AMOUNT",
  "LARGER_AMOUNT",
  "CHECK_RECIPIENT",
  "TEST_TRANSFER",
  "EXACT_APPROVAL",
  "LIMITED_KEY",
  "PREFER_NATIVE",
] as const;
export type SafeStep = (typeof SAFE_STEPS)[number];

export type FindingParams = Readonly<Record<string, string | number>>;
export interface Finding {
  code: FindingCode;
  severity: Severity;
  category: Category;
  /** Display parameters for the localized explanation (already sanitized, never identity). */
  params: FindingParams;
}

export type SubjectKind =
  | "swap"
  | "bridge"
  | "portfolio"
  | "address"
  | "near-transaction"
  | "near-message"
  | "agent-action"
  | "intents-route"
  | "asset";

export interface Verdict {
  policy: string;
  subject: SubjectKind;
  level: Level;
  /** Sorted most severe first; PASS findings last. */
  findings: Finding[];
  steps: SafeStep[];
  /** Number of rules Guardian evaluated for this subject. */
  checks: number;
  /** sha256 over the policy, subject, normalized facts and findings: the same review always has the same digest. */
  digest: string;
}

// ---- Facts: what Guardian reads. Built by VEINED surfaces from already-validated data (never from free text). ----
export interface AssetFacts {
  chainId: string;
  address: string;
  symbol: string;
  native: boolean;
  /** Registry evidence level, when the registry knows the exact chain + contract. */
  level?: AssetLevel;
  risk?: readonly RiskFlag[];
}
export interface SwapQuoteFacts {
  provider: string;
  priceImpactBps: number | null;
  slippageBps: number;
  hops: number;
  splitCount: number;
  amountOut: string;
  minAmountOut: string;
  inputUsdMicros: string | null;
  outputUsdMicros: string | null;
  quotedAt: number;
  expiresAt: number;
  /** VEINED platform fee charged by this quote (smallest unit). Policy: always "0". */
  platformFee?: string;
}
export interface ApprovalFacts {
  kind: string;
  spender: string | null;
  amount: string;
}
export interface SwapFacts {
  kind: "swap";
  chainId: string;
  ecosystem: "EVM" | "SVM";
  sender: string;
  recipient: string;
  pay: AssetFacts;
  receive?: AssetFacts;
  quote?: SwapQuoteFacts;
  /** amountOut of the other providers' quotes for the same intent (cross-check). */
  alternatives?: readonly string[];
  approval?: ApprovalFacts;
  /** Addresses the user is known to use (wallet, scanned identity): recipients that only resemble them are poisoned. */
  known?: readonly string[];
}
export interface BridgeStepFacts {
  tool: string;
  catalogBound: boolean;
  destinationSignature: boolean;
}
export interface BridgeFacts {
  kind: "bridge";
  sourceChain: string;
  destinationChain: string;
  sender: string;
  recipient: string;
  pay: AssetFacts;
  receive?: AssetFacts;
  route?: {
    steps: readonly BridgeStepFacts[];
    durationSeconds: number;
    /** Fraction (0.01 = 1%) as reported by the routing source, when known. */
    priceImpact: number | null;
    warnings: number;
    valid: boolean;
    inputUsd?: number | null;
    outputUsd?: number | null;
    /** G13: USD sum of the route's cost lines that are taken out of the amount sent (as the routing source priced
     * them); null when any such line has no USD value. Only these lines can explain the in/out value difference. */
    costUsd?: number | null;
  };
  known?: readonly string[];
}
export interface HoldingFacts {
  chainId: string;
  address: string;
  symbol: string;
  spam: boolean;
  suspicious: boolean;
  metadataVerified?: boolean;
  routable?: boolean;
  usd: number | null;
}
export interface PortfolioFacts {
  kind: "portfolio";
  holdings: readonly HoldingFacts[];
}
export interface AddressFacts {
  kind: "address";
  value: string;
  known?: readonly string[];
}
export type GuardianFacts =
  SwapFacts | BridgeFacts | PortfolioFacts | AddressFacts;

export const SEVERITY_RANK: Record<Severity, number> = {
  PASS: 0,
  INFO: 1,
  CAUTION: 2,
  WARNING: 3,
  CRITICAL: 4,
};
export function levelOf(findings: readonly Finding[]): Level {
  const top = Math.max(0, ...findings.map((f) => SEVERITY_RANK[f.severity]));
  return top >= 4
    ? "BLOCK"
    : top === 3
      ? "HOLD"
      : top === 2
        ? "CAUTION"
        : "CLEAR";
}
export const finding = (
  code: FindingCode,
  severity: Severity,
  category: Category,
  params: FindingParams = {},
): Finding => ({ code, severity, category, params });
