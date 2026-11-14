// Guardian verdicts: one entry point per subject, one aggregation rule, one digest. Browser-safe (the same code runs
// in the panels, in the Guardian console and behind /api/guardian, so a verdict can be re-derived anywhere).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonical } from "./support";
import {
  GUARDIAN_POLICY,
  SEVERITY_RANK,
  finding,
  levelOf,
  type Finding,
  type AssetFacts,
  type GuardianFacts,
  type SafeStep,
  type SubjectKind,
  type Verdict,
} from "./model";
import {
  addressRules,
  assetRules,
  bridgeRules,
  portfolioRules,
  swapRules,
} from "./rules";
import { reviewNearTransaction, type NearTransaction } from "./near";
import { intentsRules, type IntentsRouteFacts } from "./intents";

const STEP_ORDER: readonly SafeStep[] = [
  "STOP",
  "DO_NOT_INTERACT",
  "PICK_CURATED",
  "CHECK_RECIPIENT",
  "PREFER_NATIVE",
  "LIMITED_KEY",
  "EXACT_APPROVAL",
  "REQUOTE",
  "REDUCE_AMOUNT",
  "LARGER_AMOUNT",
  "TEST_TRANSFER",
];
function dedupe(findings: Finding[]) {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.code}|${canonical(f.params)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function digestOf(
  subject: SubjectKind,
  facts: unknown,
  findings: readonly Finding[],
) {
  return bytesToHex(
    sha256(
      utf8ToBytes(
        canonical({
          policy: GUARDIAN_POLICY.version,
          subject,
          facts,
          findings,
        }),
      ),
    ),
  );
}
export function verdictOf(
  subject: SubjectKind,
  facts: unknown,
  raw: Finding[],
  rawSteps: readonly SafeStep[],
  checks: number,
): Verdict {
  const findings = dedupe(raw).sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.severity === "PASS" ? 1 : 0) - (b.severity === "PASS" ? 1 : 0),
  );
  const level = levelOf(findings);
  // A blocked action has one safe step that matters first: do not sign it.
  const steps = STEP_ORDER.filter(
    (s) => rawSteps.includes(s) || (s === "STOP" && level === "BLOCK"),
  );
  return {
    policy: GUARDIAN_POLICY.version,
    subject,
    level,
    findings,
    steps,
    checks,
    digest: digestOf(subject, facts, findings),
  };
}

/** Review VEINED facts (Swap, Bridge, Portfolio, pasted address). `now` only decides freshness. `extra`/`extraSteps`:
 * evidence gathered outside the pure rules (the server's on-chain account check, a chat draft's amount policy). */
export function review(
  facts: GuardianFacts,
  now = Date.now(),
  extra: readonly Finding[] = [],
  extraSteps: readonly SafeStep[] = [],
): Verdict {
  const r =
    facts.kind === "swap"
      ? swapRules(facts, now)
      : facts.kind === "bridge"
        ? bridgeRules(facts)
        : facts.kind === "portfolio"
          ? portfolioRules(facts)
          : addressRules(facts);
  const findings = [...r.findings, ...extra];
  // Swap and Bridge: VEINED's execution boundary is part of the review (nothing is signed from this build).
  if (facts.kind === "swap" || facts.kind === "bridge")
    findings.push(finding("EXECUTION_CLOSED", "INFO", "EXECUTION", {}));
  return verdictOf(
    facts.kind,
    facts,
    findings,
    withOnchainSteps([...r.steps, ...extraSteps], extra),
    r.checks + extra.length,
  );
}
/** One exact asset on its own ("is this token safe?"): the stricter receive-side evidence rules. */
export function reviewAsset(facts: AssetFacts): Verdict {
  const r = assetRules(facts, "receive");
  return verdictOf("asset", facts, r.findings, r.steps, r.checks);
}
/** `extra`: evidence gathered outside the pure rules (the server's on-chain account check). */
export function reviewNear(
  tx: NearTransaction,
  known: readonly string[] = [],
  extra: readonly Finding[] = [],
): Verdict {
  const r = reviewNearTransaction(tx, known);
  return verdictOf(
    "near-transaction",
    tx,
    [...r.findings, ...extra],
    withOnchainSteps(r.steps, extra),
    r.checks + extra.length,
  );
}
export function reviewIntents(
  facts: IntentsRouteFacts,
  now = Date.now(),
  extra: readonly Finding[] = [],
  extraSteps: readonly SafeStep[] = [],
): Verdict {
  const r = intentsRules(facts, now);
  return verdictOf(
    "intents-route",
    facts,
    [...r.findings, ...extra],
    withOnchainSteps([...r.steps, ...extraSteps], extra),
    r.checks + extra.length,
  );
}
export function withOnchainSteps(
  steps: readonly SafeStep[],
  extra: readonly Finding[],
): SafeStep[] {
  const out = new Set(steps);
  if (extra.some((f) => f.code === "NEAR_ACCOUNT_MISSING"))
    out.add("STOP").add("CHECK_RECIPIENT");
  if (extra.some((f) => f.code === "NEAR_ACCOUNT_UNFUNDED"))
    out.add("TEST_TRANSFER");
  return [...out];
}
