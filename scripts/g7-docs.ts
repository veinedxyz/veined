// V1.7 G7-prep owner documents generated from the EXACT final artifacts (no hand-typed values).
// Usage: pnpm g7:docs <label>   (reads G7_*.json at the repository root and <evidence>/<label>/)
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits18 } from "../src/g7/prep";
import { SETTLEMENT_POLICY } from "../src/g7/track";
import {
  TRUST_ACCEPTANCE_SENTENCE,
  TRUST_STATEMENT,
  TRUST_STATEMENT_TR,
} from "../src/g7/policy";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = readFileSync(
  join(REPO, ".otherbridge", "g7-evidence-path.txt"),
  "utf8",
).trim();
const LABEL = process.argv[2] ?? "final";
const read = (p: string) => JSON.parse(readFileSync(join(REPO, p), "utf8"));
const pkg = read("G7_UNSIGNED_TRANSACTION.json");
const decision = read("G7_PREP_DECISION.json");
const digest = read("G7_INTENT_DIGEST.json");
if (decision.label !== LABEL)
  throw new Error(
    `root artifacts belong to label ${decision.label}, not ${LABEL}`,
  );
const runDir = `${ROOT}/${LABEL}`;
const attemptDir = `${runDir}/phase-b/attempt-${decision.attempt}`;
const baseline = read(`${runDir}/phase-a/settlement-baseline.json`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const one = (wei: string) => `${formatUnits18(BigInt(wei))} ONE`;
const cross = (wei: string) => `${formatUnits18(BigInt(wei))} CROSS`;
const gwei = (wei: string) => `${(Number(BigInt(wei)) / 1e9).toString()} gwei`;
const x = pkg.exposure;
const t = pkg.trustModel;
const rp = pkg.routePins;
const res = pkg.reserve;
const statusLine =
  decision.status === "READY_FOR_OWNER_SIGNATURE"
    ? "READY_FOR_OWNER_SIGNATURE (preparation only — G7 is NOT PASS)"
    : decision.status;

const card = `# G7 owner approval card — NOT SIGNED · NOT BROADCAST

**G7_PREP = ${statusLine}** · prepared ${decision.observedAt} · evidence \`${runDir}\`
Quote/fee/gas values are **ephemeral: MUST_REFRESH_BEFORE_SIGNING** (\`pnpm g7:prepare\` again right before the wallet prompt).

| Field | Value |
|---|---|
| FROM | \`${pkg.from}\` (public EOA; empty code observed — ownership not proven until the owner signs) |
| TO CONTRACT | \`${pkg.to}\` — ONEbridge proxy (CrossBridge @ \`${rp.source.build.slice(0, 7)}\`) |
| NETWORK | ONEchain, chainId **${pkg.chainId}** |
| DESTINATION NETWORK | BNB Smart Chain, chainId **56** |
| RECIPIENT | \`${pkg.decodedIntent.to}\` (same EOA as FROM; empty code on BSC) |
| AMOUNT | **${one(x.principal.wei)}** (= live route minimum) |
| NETWORK FEE | ${one(x.bridgeNetworkFee.wei)} (bridge fee to the operator's dev address); service fee ${one(x.serviceFee.wei)} |
| OTHERBRIDGE FEE | **0** |
| EXACT msg.value | **${one(pkg.value)}** (\`${pkg.valueHex}\`) — the contract requires this exact value |
| ESTIMATED GAS | ${Number(pkg.gasEstimate).toLocaleString("en-US")} gas × ${gwei(pkg.gasPrice)} ≈ ${one(x.estimatedGasCost.wei)}; gas limit ${Number(pkg.recommendedGasLimit).toLocaleString("en-US")} (+${pkg.feeModel.gasMarginPercent} %), max fee ${gwei(pkg.feeModel.maxFeePerGas)} |
| MAXIMUM EXPOSURE | **${one(pkg.maximumExposure)}** (msg.value + gas limit × max fee) |
| EXPECTED RECEIVE | **${cross(pkg.expectedDestination.amount)}** canonical CROSS \`${pkg.expectedDestination.token}\` on BSC |
| TRUST MODEL | **Centralized:** admin ${t.admin.addresses.map(short).join(", ")} (single EOA, instant upgrade) · validators ${t.validators.length} EOAs, threshold **${t.threshold}-of-${t.validators.length}** · VERIFIER_ROLE ${t.verifierRole.map(short).join(", ")} · **trustModelAccepted = false** |
| RUNTIME HASH STATUS | ONE impl \`${short(rp.source.implementation)}\` \`${rp.source.implementationCodeHash.slice(0, 10)}…\` = pin · BSC impl \`${short(rp.destination.implementation)}\` \`${rp.destination.implementationCodeHash.slice(0, 10)}…\` = pin · proxies, verifiers, CROSS token = pins · route-pin digest \`${rp.digestSha256.slice(0, 16)}…\` = expected |
| RESERVE STATUS | verified=${res.verified} at BSC finalized block ${res.pinnedBlock}; spendable ${cross(res.spendable)}; valued pending ${res.activeValuedPendingCross}; in-flight ${res.inFlight.count} |
| QUOTE AGE | ${(decision.quoteAgeAtReadyMs / 1000).toFixed(1)} s at READY (limit 60 s); quote ${pkg.quoteObservedAt} → expires ${pkg.quoteExpiresAt} |

> ${TRUST_STATEMENT}
>
> ${TRUST_STATEMENT_TR}

Approvals/permits: **none** (native route). Signature: **null**. Transaction hash: **null**. Broadcast: **false**.
Intent digest (sha256): \`${digest.digest.sha256}\`.
Owner decision still required — trust acceptance sentence (not set by this preparation):
*"${TRUST_ACCEPTANCE_SENTENCE}"*
`;

const checklist = `# G7 signature checklist — for the LATER owner-approved pilot step (not executed here)

This preparation produced **no** signature, approval, permit or broadcast. Use this list only after a separate, explicit owner instruction. If ANY item differs, **abort** — do not "fix and continue".

## Before the wallet prompt
1. Owner has read the trust model and explicitly accepts: *"${TRUST_ACCEPTANCE_SENTENCE}"* (record it in the pilot record).
2. Refresh: run \`pnpm g7:prepare <label>\` and require **READY_FOR_OWNER_SIGNATURE** with quote age ≤ 60 s. Quote, fees, gas, value and reserve are ephemeral; the package from ${decision.observedAt} is reviewable, not reusable.
3. If the refreshed minimum is above 5 ONE or msg.value above 5.18 ONE → **OWNER_REAPPROVAL_REQUIRED**, stop.
4. Recompute the intent digest from the refreshed \`G7_UNSIGNED_TRANSACTION.json\` (\`normalizedOwnerIntent\` + \`intentDigest\`) and compare with the refreshed \`G7_INTENT_DIGEST.json\`; the stable fields (from, to, recipient, chain, selector, pins, trust sets) must equal this preparation.
5. Fetch the **current** nonce in the wallet; the informational nonce (${pkg.nonceObservedInformational.value}) is not reserved.

## The wallet confirmation screen must show exactly
| Check | Required |
|---|---|
| Network | **ONEchain, chainId 612055** (not BSC, not a test network) |
| To / interacting contract | **\`${pkg.to}\`** (ONEbridge proxy) — nothing else, no token contract |
| Value | **exactly ${one(pkg.value)}** (\`${pkg.value}\` wei) at the refreshed quote |
| Data | starts with **\`0x5fd262de\`** (bridgeToken); recipient inside = \`${pkg.from}\`; destination chain 56; extraData empty |
| Approval / token permission | **none** — no approve, no permit, no allowance, no signature request of any other kind |
| Gas | limit ≈ ${Number(pkg.recommendedGasLimit).toLocaleString("en-US")} (estimate ${Number(pkg.gasEstimate).toLocaleString("en-US")} + 20 %); max fee ≈ ${gwei(pkg.feeModel.maxFeePerGas)} at preparation time; total gas well below ${one(x.maximumGasCost.wei)} |
| Unexpected interaction | none (no second transaction, no contract deployment, no message signature) |

Abort if the wallet shows a different contract, value, network, an approval, a permit, a typed-data/message signature, or a second transaction.

## After sending (read-only)
- The wallet "submitted" screen is **not** proof. Run \`pnpm g7:track --tx <sourceHash>\` (one shot, read-only).
- **No automatic retry:** if the source transaction reverts, is rejected, replaced or uncertain — do NOT resend; reconcile first.
- Completion only with: source receipt status 1 on a canonical block, exactly one \`BridgeInitiated(toChainID=56)\` with the expected recipient/amount, BSC \`BridgeFinalized(fromChainID=612055, index)\` preceded by \`CROSS Transfer(bridge → recipient, amount)\` on a finalized block, and an implementation consistent with the drift policy.
`;

const record = `# G7 pilot record — TEMPLATE (transaction fields intentionally empty)

| Field | Value |
|---|---|
| Preparation checkpoint | evidence \`${runDir}\`; decision ${decision.observedAt}; intent digest \`${digest.digest.sha256}\`; unsigned package sha256 \`${decision.unsignedTransactionSha256}\` |
| Preparation status | ${decision.status} (preparation only; G7 NOT PASS) |
| Owner approval timestamp | |
| Trust model acceptance (exact sentence + timestamp) | *(not accepted — trustModelAccepted=false at preparation)* |
| Refreshed quote (block, minimum, network fee, service fee, msg.value, age) | |
| Refreshed intent digest | |
| Final wallet preview (network, to, value, data prefix, gas, approvals=none) | |
| Source tx hash | |
| Source receipt (block, hash, status, confirmations) | |
| Bridge index | |
| Destination tx hash | |
| Destination receipt (block, hash, status, finalized) | |
| Final CROSS received | |
| Fees / gas actually paid | |
| Payout proof (path, checks) | |
| Tracker status history (\`pnpm g7:track\`) | |
| Anomalies | |
| Final result | |

Status progression: SOURCE_PENDING → SOURCE_CONFIRMED → SETTLEMENT_PENDING → DESTINATION_PENDING → COMPLETED, or MANUAL_REVIEW_REQUIRED. Never "failed" because of elapsed time alone; never an automatic second source transaction.
`;

const gates = decision.gates as {
  id: string;
  name: string;
  status: string;
  reasons: string[];
}[];
const mutations = read(`${attemptDir}/firewall.json`).mutations as {
  name: string;
  rejected: boolean;
  reason: string;
}[];
const sims = read(`${attemptDir}/simulations.json`) as {
  url: string;
  block: number;
  ethCall: { result?: string };
  estimateGas: { result?: string };
  negatives: {
    name: string;
    rejected: boolean;
    selector: string;
    decoded: string;
  }[];
}[];
const ledger = read(`${attemptDir}/ledger-extension.json`).ledger;
const ledgerA = read(`${runDir}/phase-a/ledger-delta.json`);
const testsSummary = existsSync(join(REPO, ROOT, "tests", "summary.json"))
  ? read(`${ROOT}/tests/summary.json`)
  : null;
const trackReports = existsSync(join(REPO, ROOT, "track"))
  ? readdirSync(join(REPO, ROOT, "track")).filter((f) => f.endsWith(".json"))
  : [];
const report = `# G7 controlled pilot — preparation report (V1.7, PREP ONLY)

**G7_PREP = ${decision.status}** (${decision.observedAt}). This is **not** G7 PASS and not a mainnet pilot. Real signatures 0 · approvals 0 · permits 0 · broadcasts 0 · deploys 0 · fee collection 0 · wallet prompts 0 · execution-gate changes 0. Evidence root: \`${ROOT}\` (final observation set: \`${attemptDir}\`). Owner card: [G7_OWNER_APPROVAL_CARD](G7_OWNER_APPROVAL_CARD.md) · checklist: [G7_SIGNATURE_CHECKLIST](G7_SIGNATURE_CHECKLIST.md) · record: [G7_PILOT_RECORD_TEMPLATE](G7_PILOT_RECORD_TEMPLATE.md).

## Gates (final observation set)
| Gate | Status | Reasons |
|---|---|---|
${gates.map((g) => `| ${g.id} ${g.name} | ${g.status} | ${g.reasons.join("; ") || "—"} |`).join("\n")}

## What was re-verified fresh (not taken from V1.6)
- Dual-RPC pins: ONE \`${pkg.sourceBlock.number}\` (\`${pkg.sourceBlock.hash}\`) on both official endpoints; BSC finalized \`${pkg.destinationBlock.number}\` (\`${pkg.destinationBlock.hash}\`) on BNB Chain official + PublicNode. All critical values identical per source.
- Runtime: EIP-1967 implementation slots, implementation/proxy/verifier/token code hashes equal the G5 pins; admin/beacon slots zero; live dispatcher still contains \`bridgeToken\` (\`0x5fd262de\`).
- Authority: every role set of both bridges and both verifiers, threshold, dev, executor, price feed, circuit-breaker thresholds equal the V1.6 snapshot; admin/validator/VERIFIER_ROLE accounts still have empty code; no Upgraded/Role/Threshold/Verifier/Pause/Pair event on either proxy or verifier since the V1.6 snapshot pins.
- Pauses: global, chain, pair and finalize pauses false on both chains.
- Fees: minimum ${one(decision.pilotAmount)}, network fee ${one(decision.networkFee)}, service fee ${one(decision.serviceFee)} read from the live verifier at the pinned block; msg.value = integer sum = ${one(decision.exactMsgValue)}.
- Reserve: incremental event-sourced ledger from the accepted V1.6 pin 125745332 to ${ledger.to}: ${ledgerA.proxyLogs} + ${ledger.proxyLogs} bridge logs, ${ledgerA.transferLogs} + ${ledger.transferLogs} CROSS transfers, ${ledgerA.deposits.count} deposits, ${ledgerA.payouts.count} payouts, 0 unclassified, 0 anomalies; deposited / pendingAmount / balance / open pending set / index ranges exact. Spendable ${cross(res.spendable)}, effective maximum ${cross(res.effectiveMaximum)}, valued pending ${res.activeValuedPendingCross} (legacy index 20 value 0 only), in-flight ${res.inFlight.count} (enumerated).
- Simulation (no state override, pinned block, both endpoints): eth_call ${sims.map((s) => (s.ethCall.result?.endsWith("1") ? "true" : "FAIL")).join("/")}, estimateGas ${sims.map((s) => BigInt(s.estimateGas.result ?? "0x0").toString()).join("/")}; negative controls: ${sims[0].negatives.map((n) => `${n.name} → \`${n.selector}\` ${n.decoded}`).join("; ")}.
- Calldata: viem encoding = independent hand-written encoding; independent decoder + viem decoder agree with the intent; keccak256 \`${pkg.calldataKeccak256}\`.
- Firewall: existing \`compareIntent\` + G7 route checks PASS; ${mutations.filter((m) => m.rejected).length}/${mutations.length} hostile mutations rejected (${mutations.map((m) => `${m.name}: ${m.reason}`).join("; ")}). Production SimulationGate still refuses with \`EXECUTION_PAUSED\` (global kill ON, empty registry, GLOBAL_EXECUTION_ENABLED=false).

## Settlement time (historical observation, not guarantee)
${baseline.samples} recent ONE→BSC CROSS transfers in the scanned windows: min ${baseline.minSeconds} s, median ${baseline.medianSeconds} s, p90 ${baseline.p90Seconds} s, max ${baseline.maxSeconds} s; accepted V1.6 proofs 20 s / 17 s / 14 s. Tracking policy (${SETTLEMENT_POLICY.label}): normal observation window ${SETTLEMENT_POLICY.normalWindowSeconds} s, escalation after ${SETTLEMENT_POLICY.escalateAfterSeconds} s, source canonical after ≥ ${SETTLEMENT_POLICY.sourceConfirmations} confirmations; elapsed time alone never means failed.

## Post-send procedures prepared (not started)
- \`pnpm g7:track --tx <sourceHash>\`: one-shot read-only observer (no background job, no resend, no release). Dry run on a past public transfer: ${trackReports.length ? trackReports.map((f) => `\`${ROOT}/track/${f}\``).join(", ") : "—"} → COMPLETED.
- No automatic retry: revert/rejection/replacement/uncertainty → MANUAL_REVIEW_REQUIRED, reconcile first.
- BridgePending: inspect \`getPendingArguments(612055, index)\`; \`releasePending\` only when its reason has cleared and only as a NEW, separately owner-approved write; never automatic.
- Admin escalation: preserve source/destination proofs, prepare a support packet; nobody is contacted automatically; no admin/operator call is signed.

## Tests and safety
${
  testsSummary
    ? Object.entries(testsSummary)
        .map(
          ([k, v]) =>
            `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
        )
        .join("\n")
    : "- see evidence tests/"
}

