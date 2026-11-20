// VEINED-MC1 (BRIDGE LANE, disarmed): the frozen scope of the app-side multi-pair Bridge lane (docs/SPEC_BRIDGE_LANE.md).
// One pair = one directed Across transfer of Circle's native USDC from a source chain to a destination chain through
// the LI.FI Diamond's AcrossFacetV4 (swapAndStartBridgeTokensViaAcrossV4 with LI.FI's fee step), exactly 5 USDC in,
// at least 4.90 USDC out, receiver = refund = depositor = the owner's own account, single use. The pair ids are the
// restricted signer v5's own route ids (`bridge-<source>-<destination>`, D:/vnd/hk1/mc1/signer/policy-v5.mjs ROUTES):
// the adapter declares {lane: "BRIDGE", route: <pair id>, step}.
// The table authorizes NOTHING by itself: the bridge lane gate (./bridge-approval.ts) stays CLOSED unless the four
// separate protected facts of a LOCAL armed variant are set; a record may only name an ENABLED pair. The Bridge canary
// (Base -> Arbitrum, src/execution/**) is not touched and shares nothing with this lane.
//
// Pairs: every ordered pair of the six chains below (30, the signer's 30 quoted-and-simulated Across pairs). 20 are
// ENABLED (chains 1 / 8453 / 42161 / 10 / 137); the 10 touching BNB Chain are BLOCKED (NO_CIRCLE_USDC: Binance-Peg
// USDC, 18 decimals) exactly as in signer v5. Avalanche has no pair at all: its Diamond has no facet for the Across
// selector (NO_ACROSS_FACET, evidence D-lifi-onchain.json) and no public operator serves eth_simulateV1.
// Per-chain values (never looser than signer v5): fee ceiling, tip bounds, confirmations and review block age are the
// swap lane's own per-chain values (./scope.ts, already aligned to v5); head skew = v5 maxHeadSkewBlocks; gas caps
// APPROVE 100 k (v5 120 k) / EXECUTE 600 k (v5 900 k; simulated need 168-222 k, B-matrix E-bridge-sims.json); the pair
// budget = v5 bridgeGasBudgetWei of the source chain. tests/unit/bridge-lane-scope.test.ts pins a copy of the v5 values.
import { LANE_MAX_HEAD_SKEW_BLOCKS, type SwapLaneFeeModel } from "./scope";

/** Global bridge lane policy (the same for every pair; v5 BRIDGE_COMMON). */
export const BRIDGE_LANE_SCOPE = Object.freeze({
  /** Raw source USDC units (6 decimals): exactly 5 USDC, never more, never less. */
  exactAmount: 5_000_000n,
  /** Raw destination USDC units (6 decimals): 4.90 USDC. */
  minimumOut: 4_900_000n,
  /** Every cost taken out of the amount (LI.FI fee + relayer fees) together may not exceed this share. */
  maxCostBps: 300,
  /** LI.FI's fee step may take at most 25 bps of the amount (12 500 of 5 000 000). */
  maxFeeBps: 25,
  /** Across output multiplier scale (1e18 = 1:1). */
  multiplierBase: 10n ** 18n,
  /** Across fill deadline, counted from the review time: a real window, but funds never locked for long. */
  minFillWindowSec: 30 * 60,
  maxFillWindowSec: 6 * 3600,
  /** The Across quote timestamp must be this close to the review time (signer v5 maxQuoteSkewSec) ... */
  maxQuoteSkewSec: 10 * 60,
  /** ... less this margin, so the skew the signer sees later (review TTL + hand-off) is still inside its bound. */
  quoteSkewMarginSec: 60,
  /** Across exclusivity: none, or at most this many seconds for one EVM relayer. */
  maxExclusivitySec: 300,
  maxIntegratorLength: 64,
  /** The LI.FI tool and BridgeData.bridge. */
  tool: "across",
  /** The quote's own gasLimit is informational only (LI.FI pads Arbitrum to ~2.8 M): it must be a positive quantity
   * below this bound; the lane's transaction carries its OWN limit (simulated need x margin, below the step cap). */
  maxQuoteGasLimit: 3_000_000n,
  /** A review (quote, pins, balances, simulation) is usable for this long, then a new review is needed. */
  reviewTtlSec: 20,
  gasMarginBps: 2_000n,
  estimateMarginBps: 1_000n,
  minGas: 21_000n,
  /** eth_getLogs block range (inclusive) of one read: the dRPC free-tier cap. */
  logWindowBlocks: 100,
  /** Destination log windows one track() call may read (the search resumes from its journaled cursor). */
  maxLogWindowsPerTrack: 30,
  singleUse: true,
});
export type BridgeLaneStep = "APPROVE" | "EXECUTE";
export const BRIDGE_LANE_STEPS: readonly BridgeLaneStep[] = Object.freeze([
  "APPROVE",
  "EXECUTE",
]);

