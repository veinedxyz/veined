// G14 Track A: two-source agreement and the native-gas / balance checks of the canary (pure). A value counts only
// when TWO INDEPENDENT RPC operators returned it for the SAME block (number and hash); one source, a missing value or
// different blocks conclude nothing (UNKNOWN), a disagreement is a FAIL. The second Base source and any Arbitrum
// source are not configured in the candidate (protected src/swap/server/config.ts, proposal B4), so the live review
// reads SINGLE -> UNKNOWN today.
import { EXECUTION_POLICY } from "../model";
import type { CanaryCheck } from "./quote-verify";

export interface SourceRead {
  /** Origin of the RPC (scheme + host), e.g. https://base-rpc.publicnode.com. */
  origin: string;
  chainId: string | null;
  /** The block the values were read at; `timestamp` (seconds) bounds how old a review may be. */
  block: { number: string; hash: string; timestamp?: number } | null;
  values: Record<string, string | null>;
}
export type Agreement = "AGREE" | "DISAGREE" | "SINGLE" | "UNKNOWN";
/** https origin (default port and path dropped), or null. */
export function normalizeOrigin(x: unknown): string | null {
  if (typeof x !== "string") return null;
  try {
    const u = new URL(x);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.origin.toLowerCase()
      : null;
  } catch {
    return null;
  }
}
/** The operator behind an origin: its registrable domain (last two host labels), review round 1 F6. */
export function operatorOf(x: unknown): string | null {
  const o = normalizeOrigin(x);
  if (!o) return null;
  // A trailing-dot FQDN is the same host (round-2 review N5).
  const labels = new URL(o).hostname.replace(/\.+$/, "").split(".");
  return labels.length < 2 ? null : labels.slice(-2).join(".");
}
export function agree(
  a: SourceRead | null,
  b: SourceRead | null,
  keys: readonly string[],
  expectedChainId: string,
): {
  status: Agreement;
  values: Record<string, string> | null;
  disagree: string[];
} {
  if (!a || !b)
    return {
      status: a || b ? "SINGLE" : "UNKNOWN",
      values: null,
      disagree: [],
    };
  const oa = operatorOf(a.origin),
    ob = operatorOf(b.origin);
  if (!oa || !ob)
    return { status: "UNKNOWN", values: null, disagree: ["origin"] };
  // Two URLs of one operator (other path, port, subdomain or case) are ONE source.
  if (oa === ob) return { status: "SINGLE", values: null, disagree: [] };
  if (
    a.chainId !== expectedChainId ||
    b.chainId !== expectedChainId ||
    !a.block ||
    !b.block
  )
    return { status: "UNKNOWN", values: null, disagree: ["chain"] };
  if (
    a.block.number !== b.block.number ||
    a.block.hash.toLowerCase() !== b.block.hash.toLowerCase() ||
    // The block time bounds how old a review is: both operators must report the same one (round-5 W4).
    (a.block.timestamp ?? null) !== (b.block.timestamp ?? null)
  )
    return { status: "UNKNOWN", values: null, disagree: ["block"] };
  const out: Record<string, string> = {};
  const disagree: string[] = [];
  for (const k of keys) {
    const x = a.values[k],
      y = b.values[k];
    if (typeof x !== "string" || typeof y !== "string")
      return { status: "UNKNOWN", values: null, disagree: [] };
    if (x.toLowerCase() !== y.toLowerCase()) disagree.push(k);
    else out[k] = x;
  }
  return disagree.length
    ? { status: "DISAGREE", values: null, disagree }
    : { status: "AGREE", values: out, disagree: [] };
}
/** One configured RPC source: the operator that runs it (server configuration) and its exact URL. */
export interface ConfiguredSource {
  operator: string;
  url: string;
}
/**
 * G14 proposal B4: agreement on the LIVE path. Besides everything agree() requires, both reads must come from the
 * chain's configured pool, from two entries with DIFFERENT operator ids (and different registrable domains): the
 * operator is bound from server configuration, not guessed from a host name alone. A read from an origin that is not
 * in the pool, a pool with fewer than two operators, or two entries of one operator conclude nothing (UNKNOWN /
 * SINGLE). Each chain is reconciled against its own pool only.
 */
