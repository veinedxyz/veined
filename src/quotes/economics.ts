// G12 H03: read-only economics of a quote, for display only. Pure (no I/O, no clock, exact bigint arithmetic); it never
// changes, re-ranks, corrects or hides a quote's own numbers — it only says what they imply:
//   F2  an estimate that is HIGHER than what is sent, for the same reviewed asset on both sides: named as a surplus,
//       with the facts that were checked here (asset identity, decimals, whether the stated minimum is also above
//       the input). The cause (solver premium, subsidy, rebate, stale price) is not
//       knowable from a quote and is never guessed; a surplus above the plausibility bound is flagged IMPLAUSIBLE.
//   F3  costs that are out of proportion to the amount sent: the route is named economically unsuitable instead of
//       being shown like a normal route.
// Nothing here enables, prices or collects a VEINED fee: the platform fee stays disabled (0 bps, no recipient).

export const ECONOMICS_POLICY = Object.freeze({
  version: "qe1.2026-11",
  /** Costs at or above this share of the amount sent: economically unsuitable. */
  uneconomicCostBps: 1000,
  /** Costs at or above this share: most of the amount would be spent on costs. */
  severeCostBps: 5000,
  /** A surplus above this (whole basis points, floored: effectively above 1.01%) is not presented as plausible. */
  implausibleSurplusBps: 100,
});

export interface EconomicsInput {
  /** Both sides are the same reviewed asset (exact registry identity on each network, same symbol and decimals);
   * decided by the caller from registry evidence, never from a symbol alone. */
  sameAsset: boolean;
  amountIn: bigint;
  inDecimals: number;
  expectedOut: bigint;
  minimumOut: bigint;
  outDecimals: number;
  /** Value of the amount sent / the expected output in micro-dollars, when a price source reported it. */
  inputUsdMicros: bigint | null;
  outputUsdMicros: bigint | null;
  /** Every cost line of the quote; `usdMicros` null when the quote carries no USD value for it. */
  costs: readonly { usdMicros: bigint | null; included: boolean }[];
}
export type SurplusLevel = "NOTICE" | "IMPLAUSIBLE";
export type CostLevel = "OK" | "UNECONOMIC" | "SEVERE" | "UNKNOWN";
export interface Economics {
  policy: string;
  /** null: the estimate is not above what is sent (or it cannot be compared). */
  surplus: {
    basis: "SAME_ASSET";
    /** Estimate above the amount sent, in basis points of the amount sent (floor). */
    bps: number;
    /** The minimum the route states is also above the amount sent. */
    minimumAbove: boolean;
    level: SurplusLevel;
  } | null;
  cost: {
    /** Sum of the cost lines that carry a USD value. */
    knownUsdMicros: bigint;
    /** Some cost line has no USD value: the true total is at least `knownUsdMicros`. */
    complete: boolean;
    /** Known costs as a share of the amount sent (floor); null when the amount sent has no USD value. */
    shareBps: number | null;
    level: CostLevel;
  };
}

const pow10 = (n: number) => 10n ** BigInt(n);
const valid = (i: EconomicsInput) =>
  i.amountIn > 0n &&
  i.expectedOut >= 0n &&
  i.minimumOut >= 0n &&
  [i.inDecimals, i.outDecimals].every(
    (d) => Number.isInteger(d) && d >= 0 && d <= 36,
  ) &&
  (i.inputUsdMicros === null || i.inputUsdMicros >= 0n) &&
  (i.outputUsdMicros === null || i.outputUsdMicros >= 0n) &&
  i.costs.every((c) => c.usdMicros === null || c.usdMicros >= 0n);
/** Clamp a bigint ratio to a safe integer number of basis points. */
const bps = (part: bigint, whole: bigint) => {
  const v = (part * 10000n) / whole;
  return v > 100_000_000n ? 100_000_000 : Number(v);
};