export interface BridgeLaneChain {
  chainId: string;
  chainHex: string;
  name: string;
  status: "ENABLED" | "BLOCKED";
  blockReason: string | null;
  feeModel: SwapLaneFeeModel;
  /** The chain's USDC (Circle native on every ENABLED chain). */
  usdc: Readonly<{ address: string; symbol: "USDC"; decimals: number }>;
  /** Signer v5 fee ceiling of the chain (= the swap lane's route value). */
  maxFeePerGasWei: bigint;
  minTipWei: bigint;
  maxTipWei: bigint;
  /** Confirmations before a receipt counts (signer v5 minConfirmations). */
  confirmations: number;
  /** The block a review reads may be at most this old (<= signer v5 maxReadBlockAgeSec). */
  maxReviewBlockAgeSec: number;
  /** Signer v5 maxHeadSkewBlocks. */
  maxHeadSkewBlocks: number;
  /** Gas limits the signer may be asked for on this chain (<= signer v5 bridge gas caps 120 k / 900 k). */
  maxGas: Readonly<{ APPROVE: bigint; EXECUTE: bigint }>;
  /** Native wei both steps of a pair FROM this chain may cost together (= signer v5 bridgeGasBudgetWei). */
  gasBudgetWei: bigint;
}
const chain = (c: BridgeLaneChain): Readonly<BridgeLaneChain> =>
  Object.freeze({
    ...c,
    usdc: Object.freeze({ ...c.usdc }),
    maxGas: Object.freeze({ ...c.maxGas }),
  });
const BRIDGE_GAS = { APPROVE: 100_000n, EXECUTE: 600_000n };

export const BRIDGE_LANE_CHAINS: Readonly<
  Record<string, Readonly<BridgeLaneChain>>
