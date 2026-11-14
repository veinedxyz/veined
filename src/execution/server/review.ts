// G13: the server-side owner-signed review of a Bridge route (lifecycle steps 1–11). It never trusts the client's
// numbers: it re-reads the route itself, builds the plan from the server's own quote and registry evidence, runs
// Guardian HERE (deterministic), reads balances and allowance read-only, then evaluates the preflight and the gate.
// It returns a review; it never returns anything signable and never opens a deposit address.
import {
  quoteInputSchema,
  type Asset,
  type Catalog,
  type QuoteInput,
  type RoutingQuote,
} from "../../routing/model";
import { review as guardianReview } from "../../guardian/verdict";
import type { AssetFacts, BridgeFacts } from "../../guardian/model";
import { EXECUTION_POLICY, type AssetRef, type ExecutionPlan } from "../model";
import { planDigest, reviewDigest } from "../binding";
import {
  preflight,
  type AssetEvidence,
  type PreflightReport,
} from "../preflight";
import { PROVIDER_CONTRACTS } from "../providers";
import { executionGateState, type GateState } from "./gate";

export class ExecutionReviewError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "ExecutionReviewError";
  }
}
export interface ReviewDeps {
  now: () => number;
  catalog: (signal?: AbortSignal) => Promise<Catalog>;
  quotes: (input: QuoteInput, signal?: AbortSignal) => Promise<RoutingQuote[]>;
  evidence: (
    chainId: string,
    address: string,
    native: boolean,
  ) => (AssetEvidence & { coingeckoId?: string }) | null;
  /** The account's raw balance of `token` (zero address = native) on `chainId`, once per independent RPC source. */
  balances: (
    chainId: string,
    account: string,
    token: string,
    signal?: AbortSignal,
  ) => Promise<string[]>;
  allowance: (
    chainId: string,
    owner: string,
    token: string,
    spender: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
}
export interface ExecutionReview {
  kind: "EVM_BRIDGE";
  quote: { id: string; observedAt: number; expiresAt: number; tool: string };
  plan: ExecutionPlan;
  planDigest: string;
  guardian: { level: string; digest: string; findings: string[] };
  preflight: PreflightReport;
  gate: GateState;
  review: string;
  /** What the lifecycle would be: a plan that passed every check still stops at the closed gate. */
  outcome:
    "BLOCKED_BY_PREFLIGHT" | "BLOCKED_BY_GUARDIAN" | "STOPPED_AT_CLOSED_GATE";
}
const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (a: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a;
/** Destinations of the canary scope: the chains where the routing provider's contracts are identified. */
export const BRIDGE_DESTINATIONS = Object.freeze([
  ...new Set(
    PROVIDER_CONTRACTS.filter((c) => c.family === "lifi").map((c) => c.chainId),
  ),
]);

const ref = (a: Asset, network: Catalog["networks"][number]): AssetRef => ({
  chainId: a.chainId,
  address: a.address,
  symbol: a.symbol,
  decimals: a.decimals,
  native: lower(a.address) === lower(network.nativeAsset.address),
});
function inputUsd(q: RoutingQuote): string | null {
  const out =
    q.outputUsd && /^\d+(\.\d+)?$/.test(q.outputUsd)
      ? Number(q.outputUsd)
      : null;
  if (
    out === null ||
    out <= 0 ||
    q.priceImpact === null ||
    !Number.isFinite(q.priceImpact) ||
    q.priceImpact < 0 ||
    q.priceImpact >= 1
  )
    return null;
  return (out / (1 - q.priceImpact)).toFixed(6);
}
export async function reviewBridgeRoute(
  body: { input: unknown; wallet?: { account?: string; chainId?: string } },
  deps: ReviewDeps,
  signal?: AbortSignal,
): Promise<ExecutionReview> {
  const input = quoteInputSchema.parse(body.input);
  if (input.mode === "swap" || input.source === input.destination)
    throw new ExecutionReviewError("BRIDGE_ONLY");
  const catalog = await deps.catalog(signal);
  const sourceNet = catalog.networks.find((n) => n.id === input.source),
    destinationNet = catalog.networks.find((n) => n.id === input.destination);
  if (!sourceNet || !destinationNet)
    throw new ExecutionReviewError("STALE_OR_UNKNOWN_NETWORK");
  const [q] = await deps.quotes(input, signal);
  if (!q) throw new ExecutionReviewError("NO_EXECUTABLE_ROUTE");
  const first = q.steps[0],
    last = q.steps.at(-1)!;
  if (
    !first ||
    lower(first.sourceAsset.address) !== lower(input.sourceAsset) ||
    lower(last.destinationAsset.address) !== lower(input.destinationAsset)
  )
    throw new ExecutionReviewError("QUOTE_ASSET_MISMATCH");
  const pay = ref(first.sourceAsset, sourceNet),
    receive = ref(last.destinationAsset, destinationNet);
  const now = deps.now();
  const spender =
    !pay.native && first.approvalAddress ? first.approvalAddress : null;
  // The allowance is read first (review N2): a plan asks for an approval only when the allowance read on chain does
  // not already cover the amount — right after an owner-signed approval the fresh plan needs none.
  const allowance = spender
    ? await deps
        .allowance(
          input.source,
          input.sourceAddress,
          pay.address,
          spender,
          signal,
        )
        .catch(() => null)
    : pay.native
      ? null
      : "0";
  const covered =
    allowance !== null &&
    /^\d{1,78}$/.test(allowance) &&
    BigInt(allowance) >= BigInt(input.amount);
  const plan: ExecutionPlan = {
    version: EXECUTION_POLICY.version,
    kind: "EVM_BRIDGE",
    provider: q.provider,
    tool: first.tool,
    quoteId: q.id,
    quotedAt: q.observedAt,
    expiresAt: q.expiresAt,
    // Routing quotes are read-only by construction (protected normalizer: executable is the literal false).
    executable: q.executable,
    account: input.sourceAddress,
    sourceChainId: input.source,
    destinationChainId: input.destination,
    pay,
    receive,
    amountIn: input.amount,
    expectedOut: q.expected,
    minimumOut: q.minimum,
    recipient: input.destinationAddress,
    refundTo: null,
    slippageBps: Math.round(input.slippage * 10000),
    platformFeeBps: q.platformFee?.bps ?? 0,
    fees: q.fees.map((f) => ({
      name: f.name,
      amount: f.amount,
      usd: f.usd ?? null,
      included: f.included,
      kind: f.kind,
      asset: {
        chainId: f.asset.chainId,
        address: f.asset.address,
        symbol: f.asset.symbol,
        decimals: f.asset.decimals,
        native: lower(f.asset.address) === lower(sourceNet.nativeAsset.address),
      },
    })),
    spender,
    approval:
      spender && !covered
        ? { token: pay.address, spender, amount: input.amount }
        : null,
    // The protected routing normalizer does not expose the provider's transaction request: no calldata, so the
    // provider identity, recipient-in-calldata and simulation checks stay UNKNOWN (fail-closed).
    transaction: null,
  };
  const evPay = deps.evidence(pay.chainId, pay.address, pay.native),
    evReceive = deps.evidence(receive.chainId, receive.address, receive.native);
  const read = async (token: string) => {
    try {
      return await deps.balances(
        plan.sourceChainId,
        plan.account,
        token,
        signal,
      );
    } catch {
      return [];
    }
  };
  const [payReads, nativeReads] = await Promise.all([
    read(pay.native ? ZERO : pay.address),
    read(ZERO),
  ]);
  const agreement =
    payReads.length === 0
      ? null
      : payReads.length === 1
        ? "SINGLE"
        : payReads.every((v) => v === payReads[0])
          ? "AGREE"
          : "DISAGREE";

  // Guardian, server-side, on the server's own quote and registry evidence (the same rules the panels run).
  const facts = (a: AssetRef, e: typeof evPay): AssetFacts => ({
    chainId: a.chainId,
    address: a.address,
    symbol: a.symbol,
    native: a.native,
    level: a.native ? "CANONICAL" : (e?.level as AssetFacts["level"]),
    risk: a.native ? [] : ((e?.risk ?? []) as AssetFacts["risk"]),
  });
  const usd = (v: string | undefined) =>
    v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  const bridgeFacts: BridgeFacts = {
    kind: "bridge",
    sourceChain: plan.sourceChainId,
    destinationChain: plan.destinationChainId,
    sender: plan.account,
    recipient: plan.recipient,
    pay: facts(pay, evPay),
    receive: facts(receive, evReceive),
    route: {
      steps: q.steps.map((s) => ({
        tool: s.tool,
        catalogBound: s.catalogBound,
        destinationSignature: s.destinationSignature,
      })),
      durationSeconds: q.duration,
      priceImpact: q.priceImpact,
      warnings: q.warnings.filter(
        (w) =>
          ![
            "WRITE_DISABLED",
            "BALANCE_AND_ALLOWANCE_UNVERIFIED",
            "SIGNATURE_COUNT_UNVERIFIED",
            "DESTINATION_SIGNATURE_REQUIRED",
            "HIGH_PRICE_IMPACT",
          ].includes(w),
      ).length,
      valid: q.expiresAt > now,
      inputUsd: null,
      outputUsd: usd(q.outputUsd),
      costUsd: q.fees
        .filter((f) => f.included)
        .reduce<number | null>((s, f) => {
          const v = /^0+$/.test(f.amount) ? 0 : usd(f.usd);
          return s === null || v === null ? null : s + v;
        }, 0),
    },
    known: [plan.account],
  };
  const verdict = guardianReview(bridgeFacts);
  const report = preflight(plan, {
    now,
    // The wallet in the request is the client's claim: it is compared, never treated as proven (review F14); the
    // protected adapter re-reads the live wallet identity at signing time.
    wallet: {
      account: body.wallet?.account ?? null,
      chainId: body.wallet?.chainId ?? null,
      proven: false,
    },
    // Registry evidence only; nothing is synthesized from the plan itself (review F14): no entry -> UNKNOWN.
    evidence: { pay: evPay, receive: evReceive },
    balances: {
      pay: payReads[0] ?? null,
      native: nativeReads[0] ?? null,
      agreement,
    },
    allowance,
    allowanceSpender: spender,
    gas: { limit: null, maxFeePerGas: null },
    inputUsd: inputUsd(q),
    simulation: null,
    guardian: { level: verdict.level, digest: verdict.digest, quoteId: q.id },
    supportedDestinations: BRIDGE_DESTINATIONS,
  });
  const gate = executionGateState(plan.sourceChainId);
  const pd = planDigest(plan);
  return {
    kind: "EVM_BRIDGE",
    quote: {
      id: q.id,
      observedAt: q.observedAt,
      expiresAt: q.expiresAt,
      tool: first.tool,
    },
    plan,
    planDigest: pd,
    guardian: {
      level: verdict.level,
      digest: verdict.digest,
      findings: verdict.findings.map((f) => f.code),
    },
    preflight: report,
    gate,
    review: reviewDigest(pd, verdict.digest, report.digest),
    outcome:
      verdict.level === "BLOCK" || verdict.level === "HOLD"
        ? "BLOCKED_BY_GUARDIAN"
        : !report.ready
          ? "BLOCKED_BY_PREFLIGHT"
          : "STOPPED_AT_CLOSED_GATE",
  };
}
