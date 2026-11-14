import { z } from "zod";
import { priceEvidenceSchema } from "../data/core/price";
export const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
export const rawSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
export const decimalSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,100})(\.\d{1,18})?$/);
export const coverageSchema = z.enum([
  "FULL_POSITION",
  "PARTIAL_POSITION",
  "BALANCE_ONLY",
  "DISCOVERY_ONLY",
  "NOT_CHECKED",
  "UNSUPPORTED",
  "FAILED",
  "PENDING",
]);
// 1.0.0 = accepted V1.13 adapters; 1.1.0 = V1.14 revisions/new families (versioned so coverage keys stay exact).
export const adapterVersionSchema = z.enum(["1.0.0", "1.1.0"]);
export const categorySchema = z.enum([
  "lending",
  "liquidity",
  "vault",
  "staking",
  "restaking",
  "rewards",
  "other",
]);
export const evidenceSchema = z
  .object({
    kind: z.enum([
      "contract-view",
      "event-index",
      "official-registry",
      "standard-interface",
      "price-source",
    ]),
    source: z.string().max(400),
    blockNumber: rawSchema.optional(),
    blockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .optional(),
    endpointGroup: z.string().max(80).optional(),
    observedAt: z.number().int().nonnegative(),
  })
  .strict();
export const assetSchema = z
  .object({
    assetId: z.string().max(160),
    chainId: z.string().regex(/^\d{1,18}$/),
    contract: addressSchema,
    symbol: z.string().max(32),
    decimals: z.number().int().min(0).max(36),
    rawAmount: rawSchema,
    role: z.enum([
      "supplied",
      "collateral",
      "borrowed",
      "underlying",
      "lp-component",
      "vault-underlying",
      "reward",
      // V1.14: exact uncollected LP fees; kept outside gross value and outside Claimable rewards.
      "fee",
    ]),
    price: priceEvidenceSchema.optional(),
    valueUsd: decimalSchema.nullable(),
  })
  .strict();