> = Object.freeze({
  "1": chain({
    chainId: "1",
    chainHex: "0x1",
    name: "Ethereum",
    status: "ENABLED",
    blockReason: null,
    feeModel: "PLAIN",
    usdc: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    },
    maxFeePerGasWei: 5_000_000_000n,
    minTipWei: 50_000_000n,
    maxTipWei: 1_000_000_000n,
    confirmations: 10,
    maxReviewBlockAgeSec: 45,
    maxHeadSkewBlocks: 2,
    maxGas: BRIDGE_GAS,
    gasBudgetWei: 546_000_000_000_000n,
  }),
  "8453": chain({
    chainId: "8453",
    chainHex: "0x2105",
    name: "Base",
    status: "ENABLED",
    blockReason: null,
    feeModel: "OP_STACK",
    usdc: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
    },
    maxFeePerGasWei: 200_000_000n,
    minTipWei: 0n,
    maxTipWei: 10_000_000n,
    confirmations: 300,
    maxReviewBlockAgeSec: 20,
    maxHeadSkewBlocks: 5,
    maxGas: BRIDGE_GAS,
    gasBudgetWei: 44_000_000_000_000n,
  }),
  "42161": chain({
    chainId: "42161",
    chainHex: "0xa4b1",
    name: "Arbitrum One",
    status: "ENABLED",
    blockReason: null,
    feeModel: "ARBITRUM",
    usdc: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      decimals: 6,
    },
    maxFeePerGasWei: 400_000_000n,
    minTipWei: 0n,
    maxTipWei: 0n,
    confirmations: 200,
    maxReviewBlockAgeSec: 10,
    maxHeadSkewBlocks: 10,
    maxGas: BRIDGE_GAS,
    gasBudgetWei: 145_000_000_000_000n,
  }),
  "10": chain({
    chainId: "10",
    chainHex: "0xa",
    name: "OP Mainnet",
    status: "ENABLED",
    blockReason: null,
    feeModel: "OP_STACK",
    usdc: {
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      symbol: "USDC",
      decimals: 6,
    },
    maxFeePerGasWei: 20_000_000n,
    minTipWei: 1_000_000n,
    maxTipWei: 10_000_000n,
    confirmations: 30,
    maxReviewBlockAgeSec: 20,
    maxHeadSkewBlocks: 3,
    maxGas: BRIDGE_GAS,
    gasBudgetWei: 7_340_000_000_000n,
  }),
  "137": chain({
    chainId: "137",
    chainHex: "0x89",
    name: "Polygon PoS",
    status: "ENABLED",
    blockReason: null,
    feeModel: "PLAIN",
    usdc: {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      decimals: 6,
    },
    maxFeePerGasWei: 2_000_000_000_000n,
    minTipWei: 30_000_000_000n,
    maxTipWei: 300_000_000_000n,
    confirmations: 64,
    maxReviewBlockAgeSec: 20,
    maxHeadSkewBlocks: 4,
    maxGas: BRIDGE_GAS,
    gasBudgetWei: 3_400_000_000_000_000_000n,
  }),
  // BNB Chain: BLOCKED (owner decision, signer v5 chain BLOCKED too). Its only USDC is Binance-Peg (18 decimals, an
  // EIP-1967 proxy, not Circle's): recorded so a later owner decision only flips the status after re-verification.
  "56": chain({
    chainId: "56",
    chainHex: "0x38",
    name: "BNB Chain",
    status: "BLOCKED",
    blockReason: "NO_CIRCLE_USDC",
    feeModel: "PLAIN",
    usdc: {
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      symbol: "USDC",
      decimals: 18,
    },
    maxFeePerGasWei: 3_000_000_000n,
    minTipWei: 50_000_000n,
    maxTipWei: 100_000_000n,
    confirmations: 140,
    maxReviewBlockAgeSec: 20,
    maxHeadSkewBlocks: 10,
    maxGas: BRIDGE_GAS,
    gasBudgetWei: 360_000_000_000_000n,
  }),
});
/** The chain of this decimal id (own entries only), or null. */
export function bridgeChainById(id: unknown): Readonly<BridgeLaneChain> | null {
  return typeof id === "string" &&
    Object.prototype.hasOwnProperty.call(BRIDGE_LANE_CHAINS, id)
    ? BRIDGE_LANE_CHAINS[id]
    : null;
}

