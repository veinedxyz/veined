// G12 "To NEAR" route for Swap and Bridge: which reviewed source assets can reach which NEAR tokens through NEAR
// Intents (1Click), how VEINED builds the DRY quote request and how a signed dry quote reads as a receipt. Browser-safe
// and pure: no network here (the /api/guardian route quotes and reviews). Nothing in this file can request a deposit
// address: the request type fixes `dry: true`, and the receipt never carries one.
import {
  INTENTS_KNOWN_ASSETS,
  INTENTS_REVIEWED_ORIGINS,
  MAX_QUOTE_AGE_MS,
  type IntentsQuoteRequest,
  type IntentsToken,
} from "./intents";
import { isAddress } from "viem";
import { validIdentity } from "./support";

/** Source networks of the route, in display order. `evm` is the wallet chain id (an EVM wallet signs there). */
export const NEAR_ROUTE_CHAINS = Object.freeze([
  { key: "base", evm: 8453 },
  { key: "eth", evm: 1 },
  { key: "arb", evm: 42161 },
  { key: "op", evm: 10 },
  { key: "pol", evm: 137 },
  { key: "bsc", evm: 56 },
  { key: "avax", evm: 43114 },
  { key: "sol", evm: null },
] as const);
export type NearRouteChain = (typeof NEAR_ROUTE_CHAINS)[number]["key"];

/** What each NEAR token is, so wrapped and bridged assets are never presented as the native coin. */
export const NEAR_ROUTE_DESTINATIONS = Object.freeze([
  { assetId: "nep141:wrap.near", kind: "wrapped" },
  {
    assetId:
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    kind: "native",
  },
  { assetId: "nep141:usdt.tether-token.near", kind: "native" },
] as const);
export type NearDestinationKind =
  (typeof NEAR_ROUTE_DESTINATIONS)[number]["kind"];

export const nearRouteOrigins = (chain: NearRouteChain): IntentsToken[] =>
  INTENTS_REVIEWED_ORIGINS.filter((t) => t.blockchain === chain);
export const nearRouteDestinations = () =>
  NEAR_ROUTE_DESTINATIONS.map((d) => ({
    ...INTENTS_KNOWN_ASSETS.find((t) => t.assetId === d.assetId)!,
    kind: d.kind,
  }));
/** The route chain a connected EVM wallet is on, when the route supports it. */
export const nearRouteChainOf = (walletChain?: number) =>
  NEAR_ROUTE_CHAINS.find((c) => c.evm !== null && c.evm === walletChain)?.key;
/** The address format refunds need on this source chain (EVM wallets cannot receive Solana refunds). */
export const nearRouteEcosystem = (chain: NearRouteChain) =>
  chain === "sol" ? ("SVM" as const) : ("EVM" as const);
/** A refund address the source chain can actually pay back to: EIP-55 checksum when mixed-case, never the zero
 * address or the Solana system program. */
export function validRefundAddress(chain: NearRouteChain, address: string) {
  const a = address.trim();
  if (nearRouteEcosystem(chain) === "EVM")
    return (
      isAddress(a, { strict: true }) &&
      a.toLowerCase() !== "0x0000000000000000000000000000000000000000"
    );
  return validIdentity(a, "SVM") && a !== "11111111111111111111111111111111";
}

/** Slippage VEINED asks for (basis points) and how long the refund window lasts if the route never completes. */
export const NEAR_ROUTE_SLIPPAGE_BPS = 100;
export const NEAR_ROUTE_DEADLINE_MS = 600_000;

/** The DRY quote request: exact input, refunds to the sender on the source chain, delivery to a NEAR account. */
export function nearQuoteRequest(input: {
  origin: IntentsToken;
  destination: IntentsToken;
  amount: bigint;
  sender: string;
  recipient: string;
  now: number;
}): IntentsQuoteRequest {
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: NEAR_ROUTE_SLIPPAGE_BPS,
    originAsset: input.origin.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.destination.assetId,
    amount: input.amount.toString(),
    refundTo: input.sender.trim(),
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient.trim(),
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(input.now + NEAR_ROUTE_DEADLINE_MS).toISOString(),
    quoteWaitingTimeMs: 3000,
  };
}

