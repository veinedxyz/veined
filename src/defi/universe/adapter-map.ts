import type { CoverageStatus } from "./model";
// Reviewed, code-owned links from a DeFiLlama catalog identity to Otherbridge position adapters. A link requires BOTH
// the numeric DeFiLlama id and the slug to match: an upstream rename, slug reassignment or a look-alike clone can never
// inherit financial logic (it becomes NEEDS_REVIEW). Catalog syncs never edit this file.
//
// attribution:
//   EXACT           the catalog entry is the same product the adapter reads (for example Aave V3 <-> aave-v3 pools)
//   PRODUCT_FAMILY  the adapter reads one reviewed product inside a broader catalog entry; coverage is capped at
//                   PARTIAL_POSITION because the entry's other products are not read
export interface ReviewedLink {
  llamaId: string;
  slug: string;
  product: string;
  version: string | null;
  /** Otherbridge deployment protocolIds (src/defi/deployments.generated.json) read for this catalog entry. */
  protocolIds: string[];
  /** Optional exact deployment ids when only some deployments of a protocolId belong to this entry. */
  deploymentIds?: string[];
  attribution: "EXACT" | "PRODUCT_FAMILY";
  /** Catalog state on a chain that has at least one reviewed deployment. The live scan can only lower it. */
  status: Extract<
    CoverageStatus,
    "FULL_POSITION" | "PARTIAL_POSITION" | "DISCOVERY_ONLY"
  >;
  reason: string;
  adapterVersion: string;
}
export const REVIEWED_LINKS: ReviewedLink[] = [
  {
    llamaId: "1599",
    slug: "aave-v3",
    product: "Aave V3 Pool",
    version: "V3",
    protocolIds: ["aave-v3"],
    attribution: "EXACT",
    status: "FULL_POSITION",
    reason: "ACCOUNT_LEVEL_PROTOCOL_VIEWS",
    adapterVersion: "1.1.0",
  },
  {
    // V1.14: SparkLend is an Aave V3 fork read by the same reviewed views; its own pinned registry supplies every address.
    llamaId: "2929",
    slug: "sparklend",
    product: "SparkLend Pool",
    version: "V1",
    protocolIds: ["sparklend"],
    attribution: "EXACT",
    status: "FULL_POSITION",
    reason: "ACCOUNT_LEVEL_PROTOCOL_VIEWS",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "2088",
    slug: "compound-v3",
    product: "Compound III Comet",
    version: "V3",
    protocolIds: ["compound-iii"],
    attribution: "EXACT",
    status: "FULL_POSITION",
    reason: "ACCOUNT_LEVEL_PROTOCOL_VIEWS",
    adapterVersion: "1.0.0",
  },
  {
    llamaId: "4025",
    slug: "morpho-blue",
    product: "Morpho Blue markets",
    version: "V1",
    protocolIds: ["morpho-blue"],
    attribution: "EXACT",
    status: "PARTIAL_POSITION",
    reason: "MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "4025",
    slug: "morpho-blue",
    product: "MetaMorpho vaults",
    version: "V1",
    protocolIds: ["morpho-vault"],
    attribution: "PRODUCT_FAMILY",
    status: "PARTIAL_POSITION",
    reason: "VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX",
    adapterVersion: "1.0.0",
  },
  {
    llamaId: "182",
    slug: "lido",
    product: "Lido stETH / wstETH",
    version: null,
    protocolIds: ["lido"],
    attribution: "EXACT",
    status: "FULL_POSITION",
    reason: "EXACT_SHARE_CONVERSION_AND_WITHDRAWAL_QUEUE",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "2197",
    slug: "uniswap-v2",
    product: "Uniswap V2 pairs",
    version: "V2",
    protocolIds: ["uniswap-v2"],
    attribution: "EXACT",
    status: "PARTIAL_POSITION",
    reason: "PAIR_DISCOVERY_INDEX_OR_HELD_LP",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "2198",
    slug: "uniswap-v3",
    product: "Uniswap V3 positions",
    version: "V3",
    protocolIds: ["uniswap-v3"],
    attribution: "EXACT",
    status: "FULL_POSITION",
    reason: "NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "6716",
    slug: "spark-savings",
    product: "Savings DAI (sDAI) ERC-4626",
    version: null,
    protocolIds: ["erc4626"],
    deploymentIds: ["erc4626-sdai-1"],
    attribution: "PRODUCT_FAMILY",
    status: "PARTIAL_POSITION",
    reason: "ONLY_REVIEWED_VAULTS_READ",
    adapterVersion: "1.0.0",
  },
  // V1.14 reviewed families (official pinned sources; identities proven on-chain at read time).
  ...lst("900", "rocket-pool", "Rocket Pool rETH", ["rocket-pool"]),
  ...lst("3594", "coinbase-wrapped-staked-eth", "Coinbase cbETH", [
    "coinbase-cbeth",
  ]),
  ...lst("2914", "binance-staked-eth", "Binance wBETH (Ethereum)", [
    "binance-wbeth",
  ]),
  ...lst("2901", "swell-liquid-staking", "Swell swETH", ["swell-sweth"]),
  ...lst("3882", "meth-protocol", "Mantle mETH", ["meth-protocol"]),
  ...lst("1044", "stader", "Stader ETHx", ["stader"]),
  ...lst("3946", "kelp", "Kelp rsETH", ["kelp"]),
  {
    llamaId: "2626",
    slug: "ether.fi-stake",
    product: "ether.fi weETH",
    version: null,
    protocolIds: ["ether-fi"],
    attribution: "PRODUCT_FAMILY",
    status: "PARTIAL_POSITION",
    reason: "WEETH_CONVERSION_ONLY",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "277",
    slug: "stakewise-v3",
    product: "StakeWise osETH",
    version: "V3",
    protocolIds: ["stakewise-v3"],
    attribution: "PRODUCT_FAMILY",
    status: "PARTIAL_POSITION",
    reason: "OSETH_ONLY_VAULT_STAKES_NOT_READ",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "2221",
    slug: "frax-ether",
    product: "Frax sfrxETH (ERC-4626)",
    version: null,
    protocolIds: ["frax-ether"],
    attribution: "PRODUCT_FAMILY",
    status: "PARTIAL_POSITION",
    reason: "SFRXETH_ONLY",
    adapterVersion: "1.0.0",
  },
  {
    llamaId: "4088",
    slug: "puffer-stake",
    product: "Puffer pufETH (ERC-4626)",
    version: null,
    protocolIds: ["puffer"],
    attribution: "EXACT",
    status: "FULL_POSITION",
    reason: "ERC4626_CONVERSION",
    adapterVersion: "1.0.0",
  },
  {
    llamaId: "3107",
    slug: "eigencloud",
    product: "EigenLayer restaking",
    version: null,
    protocolIds: ["eigenlayer"],
    attribution: "PRODUCT_FAMILY",
    status: "PARTIAL_POSITION",
    reason: "LST_STRATEGIES_EXACT_NATIVE_AND_QUEUED_PARTIAL",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "3",
    slug: "curve-dex",
    product: "Curve pools and gauges",
    version: null,
    protocolIds: ["curve"],
    attribution: "EXACT",
    status: "PARTIAL_POSITION",
    reason: "CURVE_REWARDS_NOT_EXACT",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "2611",
    slug: "balancer-v2",
    product: "Balancer V2 weighted pools",
    version: "V2",
    protocolIds: ["balancer-v2"],
    attribution: "PRODUCT_FAMILY",
    status: "PARTIAL_POSITION",
    reason: "WEIGHTED_POOLS_ONLY_STAKED_BPT_NOT_CHECKED",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "3450",
    slug: "aerodrome-v1",
    product: "Aerodrome basic pools and gauges",
    version: "V1",
    protocolIds: ["aerodrome"],
    attribution: "EXACT",
    status: "PARTIAL_POSITION",
    reason: "RECEIPT_DISCOVERY_ONLY",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "3302",
    slug: "velodrome-v2",
    product: "Velodrome basic pools and gauges",
    version: "V2",
    protocolIds: ["velodrome"],
    attribution: "EXACT",
    status: "PARTIAL_POSITION",
    reason: "RECEIPT_DISCOVERY_ONLY",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "119",
    slug: "sushiswap",
    product: "SushiSwap V2 pairs",
    version: "V2",
    protocolIds: ["sushiswap"],
    attribution: "EXACT",
    status: "PARTIAL_POSITION",
    reason: "PAIR_DISCOVERY_INDEX_OR_HELD_LP",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "194",
    slug: "pancakeswap-amm",
    product: "PancakeSwap V2 pairs",
    version: "V2",
    protocolIds: ["pancakeswap"],
    attribution: "EXACT",
    status: "PARTIAL_POSITION",
    reason: "PAIR_DISCOVERY_INDEX_OR_HELD_LP",
    adapterVersion: "1.1.0",
  },
  {
    llamaId: "2769",
    slug: "pancakeswap-amm-v3",
    product: "PancakeSwap V3 positions",
    version: "V3",
    protocolIds: ["pancakeswap-v3"],
    attribution: "EXACT",
    status: "PARTIAL_POSITION",
    reason: "STAKED_POSITIONS_NOT_CHECKED",
    adapterVersion: "1.1.0",
  },
];
function lst(
  llamaId: string,
  slug: string,
  product: string,
  protocolIds: string[],
): ReviewedLink[] {
  return [
    {
      llamaId,
      slug,
      product,
      version: null,
      protocolIds,
      attribution: "EXACT",
      status: "FULL_POSITION",
      reason: "EXACT_PROTOCOL_CONVERSION_OR_REPORTED_RATE",
      adapterVersion: "1.1.0",
    },
  ];
}