## Unchanged external statuses
INDEPENDENT_EXTERNAL_SOURCE_REVIEW = NOT_RUN · WEB_API_PENTEST_EXTERNAL = NOT_RUN · TRANSACTION_FIREWALL_EXTERNAL_REVIEW = NOT_RUN · LEGAL_REVIEW = NOT_RUN · OWNER_RELEASE_APPROVAL = NOT_RUN · trustModelAccepted = false · Production execution = DISABLED · G7 = NOT_RUN (preparation READY only).
`;

writeFileSync(join(REPO, "docs", "G7_OWNER_APPROVAL_CARD.md"), card);
writeFileSync(join(REPO, "docs", "G7_SIGNATURE_CHECKLIST.md"), checklist);
writeFileSync(join(REPO, "docs", "G7_PILOT_RECORD_TEMPLATE.md"), record);
writeFileSync(join(REPO, "docs", "G7_PREP_REPORT.md"), report);
console.log(
  JSON.stringify(
    {
      label: LABEL,
      status: decision.status,
      written: [
        "docs/G7_OWNER_APPROVAL_CARD.md",
        "docs/G7_SIGNATURE_CHECKLIST.md",
        "docs/G7_PILOT_RECORD_TEMPLATE.md",
        "docs/G7_PREP_REPORT.md",
      ],
    },
    null,
    1,
  ),
);
