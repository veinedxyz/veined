// Guardian Agent Gate: give an AI agent money without giving it the keys to everything. Every NEAR action an agent
// proposes passes two independent checks before anything could be signed:
//   1. the owner's policy (receiver allowlist, method allowlist, NEAR and per-token spending limits), and
//   2. Guardian's own review of the transaction (look-alike accounts, full-access keys, account deletion …).
// The decision is the stricter of the two: ALLOW, WARN, ESCALATE or BLOCK. Fail closed: an empty method list allows no
// function call, a token without a configured limit cannot be moved, and an agent may only propose plain Transfer and
// FunctionCall actions (keys, deployments, deletions, staking and nested meta transactions are never agent actions).
// Only ALLOW is authorized automatically; WARN needs the owner's acknowledgement (unless the owner opted in to
// auto-approving warnings), ESCALATE needs the owner's confirmation and BLOCK is refused. Only automatically authorized
// actions consume the budget. An agent's stated reason is untrusted text: shown, never parsed, never able to relax a
// decision. This module is the reference semantics for the on-chain Guardian vault (docs/guardian/ARCHITECTURE.md).
import { z } from "zod";
import { finding, type Finding, type SafeStep, type Verdict } from "./model";
import {
  knownNearAccount,
  reviewNearTransaction,
  type NearTransaction,
} from "./near";
import { verdictOf } from "./verdict";

const units = z.string().regex(/^(0|[1-9]\d{0,39})$/);
const limit = z.object({ perAction: units, daily: units }).strict();
export const agentPolicySchema = z
  .object({
    agent: z.string().min(2).max(64),
    owner: z.string().min(2).max(64),
    allowReceivers: z.array(z.string().min(2).max(64)).max(64),
    /** Methods the agent may call. Empty = no function call at all. */
    allowMethods: z.array(z.string().min(1).max(64)).max(64),
    /** NEAR (yoctoNEAR) moved by attached deposits and transfers. */
    perActionLimit: units,
    dailyLimit: units,
    /** NEP-141 token contract → limits in the token's smallest unit. A token without an entry cannot be moved. */
    tokenLimits: z.record(z.string().min(2).max(64), limit).default({}),
    /** "owner-acknowledges" (default): a WARN waits for the owner; "auto": a WARN goes through like an ALLOW. */
    warnings: z
      .enum(["owner-acknowledges", "auto"])
      .default("owner-acknowledges"),
  })
  .strict();
export type AgentPolicy = z.input<typeof agentPolicySchema>;
type Policy = z.output<typeof agentPolicySchema>;
export type AgentDecision = "ALLOW" | "WARN" | "ESCALATE" | "BLOCK";
export type AgentAuthorization =
  | "AUTO"
  | "OWNER_ACKNOWLEDGEMENT_REQUIRED"
  | "OWNER_CONFIRMATION_REQUIRED"
  | "REFUSED";
export interface AgentProposal {
  id: string;
  /** What the agent says it is doing. Untrusted display text. */
  reason: string;
  tx: NearTransaction;
}
export interface AgentLedger {
  near: bigint;
  tokens: Record<string, bigint>;
}
export interface AgentGateResult {
  proposal: string;
  decision: AgentDecision;
  authorization: AgentAuthorization;
  verdict: Verdict;
  /** NEAR (yoctoNEAR) this action would move: attached deposits and transfers. */
  spend: string;
  /** NEAR moved so far today, after this decision (only automatically authorized actions count). */
  spentAfter: string;
  /** Token amounts moved so far today per token contract, after this decision. */
  tokensAfter: Record<string, string>;
  /** Always false in this build: no decision carries a signing or sending capability. */
  executable: false;
}

