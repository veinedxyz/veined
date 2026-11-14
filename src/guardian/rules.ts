// Guardian rules for VEINED's own surfaces (Swap, Bridge, Portfolio) and for any pasted address. Pure functions over
// facts VEINED has already validated (registry evidence levels, quote schemas, decoded approvals). Guardian never
// treats a symbol as identity: every asset is chain + exact contract, and symbols only appear as display text.
import {
  displayText,
  validIdentity,
  type AssetLevel,
  type RiskFlag,
} from "./support";
import { reviewNearAccount, nearAccountKind } from "./near";
import {
  GUARDIAN_POLICY,
  finding,
  type AddressFacts,
  type AssetFacts,
  type BridgeFacts,
  type Finding,
  type PortfolioFacts,
  type SafeStep,
  type SwapFacts,
} from "./model";

export interface RuleResult {
  findings: Finding[];
  steps: SafeStep[];
  checks: number;
}
const sym = (s: string) => displayText(s, 16) || "?";
const lower = (a: string) =>
  /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : a;
const shortAddr = (a: string) =>
  a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

const TEXT_LURES: readonly RiskFlag[] = [
  "URL_IN_TEXT",
  "BIDI_OR_INVISIBLE",
  "MIXED_SCRIPT",
  "LONG_TEXT",
];
const TRUSTED: readonly AssetLevel[] = ["CANONICAL", "CURATED"];

/** Asset evidence. `receive` is stricter than `pay`: buying an impersonation loses the whole amount. */
export function assetRules(a: AssetFacts, role: "pay" | "receive"): RuleResult {
  const findings: Finding[] = [],
    steps = new Set<SafeStep>();
  const p = { symbol: sym(a.symbol), role };
  const risk = a.risk ?? [];
  if (a.native || (a.level && TRUSTED.includes(a.level) && risk.length === 0)) {
    findings.push(
      finding("ASSET_EVIDENCE", "PASS", "ASSET", {
        ...p,
        level: a.native ? "CANONICAL" : a.level!,
      }),
    );
    return { findings, steps: [], checks: 3 };
  }
  if (a.level === "BLOCKED" || risk.includes("SPAM_LISTED")) {
    findings.push(finding("ASSET_BLOCKED", "CRITICAL", "ASSET", p));
    steps.add("STOP").add("DO_NOT_INTERACT");
  }
  if (risk.includes("SYMBOL_IMPERSONATION")) {
    findings.push(
      finding(
        "ASSET_IMPERSONATION",
        role === "receive" ? "CRITICAL" : "WARNING",
        "ASSET",
        p,
      ),
    );
    steps
      .add(role === "receive" ? "STOP" : "DO_NOT_INTERACT")
      .add("PICK_CURATED");
  }
  if (risk.includes("NO_CODE")) {
    findings.push(finding("ASSET_NO_CODE", "CRITICAL", "ASSET", p));
    steps.add("STOP");
  }
  if (TEXT_LURES.some((f) => risk.includes(f))) {
    findings.push(finding("ASSET_TEXT_LURE", "WARNING", "ASSET", p));
    steps.add("DO_NOT_INTERACT");
  }
  // Missing evidence is not clean evidence: an asset the registry has no level for is unverified (fail closed).
  if (
    a.level === undefined ||
    a.level === "IMPORTED_UNVERIFIED" ||
    a.level === "DEX_DISCOVERED" ||
    risk.includes("METADATA_MISMATCH")
  ) {
    findings.push(finding("ASSET_UNVERIFIED", "CAUTION", "ASSET", p));
    steps.add("PICK_CURATED");
  }
  if (risk.includes("NO_MARKET_EVIDENCE") || risk.includes("LOW_LIQUIDITY")) {
    findings.push(finding("ASSET_THIN_MARKET", "CAUTION", "ASSET", p));
    steps.add("REDUCE_AMOUNT");
  }
  if (a.level === "MARKET_LISTED" && !findings.length)
    findings.push(
      finding("ASSET_EVIDENCE", "PASS", "ASSET", { ...p, level: a.level }),
    );
  return { findings, steps: [...steps], checks: 6 };
}

const BURN =
  /^0x0{40}$|^0x0{36}dead$|^0x000000000000000000000000000000000000dead$/i;
