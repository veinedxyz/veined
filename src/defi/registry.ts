import { z } from "zod";
import snapshot from "./deployments.generated.json" with { type: "json" };
import {
  addressSchema,
  categorySchema,
  type ProtocolDeployment,
} from "./model";
const schema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,120}$/),
    protocolId: z.string(),
    name: z.string(),
    chainId: z.string().regex(/^\d+$/),
    adapter: z.enum([
      "aave-v3",
      "compound-iii",
      "morpho-blue",
      "morpho-vault",
      "erc4626",
      "lido",
      "uniswap-v2",
      "uniswap-v3",
      "lst-rate",
      "eigenlayer",
      "curve",
      "balancer-v2",
      "solidly-v2",
    ]),
    category: categorySchema,
    contracts: z.record(z.string(), addressSchema),
    source: z
      .string()
      .url()
      .refine((s) => new URL(s).hostname === "raw.githubusercontent.com"),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    status: z.literal("active"),
    environment: z.literal("mainnet"),
    startBlock: z
      .string()
      .regex(/^\d{1,12}$/)
      .optional(),
    variant: z.enum(["fee5", "fee3", "pancake"]).optional(),
    config: z
      .object({
        call: z.enum([
          "getEthValue",
          "exchangeRate",
          "getEETHByWeETH",
          "mETHToETH",
          "convertToAssets",
          "swETHToETHRate",
          "rsETHPrice",
        ]),
        mode: z.enum(["convert", "rate"]),
        underlying: z.enum(["native", "token"]),
        rateSource: z.string().regex(/^[a-z-]{1,40}$/),
      })
      .strict()
      .optional(),
    strategies: z
      .array(
        z
          .object({
            symbol: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
            strategy: addressSchema,
            underlying: addressSchema,
          })
          .strict(),
      )
      .max(64)
      .optional(),
    identity: z.enum(["OFFICIAL_SOURCE_LITERAL", "ONCHAIN_DERIVED"]).optional(),
    derivation: z.record(z.string(), z.string().max(300)).optional(),
    assets: z
      .array(
        z.object({
          symbol: z.string(),
          underlying: addressSchema,
          receipt: addressSchema,
          debt: addressSchema,
          decimals: z.number().int().min(0).max(36),
        }),
      )
      .optional(),
  })
  .strict();
export const deployments: ProtocolDeployment[] = z
  .array(schema)
  .parse(snapshot.deployments);
if (new Set(deployments.map((d) => d.id)).size !== deployments.length)
  throw Error("DUPLICATE_DEPLOYMENT");
export const protocolUrls: Record<string, string> = {
  "aave-v3": "https://app.aave.com/",
  "compound-iii": "https://app.compound.finance/",
  "morpho-blue": "https://app.morpho.org/",
  "morpho-vault": "https://app.morpho.org/",
  erc4626: "https://app.spark.fi/",
  lido: "https://stake.lido.fi/",
  "uniswap-v2": "https://app.uniswap.org/",
  "uniswap-v3": "https://app.uniswap.org/",
  "rocket-pool": "https://stake.rocketpool.net/",
  "coinbase-cbeth": "https://www.coinbase.com/cbeth",
  "binance-wbeth": "https://www.binance.com/en/wbeth",
  "swell-sweth": "https://app.swellnetwork.io/",
  "ether-fi": "https://app.ether.fi/",
  "meth-protocol": "https://www.methprotocol.xyz/",
  stader: "https://www.staderlabs.com/eth/",
  kelp: "https://kerneldao.com/kelp/",
  "stakewise-v3": "https://app.stakewise.io/",
  "frax-ether": "https://app.frax.finance/",
  puffer: "https://app.puffer.fi/",
  eigenlayer: "https://app.eigenlayer.xyz/",
  curve: "https://www.curve.finance/",
  "balancer-v2": "https://balancer.fi/",
  aerodrome: "https://aerodrome.finance/",
  velodrome: "https://velodrome.finance/",
  sushiswap: "https://www.sushi.com/",
  pancakeswap: "https://pancakeswap.finance/",
  "pancakeswap-v3": "https://pancakeswap.finance/",
  sparklend: "https://app.spark.fi/",
};
export function requireDeployment(id: string, chainId: string) {
  const d = deployments.find((d) => d.id === id && d.chainId === chainId);
  if (!d) throw Error("UNSUPPORTED_DEPLOYMENT");
  return d;
}
