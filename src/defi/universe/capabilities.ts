import rpcSnapshot from "../../data/registry/rpc-registry.snapshot.json" with { type: "json" };
import identityFile from "../../registry/chain-identities.generated.json" with { type: "json" };
import { defaultTierConfig, type TierConfig } from "../../data/registry/chains";
import type { ChainCapability, UniverseChain } from "./model";
import { DEFI_ENGINE_VMS, type DeploymentRef } from "./coverage";
// Product capabilities come from reviewed Otherbridge registries in code (vetted RPC registry, tier config, chain
// identity registry, reviewed DeFi deployments), never from the upstream catalog. Identity capabilities (CATALOG,
// IDENTIFIED, UNSUPPORTED_VM, DEPRECATED, NEEDS_REVIEW) are decided during normalization.
export interface CapabilityRegistries {
  rpcChains: ReadonlySet<string>;
  multicallChains: ReadonlySet<string>;
  tiers: TierConfig;
  routingChains: ReadonlySet<string>;
  customChains: ReadonlySet<string>;
  deployments: (DeploymentRef & { adapter: string })[];
}
const DISCOVERY_FAMILIES = new Set([
  "morpho-blue",
  "morpho-vault",
  "uniswap-v2",
  "uniswap-v3",
]);
export function defaultRegistries(
  deployments: (DeploymentRef & { adapter: string })[],
): CapabilityRegistries {
  const identities = (
    identityFile as {
      chains: { id: string; environment: string; sources: string[] }[];
    }
  ).chains;
  return {
    rpcChains: new Set(rpcSnapshot.endpoints.map((e) => e.chainId)),
    multicallChains: new Set(Object.keys(rpcSnapshot.multicall ?? {})),
    tiers: defaultTierConfig,
    routingChains: new Set(
      identities
        .filter(
          (i) =>
            i.environment === "mainnet" &&
            i.sources.includes("routing-catalog"),
        )
        .map((i) => i.id),
    ),
    customChains: new Set(
      identities
        .filter((i) => i.sources.includes("custom-registry"))
        .map((i) => i.id),
    ),
    deployments,
  };
}
const ORDER: ChainCapability[] = [
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
];
const IDENTITY_CAPS = new Set<ChainCapability>([
  "CATALOG",
  "IDENTIFIED",
  "UNSUPPORTED_VM",
  "DEPRECATED",
  "NEEDS_REVIEW",
]);
export function chainCapabilities(
  chain: UniverseChain,
  r: CapabilityRegistries,
): ChainCapability[] {
  const caps = new Set<ChainCapability>(
    chain.capabilities.filter((c) => IDENTITY_CAPS.has(c)),
  );
  caps.add("CATALOG");
  const live = chain.status === "ACTIVE" || chain.status === "REFERENCED_ONLY";
  // Only an identified network can gain product capabilities: a name match alone never routes reads or funds.
  if (caps.has("IDENTIFIED") && live) {
    const evm = chain.vm === "EVM" && chain.chainId;
    const id = evm ? chain.chainId! : chain.otherbridgeId;
    if (id && !r.tiers.disabled.includes(id)) {
      if (r.rpcChains.has(id)) {
        caps.add("RPC_READ");
        if (evm) {
          caps.add("PORTFOLIO_NATIVE");
          if (r.multicallChains.has(id)) caps.add("PORTFOLIO_FUNGIBLE");
          if (r.tiers.fullIndexed.includes(id)) caps.add("INDEXED");
        } else {
          const tier = r.tiers.nonEvmPortfolio[id];
          if (tier && tier !== "CATALOG_ONLY") caps.add("PORTFOLIO_NATIVE");
          if (tier === "ON_DEMAND_FUNGIBLE" || tier === "FULL_INDEXED")
            caps.add("PORTFOLIO_FUNGIBLE");
        }
      }
      if (evm && DEFI_ENGINE_VMS.has(chain.vm)) {
        const deps = r.deployments.filter((d) => d.chainId === id);
        if (deps.length && r.rpcChains.has(id)) caps.add("DEFI_POSITION");
        if (
          deps.some((d) => DISCOVERY_FAMILIES.has(d.adapter)) &&
          r.rpcChains.has(id)
        )
          caps.add("DEFI_DISCOVERY");
      }
      if (r.routingChains.has(id) || r.customChains.has(id)) caps.add("BRIDGE");
      if (r.routingChains.has(id)) caps.add("SWAP");
    }
  }
  return ORDER.filter((c) => caps.has(c));
}