/** Recipient rules: who actually receives, and whether that address only resembles one the user knows. */
export function recipientRules(
  sender: string,
  recipient: string,
  known: readonly string[] = [],
  tokens: readonly string[] = [],
): RuleResult {
  const findings: Finding[] = [],
    steps = new Set<SafeStep>();
  const r = lower(recipient),
    mine = [sender, ...known].filter(Boolean).map(lower);
  if (!r) return { findings, steps: [], checks: 0 };
  if (BURN.test(r)) {
    findings.push(
      finding("RECIPIENT_BURN", "CRITICAL", "RECIPIENT", {
        address: shortAddr(r),
      }),
    );
    steps.add("STOP");
  } else if (tokens.map(lower).includes(r)) {
    findings.push(
      finding("RECIPIENT_TOKEN_CONTRACT", "CRITICAL", "RECIPIENT", {
        address: shortAddr(r),
      }),
    );
    steps.add("STOP").add("CHECK_RECIPIENT");
  } else if (mine.includes(r)) {
    findings.push(
      finding("RECIPIENT_SELF", "PASS", "RECIPIENT", { address: shortAddr(r) }),
    );
  } else {
    // Address poisoning: a fresh address generated to share the first and last characters of one the user knows,
    // planted in history so it gets copied by mistake.
    const twin = mine.find(
      (m) =>
        m.length === r.length &&
        m.slice(0, 6) === r.slice(0, 6) &&
        m.slice(-4) === r.slice(-4),
    );
    if (twin) {
      findings.push(
        finding("RECIPIENT_POISONED", "CRITICAL", "RECIPIENT", {
          address: shortAddr(r),
          twin: shortAddr(twin),
        }),
      );
      steps.add("STOP").add("CHECK_RECIPIENT");
    } else {
      findings.push(
        finding("RECIPIENT_EXTERNAL", "CAUTION", "RECIPIENT", {
          address: shortAddr(r),
        }),
      );
      steps.add("CHECK_RECIPIENT").add("TEST_TRANSFER");
    }
  }
  return { findings, steps: [...steps], checks: 4 };
}

