import { z } from "zod";
// V1.14 global DeFi universe. Browser-safe vocabulary and schemas only: the normalized catalog itself is server data
// (content/defi-universe) and reaches the browser only as bounded, paginated API pages.
//
// Catalog breadth never implies accounting support. Every entry carries an explicit coverage state; a protocol that
// is only cataloged is CATALOG_ONLY, never a checked zero.
export const VM_FAMILIES = [
  "EVM",
  "Solana",
  "Sui",
  "Aptos",
  "Cosmos",
  "Bitcoin",
  "Tron",
  "Stellar",
  "Other",
] as const;
export const vmFamilySchema = z.enum(VM_FAMILIES);
export type VmFamily = z.infer<typeof vmFamilySchema>;
// Independent capabilities. There is deliberately no single "supported" boolean.
export const CHAIN_CAPABILITIES = [
  "CATALOG",
  "IDENTIFIED",
  "RPC_READ",
  "PORTFOLIO_NATIVE",
  "PORTFOLIO_FUNGIBLE",
  "DEFI_DISCOVERY",
  "DEFI_POSITION",
  "INDEXED",
  "BRIDGE",
  "SWAP",
  "UNSUPPORTED_VM",
  "DEPRECATED",
  "NEEDS_REVIEW",
] as const;
export const chainCapabilitySchema = z.enum(CHAIN_CAPABILITIES);
export type ChainCapability = z.infer<typeof chainCapabilitySchema>;
// Catalog coverage for protocol + chain + product/version + adapterVersion.
export const COVERAGE_STATUSES = [
  "FULL_POSITION",
  "PARTIAL_POSITION",
  "DISCOVERY_ONLY",
  "NOT_CHECKED",
  "CATALOG_ONLY",
  "NEEDS_REVIEW",
  "UNSUPPORTED",
  "DEPRECATED",
  "FAILED",
] as const;
export const coverageStatusSchema = z.enum(COVERAGE_STATUSES);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;
// Ordering used for a protocol's headline state: the best per-chain state wins, the per-chain rows stay visible.
export const coverageRank: Record<CoverageStatus, number> = {
  FULL_POSITION: 8,
  PARTIAL_POSITION: 7,
  DISCOVERY_ONLY: 6,
  NOT_CHECKED: 5,
  CATALOG_ONLY: 4,
  NEEDS_REVIEW: 3,
  FAILED: 2,
  UNSUPPORTED: 1,
  DEPRECATED: 0,
};
// Wallet scan outcome per protocol deployment. Never merged: a checked zero is not "not checked" nor "failed".
export const SCAN_RESULTS = [
  "CHECKED_ZERO",
  "NONZERO",
  "NOT_CHECKED",
  "FAILED",
  "CATALOG_ONLY",
] as const;
export const scanResultSchema = z.enum(SCAN_RESULTS);
export type ScanResult = z.infer<typeof scanResultSchema>;
export const PRODUCT_CATEGORIES = [
  "lending",
  "cdp",
  "stablecoin",
  "dex",
  "dex-aggregator",
  "yield",
  "farm",
  "liquid-staking",
  "restaking",
  "liquid-restaking",
  "derivatives",
  "options",
  "prediction",
  "rwa",
  "insurance",
  "nft-finance",
  "bridge",
  "cex",
  "chain",
  "launchpad",
  "services",
  "gaming",
  "other",
] as const;
export const productCategorySchema = z.enum(PRODUCT_CATEGORIES);
export type ProductCategory = z.infer<typeof productCategorySchema>;
export const CHAIN_UNMAPPED_REASONS = [
  "UNKNOWN_CHAIN_ID",
  "AMBIGUOUS_ALIAS",
  "UNSUPPORTED_VM",
  "IDENTITY_REVIEW_REQUIRED",
  "SOURCE_INCOMPLETE",
  "DEPRECATED",
  "METADATA_ONLY",
] as const;
export const PROTOCOL_UNMAPPED_REASONS = [
  "SOURCE_INCOMPLETE",
  "IDENTITY_REVIEW_REQUIRED",
  "AMBIGUOUS_ALIAS",
  "UNKNOWN_CHAIN",
  "SLUG_COLLISION",
  "MALFORMED_ROW",
] as const;
export const chainMappingMethodSchema = z.enum([
  "CHAIN_CATALOG_NAME",
  "KEY_LABEL_MAP",
  "SHARED_CHAIN_ID",
  "STANDALONE",
  "UNRESOLVED",
]);
export const chainStatusSchema = z.enum([
  "ACTIVE",
  "REFERENCED_ONLY",
  "METADATA_ONLY",
  "REMOVED_UPSTREAM",
]);
export const protocolStatusSchema = z.enum([
  "ACTIVE",
  "DEPRECATED",
  "DEAD",
  "RUGGED",
  "REMOVED_UPSTREAM",
]);
const slugText = z.string().regex(/^[a-z0-9][a-z0-9._+()!-]{0,119}$/);
const tvl = z.number().finite().nonnegative().nullable();
export const universeChainSchema = z
  .object({
    key: z.string().regex(/^chain:[a-z0-9-]{1,80}$/),
    name: z.string().min(1).max(120),
    aliases: z.array(z.string().max(120)).max(32),
    vm: vmFamilySchema,
    chainId: z
      .string()
      .regex(/^\d{1,20}$/)
      .nullable(),
    otherbridgeId: z.string().max(80).nullable(),
    caip2: z.string().max(80).nullable(),
    sources: z.array(z.enum(["chain-catalog", "protocols", "metadata"])),
    inChainCatalog: z.boolean(),
    tvlUsd: tvl,
    parent: z.string().max(120).nullable(),
    categories: z.array(z.string().max(60)).max(16),
    mapping: z
      .object({
        status: z.enum(["MAPPED", "UNMAPPED"]),
        method: chainMappingMethodSchema,
        reason: z.enum(CHAIN_UNMAPPED_REASONS).nullable(),
        crossChecked: z.boolean(),
      })
      .strict(),
    capabilities: z.array(chainCapabilitySchema),
    protocolCount: z.number().int().nonnegative(),
    status: chainStatusSchema,
    flags: z.array(z.string().regex(/^[A-Z0-9_]{1,60}$/)).max(16),
    firstSeen: z.string().max(80),
    lastSeen: z.string().max(80),
  })
  .strict();