export const riskSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("health-factor"),
      value: decimalSchema,
      ltvBps: rawSchema,
      liquidationThresholdBps: rawSchema,
      source: z.literal("protocol-view"),
      attention: z.enum(["none", "monitor", "attention"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collateralization-status"),
      borrowCollateralized: z.boolean(),
      liquidatable: z.boolean(),
      source: z.literal("protocol-view"),
      attention: z.enum(["none", "attention"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ltv"),
      ltv: decimalSchema,
      liquidationLtv: decimalSchema,
      margin: z.string().regex(/^-?\d+(\.\d+)?$/),
      oracle: addressSchema,
      source: z.literal("protocol-state"),
      attention: z.enum(["none", "monitor", "attention"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("not-available"),
      reason: z.string().regex(/^[A-Z0-9_]{1,80}$/),
    })
    .strict(),
]);
export const rewardSchema = z
  .object({
    asset: assetSchema,
    rawClaimable: rawSchema,
    sourceContract: addressSchema,
    confidence: z.enum(["protocol-view", "indexed-estimate"]),
    observedAt: z.number().int().nonnegative(),
  })
  .strict();
export const positionSchema = z
  .object({
    id: z.string().max(220),
    wallet: addressSchema,
    chainId: z.string().regex(/^\d{1,18}$/),
    deploymentId: z.string().max(120),
    protocolId: z.string().regex(/^[a-z0-9-]{1,50}$/),
    protocolName: z.string().max(80),
    category: categorySchema,
    positionKey: z.string().max(160),
    adapterVersion: adapterVersionSchema,
    sourceBlock: rawSchema,
    sourceBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    observedAt: z.number().int().nonnegative(),
    supplied: z.array(assetSchema).max(128),
    collateral: z.array(assetSchema).max(128),
    borrowed: z.array(assetSchema).max(128),
    underlying: z.array(assetSchema).max(128),
    representations: z.array(z.string().max(160)).max(256),
    rewards: z.array(rewardSchema).max(64),
    fees: z.array(assetSchema).max(8).optional(),
    rewardsStatus: z.enum(["CHECKED", "NOT_CHECKED", "FAILED"]),
    risk: riskSchema,
    grossAssetsUsd: decimalSchema,
    debtUsd: decimalSchema,
    knownNetUsd: z.string().regex(/^-?\d+(\.\d+)?$/),
    confidence: z.enum([
      "EXACT_ONCHAIN",
      "EXACT_WITH_PRICE",
      "PARTIAL",
      "UNPRICED",
      "ESTIMATED",
    ]),
    coverage: coverageSchema,
    warnings: z.array(z.string().regex(/^[A-Z0-9_]{1,80}$/)).max(64),
    evidence: z.array(evidenceSchema).max(1024),
    details: z.record(z.string().max(50), z.string().max(200)),
  })
  .strict();
export type PositionAsset = z.infer<typeof assetSchema>;
export type DefiPosition = z.infer<typeof positionSchema>;
export type PositionRisk = z.infer<typeof riskSchema>;
export type PositionEvidence = z.infer<typeof evidenceSchema>;
export const deploymentCoverageSchema = z
  .object({
    deploymentId: z.string().max(120),
    protocolId: z.string().max(50),
    protocolName: z.string().max(80),
    chainId: z.string().regex(/^\d{1,18}$/),
    adapterVersion: adapterVersionSchema,
    state: coverageSchema,
    result: z.enum(["NONZERO", "ZERO", "UNKNOWN"]),
    reason: z.string().regex(/^[A-Z0-9_]{1,100}$/),
    observedAt: z.number().int().nonnegative(),
    sourceBlock: rawSchema.nullable(),
    sourceBlockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    // V1.14 scan outcome vocabulary: a checked zero is never "not checked" and never "failed".
    scanResult: z
      .enum(["CHECKED_ZERO", "NONZERO", "NOT_CHECKED", "FAILED"])
      .optional(),
    signal: z
      .enum([
        "ACCOUNT_LOOKUP",
        "RECEIPT_TOKEN",
        "INDEXED_ACTIVITY",
        "POSITION_NFT",
        "EXPLICIT",
      ])
      .optional(),
    // V1.14.1 scheduling tier (priority only, never position truth) and request census of this deployment's reader.
    tier: z
      .enum([
        "EXACT_HELD_RECEIPT",
        "EXACT_POSITION_NFT",
        "EXACT_ACTIVE_INTERACTION",
        "EXACT_PROTOCOL_ACCOUNT",
        "HISTORICAL_INTERACTION",
        "BOUNDED_FALLBACK_PROBE",
      ])
      .optional(),
    http: z.number().int().nonnegative().optional(),
    rpcItems: z.number().int().nonnegative().optional(),
    multicallBatches: z.number().int().nonnegative().optional(),
    retries: z.number().int().nonnegative().optional(),
    cooldownSkips: z.number().int().nonnegative().optional(),
    cacheHits: z.number().int().nonnegative().optional(),
    calls: z.number().int().nonnegative(),
    batches: z.number().int().nonnegative(),
    fallbacks: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  })
  .strict();
export type DeploymentCoverage = z.infer<typeof deploymentCoverageSchema>;
const count = z.number().int().nonnegative();
// V1.14 scan receipt: the candidate funnel (global universe -> chain-relevant -> candidates -> adapters run) and
// the honest outcome counts of one progressive scan round (merged across continuation rounds).
export const scanReceiptSchema = z
  .object({
    catalogVersion: z.string().max(80).nullable(),
    chainsConsidered: count,
    chainsChecked: count,
    funnel: z
      .object({
        universeRows: count.nullable(),
        chainRelevantRows: count.nullable(),
        candidateDeployments: count,
        adaptersRun: count,
      })
      .strict(),
    signals: z.record(z.string().max(30), count),
    candidateProtocols: z.array(z.string().max(60)).max(500),
    skipped: z
      .array(
        z
          .object({
            deploymentId: z.string().max(120),
            reason: z.string().regex(/^[A-Z0-9_]{1,100}$/),
          })
          .strict(),
      )
      .max(1000),
    failed: count,
    checkedZero: count,
    nonzero: count,
    positions: count,
    unpriced: count,
    unpricedDebt: count,
    durationMs: z.number().nonnegative(),
    rpcCalls: count,
    slowest: z
      .object({
        deploymentId: z.string().max(120),
        durationMs: z.number().nonnegative(),
      })
      .strict()
      .nullable(),
    tiers: z.record(z.string().max(40), count).optional(),
    requests: z
      .object({
        http: count,
        rpcItems: count,
        multicallBatches: count,
        retries: count,
        cooldownSkips: count,
        cacheHits: count,
        pins: count,
        pinVerifications: count,
      })
      .strict()
      .optional(),
    timing: z
      .object({
        firstResultMs: z.number().nonnegative().nullable(),
        roundMs: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ScanReceipt = z.infer<typeof scanReceiptSchema>;
export const scanSchema = z
  .object({
    version: z.literal(2),
    wallet: addressSchema,
    scanId: z.string().max(100),
    observedAt: z.number().int().nonnegative(),
    positions: z.array(positionSchema).max(5000),
    coverage: z.array(deploymentCoverageSchema).max(1000),
    replacedWalletAssets: z.array(z.string().max(160)).max(5000),
    replacementOwners: z
      .record(z.string().max(120), z.array(z.string().max(160)).max(5000))
      .default({}),
    continuation: z.array(z.string().max(120)).max(1000),
    nonEvm: z.literal("NOT_CHECKED"),
    elapsedMs: z.number().nonnegative(),
    peakConcurrency: z.number().int().min(0).max(32),
    receipt: scanReceiptSchema.optional(),
  })
  .strict();
export type DefiScan = z.infer<typeof scanSchema>;
export type AdapterType =
  | "aave-v3"
  | "compound-iii"
  | "morpho-blue"
  | "morpho-vault"
  | "erc4626"
  | "lido"
  | "uniswap-v2"
  | "uniswap-v3"
  | "lst-rate"
  | "eigenlayer"
  | "curve"
  | "balancer-v2"
  | "solidly-v2";
export interface ProtocolDeployment {
  id: string;
  protocolId: string;
  name: string;
  chainId: string;
  adapter: AdapterType;
  category: z.infer<typeof categorySchema>;
  contracts: Record<string, string>;
  source: string;
  revision: string;
  status: "active";
  environment: "mainnet";
  startBlock?: string;
  /** V1.14 reviewed per-deployment semantics (fork fee denominators, conversion views, VM-specific layouts). */
  variant?: string;
  config?: Record<string, string>;
  strategies?: { symbol: string; strategy: string; underlying: string }[];
  identity?: "OFFICIAL_SOURCE_LITERAL" | "ONCHAIN_DERIVED";
  derivation?: Record<string, string>;
  assets?: {
    symbol: string;
    underlying: string;
    receipt: string;
    debt: string;
    decimals: number;
  }[];
}
export interface PositionRef {
  key: string;
  contract?: string;
  tokenId?: string;
  marketId?: string;
  discovery: "registry" | "event-index" | "enumeration" | "token-triggered";
}
export interface AdapterCoverage {
  state: z.infer<typeof coverageSchema>;
  reason: string;
}