const bps = (n: number) => `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
function ladder(value: number, [c, w, x]: readonly [number, number, number]) {
  return value >= x
    ? "CRITICAL"
    : value >= w
      ? "WARNING"
      : value >= c
        ? "CAUTION"
        : null;
}
/** Loss between priced input and priced output (basis points), when both come from the same source. */
export function valueLossBps(
  inUsd: number | null | undefined,
  outUsd: number | null | undefined,
) {
  if (!inUsd || outUsd === null || outUsd === undefined || inUsd <= 0)
    return null;
  return Math.round(((inUsd - outUsd) / inUsd) * 10000);
}
/**
 * G13: the route's own fees as a share of the value sent (nearest basis point: a floor of a floating ratio would print
 * 8.59% beside the same 8.60% impact), from the route source's own figures
 * only: the input value it priced, or — as the H03 cost note derives it — output / (1 - impact) for a reported loss.
 * Null whenever a figure is missing, non-finite or negative (never guessed).
 */
export function routeCostShareBps(r: {
  priceImpact: number | null;
  inputUsd?: number | null;
  outputUsd?: number | null;
  costUsd?: number | null;
}): number | null {
  const cost = r.costUsd;
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0)
    return null;
  let input: number | null = null;
  if (r.inputUsd && Number.isFinite(r.inputUsd) && r.inputUsd > 0)
    input = r.inputUsd;
  else if (
    r.outputUsd !== null &&
    r.outputUsd !== undefined &&
    Number.isFinite(r.outputUsd) &&
    r.outputUsd > 0 &&
    r.priceImpact !== null &&
    Number.isFinite(r.priceImpact) &&
    r.priceImpact > 0 &&
    r.priceImpact < 1
  )
    input = r.outputUsd / (1 - r.priceImpact);
  if (input === null || !(input > 0)) return null;
  const share = Math.round((cost / input) * 10000);
  return Number.isSafeInteger(share) ? share : null;
}

/** An asset whose chain is not the chain of the action is not the asset being moved (identity is chain + contract). */
function chainRule(
  a: AssetFacts | undefined,
  chain: string,
  findings: Finding[],
  steps: Set<SafeStep>,
) {
  if (!a || a.chainId === chain) return;
  findings.push(
    finding("ASSET_CHAIN_MISMATCH", "CRITICAL", "ASSET", {
      symbol: sym(a.symbol),
    }),
  );
  steps.add("STOP");
}

export function swapRules(f: SwapFacts, now: number): RuleResult {
  const findings: Finding[] = [],
    steps = new Set<SafeStep>();
  let checks = 2;
  const add = (r: RuleResult) => {
    findings.push(...r.findings);
    r.steps.forEach((s) => steps.add(s));
    checks += r.checks;
  };
  add(assetRules(f.pay, "pay"));
  if (f.receive) add(assetRules(f.receive, "receive"));
  chainRule(f.pay, f.chainId, findings, steps);
  chainRule(f.receive, f.chainId, findings, steps);
  if (f.recipient && !validIdentity(f.recipient, f.ecosystem)) {
    findings.push(
      finding("RECIPIENT_INVALID", "CRITICAL", "RECIPIENT", {
        address: displayText(shortAddr(f.recipient), 24),
      }),
    );
    steps.add("STOP").add("CHECK_RECIPIENT");
  } else if (f.recipient)
    add(
      recipientRules(
        f.sender,
        f.recipient,
        f.known,
        [f.pay, f.receive].flatMap((a) => (a && !a.native ? [a.address] : [])),
      ),
    );
  const q = f.quote;
  if (q) {
    checks += 6;
    if (q.platformFee !== undefined && q.platformFee !== "0") {
      findings.push(finding("FEE_POLICY_VIOLATION", "CRITICAL", "ROUTE", {}));
      steps.add("STOP");
    }
    if (q.priceImpactBps === null)
      findings.push(finding("ROUTE_IMPACT_UNKNOWN", "CAUTION", "ROUTE", {}));
    else {
      const s = ladder(Math.abs(q.priceImpactBps), GUARDIAN_POLICY.impactBps);
      if (s) {
        findings.push(
          finding("ROUTE_IMPACT", s, "ROUTE", {
            impact: bps(Math.abs(q.priceImpactBps)),
          }),
        );
        steps.add("REDUCE_AMOUNT");
      }
    }
    const loss =
      q.inputUsdMicros && q.outputUsdMicros
        ? valueLossBps(
            Number(q.inputUsdMicros) / 1e6,
            Number(q.outputUsdMicros) / 1e6,
          )
        : null;
    const ls =
      loss === null ? null : ladder(loss, GUARDIAN_POLICY.valueLossBps);
    if (ls && loss !== null) {
      findings.push(
        finding("ROUTE_VALUE_LOSS", ls, "ROUTE", { loss: bps(loss) }),
      );
      steps.add("REDUCE_AMOUNT");
    }
    if (q.slippageBps >= GUARDIAN_POLICY.slippageBps[0])
      findings.push(
        finding(
          "ROUTE_SLIPPAGE",
          q.slippageBps >= GUARDIAN_POLICY.slippageBps[1]
            ? "WARNING"
            : "CAUTION",
          "ROUTE",
          {
            slippage: bps(q.slippageBps),
          },
        ),
      );
    if (
      q.hops >= GUARDIAN_POLICY.complexHops ||
      q.splitCount >= GUARDIAN_POLICY.complexHops
    )
      findings.push(
        finding("ROUTE_COMPLEX", "INFO", "ROUTE", {
          hops: q.hops,
          splits: q.splitCount,
        }),
      );
    if (q.expiresAt <= now) {
      findings.push(finding("ROUTE_STALE", "WARNING", "ROUTE", {}));
      steps.add("REQUOTE");
    }
    const others = (f.alternatives ?? [])
      .map((v) => BigInt(v))
      .filter((v) => v > 0n);
    if (!others.length)
      findings.push(
        finding("ROUTE_SINGLE_SOURCE", "INFO", "ROUTE", {
          provider: displayText(q.provider, 24),
        }),
      );
    else {
      const sorted = [...others].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const median = sorted[Math.floor(sorted.length / 2)];
      const out = BigInt(q.amountOut);
      const above =
        median > 0n ? Number(((out - median) * 10000n) / median) : 0;
      if (above >= GUARDIAN_POLICY.outlierBps)
        findings.push(
          finding("ROUTE_OUTLIER", "CAUTION", "ROUTE", {
            above: bps(above),
            count: others.length + 1,
          }),
        );
      else
        findings.push(
          finding("ROUTE_CROSS_CHECKED", "PASS", "ROUTE", {
            count: others.length + 1,
          }),
        );
    }
  }
  if (f.approval) {
    checks += 2;
    const amount = /^\d{1,78}$/.test(f.approval.amount)
      ? BigInt(f.approval.amount)
      : null;
    if (f.approval.kind === "PERMIT2")
      findings.push(finding("APPROVAL_PERMIT2", "INFO", "APPROVAL", {}));
    if (amount !== null && amount >= 2n ** 255n) {
      findings.push(
        finding("APPROVAL_UNLIMITED", "WARNING", "APPROVAL", {
          spender: f.approval.spender ? shortAddr(f.approval.spender) : "—",
          symbol: sym(f.pay.symbol),
        }),
      );
      steps.add("EXACT_APPROVAL");
    } else if (amount !== null && amount > 0n)
      findings.push(
        finding("APPROVAL_EXACT", "PASS", "APPROVAL", {
          symbol: sym(f.pay.symbol),
        }),
      );
  }
  return { findings, steps: [...steps], checks };
}

export function bridgeRules(f: BridgeFacts): RuleResult {
  const findings: Finding[] = [],
    steps = new Set<SafeStep>();
  let checks = 0;
  const add = (r: RuleResult) => {
    findings.push(...r.findings);
    r.steps.forEach((s) => steps.add(s));
    checks += r.checks;
  };
  add(assetRules(f.pay, "pay"));
  if (f.receive) add(assetRules(f.receive, "receive"));
  chainRule(f.pay, f.sourceChain, findings, steps);
  chainRule(f.receive, f.destinationChain, findings, steps);
  // The moved assets' own contracts are never a recipient: funds sent to a token contract are stuck there.
  if (f.recipient)
    add(
      recipientRules(
        f.sender,
        f.recipient,
        f.known,
        [f.pay, f.receive].flatMap((a) => (a && !a.native ? [a.address] : [])),
      ),
    );
  const r = f.route;
  if (r) {
    checks += 6;
    if (!r.valid) {
      findings.push(finding("ROUTE_STALE", "WARNING", "ROUTE", {}));
      steps.add("REQUOTE");
    }
    if (r.priceImpact === null)
      findings.push(finding("ROUTE_IMPACT_UNKNOWN", "CAUTION", "ROUTE", {}));
    else {
      const impact = Math.round(Math.abs(r.priceImpact) * 10000);
      const s = ladder(impact, GUARDIAN_POLICY.impactBps);
      // G13 (VBA-P1-02): a bridge's reported impact is the USD difference between what is sent and what arrives, so
      // it contains the route's own fees. When those fees make up at least half of it, the amount is small for this
      // route and "send less" would make it worse: the severity stays exactly the same, but the finding names the fee
      // share and the safe step is a larger amount or another route. Unknown fees keep the accepted finding.
      const share = s ? routeCostShareBps(r) : null;
      if (s && share !== null && share * 2 >= impact) {
        findings.push(
          // The real share is shown (review fix): fees can exceed the reported difference when the source priced
          // the output above the input; capping it would contradict the cost note on the same screen.
          finding("ROUTE_COST_SHARE", s, "ROUTE", {
            impact: bps(impact),
            share: bps(share),
          }),
        );
        steps.add("LARGER_AMOUNT");
      } else if (s) {
        findings.push(
          finding("ROUTE_IMPACT", s, "ROUTE", { impact: bps(impact) }),
        );
        steps.add("REDUCE_AMOUNT");
      }
    }
    const loss = valueLossBps(r.inputUsd, r.outputUsd);
    const ls =
      loss === null ? null : ladder(loss, GUARDIAN_POLICY.valueLossBps);
    if (ls && loss !== null) {
      findings.push(
        finding("ROUTE_VALUE_LOSS", ls, "ROUTE", { loss: bps(loss) }),
      );
      // Never both "send less" and "send more": a loss already explained by the route's fees keeps that advice.
      if (!steps.has("LARGER_AMOUNT")) steps.add("REDUCE_AMOUNT");
    }
    if (r.steps.some((s) => s.destinationSignature))
      findings.push(
        finding("BRIDGE_DESTINATION_SIGNATURE", "CAUTION", "EXECUTION", {}),
      );
    // Raw upstream tool identifiers never reach the screen (VEINED's public-label boundary): the step is named by
    // its position in the route.
    const unbound = r.steps.findIndex(
      (s) => !s.catalogBound && s.tool !== "feeCollection",
    );
    if (unbound >= 0) {
      findings.push(
        finding("BRIDGE_UNBOUND_TOOL", "WARNING", "ROUTE", {
          tool: `#${unbound + 1}`,
        }),
      );
      steps.add("REQUOTE");
    }
    if (r.durationSeconds >= GUARDIAN_POLICY.slowBridgeSeconds)
      findings.push(
        finding("BRIDGE_SLOW", "INFO", "ROUTE", {
          minutes: Math.round(r.durationSeconds / 60),
        }),
      );
    if (r.warnings > 0)
      findings.push(
        finding("BRIDGE_PROVIDER_NOTE", "CAUTION", "ROUTE", {
          count: r.warnings,
        }),
      );
    if (r.steps.length >= GUARDIAN_POLICY.complexHops)
      findings.push(
        finding("ROUTE_COMPLEX", "INFO", "ROUTE", {
          hops: r.steps.length,
          splits: 1,
        }),
      );
  }
  return { findings, steps: [...steps], checks };
}

