// Startup report of a G7 pilot launcher (never contains the session token).
import { GLOBAL_EXECUTION_ENABLED } from "../../src/g5/route-pins";
import { formatUnits18 } from "../../src/g7/prep";
import { QUOTE_MAX_AGE_AT_WALLET_MS } from "./policy";
import type { PilotSession } from "./session";

export function startupReport(
  s: ReturnType<PilotSession["snapshot"]>,
  extra: Record<string, unknown>,
) {
  const pf = s.preflight;
  const review = pf?.review ?? null;
  const intent = review?.intent;
  const one = (wei: string | undefined) =>
    wei === undefined ? null : `${formatUnits18(BigInt(wei))} ONE`;
  const gwei = (wei: string | undefined) =>
    wei === undefined ? null : `${formatUnits18(BigInt(wei) * 10n ** 9n)} gwei`;
  return {
    status: s.state,
    ...extra,
    session: s.sessionId,
    sessionExpiresAt: new Date(s.expiresAt).toISOString(),
    existingLock: s.lock
      ? { state: s.lock.state, txHash: s.lock.txHash }
      : null,
    walletBalance: one(pf?.summary?.balance),
    quoteObservedAt: review
      ? new Date(review.quote.observedAt).toISOString()
      : null,
    quoteAgeAtDecisionMs:
      review && pf ? pf.decisionAt - review.quote.observedAt : null,
    quoteWindowEndsAt: review
      ? new Date(
          review.quote.observedAt + QUOTE_MAX_AGE_AT_WALLET_MS,
        ).toISOString()
      : null,
    from: intent?.from ?? null,
    to: intent?.to ?? null,
    recipient: intent?.recipient ?? null,
    principal: one(intent?.principal),
    networkFee: one(intent?.networkFee),
    serviceFee: one(intent?.serviceFee),
    otherbridgeFee: intent ? "0" : null,
    msgValue: intent
      ? `${one(intent.value)} (${intent.value} wei, ${review!.tx.value})`
      : null,
    gasLimit: intent?.gasLimit ?? null,
    estimatedGas: review ? one(review.estimatedGas.cost) : null,
    feeCap: intent
      ? `maxFeePerGas ${gwei(intent.maxFeePerGas)}, maxPriorityFeePerGas ${gwei(intent.maxPriorityFeePerGas)}`
      : null,
    maximumWalletDebit: one(intent?.maximumWalletDebit),
    expectedReceive: intent
      ? `${formatUnits18(BigInt(intent.expectedReceive.amount))} CROSS (${intent.expectedReceive.token}, BSC 56)`
      : null,
    intentDigest: review?.intentDigest ?? null,
    calldataKeccak256: intent?.calldataKeccak256 ?? null,
    summary: pf?.summary ?? null,
    blockedReasons: pf?.blockedReasons ?? [],
    reapprovalReasons: pf?.reapprovalReasons ?? [],
    gates: pf?.gates.map((g) => `${g.id} ${g.name} ${g.status}`) ?? [],
    globalProductionExecution: GLOBAL_EXECUTION_ENABLED
      ? "ENABLED"
      : "disabled",
    counters: s.counters,
  };
}