export function agreeConfigured(
  a: SourceRead | null,
  b: SourceRead | null,
  keys: readonly string[],
  expectedChainId: string,
  pool: readonly ConfiguredSource[] | null | undefined,
): ReturnType<typeof agree> {
  const entries = Array.isArray(pool) ? pool : [];
  const find = (r: SourceRead | null) =>
    r
      ? (entries.find(
          (e) =>
            typeof e?.url === "string" &&
            normalizeOrigin(e.url) !== null &&
            normalizeOrigin(e.url) === normalizeOrigin(r.origin),
        ) ?? null)
      : null;
  if (!a || !b) return agree(a, b, keys, expectedChainId);
  const ea = find(a),
    eb = find(b);
  if (!ea || !eb)
    return { status: "UNKNOWN", values: null, disagree: ["origin"] };
  if (
    typeof ea.operator !== "string" ||
    typeof eb.operator !== "string" ||
    !ea.operator ||
    !eb.operator
  )
    return { status: "UNKNOWN", values: null, disagree: ["operator"] };
  if (ea.operator.toLowerCase() === eb.operator.toLowerCase())
    return { status: "SINGLE", values: null, disagree: [] };
  return agree(a, b, keys, expectedChainId);
}
export function agreementCheck(
  id: string,
  r: ReturnType<typeof agree>,
): CanaryCheck {
  return {
    id,
    status:
      r.status === "AGREE"
        ? "PASS"
        : r.status === "DISAGREE"
          ? "FAIL"
          : "UNKNOWN",
    code:
      r.status === "AGREE"
        ? "TWO_SOURCES_AGREE"
        : r.status === "DISAGREE"
          ? `SOURCES_DISAGREE:${r.disagree.join(",")}`
          : r.status === "SINGLE"
            ? "SINGLE_SOURCE"
            : "NOT_READ",
  };
}
const DIGITS = /^(0|[1-9]\d{0,77})$/;
/**
 * Native gas: every simulated call's gas, with the policy margin, at the current fee cap, plus the OP-stack L1 data fee,
 * must be covered by the owner's native balance (read from agreeing sources); the USDC balance must cover the amount.
 */
export function balanceAndGasCheck(i: {
  usdcBalance: string | null;
  amountIn: bigint;
  nativeBalance: string | null;
  gasUsed: readonly bigint[];
  maxFeePerGas: string | null;
  /** OP-stack L1 data fee of the transactions (GasPriceOracle.getL1Fee), wei; null = not read (review F11). */
  l1FeeWei: string | null;
}): CanaryCheck[] {
  const out: CanaryCheck[] = [];
  if (i.usdcBalance === null || !DIGITS.test(i.usdcBalance))
    out.push({ id: "BALANCE", status: "UNKNOWN", code: "BALANCE_NOT_AGREED" });
  else
    out.push({
      id: "BALANCE",
      status: BigInt(i.usdcBalance) >= i.amountIn ? "PASS" : "FAIL",
      code:
        BigInt(i.usdcBalance) >= i.amountIn
          ? "COVERS_AMOUNT"
          : "INSUFFICIENT_USDC",
    });
  if (
    i.nativeBalance === null ||
    !DIGITS.test(i.nativeBalance) ||
    i.maxFeePerGas === null ||
    !DIGITS.test(i.maxFeePerGas) ||
    i.gasUsed.length === 0 ||
    i.gasUsed.some((g) => g <= 0n) ||
    i.l1FeeWei === null ||
    !DIGITS.test(i.l1FeeWei)
  ) {
    out.push({ id: "GAS", status: "UNKNOWN", code: "GAS_NOT_PROVEN" });
    return out;
  }
  const margin = BigInt(10_000 + EXECUTION_POLICY.gasMarginBps);
  const need =
    i.gasUsed.reduce((a, g) => a + (g * margin) / 10_000n, 0n) *
      BigInt(i.maxFeePerGas) +
    BigInt(i.l1FeeWei);
  out.push({
    id: "GAS",
    status: BigInt(i.nativeBalance) >= need ? "PASS" : "FAIL",
    code:
      BigInt(i.nativeBalance) >= need
        ? `NATIVE_COVERS:${need}`
        : `INSUFFICIENT_NATIVE_GAS:${need}`,
  });
  return out;
}
