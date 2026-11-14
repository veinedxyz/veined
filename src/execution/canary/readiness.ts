// G14 Track A + G14 closure: the canary release matrix (browser-safe, static). One row per control the owner required
// before any financial gate may open. Every control's code is implemented, tested AND wired to the server (the one
// runtime, src/execution/server/canary/runtime.ts, behind /api/execution and the review panel): `wired: true`. What is
// NOT the case: `active` — activation is DISABLED by the protected constants (no owner-approved canary record,
// CANARY_LIVE_WIRING false), so every step that could lead to a signature is refused with 403 WRITE_DISABLED and no
// step control is rendered. `liveNeeds` names what only the OWNER can still do (a record, the activation change and
// its G7 application, keeping the audit head, the manual wallet acceptance, re-confirming pins / operators); none of
// it is an engineering gap of this build. Nothing here opens anything.
import { OWNER_CANARY_APPROVAL } from "../../security/canary-approval";

export interface CanaryControl {
  id: string;
  state: "IMPLEMENTED_WIRED_DISABLED" | "OWNER_STEP";
  liveNeeds: readonly string[];
}
const ACT = "OWNER_ACTIVATION_AND_G7_APPLICATION";
const REC = "OWNER_RECORD";
const PIN = "PIN_AND_OPERATOR_RECONFIRMATION";
export const CANARY_CONTROLS: readonly CanaryControl[] = Object.freeze([
  {
    id: "SERVER_SINGLE_USE_AUTHORIZATION",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [REC, ACT],
  },
  {
    id: "GLOBAL_NONCE_REPLAY_PREVENTION",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "SINGLE_USE_CANARY_JOURNAL",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "EXTERNALLY_ANCHORED_AUDIT",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT, "OWNER_KEEPS_ANCHOR_HEAD"],
  },
  {
    id: "SERVER_AUTHENTICATED_PREFLIGHT_GUARDIAN",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  { id: "TRACKING_V1_V2", state: "IMPLEMENTED_WIRED_DISABLED", liveNeeds: [] },
  {
    id: "FRESH_EXECUTABLE_QUOTE",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "INDEPENDENT_CALLDATA_DECODING",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "PROVIDER_CONTRACT_FACET_PINNING",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [PIN],
  },
  {
    id: "EXACT_SPENDER_ALLOWANCE",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "NATIVE_GAS_BALANCE",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [REC, ACT],
  },
  {
    id: "DUAL_RPC_AGREEMENT",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [PIN],
  },
  {
    id: "REAL_TRANSACTION_SIMULATION",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "RECIPIENT_MINIMUM_OUTPUT",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [REC],
  },
  {
    id: "WALLET_ACCOUNT_CHAIN_BINDING",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: ["OWNER_RABBY_ACCEPTANCE"],
  },
  {
    id: "FAILURE_REPLACEMENT_REORG_TRACKING",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "DESTINATION_SETTLEMENT_REFUND",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "FINAL_BALANCE_RECONCILIATION",
    state: "IMPLEMENTED_WIRED_DISABLED",
    liveNeeds: [ACT],
  },
  {
    id: "OWNER_APPROVED_CANARY_RECORD",
    state: "OWNER_STEP",
    liveNeeds: [REC, "OWNER_GOAL"],
  },
]);
export function canaryReadiness() {
  const implemented = CANARY_CONTROLS.filter(
    (c) => c.state === "IMPLEMENTED_WIRED_DISABLED",
  ).length;
  const liveNeeds = [
    ...new Set(CANARY_CONTROLS.flatMap((c) => c.liveNeeds)),
  ].sort();
  return {
    total: CANARY_CONTROLS.length,
    implemented,
    /** The code is connected to the server's API and the review panel. */
    wired: true as const,
    /** Nothing is active: the protected record and wiring constant keep every signing step refused. */
    active: false as const,
    implementation: "PRESENT" as const,
    activation: "DISABLED" as const,
    ownerRecord:
      OWNER_CANARY_APPROVAL === null
        ? ("ABSENT" as const)
        : ("PRESENT" as const),
    liveNeeds,
    controls: CANARY_CONTROLS,
  };
}