const NEAR = (v: bigint) => {
  const whole = v / 10n ** 24n,
    frac = (v % 10n ** 24n)
      .toString()
      .padStart(24, "0")
      .slice(0, 3)
      .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const show = (r: string) =>
  r.length > 30 ? `${r.slice(0, 12)}…${r.slice(-8)}` : r;
const FT = new Set(["ft_transfer", "ft_transfer_call"]);
const objectArgs = (args: unknown) =>
  args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;

/** Decide one proposal against the ledger of what was already moved today. */
export function gateAgentAction(
  input: AgentPolicy,
  proposal: AgentProposal,
  ledger: AgentLedger,
): AgentGateResult {
  const policy: Policy = agentPolicySchema.parse(input);
  const tx: NearTransaction = {
    ...proposal.tx,
    signerId: proposal.tx.signerId ?? policy.agent,
  };
  const review = reviewNearTransaction(tx, [
    policy.owner,
    ...policy.allowReceivers,
  ]);
  const findings: Finding[] = [...review.findings],
    steps = new Set<SafeStep>(review.steps);
  let checks = review.checks + 5;
  let spend = 0n;
  const tokenSpend: Record<string, bigint> = {};
  const receivers = new Set<string>();
  if (tx.receiverId !== policy.agent) receivers.add(tx.receiverId);
  for (const a of tx.actions) {
    checks++;
    if (a.type !== "Transfer" && a.type !== "FunctionCall") {
      findings.push(
        finding("POLICY_ACTION_NOT_ALLOWED", "CRITICAL", "EXECUTION", {
          action: a.type,
        }),
      );
      continue;
    }
    spend += BigInt(a.deposit);
    if (a.type !== "FunctionCall") continue;
    if (!policy.allowMethods.includes(a.methodName))
      findings.push(
        finding("POLICY_METHOD_NOT_ALLOWED", "CRITICAL", "EXECUTION", {
          method: a.methodName.slice(0, 32),
        }),
      );
    const args = objectArgs(a.args);
    if (typeof args?.receiver_id === "string") receivers.add(args.receiver_id);
    if (FT.has(a.methodName)) {
      // The token is the contract being called; its amount is in the token's smallest unit.
      const amount = args?.amount;
      if (typeof amount !== "string" || !/^(0|[1-9]\d{0,39})$/.test(amount))
        findings.push(
          finding("POLICY_AMOUNT_INVALID", "CRITICAL", "EXECUTION", {
            method: a.methodName,
          }),
        );
      else
        tokenSpend[tx.receiverId] =
          (tokenSpend[tx.receiverId] ?? 0n) + BigInt(amount);
    }
  }
  for (const r of receivers) {
    checks++;
    if (r !== policy.owner && !policy.allowReceivers.includes(r))
      findings.push(
        finding("POLICY_RECEIVER_NOT_ALLOWED", "CRITICAL", "ACCOUNT", {
          account: show(r),
        }),
      );
  }
  // NEAR budget.
  const perAction = BigInt(policy.perActionLimit),
    daily = BigInt(policy.dailyLimit);
  let overDaily = false;
  if (spend > perAction)
    findings.push(
      finding("POLICY_PER_ACTION_LIMIT", "CRITICAL", "EXECUTION", {
        amount: NEAR(spend),
        limit: NEAR(perAction),
      }),
    );
  else if (ledger.near + spend > daily) {
    overDaily = true;
    findings.push(
      finding("POLICY_DAILY_LIMIT", "WARNING", "EXECUTION", {
        amount: NEAR(ledger.near + spend),
        limit: NEAR(daily),
      }),
    );
  }
  // Token budgets: a token without a configured limit cannot be moved by the agent.
  for (const [token, amount] of Object.entries(tokenSpend)) {
    checks++;
    const label = knownNearAccount(token)?.label ?? show(token);
    const l = policy.tokenLimits[token];
    if (!l)
      findings.push(
        finding("POLICY_TOKEN_NOT_ALLOWED", "CRITICAL", "ASSET", {
          token: label,
        }),
      );
    else if (amount > BigInt(l.perAction))
      findings.push(
        finding("POLICY_TOKEN_LIMIT", "CRITICAL", "ASSET", { token: label }),
      );
    else if ((ledger.tokens[token] ?? 0n) + amount > BigInt(l.daily)) {
      overDaily = true;
      findings.push(
        finding("POLICY_TOKEN_DAILY_LIMIT", "WARNING", "ASSET", {
          token: label,
        }),
      );
    }
  }
  if (!overDaily && !findings.some((f) => f.code === "POLICY_PER_ACTION_LIMIT"))
    findings.push(
      finding("POLICY_WITHIN_LIMITS", "PASS", "EXECUTION", {
        amount: NEAR(ledger.near + spend),
        limit: NEAR(daily),
      }),
    );
  if (
    findings.some(
      (f) => f.code.startsWith("POLICY_") && f.severity === "CRITICAL",
    )
  )
    steps.add("STOP");
  const verdict = verdictOf(
    "agent-action",
    { policy, proposal: { id: proposal.id, tx } },
    findings,
    [...steps],
    checks,
  );
  const decision: AgentDecision =
    verdict.level === "BLOCK"
      ? "BLOCK"
      : verdict.level === "HOLD"
        ? "ESCALATE"
        : verdict.level === "CAUTION"
          ? "WARN"
          : "ALLOW";
  const authorization: AgentAuthorization =
    decision === "ALLOW" || (decision === "WARN" && policy.warnings === "auto")
      ? "AUTO"
      : decision === "WARN"
        ? "OWNER_ACKNOWLEDGEMENT_REQUIRED"
        : decision === "ESCALATE"
          ? "OWNER_CONFIRMATION_REQUIRED"
          : "REFUSED";
  // Only automatically authorized actions consume the budget; everything else waits for the owner or is refused.
  const auto = authorization === "AUTO";
  const near = ledger.near + (auto ? spend : 0n);
  const tokens = { ...ledger.tokens };
  if (auto)
    for (const [t, a] of Object.entries(tokenSpend))
      tokens[t] = (tokens[t] ?? 0n) + a;
  return {
    proposal: proposal.id,
    decision,
    authorization,
    verdict,
    spend: spend.toString(),
    spentAfter: near.toString(),
    tokensAfter: Object.fromEntries(
      Object.entries(tokens).map(([k, v]) => [k, v.toString()]),
    ),
    executable: false,
  };
}

/** Replay an agent's proposals in order (the day's ledger carries over between them). */
export function gateAgentRun(
  policy: AgentPolicy,
  proposals: readonly AgentProposal[],
) {
  let ledger: AgentLedger = { near: 0n, tokens: {} };
  return proposals.map((p) => {
    const r = gateAgentAction(policy, p, ledger);
    ledger = {
      near: BigInt(r.spentAfter),
      tokens: Object.fromEntries(
        Object.entries(r.tokensAfter).map(([k, v]) => [k, BigInt(v)]),
      ),
    };
    return r;
  });
}
