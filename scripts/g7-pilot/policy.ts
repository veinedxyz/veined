// G7 controlled pilot — HUMAN-SIGNED execution scope approved by the owner: exactly ONE native 5 ONE transfer
// ONEchain 612055 -> BSC 56 (canonical CROSS) from and to the owner EOA, Otherbridge fee 0, through the owner's
// own injected wallet. No key material, no local signer, no raw-transaction broadcast, no message signature,
// no approval/permit, no deploy, no production execution gate change. The production app never imports this.
import { G5_ROUTE_PINS } from "../../src/g5/route-pins";
import {
  BRIDGE_TOKEN_SELECTOR,
  BRIDGE_TOKEN_SIGNATURE,
} from "../../src/g7/decoder";
import {
  CROSS,
  NATIVE,
  PILOT_EOA,
  TRUST_ACCEPTANCE_SENTENCE,
  TRUST_STATEMENT,
} from "../../src/g7/policy";

export { CROSS, NATIVE, PILOT_EOA, TRUST_ACCEPTANCE_SENTENCE, TRUST_STATEMENT };
export const PILOT_SCHEMA = "otherbridge.g7.pilot-intent.v1" as const;

// Fixed owner-approved fields. Any difference is not a "new quote", it is a different transaction: BLOCKED.
export const PILOT_SCOPE = {
  label:
    "G7 controlled pilot — one 5 ONE ONEchain -> BSC canonical CROSS transfer to the owner EOA",
  sourceChainId: 612055,
  sourceChainIdHex: "0x956d7",
  destinationChainId: 56,
  account: PILOT_EOA,
  accountDisplay: "0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c",
  recipient: PILOT_EOA,
  contract: G5_ROUTE_PINS.source.proxy,
  sourceToken: NATIVE,
  destinationToken: CROSS,
  principal: 5_000_000_000_000_000_000n,
  extraData: "0x",
  otherbridgeFee: 0n,
  selector: BRIDGE_TOKEN_SELECTOR,
  signature: BRIDGE_TOKEN_SIGNATURE,
} as const;

// Owner-reviewed upper bounds. Exceeding any of them => OWNER_REAPPROVAL_REQUIRED and no wallet request.
export const PILOT_BOUNDS = {
  maxMinimum: 5_000_000_000_000_000_000n,
  maxNetworkFee: 180_000_000_000_000_000n,
  maxServiceFee: 0n,
  maxWalletDebit: 5_180_759_310_000_000_000n,
} as const;

// The quote must be at most 20 s old at the instant the browser makes the wallet request. The server only arms a
// candidate while it is at most 17 s old, leaving 3 s for the arm round-trip and the browser-side checks.
export const QUOTE_MAX_AGE_AT_WALLET_MS = 20_000;
export const ARM_MAX_QUOTE_AGE_MS = 17_000;
export const SESSION_TTL_MS = 90 * 60_000;
export const DEFAULT_PORT = 3197;
export const HOST = "127.0.0.1" as const;

export const CONFIRMATION_PHRASE = "G7 5 ONE";
export const BUTTON_LABEL = "Request wallet confirmation for ONE transaction";
export const CONFIRMATION_CHECKS = {
  scope: "I verified the network, contract, recipient and the 5 ONE amount.",
  trust:
    "I accept the centralized trust model: single admin EOA + 2-of-3 validator EOAs.",
} as const;

// Test-only provider identity. In fixture mode the page refuses every other wallet, so fixture data can never
// reach a real wallet; in dry-run/real mode this identity is refused.
export const MOCK_WALLET_RDNS = "invalid.otherbridge.g7-mock";

export const MODES = ["real", "dry-run"] as const;
export type PilotMode = (typeof MODES)[number];

export const SESSION_STATES = [
  "PREFLIGHT_RUNNING",
  "READY",
  "BLOCKED",
  "OWNER_REAPPROVAL_REQUIRED",
  "FINAL_PREFLIGHT_RUNNING",
  "ARMABLE",
  "ARMED",
  "DRY_RUN_COMPLETE",
  "SENT",
  "USER_REJECTED",
  "MANUAL_REVIEW_REQUIRED",
  "ABORTED_BEFORE_WALLET_REQUEST",
  "G7_PASS",
  "LOCKED",
  "EXPIRED",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];
// States in which no send capability can ever exist again for this run (persisted by the lock file).
export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set([
  "OWNER_REAPPROVAL_REQUIRED",
  "ARMED",
  "SENT",
  "USER_REJECTED",
  "MANUAL_REVIEW_REQUIRED",
  "ABORTED_BEFORE_WALLET_REQUEST",
  "G7_PASS",
  "LOCKED",
  "EXPIRED",
]);
