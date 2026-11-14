// G13: the execution gate as it stands, read from the protected sources of truth (never changed here, never from the
// environment, a request, a cookie or a build flag). Every reason below must be gone before anything could be
// signed; the last one ("no owner-approved canary") can only be removed by a separately approved protected change
// (PROTECTED_CHANGE_PROPOSAL_TR.md). There is deliberately no parameter, variable or switch that opens this gate.
import { GLOBAL_EXECUTION_ENABLED } from "../../g5/route-pins";
import { executionGate } from "../../routing/model";
import { EXECUTION } from "../../swap/model";
import {
  CANARY_PIN_SET_ID,
  canaryContractEntry,
  canaryFirewallDecision,
  contractRegistry,
  killPolicy,
  type CanaryFirewallInput,
} from "../../security/firewall";
import {
  CANARY_SOURCE_CHAIN,
  CANARY_TRUSTED_CHAINS,
  TRUSTED_CHAINS,
} from "../../features/wallet/adapter";
import {
  CANARY_APPROVAL_BOUNDS,
  OWNER_CANARY_APPROVAL,
  approvalRecordProblems,
} from "../../security/canary-approval";
import { CANARY_RPC_POOL } from "../../swap/server/config";
import { EXECUTION_POLICY } from "../model";

export type GateReason =
  | "G5_GLOBAL_EXECUTION_DISABLED"
  | "ROUTING_WRITE_DISABLED"
  | "SWAP_EXECUTION_CLOSED"
  | "FIREWALL_GLOBAL_KILL"
  | "NO_ACTIVE_CONTRACT_ENTRY"
  | "WALLET_CHAIN_NOT_TRUSTED"
  | "NO_OWNER_APPROVED_CANARY";
export interface GateState {
  state: "CLOSED" | "OPEN";
  open: boolean;
  reasons: GateReason[];
  policy: string;
  platformFeeBps: 0;
}
export function executionGateState(sourceChainId?: string): GateState {
  const reasons: GateReason[] = [];
  if ((GLOBAL_EXECUTION_ENABLED as boolean) !== true)
    reasons.push("G5_GLOBAL_EXECUTION_DISABLED");
  if ((executionGate.enabled as boolean) !== true)
    reasons.push("ROUTING_WRITE_DISABLED");
  if (
    (EXECUTION.enabled as boolean) !== true ||
    EXECUTION.state !== ("OPEN" as string)
  )
    reasons.push("SWAP_EXECUTION_CLOSED");
  if (killPolicy.global) reasons.push("FIREWALL_GLOBAL_KILL");
  if (!contractRegistry.some((e) => e.status === "ACTIVE"))
    reasons.push("NO_ACTIVE_CONTRACT_ENTRY");
  if (sourceChainId !== undefined && !TRUSTED_CHAINS[Number(sourceChainId)])
    reasons.push("WALLET_CHAIN_NOT_TRUSTED");
  // The owner-approved canary record is the protected module constant (src/security/canary-approval.ts); it is
  // disarmed (null) in this build, and no request, variable or switch can supply one.
  if (approvalRecordProblems(OWNER_CANARY_APPROVAL).length > 0)
    reasons.push("NO_OWNER_APPROVED_CANARY");
  const open = reasons.length === 0;
  return {
    state: open ? "OPEN" : "CLOSED",
    open,
    reasons,
    policy: EXECUTION_POLICY.version,
    platformFeeBps: EXECUTION_POLICY.platformFeeBps,
  };
}