/** Portfolio sweep: what in this wallet should never be touched, and which holdings pretend to be others. */
export function portfolioRules(f: PortfolioFacts): RuleResult {
  const findings: Finding[] = [],
    steps = new Set<SafeStep>();
  const visible = f.holdings.filter((h) => !h.spam);
  const spam = f.holdings.length - visible.length;
  const suspicious = visible.filter((h) => h.suspicious);
  if (suspicious.length) {
    findings.push(
      finding("HOLDINGS_SUSPICIOUS", "WARNING", "PORTFOLIO", {
        count: suspicious.length,
        symbols: [...new Set(suspicious.map((h) => sym(h.symbol)))]
          .slice(0, 3)
          .join(", "),
      }),
    );
    steps.add("DO_NOT_INTERACT");
  }
  // Same symbol on the same network from different contracts: at most one of them is the asset its name suggests.
  const groups = new Map<string, Set<string>>();
  for (const h of visible) {
    const key = `${h.chainId}|${sym(h.symbol).toUpperCase()}`;
    groups.set(key, (groups.get(key) ?? new Set()).add(lower(h.address)));
  }
  const twins = [...groups.entries()].filter(([, set]) => set.size > 1);
  if (twins.length) {
    findings.push(
      finding("HOLDINGS_SAME_SYMBOL", "WARNING", "PORTFOLIO", {
        count: twins.length,
        symbols: twins
          .map(([k]) => k.split("|")[1])
          .slice(0, 3)
          .join(", "),
      }),
    );
    steps.add("PICK_CURATED");
  }
  const unverified = visible.filter(
    (h) =>
      !h.suspicious && (h.metadataVerified === false || h.routable === false),
  );
  if (unverified.length)
    findings.push(
      finding("HOLDINGS_UNVERIFIED", "CAUTION", "PORTFOLIO", {
        count: unverified.length,
      }),
    );
  if (spam)
    findings.push(
      finding("HOLDINGS_SPAM_HIDDEN", "INFO", "PORTFOLIO", { count: spam }),
    );
  if (!suspicious.length && !twins.length && !unverified.length)
    findings.push(
      finding("HOLDINGS_CLEAN", "PASS", "PORTFOLIO", { count: visible.length }),
    );
  return { findings, steps: [...steps], checks: 4 };
}

/** Any pasted address: EVM, Solana or NEAR account. */
export function addressRules(f: AddressFacts): RuleResult {
  const v = f.value.trim();
  if (
    validIdentity(v, "EVM") ||
    (!nearAccountKind(v) && validIdentity(v, "SVM"))
  ) {
    const r = recipientRules("", v, f.known);
    return { ...r, checks: r.checks + 1 };
  }
  const findings = reviewNearAccount(v, { known: f.known, role: "recipient" });
  const steps = new Set<SafeStep>();
  if (
    findings.some(
      (x) =>
        x.code === "NEAR_ACCOUNT_LOOKALIKE" ||
        x.code === "NEAR_ACCOUNT_INVALID",
    )
  )
    steps.add("STOP").add("CHECK_RECIPIENT");
  if (findings.some((x) => x.code === "NEAR_TOKEN_BRIDGED_VARIANT"))
    steps.add("PREFER_NATIVE");
  if (findings.some((x) => x.code === "NEAR_ACCOUNT_IMPLICIT"))
    steps.add("TEST_TRANSFER");
  return { findings, steps: [...steps], checks: 5 };
}