export function quoteEconomics(i: EconomicsInput): Economics | null {
  if (!valid(i)) return null;
  let surplus: Economics["surplus"] = null;
  if (i.sameAsset) {
    // Same asset on both sides: compare token amounts exactly, on a common scale. Different assets are not compared:
    // two price feeds differ normally, and a sentence about "more than you send" would not be true of amounts.
    const sent = i.amountIn * pow10(i.outDecimals);
    const expected = i.expectedOut * pow10(i.inDecimals);
    const minimum = i.minimumOut * pow10(i.inDecimals);
    const over = expected > sent ? bps(expected - sent, sent) : 0;
    // Below one basis point there is nothing to say (it would read "0% more").
    if (over >= 1)
      surplus = {
        basis: "SAME_ASSET",
        bps: over,
        minimumAbove: minimum > sent,
        level:
          over > ECONOMICS_POLICY.implausibleSurplusBps
            ? "IMPLAUSIBLE"
            : "NOTICE",
      };
  }
  const knownUsdMicros = i.costs.reduce((n, c) => n + (c.usdMicros ?? 0n), 0n);
  const complete = i.costs.every((c) => c.usdMicros !== null);
  const shareBps =
    i.inputUsdMicros !== null && i.inputUsdMicros > 0n
      ? bps(knownUsdMicros, i.inputUsdMicros)
      : null;
  // The known part is a lower bound of the total: it can prove a route unsuitable, never prove it suitable.
  const level: CostLevel =
    shareBps === null
      ? "UNKNOWN"
      : shareBps >= ECONOMICS_POLICY.severeCostBps
        ? "SEVERE"
        : shareBps >= ECONOMICS_POLICY.uneconomicCostBps
          ? "UNECONOMIC"
          : complete
            ? "OK"
            : "UNKNOWN";
  return {
    policy: ECONOMICS_POLICY.version,
    surplus,
    cost: { knownUsdMicros, complete, shareBps, level },
  };
}

/** "12.345678" (a provider's decimal USD string) to micro-dollars, exactly; null when it is not a plain decimal. */
export function usdMicros(value: string | undefined | null): bigint | null {
  if (!value || !/^\d{1,30}(\.\d{1,18})?$/.test(value)) return null;
  const [a, b = ""] = value.split(".");
  return BigInt(a) * 1_000_000n + BigInt(b.padEnd(6, "0").slice(0, 6));
}

// ---- Platform fee readiness (CLOSED) --------------------------------------------------------------------------
// A versioned description of where a VEINED fee COULD be charged later, and only through the selected provider's own
// documented integrator-fee mechanism. Nothing reads these values to charge anything: `enabled` is the literal false,
// the rate is 0 and the recipient is the literal null (no address exists anywhere in this module). Activation needs a separate owner decision, partner terms and
// a protected-file change (src/routing/fee-policy.ts stays the authority and is not modified here).
export const PLATFORM_FEE_READINESS = Object.freeze({
  version: "pf0.2026-11",
  enabled: false as const,
  bps: 0 as const,
  recipient: null,
  /** Provider id → its official integrator-fee mechanism, as documented (evidence: G12_PROVIDER_MATRIX_TR.md). */
  mechanisms: Object.freeze({
    "routing-core":
      "`fee` + `integrator` of the routing provider's quote (fee wallet configured in its partner portal)",
    "near-intents":
      "`appFees[]` of the 1Click quote request (combined cap 500 bps; never sent by VEINED today)",
    uniswap:
      "`integratorFees[]` of the Trading API quote (max 500 bips; API key and attribution required)",
    jupiter:
      "`referralAccount` + `referralFee` of the order request (50-255 bps; the provider keeps a share)",
    titan: "`feeAccount` + `feeBps` of the quote request",
  }),
  /** Routers read directly on-chain (no provider integrator-fee mechanism): they can never carry a VEINED fee. */
  unsupported: Object.freeze(["pancakeswap", "aerodrome"]),
});
/** The VEINED fee on any quote today: always zero, by construction. */
export function platformFeeToday(): { enabled: false; bps: 0; amount: "0" } {
  return { enabled: false, bps: 0, amount: "0" };
}