export type UniverseChain = z.infer<typeof universeChainSchema>;
export const universeProtocolSchema = z
  .object({
    id: z.string().regex(/^llama:[0-9a-z#._-]{1,80}$/),
    llamaId: z.string().max(80),
    slug: slugText,
    name: z.string().min(1).max(120),
    flags: z.array(z.string().regex(/^[A-Z0-9_]{1,60}$/)).max(16),
    category: z.string().max(60),
    productCategory: productCategorySchema,
    parent: z
      .object({ id: z.string().max(80), name: z.string().max(120) })
      .strict()
      .nullable(),
    version: z.string().max(20).nullable(),
    chains: z.array(z.string().regex(/^chain:[a-z0-9-]{1,80}$/)).max(1000),
    tvlUsd: tvl,
    status: protocolStatusSchema,
    deadFrom: z.string().max(40).nullable(),
    forkedFrom: z.array(z.string().max(80)).max(32),
    listedAt: z.number().int().nonnegative().nullable(),
    url: z.string().max(300).nullable(),
    module: z.string().max(200).nullable(),
    github: z.array(z.string().max(80)).max(16),
    previousNames: z.array(z.string().max(120)).max(16),
    mapping: z
      .object({
        status: z.enum(["MAPPED", "UNMAPPED"]),
        reason: z.enum(PROTOCOL_UNMAPPED_REASONS).nullable(),
      })
      .strict(),
    firstSeen: z.string().max(80),
    lastSeen: z.string().max(80),
  })
  .strict();
export type UniverseProtocol = z.infer<typeof universeProtocolSchema>;
export const protocolChainRowSchema = z
  .object({
    protocolId: z.string().max(90),
    chainKey: z.string().max(90),
    rawChain: z.string().max(120),
    tvlUsd: tvl,
    borrowedUsd: tvl,
  })
  .strict();
export type ProtocolChainRow = z.infer<typeof protocolChainRowSchema>;
export const sourceRecordSchema = z
  .object({
    id: z.string().max(60),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    fetchedAt: z.string().max(40),
    rows: z.number().int().nonnegative(),
  })
  .strict();
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export const universeStatsSchema = z
  .object({
    chainsSeen: z.number().int().nonnegative(),
    chainsMapped: z.number().int().nonnegative(),
    chainsUnmapped: z.number().int().nonnegative(),
    chainCatalogRows: z.number().int().nonnegative(),
    canonicalChains: z.number().int().nonnegative(),
    protocolsSeen: z.number().int().nonnegative(),
    protocolsMapped: z.number().int().nonnegative(),
    protocolsUnmapped: z.number().int().nonnegative(),
    activeProtocols: z.number().int().nonnegative(),
    deprecatedProtocols: z.number().int().nonnegative(),
    removedUpstreamProtocols: z.number().int().nonnegative(),
    categoriesSeen: z.number().int().nonnegative(),
    protocolChainRows: z.number().int().nonnegative(),
  })
  .strict();
export type UniverseStats = z.infer<typeof universeStatsSchema>;
export const universeSchema = z
  .object({
    version: z.literal(1),
    syncId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
    generatedAt: z.string().max(40),
    sources: z.array(sourceRecordSchema).max(16),
    stats: universeStatsSchema,
    categories: z
      .array(
        z
          .object({
            raw: z.string().max(60),
            productCategory: productCategorySchema,
            protocols: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(1000),
    chains: z.array(universeChainSchema).max(20000),
    protocols: z.array(universeProtocolSchema).max(100000),
    rows: z.array(protocolChainRowSchema).max(1000000),
  })
  .strict();
export type Universe = z.infer<typeof universeSchema>;
export interface CoverageRow {
  protocolId: string;
  chainKey: string;
  product: string;
  version: string | null;
  adapterVersion: string | null;
  status: CoverageStatus;
  reason: string;
  deployments: string[];
}
export interface UnmappedChain {
  name: string;
  sources: string[];
  reason: (typeof CHAIN_UNMAPPED_REASONS)[number];
  detail: string;
  chainId: string | null;
  catalogKey: string | null;
}
export interface UnmappedProtocol {
  llamaId: string | null;
  slug: string | null;
  name: string | null;
  sourceIndex: number;
  rowSha256: string;
  reason: (typeof PROTOCOL_UNMAPPED_REASONS)[number];
  detail: string;
  catalogId: string | null;
}