// G14 protected proposal (B2 + B3 + B4 + B5): the SEPARATE canary gate. It never opens the general gate above — G5,
// Swap and general routing stay closed whatever it reads — and in this build it cannot be OPEN at all:
// CANARY_LIVE_WIRING is false (the engine is not connected to any server route, API action or UI), and the owner
// record is disarmed. A later, separately approved step has to change BOTH protected facts.
export const CANARY_LIVE_WIRING = false as const;
/** What the engine proved about ONE wallet step, handed to the gate at authorize / prepare time. */
export interface CanaryGateFacts {
  /**
   * The step's own transaction and everything the firewall's canary control decides on (pin evidence, live wallet,
   * reviewed output, gas, single-use state). The gate runs that control itself (review 1 F5): no caller hands it a
   * verdict, and the owner record is evaluated inside it against values read from the transaction.
   */
  step: CanaryFirewallInput;
  /** True only when the review's pins and balances came from two different configured operators (B4). */
  operatorsConfigured: boolean | null;
  /** True only when the reviewed quote is the object the protected routing adapter returned (B1, review 1 F8). */
  quoteFromAdapter: boolean | null;
}
export type CanaryGateReason =
  | "NO_ACTIVE_CANARY_ENTRY"
  | "CANARY_CHAIN_NOT_TRUSTED"
  | "CANARY_RPC_POOL_INCOMPLETE"
  | "NO_OWNER_APPROVED_CANARY"
  | "CANARY_FACTS_MISSING"
  | "CANARY_OPERATORS_NOT_PROVEN"
  | "CANARY_QUOTE_NOT_FROM_ADAPTER"
  | "CANARY_NOT_WIRED"
  | `OWNER_APPROVAL:${string}`
  | `FIREWALL:${string}`;
export interface CanaryGateState {
  state: "CLOSED" | "OPEN";
  open: boolean;
  reasons: CanaryGateReason[];
  scope: string;
  pinSet: string;
  policy: string;
  platformFeeBps: 0;
}
const twoOperators = (pool: readonly { operator: string; url: string }[]) =>
  pool.length === 2 &&
  !!pool[0].operator &&
  !!pool[1].operator &&
  pool[0].operator.toLowerCase() !== pool[1].operator.toLowerCase() &&
  pool[0].url !== pool[1].url;
export function canaryGateState(facts?: CanaryGateFacts): CanaryGateState {
  const reasons: CanaryGateReason[] = [];
  // An ACTIVE entry is necessary, never sufficient.
  if (canaryContractEntry.status !== "ACTIVE")
    reasons.push("NO_ACTIVE_CANARY_ENTRY");
  if (CANARY_TRUSTED_CHAINS[CANARY_SOURCE_CHAIN]?.switchable !== true)
    reasons.push("CANARY_CHAIN_NOT_TRUSTED");
  if (
    !twoOperators(CANARY_RPC_POOL["8453"]) ||
    !twoOperators(CANARY_RPC_POOL["42161"])
  )
    reasons.push("CANARY_RPC_POOL_INCOMPLETE");
  if (OWNER_CANARY_APPROVAL === null) reasons.push("NO_OWNER_APPROVED_CANARY");
  else if (!facts || typeof facts !== "object" || !facts.step)
    reasons.push("CANARY_FACTS_MISSING");
  else {
    // The firewall's canary control decides for THIS transaction; it evaluates the owner record itself.
    const d = canaryFirewallDecision(facts.step);
    if (d.decision !== "CANARY_EXCEPTION")
      reasons.push(
        ...d.reasons.map((r) =>
          r.startsWith("OWNER_APPROVAL:")
            ? (r as CanaryGateReason)
            : (`FIREWALL:${r}` as CanaryGateReason),
        ),
      );
    if (facts.operatorsConfigured !== true)
      reasons.push("CANARY_OPERATORS_NOT_PROVEN");
    if (facts.quoteFromAdapter !== true)
      reasons.push("CANARY_QUOTE_NOT_FROM_ADAPTER");
  }
  if ((CANARY_LIVE_WIRING as boolean) !== true)
    reasons.push("CANARY_NOT_WIRED");
  const open = reasons.length === 0;
  return {
    state: open ? "OPEN" : "CLOSED",
    open,
    reasons,
    scope: CANARY_APPROVAL_BOUNDS.scope,
    pinSet: CANARY_PIN_SET_ID,
    policy: EXECUTION_POLICY.version,
    platformFeeBps: EXECUTION_POLICY.platformFeeBps,
  };
}