const units = (v: unknown) =>
  typeof v === "string" && /^(0|[1-9]\d{0,77})$/.test(v) ? BigInt(v) : null;
const usd = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export interface NearRouteReceipt {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  amountInUsd: number | null;
  amountOutUsd: number | null;
  /** Fee the provider added to the signed quote (basis points, summed); VEINED requests none. */
  providerFeeBps: number | null;
  /** Charged in the source asset only if the route fails and is refunded. */
  refundFee: bigint | null;
  /** Already deducted from amountOut, in the destination asset. */
  withdrawFee: bigint | null;
  timeEstimate: number | null;
  issuedAt: number | null;
  /** After this moment Guardian no longer reviews the quote as current. */
  previewUntil: number | null;
}
/** Display facts of a signed dry quote, read field by field (an absent or malformed value stays unknown, never 0). */
export function nearRouteReceipt(signed: unknown): NearRouteReceipt | null {
  const r =
    signed && typeof signed === "object"
      ? (signed as Record<string, unknown>)
      : {};
  const q =
    r.quote && typeof r.quote === "object"
      ? (r.quote as Record<string, unknown>)
      : null;
  const echo =
    r.quoteRequest && typeof r.quoteRequest === "object"
      ? (r.quoteRequest as Record<string, unknown>)
      : {};
  if (!q) return null;
  const amountIn = units(q.amountIn),
    amountOut = units(q.amountOut),
    minAmountOut = units(q.minAmountOut);
  if (amountIn === null || amountOut === null || minAmountOut === null)
    return null;
  // An absent fee list is unknown (the provider did not report one), never 0.
  const fees = Array.isArray(echo.appFees) ? echo.appFees : null;
  const bps = fees?.map((f) =>
    f && typeof f === "object" ? (f as { fee?: unknown }).fee : undefined,
  );
  const providerFeeBps =
    bps &&
    bps.every(
      (b) =>
        typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 10000,
    )
      ? (bps as number[]).reduce((a, b) => a + b, 0)
      : null;
  const issued =
    typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  const eta = usd(q.timeEstimate);
  return {
    amountIn,
    amountOut,
    minAmountOut,
    amountInUsd: usd(q.amountInUsd),
    amountOutUsd: usd(q.amountOutUsd),
    providerFeeBps,
    refundFee: units(q.refundFee),
    withdrawFee: units(q.withdrawFee),
    timeEstimate: eta,
    issuedAt: Number.isFinite(issued) ? issued : null,
    previewUntil: Number.isFinite(issued) ? issued + MAX_QUOTE_AGE_MS : null,
  };
}

/** True only when the signed quote is for exactly what was asked (assets, amount, recipient, refund) and opened no
 * deposit address. A receipt that fails this is never displayed as amounts: its units could belong to another asset. */
export function quoteMatchesRequest(
  request: IntentsQuoteRequest,
  signed: unknown,
): boolean {
  const r =
    signed && typeof signed === "object"
      ? (signed as Record<string, unknown>)
      : {};
  const echo =
    r.quoteRequest && typeof r.quoteRequest === "object"
      ? (r.quoteRequest as Record<string, unknown>)
      : {};
  const q =
    r.quote && typeof r.quote === "object"
      ? (r.quote as Record<string, unknown>)
      : {};
  return (
    (
      [
        "dry",
        "originAsset",
        "destinationAsset",
        "amount",
        "recipient",
        "refundTo",
      ] as const
    ).every((k) => echo[k] === request[k]) &&
    q.amountIn === request.amount &&
    !q.depositAddress
  );
}