export interface BridgeLanePair {
  /** `bridge-<source>-<destination>` = the signer v5 route id; also the record's `route` and `scope`. */
  id: string;
  source: string;
  destination: string;
  status: "ENABLED" | "BLOCKED";
  blockReason: string | null;
  /** Exactly 5 USDC in source units. */
  exactAmount: bigint;
  /** 4.90 USDC in destination units. */
  minimumOut: bigint;
  /** 25 bps of the amount, in source units. */
  maxFee: bigint;
  maxCostBps: number;
  /** 1.0 in Across' 1e18 scale, decimals-normalised (v5 maxMultiplier). */
  maxMultiplier: bigint;
  /** = the source chain's bridge budget. */
  gasBudgetWei: bigint;
}
function buildPairs(): Readonly<Record<string, Readonly<BridgeLanePair>>> {
  const out: Record<string, Readonly<BridgeLanePair>> = {};
  for (const s of Object.values(BRIDGE_LANE_CHAINS))
    for (const d of Object.values(BRIDGE_LANE_CHAINS)) {
      if (s.chainId === d.chainId) continue;
      const inU = 10n ** BigInt(s.usdc.decimals),
        outU = 10n ** BigInt(d.usdc.decimals);
      const enabled = s.status === "ENABLED" && d.status === "ENABLED";
      const id = `bridge-${s.chainId}-${d.chainId}`;
      out[id] = Object.freeze({
        id,
        source: s.chainId,
        destination: d.chainId,
        status: enabled ? "ENABLED" : "BLOCKED",
        blockReason: enabled
          ? null
          : ((s.status !== "ENABLED" ? s : d).blockReason ?? "BLOCKED"),
        exactAmount: (BRIDGE_LANE_SCOPE.exactAmount * inU) / 1_000_000n,
        minimumOut: (BRIDGE_LANE_SCOPE.minimumOut * outU) / 1_000_000n,
        maxFee:
          (BRIDGE_LANE_SCOPE.exactAmount *
            inU *
            BigInt(BRIDGE_LANE_SCOPE.maxFeeBps)) /
          1_000_000n /
          10_000n,
        maxCostBps: BRIDGE_LANE_SCOPE.maxCostBps,
        maxMultiplier: (BRIDGE_LANE_SCOPE.multiplierBase * outU) / inU,
        gasBudgetWei: s.gasBudgetWei,
      } satisfies BridgeLanePair);
    }
  return Object.freeze(out);
}
/** The 30 directed pairs of the six chains (20 ENABLED, 10 BLOCKED by BNB Chain); no Avalanche pair exists. */
export const BRIDGE_LANE_PAIRS = buildPairs();
/** The pair of this id (own entries only), or null. */
export function pairById(id: unknown): Readonly<BridgeLanePair> | null {
  return typeof id === "string" &&
    Object.prototype.hasOwnProperty.call(BRIDGE_LANE_PAIRS, id)
    ? BRIDGE_LANE_PAIRS[id]
    : null;
}
/** Every pair a record may name. */
export function enabledPairs(): readonly Readonly<BridgeLanePair>[] {
  return Object.freeze(
    Object.values(BRIDGE_LANE_PAIRS).filter((p) => p.status === "ENABLED"),
  );
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Internal consistency of one chain ([] = consistent). Kept true for every chain by the unit tests. */
export function bridgeChainProblems(c: Readonly<BridgeLaneChain>): string[] {
  const p: string[] = [];
  if (!/^[1-9]\d{0,9}$/.test(c.chainId)) p.push("CHAIN_ID");
  else if (c.chainHex !== "0x" + BigInt(c.chainId).toString(16))
    p.push("CHAIN_HEX");
  if (!ADDRESS.test(c.usdc.address) || /^0x0{40}$/.test(c.usdc.address))
    p.push("USDC_ADDRESS");
  if (c.status === "ENABLED" && c.usdc.decimals !== 6) p.push("USDC_DECIMALS");
  if (
    c.minTipWei < 0n ||
    c.maxTipWei < c.minTipWei ||
    c.maxFeePerGasWei <= c.maxTipWei
  )
    p.push("FEE_BOUNDS");
  if (
    c.maxGas.APPROVE < BRIDGE_LANE_SCOPE.minGas ||
    c.maxGas.EXECUTE < c.maxGas.APPROVE ||
    c.maxGas.APPROVE > 120_000n ||
    c.maxGas.EXECUTE > 900_000n
  )
    p.push("MAX_GAS");
  if (c.gasBudgetWei <= 0n) p.push("GAS_BUDGET");
  if (!Number.isInteger(c.confirmations) || c.confirmations < 1)
    p.push("CONFIRMATIONS");
  if (
    !Number.isInteger(c.maxReviewBlockAgeSec) ||
    c.maxReviewBlockAgeSec < 1 ||
    c.maxReviewBlockAgeSec > 45
  )
    p.push("BLOCK_AGE");
  if (
    !Number.isInteger(c.maxHeadSkewBlocks) ||
    c.maxHeadSkewBlocks < 0 ||
    c.maxHeadSkewBlocks !== LANE_MAX_HEAD_SKEW_BLOCKS[c.chainId]
  )
    p.push("HEAD_SKEW");
  if (c.status === "ENABLED" && c.blockReason !== null) p.push("BLOCK_REASON");
  if (
    c.status === "BLOCKED" &&
    !(
      typeof c.blockReason === "string" &&
      /^[A-Z0-9_]{3,64}$/.test(c.blockReason)
    )
  )
    p.push("BLOCK_REASON");
  return p;
}
